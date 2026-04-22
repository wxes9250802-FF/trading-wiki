// Force Node.js runtime — required for Drizzle (postgres-js uses net.Socket).
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/server";
import { createSupabaseAdminClient } from "@/lib/auth/admin";
import { db } from "@/lib/db/client";
import { userProfiles, inviteCodes } from "@/lib/db/schema/users";
import { eq, and, isNull, gt } from "drizzle-orm";
import { safeRedirect } from "@/lib/utils/safe-redirect";

/**
 * Delete an orphaned auth user so they cannot retry a different code path.
 * Non-fatal: if the service_role key is absent or the call fails, we log
 * and continue — an orphaned auth user is less bad than blocking the flow.
 */
async function tryDeleteAuthUser(userId: string): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    await admin.auth.admin.deleteUser(userId);
  } catch {
    // Intentionally ignored — orphaned auth users are handled by Supabase's
    // account cleanup policy. Log here if you add a structured logger.
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const next = safeRedirect(searchParams.get("next"));
  // Normalise invite code the same way validateInviteCode / redeemInviteCode do.
  const inviteCode =
    searchParams.get("invite_code")?.trim().toUpperCase() ?? null;

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/auth/login?error=auth_failed`);
  }

  const userId = data.user.id;

  // ── Determine whether this is a first-time registration ──────────────────
  const [existingProfile] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId))
    .limit(1);

  const isNewUser = !existingProfile;

  if (isNewUser) {
    // New users MUST arrive via /auth/signup with a valid invite code.
    if (!inviteCode) {
      await tryDeleteAuthUser(userId);
      return NextResponse.redirect(
        `${origin}/auth/signup?error=invite_required`
      );
    }

    // ── Atomic: create profile + redeem invite in one transaction ────────────
    // If either step fails the whole transaction rolls back and we delete the
    // auth user so the email address is freed for a clean retry.
    try {
      await db.transaction(async (tx) => {
        // 1. Insert the user profile row
        await tx
          .insert(userProfiles)
          .values({ id: userId, role: "member" })
          .onConflictDoNothing(); // idempotent — safe if called twice somehow

        // 2. Redeem the invite code atomically.
        //    All validity conditions (not revoked, not used, not expired) live
        //    in the WHERE clause so concurrent redemption attempts are rejected.
        const now = new Date();
        const updated = await tx
          .update(inviteCodes)
          .set({ usedBy: userId, usedAt: now })
          .where(
            and(
              eq(inviteCodes.code, inviteCode),
              eq(inviteCodes.isRevoked, false),
              isNull(inviteCodes.usedAt),
              gt(inviteCodes.expiresAt, now)
            )
          )
          .returning({ id: inviteCodes.id });

        if (updated.length === 0) {
          // Throw to trigger transaction rollback
          throw new Error("invite_invalid");
        }
      });
    } catch (err) {
      // Transaction rolled back — remove the auth user for a clean retry
      await tryDeleteAuthUser(userId);
      const errMsg = err instanceof Error ? err.message : "invite_invalid";
      return NextResponse.redirect(
        `${origin}/auth/signup?error=${encodeURIComponent(errMsg)}`
      );
    }
  }

  // Existing user: profile already exists, no invite needed.
  // The session cookie is already set by exchangeCodeForSession above.

  return NextResponse.redirect(`${origin}${next}`);
}
