/**
 * User-facing symbol formatting.
 *
 * Canonical display is "CODE NAME" (e.g. "2330 台積電"). Falls back to just
 * the code when no name is available (warrant bypass, unresolved ticker,
 * stale data).
 *
 * The code itself is always stripped of .TW / .TWO suffix for readability.
 */

export function stripTwSuffix(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/, "");
}

/**
 * Format a symbol + optional name for display.
 * Examples:
 *   formatSymbolName("2330.TW", "台積電")  → "2330 台積電"
 *   formatSymbolName("2330.TW", null)     → "2330"
 *   formatSymbolName("08501U", null)      → "08501U"
 */
export function formatSymbolName(
  symbol: string,
  name?: string | null
): string {
  const bare = stripTwSuffix(symbol);
  if (name && name.trim() && name !== bare) return `${bare} ${name}`;
  return bare;
}
