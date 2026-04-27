/**
 * Classify a Taiwan stock-like symbol by format.
 *
 * Rules (bare code, no .TW / .TWO suffix):
 *   - stock   : 4 digits (e.g. "2330" 一般股), 4-5 digits starting with 00
 *               (ETF: "0050" "00878" "00940"), or 6 digits starting with 00
 *               (ETF: "006208" 富邦台 50)
 *   - warrant : 6 chars all alphanumeric containing at least one digit, but
 *               NOT all-digit-starting-with-00 (those are ETFs, see above).
 *               Examples: "08501U", "739445", "03739P"
 *   - unknown : anything else (likely invalid or an unsupported instrument)
 *
 * Note: FinMind covers warrant prices for most active warrants, but many have
 * zero volume / zero price. Callers should tolerate null / zero responses.
 */
export function classifyTwSymbol(code: string): "stock" | "warrant" | "unknown" {
  const trimmed = code.trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!trimmed) return "unknown";

  // 4-5 digit pure numeric → stock / ETF
  if (/^\d{4,5}$/.test(trimmed)) return "stock";

  // 6-digit pure numeric starting with "00" → ETF (e.g. 006208 富邦台 50)
  if (/^00\d{4}$/.test(trimmed)) return "stock";

  // 6-char alphanumeric with at least one digit → warrant
  if (/^[0-9A-Z]{6}$/.test(trimmed) && /[0-9]/.test(trimmed)) return "warrant";

  return "unknown";
}

export function isTwWarrant(code: string): boolean {
  return classifyTwSymbol(code) === "warrant";
}
