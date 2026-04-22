import "server-only";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { inviteCodes } from "@/lib/db/schema/users";
import { createSupabaseAdminClient } from "@/lib/auth/admin";
import type { InviteCode } from "@/lib/db/schema/users";

// ─── Charset ─────────────────────────────────────────────────────────────────
// Excludes visually ambiguous characters: 0 (zero), O (letter), 1 (one), I (letter)
// Length = 32 = 2^5, so `byte % 32` distributes uniformly across the 256 byte values
// (256 / 32 = 8 exactly — no modulo bias).
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;
const EXPIRY_DAYS = 7;

// Regex derived from CHARSET: A-H, J-N, P-Z (letters minus I and O), 2-9 (digits minus 0 and 1)
const CODE_REGEX = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => CHARSET[b % CHARSET.length]!)
    .join("");
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a new single-use invite code for the given admin user.
 * Requires service_role — call from Server Actions or Route Handlers only.
 */
export async function generateInviteCode(createdBy: string): Promise<InviteCode> {
  // Validate service_role key is present before writing
  createSupabaseAdminClient();

  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(inviteCodes)
    .values({ code, createdBy, expiresAt })
    .returning();

  if (!row) {
    throw new Error("Failed to insert invite code");
  }

  return row;
}

/**
 * Validates an invite code without consuming it.
 * Returns `{ valid: true }` if the code is usable, or `{ valid: false, error }` otherwise.
 */
export async function validateInviteCode(
  rawCode: string
): Promise<{ valid: boolean; error?: string }> {
  const code = normalizeCode(rawCode);

  if (!CODE_REGEX.test(code)) {
    return { valid: false, error: "Invalid invite code format" };
  }

  const [row] = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  if (!row) {
    return { valid: false, error: "Invalid invite code" };
  }

  if (row.isRevoked) {
    return { valid: false, error: "Invite code has been revoked" };
  }

  if (row.usedAt !== null) {
    return { valid: false, error: "Invite code has already been used" };
  }

  return { valid: true };
}

/**
 * Marks an invite code as used by `usedBy` (the new user's UUID).
 * All conditions (not revoked, not used, not expired) are enforced atomically
 * in the WHERE clause — safe against concurrent redemption attempts.
 *
 * Throws if the code is invalid, already used, revoked, or expired.
 */
export async function redeemInviteCode(
  rawCode: string,
  usedBy: string
): Promise<void> {
  const code = normalizeCode(rawCode);

  if (!CODE_REGEX.test(code)) {
    throw new Error("Invalid invite code format");
  }

  const now = new Date();

  const updated = await db
    .update(inviteCodes)
    .set({ usedBy, usedAt: now })
    .where(
      and(
        eq(inviteCodes.code, code),
        eq(inviteCodes.isRevoked, false),
        isNull(inviteCodes.usedAt),
        gt(inviteCodes.expiresAt, now)
      )
    )
    .returning({ id: inviteCodes.id });

  if (updated.length === 0) {
    throw new Error("Invite code is invalid, already used, expired, or revoked");
  }
}
