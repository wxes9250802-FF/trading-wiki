#!/usr/bin/env bun
/**
 * One-shot dedup: cluster tips by semantic similarity per ticker, merge
 * the info of duplicate tips into a canonical one, then delete the dupes.
 *
 * Trigger via GitHub Actions (workflow_dispatch).
 *
 * Env vars:
 *   DATABASE_URL        — Supabase connection string (DDL / DML)
 *   ANTHROPIC_API_KEY   — for Claude Haiku clustering calls
 *   DRY_RUN=true        — print planned changes but do NOT delete / update
 *   MIN_GROUP_SIZE=2    — skip tickers with fewer tips than this (default 2)
 *
 * Behaviour per ticker:
 *   1. Load all tips that mention this ticker (via tips.ticker, primary only)
 *   2. Ask Haiku to cluster them by topic
 *   3. For each cluster with N>1:
 *        - Keep the earliest tip
 *        - Update its summary with an AI-merged summary (keeps unique info
 *          from every dupe so nothing is lost)
 *        - Delete the other tips (cascades to tip_tickers, tip_verifications)
 */

import { eq, inArray, isNotNull } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db/client";
import { tips } from "@/lib/db/schema/tips";
import { toTraditional } from "@/lib/util/chinese";

const DRY_RUN = (process.env["DRY_RUN"] ?? "").toLowerCase() === "true";
const MIN_GROUP_SIZE = Math.max(2, parseInt(process.env["MIN_GROUP_SIZE"] ?? "2", 10));
const MODEL = "claude-haiku-4-5";

