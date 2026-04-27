import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toTraditional } from "@/lib/util/chinese";

// ─── Model ────────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "claude-haiku-4-5";

/** Bump this string whenever the prompt changes. Stored in ai_classifications. */
export const PROMPT_VERSION = "classify-v2";

// ─── Response schema ──────────────────────────────────────────────────────────

const tickerSchema = z.object({
  /** Taiwan stock code (4-6 digits) as the AI understood it — resolver canonicalises later */
  symbol: z.string().min(1).max(10),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  /** Target price in TWD, if mentioned */
  target_price: z.number().positive().optional(),
});

export const classifySchema = z.discriminatedUnion("is_tip", [
  z.object({
    is_tip: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    is_tip: z.literal(true),
    /** Always "TW" — the system is Taiwan-only */
    market: z.literal("TW"),
    /** Overall directional sentiment of the tip */
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    /** One-line summary in Traditional Chinese, max 100 chars */
    summary: z.string().max(200),
    /** How confident the AI is this is a real, actionable tip (0–100) */
    confidence: z.number().int().min(0).max(100),
    /** All Taiwan stock codes explicitly or clearly implied by the message */
    tickers: z.array(tickerSchema).min(1).max(20),
    /** Brief company description in Traditional Chinese, max 100 chars (AI-generated) */
    company_description: z.string().max(100).optional(),
    /** Relative position of the stock in its sector, e.g. "龍頭"、"二線" (AI-generated) */
    sector_position: z.string().max(30).optional(),
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

const SYSTEM_PROMPT = `你是一個台股交易情報分析師。分析以下 Telegram 訊息，判斷是否包含有效的台股交易建議。

【重要前提】
- 本系統只處理台股（上市 + 上櫃），非台股內容一律回覆 is_tip: false。
- 所有輸出文字（summary / company_description / sector_position）**一律使用台灣慣用繁體中文**，禁止任何簡體字、禁止大陸用詞（例如請用「軟體」不要用「軟件」、「網路」不要用「網絡」、「品質」不要用「質量」、「滑鼠」不要用「鼠標」）。來源訊息若為簡體字，輸出時也要轉為繁體中文。

【如果是台股交易情報】回覆此 JSON（不含其他文字）：
{
  "is_tip": true,
  "market": "TW",
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "一句話摘要（繁體中文，100字以內）",
  "confidence": 整數0到100,
  "tickers": [
    { "symbol": "4-5位數字代碼", "sentiment": "bullish"|"bearish"|"neutral", "target_price": 目標價（可省略）}
  ],
  "company_description": "主要標的的公司業務簡述（繁體中文，50字以內，例如「台積電為全球最大晶圓代工廠」）",
  "sector_position": "此股在產業內的相對地位（例如「龍頭」「二線」「中小型」「後段」，盡量簡短）"
}

【欄位說明】
- market: 固定為 "TW"
- sentiment: bullish=看多, bearish=看空, neutral=中性觀察
- confidence: 判斷這是明確可行情報的信心，不確定則給低分
- tickers.symbol: 台股代碼（不加 .TW 後綴）。包含：
    • 4 位數一般股票（例「2330」「6451」「1101」）
    • 4 位數 ETF（例「0050」「0056」）
    • 5 位數 ETF（例「00878」「00940」「006208」）
  ETF 也是合法的情報標的，請當作一般股票照常抽出，**不要因為是 ETF 就跳過**
- target_price: 新台幣目標價，若原訊息無提及則省略此欄位
- company_description: 主要標的的公司業務簡述（50字以內）；無法判斷可省略
- sector_position: 此股在產業內的相對地位（例如「龍頭」「二線」「中小型」「後段」）；無法判斷可省略

【如果不是台股情報】（一般閒聊、純新聞、無方向建議、美股、加密貨幣等）：
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

  // Safety net: normalise AI-generated Chinese fields to Traditional (twp).
  // Haiku occasionally emits simplified glyphs ("目标价") despite the prompt.
  const data = validation.data;
  if (data.is_tip) {
    data.summary = toTraditional(data.summary);
    if (data.company_description) {
      data.company_description = toTraditional(data.company_description);
    }
    if (data.sector_position) {
      data.sector_position = toTraditional(data.sector_position);
    }
  }

  return {
    result: data,
    model,
    inputTokens,
    outputTokens,
    rawResponse: response,
  };
}
