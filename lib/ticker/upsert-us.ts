import "server-only";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tickers } from "@/lib/db/schema/tickers";
import type { Ticker } from "@/lib/db/schema/tickers";
import { fetchUsCompanyProfile } from "@/lib/finnhub/client";

/**
 * Lazy-load a US ticker into the `tickers` table on first use.
 *
 * Strategy:
 *   1. Look it up in DB. If present → return it.
 *   2. Otherwise call Finnhub /stock/profile2 to get the canonical name +
 *      exchange. Insert the row. Return.
 *   3. If Finnhub returns nothing (delisted / wrong symbol / API issue),
 *      return null — caller should treat as "name unknown" and continue.
 *
 * This keeps the tickers table clean without a 7000-row bulk sync.
 */
export async function upsertUsTicker(symbol: string): Promise<Ticker | null> {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return null;

  // 1. Already in DB?
  const [existing] = await db
    .select()
    .from(tickers)
    .where(and(eq(tickers.symbol, upper), isNull(tickers.delistedAt)))
    .limit(1);
  if (existing) return existing;

  // 2. Fetch from Finnhub
  const profile = await fetchUsCompanyProfile(upper);
  if (!profile || !profile.name) return null;

  // Normalise exchange — Finnhub returns verbose strings like "NASDAQ NMS - GLOBAL MARKET"
  const ex = (profile.exchange || "").toUpperCase();
  let exchange: "NYSE" | "NASDAQ" | "OTHER" = "OTHER";
  if (ex.includes("NASDAQ")) exchange = "NASDAQ";
  else if (ex.includes("NEW YORK") || ex.includes("NYSE")) exchange = "NYSE";

  // 3. Insert (or upsert in case of race)
  const [inserted] = await db
    .insert(tickers)
    .values({
      symbol: upper,
      name: profile.name,
      exchange,
      aliases: null,
    })
    .onConflictDoUpdate({
      target: tickers.symbol,
      set: {
        name: profile.name,
        lastUpdated: new Date(),
      },
    })
    .returning();

  return inserted ?? null;
}
