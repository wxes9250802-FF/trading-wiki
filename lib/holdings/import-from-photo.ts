import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedHoldingItem {
  symbol: string;      // 4-5 位數字台股代碼（原始，未正規化）
  sharesLots: number;  // 張數
  avgCost: number;     // 每股成本
}

export interface ParseHoldingsResult {
  items: ParsedHoldingItem[];
  /** Warrants / other unsupported instruments Claude identified and skipped. */
  skippedWarrants: string[];
}

// ─── Claude Vision prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是台股持股解析助手。這張截圖是台股券商 APP 的持股明細畫面。

請解析每一筆持股，分成兩類回傳 JSON 物件：

{
  "items": [
    { "symbol": "2330", "sharesLots": 10, "avgCost": 985.5 },
    ...
  ],
  "skippedWarrants": ["08501U", "739445"]
}

規則：
- items 只放**一般股票或 ETF**，symbol 為 4-5 位純數字台股代碼（不加 .TW 後綴，例如 "2330"、"1711"、"0050"、"00878"）
- sharesLots: 張數（若圖上顯示股數，除以 1000；若顯示「張」直接取用）
- avgCost: 每股成本價（新台幣）
- skippedWarrants 放所有被跳過的「權證」代碼（原樣），讓使用者知道哪些被忽略
- 看不清楚、欄位不全的整筆跳過（items 與 skippedWarrants 都不放）
- 如果整張圖沒有任何持股，回傳 {"items": [], "skippedWarrants": []}

**務必放進 skippedWarrants 而非 items 的項目：**
- 權證：代號含英文字母（如 "08501U"）、代號為 6 位數、或名稱含「購」「售」「認購」「認售」「牛」「熊」等字樣

**完全忽略（兩邊都不放）的項目：**
- 期貨、選擇權、期指
- 基金、境外債券、特別股
- 興櫃、未上市

只回傳 JSON 物件，不加其他文字、不加 markdown 標記。`;

// ─── Client ───────────────────────────────────────────────────────────────────

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ─── Main function ─────────────────────────────────────────────────────────────

/**
 * 傳入 base64 JPEG 圖片，呼叫 Claude Vision 解析台股持股截圖。
 * 回傳 items（股票/ETF）與 skippedWarrants（被識別但不匯入的權證代碼）；
 * 若 Vision 失敗或 JSON 無法解析，回傳 null。
 */
export async function parseHoldingsPhoto(
  base64: string
): Promise<ParseHoldingsResult | null> {
  const client = getClient();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64,
              },
            },
            {
              type: "text",
              text: '請解析這張持股截圖，回傳 {"items": [...], "skippedWarrants": [...]} JSON 物件。',
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("[import-from-photo] Claude API error:", err);
    return null;
  }

  const block = response.content[0];
  if (!block || block.type !== "text") {
    console.error("[import-from-photo] Unexpected response: no text block");
    return null;
  }

  // Strip markdown code fences if present
  const raw = block.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[import-from-photo] JSON parse failed:", raw.slice(0, 200));
    return null;
  }

  // Accept either the new object shape {items, skippedWarrants} or a legacy
  // array (older Claude responses ignoring the instruction).
  let rawItems: unknown[] = [];
  let rawSkipped: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["items"])) rawItems = obj["items"];
    if (Array.isArray(obj["skippedWarrants"])) rawSkipped = obj["skippedWarrants"];
  } else {
    console.error("[import-from-photo] Unexpected root type:", typeof parsed);
    return null;
  }

  // Validate items. Only accept 4-5 digit stock/ETF codes; anything 6-char or
  // with letters gets redirected to skippedWarrants (second-line defence if
  // Claude misclassifies).
  const items: ParsedHoldingItem[] = [];
  const skippedWarrants = new Set<string>();

  for (const item of rawItems) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>)["symbol"] !== "string" ||
      typeof (item as Record<string, unknown>)["sharesLots"] !== "number" ||
      typeof (item as Record<string, unknown>)["avgCost"] !== "number" ||
      !((item as Record<string, unknown>)["sharesLots"] as number > 0) ||
      !((item as Record<string, unknown>)["avgCost"] as number > 0)
    ) {
      continue;
    }

    const symbol = String(
      (item as Record<string, unknown>)["symbol"]
    ).toUpperCase();

    if (/^\d{4,5}$/.test(symbol)) {
      items.push({
        symbol,
        sharesLots: (item as Record<string, unknown>)["sharesLots"] as number,
        avgCost: (item as Record<string, unknown>)["avgCost"] as number,
      });
    } else if (/^[0-9A-Z]{5,8}$/.test(symbol)) {
      // Looks like a warrant slipped into items — salvage it into skipped list
      skippedWarrants.add(symbol);
    }
    // Otherwise: malformed, drop silently
  }

  for (const s of rawSkipped) {
    if (typeof s === "string" && s.trim()) {
      skippedWarrants.add(s.trim().toUpperCase());
    }
  }

  return { items, skippedWarrants: Array.from(skippedWarrants) };
}
