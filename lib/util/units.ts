/**
 * Market-aware quantity / currency helpers.
 *
 * Holdings store the user-input "lots" or "shares" in `holdings.shares_lots`.
 * The interpretation depends on market:
 *   - TW:  1 lot = 1000 shares     → cost = lots * 1000 * avgCost
 *   - US:  1 unit = 1 share        → cost = lots * 1 * avgCost
 *
 * Currency:
 *   - TW prices in NTD (NT$)
 *   - US prices in USD (US$)
 */

import { classifyMarket } from "@/lib/ticker/classify";

export type Market = "TW" | "US";

export function marketFromSymbol(symbol: string): Market {
  const m = classifyMarket(symbol);
  // Default to TW if we can't tell — the system is TW-leaning historically
  return m === "US" ? "US" : "TW";
}

/** Number of shares per "lot" / "unit" stored in holdings.sharesLots. */
export function sharesPerLot(market: Market): number {
  return market === "TW" ? 1000 : 1;
}

/** "張" for TW lots, "股" for US shares. */
export function quantityUnit(market: Market): string {
  return market === "TW" ? "張" : "股";
}

/** Currency prefix string for display. */
export function currencyPrefix(market: Market): string {
  return market === "TW" ? "NT$" : "US$";
}

/** Locale for number formatting. */
export function localeForMarket(market: Market): string {
  return market === "TW" ? "zh-TW" : "en-US";
}

/** Format a quantity ("10 張" or "5 股") with the right unit for the market. */
export function formatQuantity(
  lots: number,
  symbol: string
): string {
  const market = marketFromSymbol(symbol);
  const unit = quantityUnit(market);
  const lotsStr = lots % 1 === 0 ? String(lots) : lots.toFixed(2);
  return `${lotsStr} ${unit}`;
}

/** Format a money value with the right currency + locale. */
export function formatMoney(
  amount: number,
  symbol: string,
  opts?: { withSign?: boolean; maximumFractionDigits?: number }
): string {
  const market = marketFromSymbol(symbol);
  const prefix = currencyPrefix(market);
  const locale = localeForMarket(market);
  const maxFrac = opts?.maximumFractionDigits ?? 0;
  const sign = opts?.withSign ? (amount >= 0 ? "+" : "-") : "";
  return `${sign}${prefix}${Math.abs(amount).toLocaleString(locale, { maximumFractionDigits: maxFrac })}`;
}
