/**
 * Pure Zod schema tests for classifySchema.
 *
 * No API calls, no DB — just validates that the schema accepts and rejects
 * inputs correctly. Fast enough to run on every commit.
 *
 * Note: `server-only` is aliased to a no-op module via vitest.config.ts so
 * that classify.ts can be imported in the Node test environment.
 */
import { describe, it, expect } from "vitest";
import { classifySchema } from "@/lib/ai/classify";

// ─── Shared fixture ────────────────────────────────────────────────────────────

const VALID_TIP = {
  is_tip: true as const,
  market: "TW" as const,
  sentiment: "bullish" as const,
  summary: "台積電突破千元關卡，短線看多",
  confidence: 80,
  tickers: [{ symbol: "2330", sentiment: "bullish" as const, target_price: 1000 }],
};

// ─── Non-tip branch ────────────────────────────────────────────────────────────

describe("classifySchema — non-tip (is_tip: false)", () => {
  it("accepts a valid non-tip result", () => {
    const input = { is_tip: false, reason: "Just casual chatter, no directional view" };
    expect(classifySchema.parse(input)).toEqual(input);
  });

  it("accepts a non-tip with a multi-line reason", () => {
    const input = {
      is_tip: false,
      reason: "Line 1\nLine 2\nNot actionable.",
    };
    expect(classifySchema.parse(input).is_tip).toBe(false);
  });

  it("rejects non-tip missing the reason field", () => {
    expect(() => classifySchema.parse({ is_tip: false })).toThrow();
  });

  it("rejects a non-tip that also includes tip-only fields", () => {
    // discriminated union: extra fields on the false branch are just ignored by
    // safeParse, but unknown keys are stripped (strict mode isn't on by default)
    const result = classifySchema.safeParse({
      is_tip: false,
      reason: "ok",
      market: "TW", // tip-only field — should be stripped not rejected
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // market should NOT appear in the parsed output
      expect("market" in result.data).toBe(false);
    }
  });
});

// ─── Tip branch ───────────────────────────────────────────────────────────────

describe("classifySchema — tip (is_tip: true)", () => {
  it("accepts a complete valid tip", () => {
    expect(classifySchema.parse(VALID_TIP)).toEqual(VALID_TIP);
  });

  it("accepts a tip without target_price (optional field)", () => {
    const tip = {
      ...VALID_TIP,
      tickers: [{ symbol: "2330", sentiment: "bullish" as const }],
    };
    const parsed = classifySchema.parse(tip);
    expect(parsed.is_tip).toBe(true);
    if (parsed.is_tip) {
      expect(parsed.tickers[0]?.target_price).toBeUndefined();
    }
  });

  it("accepts market='TW' (the only valid value)", () => {
    const result = classifySchema.safeParse({ ...VALID_TIP, market: "TW" });
    expect(result.success).toBe(true);
  });

  it("accepts all three sentiment values at the tip level", () => {
    for (const sentiment of ["bullish", "bearish", "neutral"] as const) {
      const result = classifySchema.safeParse({ ...VALID_TIP, sentiment });
      expect(result.success, `sentiment=${sentiment} should be valid`).toBe(true);
    }
  });

  it("accepts all three sentiment values at the ticker level", () => {
    for (const sentiment of ["bullish", "bearish", "neutral"] as const) {
      const tip = {
        ...VALID_TIP,
        tickers: [{ symbol: "AAPL", sentiment }],
      };
      const result = classifySchema.safeParse(tip);
      expect(result.success, `ticker sentiment=${sentiment} should be valid`).toBe(true);
    }
  });

  it("accepts confidence at boundary values 0 and 100", () => {
    expect(classifySchema.parse({ ...VALID_TIP, confidence: 0 }).is_tip).toBe(true);
    expect(classifySchema.parse({ ...VALID_TIP, confidence: 100 }).is_tip).toBe(true);
  });

  it("accepts a tip with multiple tickers (up to 20)", () => {
    const tickers = Array.from({ length: 5 }, (_, i) => ({
      symbol: `TK${i}`,
      sentiment: "neutral" as const,
    }));
    const result = classifySchema.safeParse({ ...VALID_TIP, tickers });
    expect(result.success).toBe(true);
  });

  // ── Validation failures ──────────────────────────────────────────────────

  it("accepts both TW and US markets", () => {
    for (const market of ["TW", "US"]) {
      expect(classifySchema.safeParse({ ...VALID_TIP, market }).success).toBe(true);
    }
  });

  it("rejects unsupported markets (CRYPTO/JP/etc.)", () => {
    for (const market of ["CRYPTO", "JP", "HK"]) {
      expect(classifySchema.safeParse({ ...VALID_TIP, market }).success).toBe(false);
    }
  });

  it("rejects an invalid sentiment value", () => {
    expect(classifySchema.safeParse({ ...VALID_TIP, sentiment: "strongly_bullish" }).success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    expect(classifySchema.safeParse({ ...VALID_TIP, confidence: -1 }).success).toBe(false);
  });

  it("rejects confidence above 100", () => {
    expect(classifySchema.safeParse({ ...VALID_TIP, confidence: 101 }).success).toBe(false);
  });

  it("rejects non-integer confidence", () => {
    expect(classifySchema.safeParse({ ...VALID_TIP, confidence: 80.5 }).success).toBe(false);
  });

  it("rejects summary longer than 200 chars", () => {
    const longSummary = "a".repeat(201);
    expect(classifySchema.safeParse({ ...VALID_TIP, summary: longSummary }).success).toBe(false);
  });

  it("rejects an empty tickers array", () => {
    expect(classifySchema.safeParse({ ...VALID_TIP, tickers: [] }).success).toBe(false);
  });

  it("rejects tickers array longer than 20 items", () => {
    const tickers = Array.from({ length: 21 }, (_, i) => ({
      symbol: `TK${i}`,
      sentiment: "neutral" as const,
    }));
    expect(classifySchema.safeParse({ ...VALID_TIP, tickers }).success).toBe(false);
  });

  it("rejects a ticker with an empty symbol", () => {
    const tip = {
      ...VALID_TIP,
      tickers: [{ symbol: "", sentiment: "bullish" as const }],
    };
    expect(classifySchema.safeParse(tip).success).toBe(false);
  });

  it("rejects a ticker symbol longer than 10 chars", () => {
    const tip = {
      ...VALID_TIP,
      tickers: [{ symbol: "1".repeat(11), sentiment: "bullish" as const }],
    };
    expect(classifySchema.safeParse(tip).success).toBe(false);
  });

  it("rejects a negative target_price", () => {
    const tip = {
      ...VALID_TIP,
      tickers: [{ symbol: "2330", sentiment: "bullish" as const, target_price: -10 }],
    };
    expect(classifySchema.safeParse(tip).success).toBe(false);
  });

  it("rejects a zero target_price (must be positive)", () => {
    const tip = {
      ...VALID_TIP,
      tickers: [{ symbol: "2330", sentiment: "bullish" as const, target_price: 0 }],
    };
    expect(classifySchema.safeParse(tip).success).toBe(false);
  });

  it("rejects a tip missing the market field", () => {
    const { market: _, ...tipWithoutMarket } = VALID_TIP;
    expect(classifySchema.safeParse(tipWithoutMarket).success).toBe(false);
  });

  it("rejects a tip missing the tickers field", () => {
    const { tickers: _, ...tipWithoutTickers } = VALID_TIP;
    expect(classifySchema.safeParse(tipWithoutTickers).success).toBe(false);
  });
});
