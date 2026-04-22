import { db } from "@/lib/db/client";
import { priceAlerts } from "@/lib/db/schema/price-alerts";

/**
 * Default thresholds auto-created when a user first buys or imports a holding.
 *
 * Kept deliberately conservative so users aren't spammed:
 *   - ±5% price moves
 *   - no volume alert (too noisy as a default)
 *
 * Users can override via `/alert` at any time. This helper is a no-op when
 * the user already has any alert row for the symbol — it never overwrites.
 */
export const DEFAULT_UP_PCT = 5;
export const DEFAULT_DOWN_PCT = -5;

/**
 * Insert a default ±5% alert for (userId, symbol) if one doesn't exist.
 * ON CONFLICT DO NOTHING preserves any user-customised thresholds already set.
 *
 * Safe to call repeatedly; safe to call in parallel with other alert mutations.
 * Failures are swallowed (logged) — this is a best-effort convenience feature
 * and must not break the /buy or /import flow on error.
 */
export async function ensureDefaultAlert(
  userId: string,
  symbol: string
): Promise<void> {
  try {
    await db
      .insert(priceAlerts)
      .values({
        userId,
        symbol,
        upPct: DEFAULT_UP_PCT.toString(),
        downPct: DEFAULT_DOWN_PCT.toString(),
        volumeMultiplier: null,
        enabled: true,
      })
      .onConflictDoNothing({
        target: [priceAlerts.userId, priceAlerts.symbol],
      });
  } catch (err) {
    console.warn(
      `[price-alerts] ensureDefaultAlert(${userId}, ${symbol}) failed:`,
      err
    );
  }
}