const ANTHROPIC_KEY = process.env["ANTHROPIC_API_KEY"];
if (!ANTHROPIC_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一個情報整合助手。下面會給你一組關於同一支台股的情報，每則有一個 id。

你的任務：
1. 辨識哪些情報在講**同一則新聞、同一個題材、同一個事件**（語意相同就算，不需字面相同）
2. 每個「同一件事」歸成一個 cluster，給一個簡短 topic 名稱
3. 每個 cluster 選一個 keep_id（選摘要最完整、資訊最豐富的那筆）
4. 若 cluster 有多筆，寫一個 merged_summary：把所有筆的獨特資訊整合成一句（100 字以內，不要丟失細節）
   - **必須使用台灣慣用繁體中文**（例：「軟體」非「軟件」、「網路」非「網絡」）
   - 禁止任何簡體字
5. 只有一筆的 cluster，merged_summary 設為 null

**判定標準**：
- 同新聞源的不同轉傳 = 同一 cluster（即使文字不同）
- 同事件的不同角度分析 = 同一 cluster
- 不同事件 / 不同標的角度 / 不同時間點的消息 = 不同 cluster

輸出格式（只回傳 JSON，無其他文字）：
{
  "clusters": [
    {
      "topic": "Q3 獲利",
      "tip_ids": [1, 2, 5],
      "keep_id": 1,
      "merged_summary": "Q3 EPS 創高年增 30%；3nm 毛利率提升至 55%；AI 訂單推升業績"
    },
    {
      "topic": "2nm 進度",
      "tip_ids": [3],
      "keep_id": 3,
      "merged_summary": null
    }
  ]
}`;

interface ClusterResult {
  topic: string;
  tip_ids: string[];      // Script passes UUIDs as strings
  keep_id: string;
  merged_summary: string | null;
}

async function clusterTips(
  ticker: string,
  tipRows: { id: string; summary: string | null; rawText: string; createdAt: Date }[]
): Promise<ClusterResult[]> {
  // Give the AI a short number alias to keep prompt compact, then map back
  const aliases = new Map<number, string>();
  const lines: string[] = [];
  for (let i = 0; i < tipRows.length; i++) {
    const row = tipRows[i]!;
    const alias = i + 1;
    aliases.set(alias, row.id);
    const text = (row.summary?.trim() || row.rawText.slice(0, 150)).replace(/\s+/g, " ");
    lines.push(`[id=${alias}] ${text}`);
  }

  const userMsg = `股票：${ticker}\n\n以下是 ${tipRows.length} 筆情報，請分群：\n\n${lines.join("\n")}`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error("AI response missing text block");
  }

  const raw = block.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(raw) as {
    clusters?: {
      topic?: string;
      tip_ids?: number[];
      keep_id?: number;
      merged_summary?: string | null;
    }[];
  };

  if (!parsed.clusters || !Array.isArray(parsed.clusters)) {
    throw new Error("AI response missing clusters[]");
  }

  const clusters: ClusterResult[] = [];
  for (const c of parsed.clusters) {
    if (!Array.isArray(c.tip_ids) || typeof c.keep_id !== "number") continue;
    const tip_ids = c.tip_ids
      .map((alias) => aliases.get(alias))
      .filter((id): id is string => typeof id === "string");
    const keep_id = aliases.get(c.keep_id);
    if (!keep_id || tip_ids.length === 0) continue;
    if (!tip_ids.includes(keep_id)) continue;
    clusters.push({
      topic: toTraditional(c.topic ?? "(no topic)"),
      tip_ids,
      keep_id,
      // Safety net: force Traditional even if Haiku misbehaves
      merged_summary: c.merged_summary ? toTraditional(c.merged_summary) : null,
    });
  }

  return clusters;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[dedup] mode = ${DRY_RUN ? "DRY_RUN (no changes)" : "EXECUTE"}`);
  console.log(`[dedup] min group size = ${MIN_GROUP_SIZE}\n`);

  // 1. Pull all tips that have a primary ticker
  const allTips = await db
    .select({
      id: tips.id,
      ticker: tips.ticker,
      summary: tips.summary,
      rawText: tips.rawText,
      createdAt: tips.createdAt,
    })
    .from(tips)
    .where(isNotNull(tips.ticker));

  console.log(`[dedup] loaded ${allTips.length} tips with a primary ticker`);

  // 2. Group by ticker (canonical key)
  const groups = new Map<string, typeof allTips>();
  for (const t of allTips) {
    if (!t.ticker) continue;
    const key = t.ticker.toUpperCase();
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const eligibleGroups = [...groups.entries()].filter(
    ([, arr]) => arr.length >= MIN_GROUP_SIZE
  );
  console.log(
    `[dedup] ${groups.size} distinct tickers; ${eligibleGroups.length} have ≥${MIN_GROUP_SIZE} tips and will be clustered\n`
  );

  let totalClusters = 0;
  let totalMergedClusters = 0;
  let totalDeletedTips = 0;
  let totalUpdatedSummaries = 0;

  // 3. Per-ticker clustering + cleanup
  for (const [ticker, tipRows] of eligibleGroups) {
    console.log(`── ${ticker} (${tipRows.length} tips) ──`);

    // Sort by createdAt ascending so earliest ends up as natural keeper when
    // the AI picks multiple candidates
    tipRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let clusters: ClusterResult[];
    try {
      clusters = await clusterTips(ticker, tipRows);
    } catch (err) {
      console.error(`  ⚠ cluster call failed:`, err instanceof Error ? err.message : err);
      continue;
    }

    totalClusters += clusters.length;

    for (const c of clusters) {
      if (c.tip_ids.length < 2) {
        // single-tip cluster — nothing to do
        continue;
      }

      totalMergedClusters++;
      // Force keep_id to be the EARLIEST tip in the cluster — preserves
      // original chronology even if the AI suggested something else
      const inClusterRows = tipRows.filter((r) => c.tip_ids.includes(r.id));
      inClusterRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const keepId = inClusterRows[0]!.id;
      const deleteIds = c.tip_ids.filter((id) => id !== keepId);

      const keepRow = inClusterRows[0]!;
      const keepDate = keepRow.createdAt.toISOString().slice(0, 10);
      const newSummary = c.merged_summary?.trim() || keepRow.summary || null;

      console.log(
        `  ✓ cluster "${c.topic}" (${c.tip_ids.length} tips): keep ${keepId.slice(0, 8)}… (${keepDate}), delete ${deleteIds.length}`
      );
      console.log(`    old summary: ${truncate(keepRow.summary, 80)}`);
      console.log(`    new summary: ${truncate(newSummary, 80)}`);

      if (DRY_RUN) continue;

      try {
        await db.transaction(async (tx) => {
          if (newSummary && newSummary !== keepRow.summary) {
            await tx
              .update(tips)
              .set({ summary: newSummary, updatedAt: new Date() })
              .where(eq(tips.id, keepId));
            totalUpdatedSummaries++;
          }
          if (deleteIds.length > 0) {
            // Cascades to tip_tickers, tip_verifications, and sets
            // ai_classifications.tip_id to NULL
            await tx.delete(tips).where(inArray(tips.id, deleteIds));
            totalDeletedTips += deleteIds.length;
          }
        });
      } catch (err) {
        console.error(`    ✗ transaction failed:`, err instanceof Error ? err.message : err);
      }
    }

    console.log();
  }

  console.log("━".repeat(50));
  console.log(`Summary (${DRY_RUN ? "DRY RUN" : "EXECUTED"}):`);
  console.log(`  Tickers clustered:        ${eligibleGroups.length}`);
  console.log(`  Total clusters found:     ${totalClusters}`);
  console.log(`  Clusters with dupes:      ${totalMergedClusters}`);
  console.log(`  Summaries updated:        ${totalUpdatedSummaries}`);
  console.log(`  Tips deleted:             ${totalDeletedTips}`);

  if (DRY_RUN) {
    console.log("\n  (DRY_RUN=true — nothing was changed.)");
    console.log("  Re-run without DRY_RUN to apply these changes.");
  }

  process.exit(0);
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "(none)";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

main().catch((err) => {
  console.error("[dedup] fatal:", err);
  process.exit(1);
});
