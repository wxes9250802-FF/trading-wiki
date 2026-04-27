import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toTraditional } from "@/lib/util/chinese";

// ─── Model ────────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "claude-haiku-4-5";

/** Bump this string whenever the prompt changes. Stored in ai_classifications. */
export const PROMPT_VERSION = "classify-v3-us";

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
    /** "TW" or "US" — the system supports both markets */
    market: z.enum(["TW", "US"]),
    /** Overall directional sentiment of the tip */
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    /** One-line summary in Traditional Chinese, max 100 chars */
    summary: z.string().max(200),
    /** How confident the AI is this is a real, actionable tip (0–100) */
    confidence: z.number().int().min(0).max(100),
    /** All TW or US stock codes explicitly or clearly implied by the message */
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

const SYSTEM_PROMPT = `你是一個股票交易情報分析師，處理台股（TW）與美股（US）兩個市場。分析以下 Telegram 訊息，判斷是否包含明確的交易建議。

【重要前提】
- 加密貨幣、外匯、商品、純新聞 / 閒聊等一律回覆 is_tip: false。
- 所有輸出文字（summary / company_description / sector_position）**一律使用台灣慣用繁體中文**，禁止任何簡體字、禁止大陸用詞（例如請用「軟體」不要用「軟件」、「網路」不要用「網絡」、「品質」不要用「質量」、「滑鼠」不要用「鼠標」）。來源訊息若為簡體字，輸出時也要轉為繁體中文。

【如果是台股或美股情報】回覆此 JSON（不含其他文字）：
{
  "is_tip": true,
  "market": "TW" | "US",
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "一句話摘要（繁體中文，100字以內）",
  "confidence": 整數0到100,
  "tickers": [
    { "symbol": "代碼", "sentiment": "bullish"|"bearish"|"neutral", "target_price": 目標價（可省略）}
  ],
  "company_description": "主要標的的公司業務簡述（繁體中文，50字以內，例如「台積電為全球最大晶圓代工廠」「Apple 為全球最大智慧型手機品牌」）",
  "sector_position": "此股在產業內的相對地位（例如「龍頭」「二線」「中小型」「後段」，盡量簡短）"
}

【欄位說明】
- market:
    • "TW" 若標的為台股
    • "US" 若標的為美股
    • 一則情報只能歸一個市場；若同時提到台股與美股，以主要標的為準
- sentiment: bullish=看多, bearish=看空, neutral=中性觀察
- confidence: 判斷這是明確可行情報的信心，不確定則給低分
- tickers.symbol:
    • 台股：純數字代碼（不加 .TW 後綴）。包含：
        - 4 位數一般股票（例「2330」「6451」「1101」）
        - 4 位數 ETF（例「0050」「0056」）
        - 5 位數 ETF（例「00878」「00940」）
        - 6 位數 ETF（必為 00 開頭，例「006208」）
      ETF 也是合法情報標的，**不要因為是 ETF 就跳過**
    • 美股：1-5 個英文大寫字母（例「AAPL」「TSLA」「NVDA」「MSFT」），可含 . 或 - 表示子類股（例「BRK.B」「GOOG」）
    • 同一筆 tickers 陣列內的代碼必須屬於同一個市場（與 market 欄位一致）
- target_price: 目標價（台股 NTD，美股 USD），若原訊息無提及則省略此欄位
- company_description: 公司業務簡述（50字內）；無法判斷可省略
- sector_position: 此股在產業內地位；無法判斷可省略

【如果不是股票情報】（閒聊、純新聞、無方向建議、加密貨幣、外匯等）：
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
