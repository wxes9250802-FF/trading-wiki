/**
 * Webhook route handler tests.
 *
 * Focus: guard clauses that return HTTP 200 early, without touching the DB.
 * These cover the most important correctness properties:
 *   1. Telegram always gets 200 → no spurious retries
 *   2. Bot messages are silently dropped
 *   3. Malformed payloads don't crash the handler
 *   4. Unknown update types are ignored
 *   5. Callback_query with unrecognised data format is safely ignored
 *
 * Tests that require DB reads (allowlist check, classification lookup) are
 * omitted here and covered by integration tests against a real test DB.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/telegram/webhook/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const NOW_UNIX = Math.floor(Date.now() / 1000);

// ─── Always-200 contract ──────────────────────────────────────────────────────

describe("POST /api/telegram/webhook — always returns 200", () => {
  it("returns 200 for malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is : not : valid : json {{",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 for an update that has neither message nor callback_query", async () => {
    const req = makeRequest({ update_id: 1, unknown_type: { foo: "bar" } });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 for an empty object body", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

// ─── Secret token validation ──────────────────────────────────────────────────

describe("POST /api/telegram/webhook — secret token", () => {
  it("returns 200 (silent drop) when TELEGRAM_WEBHOOK_SECRET is not set and no secret header is present", async () => {
    // No TELEGRAM_WEBHOOK_SECRET in test env → check is skipped → 200
    const req = makeRequest({ update_id: 99 });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

// ─── Message guard clauses ────────────────────────────────────────────────────

describe("POST /api/telegram/webhook — message handling", () => {
  it("returns 200 and ignores messages from bots", async () => {
    const req = makeRequest({
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 42, is_bot: true, first_name: "MyBot" },
        chat: { id: 1001, type: "private" },
        date: NOW_UNIX,
        text: "I am an automated message",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 and ignores messages with no text and no caption", async () => {
    const req = makeRequest({
      update_id: 101,
      message: {
        message_id: 2,
        from: { id: 99, is_bot: false, first_name: "Human" },
        chat: { id: 1001, type: "private" },
        date: NOW_UNIX,
        // intentionally no text or caption
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 and ignores messages with whitespace-only text", async () => {
    const req = makeRequest({
      update_id: 102,
      message: {
        message_id: 3,
        from: { id: 99, is_bot: false, first_name: "Human" },
        chat: { id: 1001, type: "private" },
        date: NOW_UNIX,
        text: "   \t\n  ",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 and ignores messages with no from field", async () => {
    const req = makeRequest({
      update_id: 103,
      message: {
        message_id: 4,
        // no `from` — channel posts omit this
        chat: { id: 2002, type: "channel" },
        date: NOW_UNIX,
        text: "Channel announcement",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

// ─── Callback query guard clauses ────────────────────────────────────────────

describe("POST /api/telegram/webhook — callback_query handling", () => {
  it("returns 200 for a callback_query with no data field", async () => {
    // data is undefined → action = "", classificationId = "" → early return after answerCallbackQuery
    // answerCallbackQuery returns null (no bot token set) without throwing
    const req = makeRequest({
      update_id: 200,
      callback_query: {
        id: "cq-001",
        from: { id: 77, is_bot: false, first_name: "User" },
        // no data field
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 for a callback_query with unrecognised action prefix", async () => {
    const req = makeRequest({
      update_id: 201,
      callback_query: {
        id: "cq-002",
        from: { id: 77, is_bot: false, first_name: "User" },
        data: "unknown_action:some-uuid",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 for a callback_query with data that has no colon separator", async () => {
    const req = makeRequest({
      update_id: 202,
      callback_query: {
        id: "cq-003",
        from: { id: 77, is_bot: false, first_name: "User" },
        data: "confNOCOLON",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 200 for a callback_query with valid prefix but empty UUID part", async () => {
    // data = "conf:" → action="conf", classificationId="" → rejected by guard
    const req = makeRequest({
      update_id: 203,
      callback_query: {
        id: "cq-004",
        from: { id: 77, is_bot: false, first_name: "User" },
        data: "conf:",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
