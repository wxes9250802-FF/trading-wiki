#!/usr/bin/env bun
/**
 * T6 — AI Classification Worker
 *
 * Picks up pending raw_messages, classifies them with Claude, and writes
 * the results back to the DB.
 *
 * Designed to run as a GitHub Actions cron job (every 5 minutes).
 * Can also be run locally for testing:  bun run ai:classify
 *
 * Processing flow per message:
 *   1. Atomically claim pending messages (FOR UPDATE SKIP LOCKED)
 *   2. Call Claude via lib/ai/classify.ts
 *   3a. If is_tip=true  → INSERT tip + tip_tickers + ai_classification in one tx
 *   3b. If is_tip=false → INSERT ai_classification, UPDATE status='ignored'
 *   4. On any error    → increment retry_count; reset to 'pending' until MAX_RETRIES,
 *                         then set status='failed'
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, or, inArray, lte, isNull, gte, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";

// Schema imports (no Next.js env dep — only drizzle types)
import { rawMessages } from "@/lib/db/schema/raw-messages";
import { tips } from "@/lib/db/schema/tips";
import { tickers } from "@/lib/db/schema/tickers";
import { tipTickers } from "@/lib/db/schema/classifications";
import { aiClassifications } from "@/lib/db/schema/classifications";
import { tipVerifications } from "@/lib/db/schema/verifications";

import { classifyMessage, DEFAULT_MODEL, PROMPT_VERSION, type ClassifyMedia } from "@/lib/ai/classify";
import { findSemanticMatch } from "@/lib/ai/semantic-match";
import { fetchCurrentPrice } from "@/lib/price/client";
import { fetchStockInfo } from "@/lib/finmind/client";
import { fetchUsCompanyProfile } from "@/lib/finnhub/client";
import { sendMessage } from "@/lib/telegram/client";
import type { RawMessage } from "@/lib/db/schema/raw-messages";

// Semantic dedup window — compare against tips for the same primary ticker
// created within this many days. Conservative (Haiku might over-merge older
// unrelated news otherwise). Tune via env if needed.
const SEMANTIC_MATCH_WINDOW_DAYS = Number(
  process.env["SEMANTIC_MATCH_WINDOW_DAYS"] ?? "7"
);
// Hard cap on candidates sent to Haiku to keep prompt small and latency low.
const SEMANTIC_MATCH_MAX_CANDIDATES = 10;

// ─── Telegram file download ───────────────────────────────────────────────────

async function downloadTelegramFile(fileId: string): Promise<string | null> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return null;

  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    );
    const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path: string } };
    if (!meta.ok || !meta.result?.file_path) return null;

    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`
    );
    const buffer = await fileRes.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch {
    return null;
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;   // messages claimed per run
const MAX_RETRIES = 3;  // after this many failures → status='failed'

// ─── DB setup (standalone — avoids Next.js env validation) ───────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error("ERROR: ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

// ─── Inline ticker resolver ───────────────────────────────────────────────────
// Mirrors lib/ticker/resolver.ts but uses the standalone `db` above (no
// lib/db/client import, which would pull in Next.js env validation).

async function resolveSymbol(raw: string): Promise<string> {
  const input = raw.trim();
  if (!input) return raw;

  // 1. Exact symbol match (case-insensitive)
  const [bySymbol] = await db
    .select({ symbol: tickers.symbol })
    .from(tickers)
    .where(
      and(
        sql`lower(${tickers.symbol}) = ${input.toLowerCase()}`,
        isNull(tickers.delistedAt)
      )
    )
    .limit(1);
  if (bySymbol) return bySymbol.symbol;

  // 2. Taiwan bare 4–6 digit code → try .TW then .TWO
  if (/^\d{4,6}$/.test(input)) {
    const [byCode] = await db
      .select({ symbol: tickers.symbol })
      .from(tickers)
      .where(
        and(
          or(
            eq(tickers.symbol, `${input}.TW`),
            eq(tickers.symbol, `${input}.TWO`)
          ),
          isNull(tickers.delistedAt)
        )
      )
      .limit(1);
    if (byCode) return byCode.symbol;
  }

  // Unresolved — store raw AI output; T7 resolver can retry at display time
  return input;
}

// ─── Notification helpers ─────────────────────────────────────────────────────

const SENTIMENT_LABEL: Record<string, string> = {
  bullish: "📈 看多",
  bearish: "📉 看空",
  neutral: "➡️ 中性",
};

function buildTipMessage(opts: {
  sentiment: string;
  summary: string;
  symbols: string[];
  industryCategory?: string | null;
  sectorPosition?: string | null;
  companyDescription?: string | null;
}): string {
  const lines = [
    "📊 <b>新情報分類完成</b>",
    "",
    `<b>方向：</b>${SENTIMENT_LABEL[opts.sentiment] ?? opts.sentiment}`,
  ];
  if (opts.symbols.length > 0) {
    lines.push(`<b>股票：</b>${opts.symbols.join("、")}`);
  }
  if (opts.industryCategory) {
    lines.push(`<b>產業：</b>${opts.industryCategory}`);
  }
  if (opts.sectorPosition) {
    lines.push(`<b>地位：</b>${opts.sectorPosition}`);
  }
  if (opts.companyDescription) {
    lines.push("", `💼 ${opts.companyDescription}`);
  }
  lines.push("", `<b>摘要：</b>${opts.summary}`, "", "請確認 AI 分類是否正確：");
  return lines.join("\n");
}

// ─── Claim messages ───────────────────────────────────────────────────────────

/**
 * Atomically claims up to BATCH_SIZE pending messages and marks them as
 * 'processing'. Uses FOR UPDATE SKIP LOCKED so multiple concurrent workers
 * don't race on the same rows.
 */
