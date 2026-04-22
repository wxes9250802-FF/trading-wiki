/**
 * Minimal Telegram Bot API client.
 * Works in both Next.js route handlers and standalone Bun scripts.
 *
 * All functions are fire-and-mostly-forget — Telegram errors are logged
 * but never thrown, so a notification failure never blocks the main flow.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface SentMessage {
  message_id: number;
  chat: { id: number };
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function call<T = unknown>(
  method: string,
  body: Record<string, unknown>
): Promise<T | null> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.warn(`[TelegramClient] TELEGRAM_BOT_TOKEN not set — skipping ${method}`);
    return null;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }
    );

    const data = (await res.json()) as ApiResponse<T>;

    if (!data.ok) {
      console.warn(
        `[TelegramClient] ${method} failed (${data.error_code}): ${data.description}`
      );
      return null;
    }

    return data.result ?? null;
  } catch (err) {
    console.warn(`[TelegramClient] ${method} network error: ${String(err)}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a text message to a chat. Returns the sent message (with message_id)
 * or null on failure.
 */
export async function sendMessage(params: {
  chat_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: InlineKeyboardMarkup;
}): Promise<SentMessage | null> {
  return call<SentMessage>("sendMessage", params);
}

/**
 * Required after every callback_query — shows a toast notification on the
 * user's device. Must be called within 30 s or Telegram shows a spinner.
 */
export async function answerCallbackQuery(params: {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}): Promise<void> {
  await call("answerCallbackQuery", params);
}

/**
 * Replace the inline keyboard on an existing message without changing its text.
 * Pass `{ inline_keyboard: [] }` to remove all buttons.
 */
export async function editMessageReplyMarkup(params: {
  chat_id: number;
  message_id: number;
  reply_markup: InlineKeyboardMarkup | { inline_keyboard: never[] };
}): Promise<void> {
  await call("editMessageReplyMarkup", params);
}
