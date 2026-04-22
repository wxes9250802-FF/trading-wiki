import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/lib/auth/invite";

// ─── Basic rate limiting ──────────────────────────────────────────────────────
// In-memory only — doesn't persist across serverless cold starts or multiple
// instances. Good enough for development; replace with Upstash / Redis for prod.

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // max 10 validate attempts per IP per minute

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false; // not limited
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true; // limited
  }

  entry.count++;
  return false;
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  if (checkRateLimit(ip)) {
    return NextResponse.json(
      {
        valid: false,
        error: "Too many requests. Please wait before trying again.",
      },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { valid: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const raw = (body as Record<string, unknown>)["code"];
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";

  if (!code) {
    return NextResponse.json(
      { valid: false, error: "Invite code is required" },
      { status: 400 }
    );
  }

  const result = await validateInviteCode(code);
  // Always return 200 — the `valid` field carries the result.
  // 4xx would let an attacker distinguish "bad format" from "valid format but wrong code".
  return NextResponse.json(result);
}
