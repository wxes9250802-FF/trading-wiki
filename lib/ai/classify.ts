import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// ─── Model ────────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "claude-haiku-4-5";

/** Bump this string whenever the prompt changes. Stored in ai_classifications. */
export const PROMPT_VERSION = "classify-v1";

// ─── Response schema ──────────────────────────────────────────────────────────

const tickerSchema = z.object({
  /** Raw symbol as the AI understood it — T7 resolver canonicalises it later */
  symbol: z.string().min(1).max(30),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  /** Target price in the tip's native currency, if mentioned */
  target_price: z.number().positive().optional(),
});

export const classifySchema = z.discriminatedUnion("is_tip", [
  z.object({
    is_tip: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    is_tip: z.literal(true),
    /** Primary market of the tip */
    market: z.enum(["TW", "US", "CRYPTO"]),
    /** Overall directional sentiment of the tip */
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    /** One-line summary in Traditional Chinese, max 100 chars */
    summary: z.string().max(200),
    /** How confident the AI is this is a real, actionable tip (0–100) */
    confidence: z.number().int().min(0).max(100),
    /** All tickers explicitly or clearly implied by the message */
    tickers: z.array(tickerSchema).min(1).max(20),
  }),
]);

export type ClassifyResult = z.infer<typeof classifySchema>;

export interface ClassifyOutput {
  result: ClassifyResult;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Full Anthropic API response, stored for debugging / fine-tuning */
  rawResponse: unknown;
}

export interface ClassifyMedia {
  type: "photo" | "pdf";
  base64: string;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一個交易情報分析師。分析以下 Telegram 訊息，判斷是否包含有效的交易建議。

【如果是交易情報】回覆此 JSON（不含其他文字）：
{
  "is_tip": true,
  "market": "TW" | "US" | "CRYPTO",
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "一句話摘要（繁體中文，100字以內）",
  "confidence": 整數0到100,
  "tickers": [
    { "symbol": "股票代碼", "sentiment": "bullish"|"bearish"|"neutral", "target_price": 目標價（可省略）}
  ]
}

【欄位說明】
- market: TW=台灣股市(上市+上櫃), US=美股, CRYPTO=加密貨幣
- sentiment: bullish=看多, bearish=看空, neutral=中性觀察
- confidence: 判斷這是明確可行情報的信心，不確定則給低分
- tickers.symbol:
  - 台股: 直接用4位數字代碼，例如 "2330"（不加 .TW）
  - 美股: 用大寫英文代碼，例如 "AAPL"、"NVDA"
  - 加密: 大寫符號，例如 "BTC"、"ETH"

【如果不是交易情報】（一般閒聊、單純新聞、無明確方向建議）：
{ "is_tip": false, "reason": "原因說明" }

只回覆 JSON，不加任何說明文字。`;

// ─── Classification function ──────────────────────────────────────────────────

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * Classifies a single message using Claude.
 * Optionally accepts a photo (base64 JPEG) or PDF for vision/document analysis.
 * Throws on API or validation errors — caller decides retry strategy.
 */
export async function classifyMessage(
  messageText: string,
  model: string = DEFAULT_MODEL,
  media?: ClassifyMedia
): Promise<ClassifyOutput> {
  const client = getClient();

  // Build content parts — prepend media before text if present
  const parts: any[] = [];

  if (media?.type === "photo") {
    parts.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: media.base64 },
    });
  } else if (media?.type === "pdf") {
    parts.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: media.base64 },
    });
  }

  parts.push({
    type: "text",
    text: messageText || "請分析上面的圖片/文件中的交易情報。",
  });

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: parts }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected Anthropic response: no text block");
  }

  let parsed: unknown;
  try {
    // Strip markdown code fences if the model wraps in ```json ... ```
    const raw = block.text.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `JSON parse failed. Raw response: ${block.text.slice(0, 300)}`
    );
  }

  const validation = classifySchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      `Schema validation failed: ${validation.error.message}. ` +
        `Parsed: ${JSON.stringify(parsed).slice(0, 300)}`
    );
  }

  return {
    result: validation.data,
    model,
    inputTokens,
    outputTokens,
    rawResponse: response,
  };
}
