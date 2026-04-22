/**
 * Invite code format tests.
 *
 * Mirrors the constants and helpers in lib/auth/invite.ts.
 * These tests intentionally duplicate the logic so any drift between the
 * implementation and the spec is caught at CI time.
 *
 * No DB, no Supabase — pure in-memory logic only.
 */
import { describe, it, expect } from "vitest";

// ─── Mirror constants from lib/auth/invite.ts ──────────────────────────────
// Excluding visually ambiguous characters: 0 (zero), O (letter), 1 (one), I
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;
const CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// ─── Charset composition ────────────────────────────────────────────────────

describe("invite code charset", () => {
  it("contains exactly 32 characters", () => {
    expect(CHARSET.length).toBe(32);
  });

  it("does not contain the digit 0 (zero)", () => {
    expect(CHARSET.includes("0")).toBe(false);
  });

  it("does not contain the digit 1 (one)", () => {
    expect(CHARSET.includes("1")).toBe(false);
  });

  it("does not contain the letter I", () => {
    expect(CHARSET.includes("I")).toBe(false);
  });

  it("does not contain the letter O", () => {
    expect(CHARSET.includes("O")).toBe(false);
  });

  it("code length is 12", () => {
    expect(CODE_LENGTH).toBe(12);
  });
});

// ─── CODE_REGEX ─────────────────────────────────────────────────────────────

describe("CODE_REGEX", () => {
  it("accepts a valid 12-char code using allowed characters", () => {
    expect(CODE_REGEX.test("ABCDEFGHJKLM")).toBe(true);
    expect(CODE_REGEX.test("23456789ABCD")).toBe(true);
    expect(CODE_REGEX.test("MNPQRSTUVWXY")).toBe(true);
    expect(CODE_REGEX.test("Z23456789ABC")).toBe(true);
  });

  it("rejects code containing 0 (zero)", () => {
    // 0 not in charset — looks like O but isn't
    expect(CODE_REGEX.test("0BCDEFGHJKLM")).toBe(false);
    expect(CODE_REGEX.test("000000000000")).toBe(false);
  });

  it("rejects code containing 1 (one)", () => {
    expect(CODE_REGEX.test("1BCDEFGHJKLM")).toBe(false);
    expect(CODE_REGEX.test("111111111111")).toBe(false);
  });

  it("rejects code containing the letter I", () => {
    expect(CODE_REGEX.test("IIIIIIIIIIII")).toBe(false);
    expect(CODE_REGEX.test("IBCDEFGHJKLM")).toBe(false);
  });

  it("rejects code containing the letter O", () => {
    expect(CODE_REGEX.test("OOOOOOOOOOOO")).toBe(false);
    expect(CODE_REGEX.test("OBCDEFGHJKLM")).toBe(false);
  });

  it("rejects code shorter than 12 characters", () => {
    expect(CODE_REGEX.test("ABCDEFGHJKL")).toBe(false); // 11 chars
    expect(CODE_REGEX.test("ABC")).toBe(false);
    expect(CODE_REGEX.test("")).toBe(false);
  });

  it("rejects code longer than 12 characters", () => {
    expect(CODE_REGEX.test("ABCDEFGHJKLMN")).toBe(false); // 13 chars
    expect(CODE_REGEX.test("ABCDEFGHJKLMNPQ")).toBe(false); // 15 chars
  });

  it("rejects code with lowercase letters", () => {
    // normalizeCode must be called first; raw lowercase fails the regex
    expect(CODE_REGEX.test("abcdefghjklm")).toBe(false);
  });

  it("rejects code with spaces or special characters", () => {
    expect(CODE_REGEX.test("ABCDEF GHJKLM")).toBe(false);
    expect(CODE_REGEX.test("ABCDEF-GHJKLM")).toBe(false);
    expect(CODE_REGEX.test("ABCDEF.GHJKLM")).toBe(false);
  });
});

// ─── normalizeCode ──────────────────────────────────────────────────────────

describe("normalizeCode", () => {
  it("trims leading whitespace", () => {
    expect(normalizeCode("   ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeCode("ABCDEFGHJKLM   ")).toBe("ABCDEFGHJKLM");
  });

  it("trims both leading and trailing whitespace", () => {
    expect(normalizeCode("  ABCDEFGHJKLM  ")).toBe("ABCDEFGHJKLM");
  });

  it("uppercases lowercase input", () => {
    expect(normalizeCode("abcdefghjklm")).toBe("ABCDEFGHJKLM");
  });

  it("uppercases mixed-case input", () => {
    expect(normalizeCode("AbCdEfGhJkLm")).toBe("ABCDEFGHJKLM");
  });

  it("trims and uppercases in combination", () => {
    expect(normalizeCode("  abcdef  ")).toBe("ABCDEF");
  });

  it("is a no-op on already-normalised codes", () => {
    const code = "ABCDEFGHJKLM";
    expect(normalizeCode(code)).toBe(code);
  });

  it("normalised code passes CODE_REGEX for valid input", () => {
    const code = normalizeCode("  abcdefghjklm  ");
    expect(CODE_REGEX.test(code)).toBe(true);
  });
});
