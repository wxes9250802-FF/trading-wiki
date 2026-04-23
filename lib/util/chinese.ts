/**
 * Simplified → Traditional Chinese conversion safety net.
 *
 * Claude Haiku occasionally outputs simplified characters (e.g. 目标价
 * instead of 目標價) even when told to use Traditional. We run every
 * AI-generated Chinese text field through this converter before persisting
 * to the DB.
 *
 * Uses OpenCC-JS with the Taiwan (tw) variant, which handles both glyph
 * mapping (简→簡) and Taiwan-specific vocabulary (软件→軟體, 网络→網路 etc.)
 * that a naïve char-by-char map would miss.
 */

import { Converter } from "opencc-js";

let _converter: ((s: string) => string) | undefined;

function getConverter(): (s: string) => string {
  if (_converter) return _converter;
  // "twp" = Taiwan variant WITH phrase mapping — converts vocabulary too
  //   软件 → 軟體 (not 軟件), 网络 → 網路 (not 網絡), 智能手机 → 智慧手機 etc.
  _converter = Converter({ from: "cn", to: "twp" });
  return _converter;
}

/**
 * Convert a string to Taiwan-variant Traditional Chinese.
 * No-ops when input is null / undefined / empty.
 */
export function toTraditional(s: string | null | undefined): string {
  if (!s) return s ?? "";
  return getConverter()(s);
}

/**
 * Same as toTraditional, but preserves null/undefined typing for optional
 * DB fields. Returns null iff the input was null/undefined.
 */
export function toTraditionalOrNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return getConverter()(s);
}
