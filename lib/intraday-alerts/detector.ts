/**
 * T6 — Intraday Price & Volume Alert Detector
 *
 * Pure functions — no I/O, no side effects. Easy to unit-test.
 *
 * Trigger conditions (all configurable via exported consts):
 *   price_up:     (today.close - prev.close) / prev.close >= PRICE_CHANGE_THRESHOLD
 *   price_down:   (today.close - prev.close) / prev.close <= -PRICE_CHANGE_THRESHOLD
 *   volume_spike: today.volume >= avg20.volume * VOLUME_SPIKE_MULTIPLIER
 *
 * Input: rows sorted ascending by date (oldest first, last row = today).
 * If fewer than 2 rows supplied, returns no alerts.
 */

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Minimum absolute price change ratio to trigger a price alert (5% = 0.05). */
export const PRICE_CHANGE_THRESHOLD = 0.05;

/** Minimum volume ratio vs 20-day average to trigger a volume_spike alert. */
export const VOLUME_SPIKE_MULTIPLIER = 2.5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OHLCVRow {
  date: string;   // "YYYY-MM-DD"
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export type AlertType = "price_up" | "price_down" | "volume_spike";

export interface AlertCandidate {
  type: AlertType;
  /** %-change (as ratio, e.g. 0.0582) for price alerts; multiplier for volume_spike */
  metric: number;
}

export interface DetectResult {
  /** The last row in the input (= today). null if input has < 2 rows. */
  today: OHLCVRow | null;
  /** All triggered alerts (0–3). */
  alerts: AlertCandidate[];
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Detect intraday anomalies from a series of daily OHLCV rows.
 *
 * @param rows  Daily OHLCV rows sorted ascending by date.
 *              Minimum 2 rows required (1 previous + 1 today).
 *              Ideally 21 rows (20 historical + today) for accurate avg20.
 */
export function detectIntradayAlerts(rows: OHLCVRow[]): DetectResult {
  if (rows.length < 2) {
    return { today: null, alerts: [] };
  }

  // Sort ascending to guarantee last row = today
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  const today = sorted[sorted.length - 1]!;
  const prev = sorted[sorted.length - 2]!;
  // Use up to 20 rows before today for volume average
  const historicalRows = sorted.slice(0, sorted.length - 1);

  const alerts: AlertCandidate[] = [];

  // ── Price change ──────────────────────────────────────────────────────────
  if (prev.close > 0) {
    const change = (today.close - prev.close) / prev.close;

    if (change >= PRICE_CHANGE_THRESHOLD) {
      alerts.push({ type: "price_up", metric: change });
    } else if (change <= -PRICE_CHANGE_THRESHOLD) {
      alerts.push({ type: "price_down", metric: change }); // metric is negative
    }
  }

  // ── Volume spike ──────────────────────────────────────────────────────────
  const window = historicalRows.slice(-20); // at most last 20 rows before today
  if (window.length > 0) {
    const avgVolume =
      window.reduce((sum, r) => sum + r.volume, 0) / window.length;

    if (avgVolume > 0) {
      const multiplier = today.volume / avgVolume;
      if (multiplier >= VOLUME_SPIKE_MULTIPLIER) {
        alerts.push({ type: "volume_spike", metric: multiplier });
      }
    }
  }

  return { today, alerts };
}
