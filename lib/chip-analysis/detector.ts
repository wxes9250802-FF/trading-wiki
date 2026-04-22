/**
 * T5 — Institutional Investor Anomaly Detector
 *
 * Determines whether today's institutional net buy/sell is anomalous
 * relative to the past 20 trading days.
 *
 * Anomaly criteria:
 *   Buy anomaly:  today's net lots >= max(avg_net_lots_past20 * 3, 500)
 *   Sell anomaly: today's net lots <= min(avg_net_lots_past20 * 3, -500)
 *
 * The 500-lot floor prevents cold/illiquid stocks from triggering on tiny moves.
 *
 * Input: raw share counts (as returned by FinMind — not pre-divided by 1000).
 * The share→lot conversion (÷1000) is done internally so callers stay consistent
 * with the FinMind data contract.
 */

export interface InstitutionalRow {
  date: string;
  /** Net shares: Foreign_Investor + Foreign_Dealer_Self buy minus sell */
  netSharesForeign: number;
  /** Net shares: Investment_Trust buy minus sell */
  netSharesTrust: number;
  /** Net shares: Dealer_self + Dealer_Hedging buy minus sell */
  netSharesDealer: number;
}

export interface AnomalyResult {
  isAnomaly: boolean;
  direction: "buy" | "sell" | null;
  /** Today's total net lots (張), rounded to integer */
  todayNetLots: number;
  /** Average net lots of the past 20 trading days (excluding today) */
  avgNetLots: number;
}

const MIN_ABS_LOTS = 500; // minimum absolute lots to qualify as anomaly
const MULTIPLIER = 3;     // today must be at least 3× the 20-day average

/**
 * Detects whether today's net institutional flow is anomalous.
 *
 * @param rows  21 rows sorted ascending by date (oldest first, latest = today).
 *              If fewer than 2 rows are supplied, isAnomaly is always false.
 */
export function detectInstitutionalAnomaly(rows: InstitutionalRow[]): AnomalyResult {
  if (rows.length < 2) {
    return { isAnomaly: false, direction: null, todayNetLots: 0, avgNetLots: 0 };
  }

  // Sort ascending by date to make sure "today" is the last element
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  const todayRow = sorted[sorted.length - 1]!;
  const historicalRows = sorted.slice(0, sorted.length - 1); // up to 20 rows

  // Convert shares → lots (張) for each row
  const toNetLots = (r: InstitutionalRow): number =>
    Math.round((r.netSharesForeign + r.netSharesTrust + r.netSharesDealer) / 1000);

  const todayNetLots = toNetLots(todayRow);

  if (historicalRows.length === 0) {
    return { isAnomaly: false, direction: null, todayNetLots, avgNetLots: 0 };
  }

  // Average of historical days (absolute value for threshold; keep signed for display)
  const historicalNetLots = historicalRows.map(toNetLots);
  const avgNetLots = Math.round(
    historicalNetLots.reduce((sum, v) => sum + v, 0) / historicalRows.length
  );

  // Buy-side anomaly: today's net lots >= max(avg * MULTIPLIER, MIN_ABS_LOTS)
  const buyThreshold = Math.max(avgNetLots * MULTIPLIER, MIN_ABS_LOTS);
  if (todayNetLots >= buyThreshold) {
    return { isAnomaly: true, direction: "buy", todayNetLots, avgNetLots };
  }

  // Sell-side anomaly: today's net lots <= min(avg * MULTIPLIER, -MIN_ABS_LOTS)
  // avg is typically negative on sell days, so avg * MULTIPLIER is more negative
  const sellThreshold = Math.min(avgNetLots * MULTIPLIER, -MIN_ABS_LOTS);
  if (todayNetLots <= sellThreshold) {
    return { isAnomaly: true, direction: "sell", todayNetLots, avgNetLots };
  }

  return { isAnomaly: false, direction: null, todayNetLots, avgNetLots };
}
