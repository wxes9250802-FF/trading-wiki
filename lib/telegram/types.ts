/**
 * Minimal Telegram Bot API types — only the fields we actually use.
 * Full spec: https://core.telegram.org/bots/api#available-types
 */

export interface TelegramUpdate {
  /** Unique update identifier. Used for idempotency (raw_messages.telegram_update_id). */
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage; // ignored by T5 for now
  callback_query?: TelegramCallbackQuery; // handled by T8
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser; // absent for channel posts
  chat: TelegramChat;
  /** Unix timestamp */
  date: number;
  /** Present for text messages */
  text?: string;
  /** Present for media messages with a caption (photo + text, etc.) */
  caption?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

/** Fired when a user taps an inline keyboard button. Handled in T8. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  /** The `callback_data` set on the button */
  data?: string;
}

/** Minimal shape for Telegram Bot API responses */
export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}
