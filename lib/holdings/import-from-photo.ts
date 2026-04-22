import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedHoldingItem {
  symbol: string;      // 4-6 位數字台股代碼（原始，未正規化）
  sharesLots: number;  // 張數
  avgCost: number;     // 每股成本
}

// ─── Claude Vision prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是台股持股解析助手。這張截圖是台股券商 APP 的持股明細畫面。
請把每一筆持股抽出，回傳 JSON 陣列：

[
  { "symbol": "2330", "sharesLots": 10, "avgCost": 985.5 },
  ...
]

規則：
- symbol: 4-6 位數字台股代碼（不加 .TW 後綴）
- sharesLots: 張數（若圖上是股數，除以 1000）
- avgCost: 每股成本價（新台幣）
- 看不清楚或無法辨識的整筆跳過
- 如果整張圖看不出任何持股，回傳空陣列 []

只回傳 JSON 陣列，不加其他文字。`;

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
 * 回傳解析出的持股陣列；若無法辨識或出錯回傳 null。
 */
export async function parseHoldingsPhoto(
  base64: string
): Promise<ParsedHoldingItem[] | null> {
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
              text: "請解析這張持股截圖，回傳 JSON 陣列。",
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

  if (!Array.isArray(parsed)) {
    console.error("[import-from-photo] Expected array, got:", typeof parsed);
    return null;
  }

  // Validate and filter each item
  const items: ParsedHoldingItem[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["symbol"] === "string" &&
      typeof (item as Record<string, unknown>)["sharesLots"] === "number" &&
      typeof (item as Record<string, unknown>)["avgCost"] === "number" &&
      /^\d{4,6}$/.test(String((item as Record<string, unknown>)["symbol"])) &&
      (item as Record<string, unknown>)["sharesLots"] as number > 0 &&
      (item as Record<string, unknown>)["avgCost"] as number > 0
    ) {
      items.push({
        symbol: String((item as Record<string, unknown>)["symbol"]),
        sharesLots: (item as Record<string, unknown>)["sharesLots"] as number,
        avgCost: (item as Record<string, unknown>)["avgCost"] as number,
      });
    }
  }

  return items;
}
