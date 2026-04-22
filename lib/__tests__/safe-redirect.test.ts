import { describe, it, expect } from "vitest";
import { safeRedirect } from "@/lib/utils/safe-redirect";

describe("safeRedirect", () => {
  // ── Rejects unsafe values ──────────────────────────────────────────────────

  it("returns / for null", () => {
    expect(safeRedirect(null)).toBe("/");
  });

  it("returns / for undefined", () => {
    expect(safeRedirect(undefined)).toBe("/");
  });

  it("returns / for empty string", () => {
    expect(safeRedirect("")).toBe("/");
  });

  it("returns / for an external http URL", () => {
    expect(safeRedirect("http://evil.com")).toBe("/");
  });

  it("returns / for an external https URL", () => {
    expect(safeRedirect("https://evil.com/steal?token=abc")).toBe("/");
  });

  it("returns / for a protocol-relative URL (//)", () => {
    expect(safeRedirect("//evil.com")).toBe("/");
  });

  it("returns / for a string that starts with // after trimming would pass", () => {
    // Even if prefixed with //, it must be rejected outright
    expect(safeRedirect("//evil.com/path")).toBe("/");
  });

  it("returns / for a bare hostname with no scheme", () => {
    expect(safeRedirect("evil.com/path")).toBe("/");
  });

  // ── Accepts safe internal paths ────────────────────────────────────────────

  it("returns the path for a root redirect", () => {
    expect(safeRedirect("/")).toBe("/");
  });

  it("returns the path for a simple internal path", () => {
    expect(safeRedirect("/dashboard")).toBe("/dashboard");
  });

  it("returns the path for a nested internal path", () => {
    expect(safeRedirect("/settings/profile")).toBe("/settings/profile");
  });

  it("preserves query strings on internal paths", () => {
    expect(safeRedirect("/auth/login?next=/dashboard")).toBe(
      "/auth/login?next=/dashboard"
    );
  });

  it("preserves hash fragments on internal paths", () => {
    expect(safeRedirect("/docs#section-2")).toBe("/docs#section-2");
  });
});