async function claimPendingMessages(): Promise<RawMessage[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: rawMessages.id })
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.status, "pending"),
          lte(rawMessages.retryCount, MAX_RETRIES - 1)
        )
      )
      .orderBy(rawMessages.createdAt)
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    const ids = candidates.map((r) => r.id);

    return tx
      .update(rawMessages)
      .set({ status: "processing", updatedAt: new Date() })
      .where(inArray(rawMessages.id, ids))
      .returning();
  });
}

// ─── Process one message ──────────────────────────────────────────────────────

async function processMessage(msg: RawMessage): Promise<void> {
  console.log(`  Processing ${msg.id} (update_id=${msg.telegramUpdateId})`);

  let classifyError: string | null = null;

  // Download media attachment if present
  let media: ClassifyMedia | undefined;
  if (msg.mediaFileId && (msg.mediaType === "photo" || msg.mediaType === "pdf")) {
    const base64 = await downloadTelegramFile(msg.mediaFileId);
    if (base64) {
      media = { type: msg.mediaType as "photo" | "pdf", base64 };
      console.log(`    → downloaded ${msg.mediaType} (${msg.mediaFileId.slice(0, 12)}...)`);
    }
  }

  try {
    const { result, model, inputTokens, outputTokens, rawResponse } =
      await classifyMessage(msg.messageText, DEFAULT_MODEL, media);

    // Pre-resolve primary symbol and fetch market data BEFORE opening the
    // transaction — avoids holding a DB connection open during HTTP calls.
    // Market-aware: TW → FinMind, US → Finnhub.
    let primarySymbol: string | null = null;
    let industryCategory: string | null = null;
    if (result.is_tip) {
      const primaryRaw = result.tickers[0];
      if (primaryRaw) {
        if (result.market === "US") {
          // US: upsert into tickers via Finnhub profile
          const profile = await fetchUsCompanyProfile(primaryRaw.symbol);
          if (profile) {
            primarySymbol = profile.symbol;
            industryCategory = profile.industry;
            // Best-effort upsert into tickers
            try {
              const exch = (profile.exchange || "").toUpperCase();
              const exchEnum: "NYSE" | "NASDAQ" | "OTHER" = exch.includes("NASDAQ")
                ? "NASDAQ"
                : exch.includes("NYSE") || exch.includes("NEW YORK")
                ? "NYSE"
                : "OTHER";
              await db
                .insert(tickers)
                .values({
                  symbol: profile.symbol,
                  name: profile.name,
                  exchange: exchEnum,
                })
                .onConflictDoUpdate({
                  target: tickers.symbol,
                  set: { name: profile.name, lastUpdated: new Date() },
                });
            } catch (err) {
              console.warn("    [classify] tickers upsert failed:", err);
            }
          } else {
            primarySymbol = primaryRaw.symbol.toUpperCase();
          }
        } else {
          // TW (default)
          primarySymbol = await resolveSymbol(primaryRaw.symbol);
          try {
            const stockInfo = await fetchStockInfo(primarySymbol);
            industryCategory = stockInfo?.industryCategory ?? null;
          } catch {
            // Non-fatal — classification continues without industry data
          }
        }
      }
    }

    // ── Semantic dedup check (BEFORE opening the write transaction) ──────
    // If the new tip is semantically a duplicate of a recent tip for the same
    // ticker, merge into it instead of creating a new row.
    let semanticMatch: Awaited<ReturnType<typeof findSemanticMatch>> = null;
    if (result.is_tip && primarySymbol) {
      const since = new Date(
        Date.now() - SEMANTIC_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000
      );
      const candidates = await db
        .select({
          id: tips.id,
          summary: tips.summary,
          createdAt: tips.createdAt,
        })
        .from(tips)
        .where(and(eq(tips.ticker, primarySymbol), gte(tips.createdAt, since)))
        .orderBy(desc(tips.createdAt))
        .limit(SEMANTIC_MATCH_MAX_CANDIDATES);

      if (candidates.length > 0) {
        semanticMatch = await findSemanticMatch(
          primarySymbol,
          result.summary,
          candidates
        );
        if (semanticMatch) {
          console.log(
            `    → semantic match: tip ${semanticMatch.matchedTipId.slice(0, 8)}… (conf=${semanticMatch.confidence})`
          );
        }
      }
    }

    await db.transaction(async (tx) => {
      if (result.is_tip && semanticMatch) {
        // ── Merge path: update existing tip's summary, don't create a new ──
        //   one. Log a classification pointing to the matched tip so audit
        //   still works. Point the raw_message at the matched tip too.
        await tx
          .update(tips)
          .set({
            summary: semanticMatch.mergedSummary,
            updatedAt: new Date(),
          })
          .where(eq(tips.id, semanticMatch.matchedTipId));

        await tx.insert(aiClassifications).values({
          rawMessageId: msg.id,
          tipId: semanticMatch.matchedTipId,
          model,
          promptVersion: PROMPT_VERSION,
          inputTokens,
          outputTokens,
          rawResponse: rawResponse as object,
          userConfirmed: null,
        });

        await tx
          .update(rawMessages)
          .set({
            status: "done",
            aiTipId: semanticMatch.matchedTipId,
            updatedAt: new Date(),
          })
          .where(eq(rawMessages.id, msg.id));

        console.log(
          `    → merged into existing tip ${semanticMatch.matchedTipId.slice(0, 8)}…`
        );

        // Notify the sender that their info was merged (non-blocking, outside tx)
        await sendMessage({
          chat_id: msg.telegramChatId,
          text: [
            "📋 <b>此情報與近期情報相似，已合併更新</b>",
            "",
            `<b>合併後摘要：</b>${semanticMatch.mergedSummary}`,
          ].join("\n"),
          parse_mode: "HTML",
        }).catch(() => {});

        return;
      }

      if (result.is_tip) {
        // ── New-tip path (original behaviour) ──────────────────────────────
        const primaryRaw = result.tickers[0];

        const [tip] = await tx
          .insert(tips)
          .values({
            telegramUserId: msg.telegramUserId,
            telegramChatId: msg.telegramChatId,
            telegramMessageId: msg.telegramMessageId,
            rawText: msg.messageText,
            ticker: primarySymbol,
            market: result.market,
            sentiment: result.sentiment,
            summary: result.summary,
            targetPrice: primaryRaw?.target_price?.toString() ?? null,
            confidence: result.confidence,
            aiClassified: true,
            industryCategory,
            companyDescription: result.company_description ?? null,
            sectorPosition: result.sector_position ?? null,
          })
          .returning({ id: tips.id });

        if (!tip) throw new Error("Failed to insert tip row");

        // Resolve raw AI symbols → canonical symbols. TW goes through tickers
        // table (.TW/.TWO suffix); US stays bare (uppercase letters).
        const resolvedTickers = await Promise.all(
          result.tickers.map(async (t) => ({
            ...t,
            symbol:
              result.market === "US"
                ? t.symbol.toUpperCase()
                : await resolveSymbol(t.symbol),
          }))
        );

        // Insert all tickers with resolved symbols
        if (resolvedTickers.length > 0) {
          await tx.insert(tipTickers).values(
            resolvedTickers.map((t) => ({
              tipId: tip.id,
              symbol: t.symbol,
              sentiment: t.sentiment,
              targetPrice: t.target_price?.toString() ?? null,
            }))
          );
        }

        // Log the classification — keep the id to use as callback_data
        const [classification] = await tx.insert(aiClassifications).values({
          rawMessageId: msg.id,
          tipId: tip.id,
          model,
          promptVersion: PROMPT_VERSION,
          inputTokens,
          outputTokens,
          rawResponse: rawResponse as object,
          userConfirmed: null,
        }).returning({ id: aiClassifications.id });

        // Mark raw_message done
        await tx
          .update(rawMessages)
          .set({ status: "done", aiTipId: tip.id, updatedAt: new Date() })
          .where(eq(rawMessages.id, msg.id));

        console.log(`    → tip ${tip.id} (${resolvedTickers.map((t) => t.symbol).join(", ")})`);

        // ── T8: send confirmation notification (outside tx — non-critical) ──
        if (classification) {
          const text = buildTipMessage({
            sentiment: result.sentiment,
            summary: result.summary,
            symbols: resolvedTickers.map((t) => t.symbol),
            industryCategory,
            sectorPosition: result.sector_position ?? null,
            companyDescription: result.company_description ?? null,
          });

          await sendMessage({
            chat_id: msg.telegramChatId,
            text,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ 確認", callback_data: `conf:${classification.id}` },
                { text: "❌ 駁回", callback_data: `rejt:${classification.id}` },
              ]],
            },
          });
        }

        // ── T11: create price target monitoring row (non-blocking) ──────
        // Only when: directional tip + resolved ticker + target price mentioned.
        // The verify-tips.ts cron checks daily whether price has reached the
        // target and notifies the user when it does.
        const tipTargetPrice = primaryRaw?.target_price ?? null;
        if (result.sentiment !== "neutral" && primarySymbol && tipTargetPrice) {
          try {
            const priceAtTip = await fetchCurrentPrice(primarySymbol);

            if (priceAtTip !== null) {
              // Idempotency: skip if a row already exists (e.g. on retry)
              const [existing] = await db
                .select({ id: tipVerifications.id })
                .from(tipVerifications)
                .where(eq(tipVerifications.tipId, tip.id))
                .limit(1);

              if (!existing) {
                await db.insert(tipVerifications).values({
                  tipId: tip.id,
                  priceAtTip: priceAtTip.toString(),
                  targetPrice: tipTargetPrice.toString(),
                });
                console.log(`    → target monitoring created (priceAtTip=${priceAtTip}, target=${tipTargetPrice})`);
              }
            } else {
              console.log(`    → price fetch failed, target monitoring skipped`);
            }
          } catch (verifyErr) {
            // Non-fatal — verification is best-effort
            console.warn(`    → target monitoring setup error: ${String(verifyErr)}`);
          }
        }
      } else {
        // ── Not a tip: log + ignore ────────────────────────────────────────
        await tx.insert(aiClassifications).values({
          rawMessageId: msg.id,
          tipId: null,
          model,
          promptVersion: PROMPT_VERSION,
          inputTokens,
          outputTokens,
          rawResponse: rawResponse as object,
          userConfirmed: null,
        });

        await tx
          .update(rawMessages)
          .set({ status: "ignored", updatedAt: new Date() })
          .where(eq(rawMessages.id, msg.id));

        console.log(`    → ignored (${result.reason})`);
      }
    });
  } catch (err) {
    classifyError = err instanceof Error ? err.message : String(err);
    console.error(`    ✗ Error: ${classifyError}`);

    const newRetryCount = msg.retryCount + 1;
    const newStatus = newRetryCount >= MAX_RETRIES ? "failed" : "pending";

    // Log error in ai_classifications for visibility
    await db.insert(aiClassifications).values({
      rawMessageId: msg.id,
      tipId: null,
      model: DEFAULT_MODEL,
      promptVersion: PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      rawResponse: null,
      error: classifyError,
    }).catch(() => {}); // non-fatal

    await db
      .update(rawMessages)
      .set({
        status: newStatus,
        retryCount: newRetryCount,
        updatedAt: new Date(),
      })
      .where(eq(rawMessages.id, msg.id));

    if (newStatus === "failed") {
      console.warn(`    → moved to failed after ${newRetryCount} attempts`);
    } else {
      console.log(`    → will retry (attempt ${newRetryCount}/${MAX_RETRIES})`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T6 Classification Worker started ═══");
  const startMs = Date.now();

  const messages = await claimPendingMessages();

  if (messages.length === 0) {
    console.log("No pending messages — exiting.");
    await pg.end();
    return;
  }

  console.log(`Claimed ${messages.length} message(s)`);

  for (const msg of messages) {
    await processMessage(msg);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
