/**
 * Semantic dedup for tips at ingestion time.
 *
 * Given a freshly-classified tip (primary ticker + summary) and the set of
 * recent tips that mention the same ticker, ask Claude Haiku whether the new
 * tip is already covered by one of the existing ones. If yes, produce a
 * merged summary that retains the unique info from both sides.
 *
 * The caller decides how to apply the result:
 *   - Match: update the matched tip's summary, don't create a new tip,
 *     point the new raw_message's aiTipId at the matched tip.
 *   - No match: create a new tip as usual.
 *
 * Design choices:
 *   - Conservative: the prompt explicitly instructs "when in doubt, say NO".
 *   - Confidence gate: matches below CONFIDENCE_THRESHOLD are ignored
 *     (treated as no-match) so we never merge on low-quality signal.
 *   - The function returns null on API/parse failure — callers fall back
 *     to the "create new tip" path so a semantic-match outage never blocks
 *     ingestion.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const MODEL = "claude-haiku-4-5";
const CONFIDENCE_THRESHOLD = 70;

export interface ExistingTipCandidate {
  id: string;            // UUID
  summary: string | null;
  createdAt: Date;
}

export interface SemanticMatchResult {
  /** The matched existing tip's id (only set when matched). */
  matchedTipId: string;
  /** Merged summary combining unique info from both sides. */
  mergedSummary: string;
  /** Model confidence 0-100. */
  confidence: number;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你在幫一個台股情報系統做去重。下面會給你一則剛進來的「新情報」，以及這檔股票近期已有的「候選情報」。

你的任務：判斷新情報是否與某一筆候選情報在講**同一則新聞 / 同一個題材 / 同一個事件**。

**判定標準**：
- 同新聞源的不同轉傳 = 同一件事（即使字面不同）
- 同事件的不同角度分析 = 同一件事
- 不同事件 / 不同時間點的消息 = 不同
- 不同標的（例如都講台積電但一則講財報、一則講 2nm 進度）= 不同

**保守原則**：猶豫就判不同。寧可留兩筆也不要誤合。

若判定為同一件事：
- matched = true
- matched_tip_id = 最相似那筆候選的 id
- merged_summary = 整合新舊雙方獨特資訊的繁體中文摘要，100 字以內，保留所有數字與細節
- confidence = 0-100（你的信心分數）

若判定為不同：
- matched = false
- 其他欄位全為 null / 0

輸出格式（只回傳 JSON，無其他文字、無 markdown）：
{
  "matched": true,
  "matched_tip_id": "abc123",
  "merged_summary": "整合摘要",
  "confidence": 85
}
或
{
  "matched": false,
  "matched_tip_id": null,
  "merged_summary": null,
  "confidence": 0
}`;

const responseSchema = z.object({
  matched: z.boolean(),
  matched_tip_id: z.string().nullable(),
  merged_summary: z.string().nullable(),
  confidence: z.number().min(0).max(100),
});

// ─── Client (lazy) ────────────────────────────────────────────────────────────

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decide whether `newSummary` is a duplicate of any of the `candidates`.
 * Returns the match (if confidence >= threshold) or null.
 *
 * The function is best-effort: any API / parse failure returns null so the
 * caller falls back to the "create new tip" path.
 */
export async function findSemanticMatch(
  ticker: string,
  newSummary: string,
  candidates: ExistingTipCandidate[]
): Promise<SemanticMatchResult | null> {
  if (!newSummary.trim() || candidates.length === 0) return null;

  // Short-lived aliases so the prompt is compact and the model doesn't
  // have to echo 36-char UUIDs (they truncate and cause format errors).
  const idMap = new Map<string, string>();
  const lines: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const alias = `c${i + 1}`;
    idMap.set(alias, c.id);
    const date = c.createdAt.toISOString().slice(0, 10);
    const text = (c.summary ?? "").slice(0, 200).replace(/\s+/g, " ");
    lines.push(`[${alias}] (${date}) ${text}`);
  }

  const userMsg = [
    `股票：${ticker}`,
    "",
    "【新情報】",
    newSummary,
    "",
    `【候選情報（共 ${candidates.length} 筆）】`,
    ...lines,
    "",
    "請判斷，回傳 JSON。matched_tip_id 請用上面 [cN] 的 N 格式（例如 c1、c2）。",
  ].join("\n");

  try {
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const block = res.content[0];
    if (!block || block.type !== "text") return null;

    const raw = block.text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = responseSchema.parse(JSON.parse(raw));

    if (!parsed.matched) return null;
    if (parsed.confidence < CONFIDENCE_THRESHOLD) return null;
    if (!parsed.matched_tip_id || !parsed.merged_summary) return null;

    const realId = idMap.get(parsed.matched_tip_id);
    if (!realId) return null;

    return {
      matchedTipId: realId,
      mergedSummary: parsed.merged_summary.trim(),
      confidence: parsed.confidence,
    };
  } catch (err) {
    console.warn("[semantic-match] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
