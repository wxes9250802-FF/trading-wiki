-- =============================================================================
-- Trading Intelligence Hub — Initial Schema
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- =============================================================================

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "public"."market" AS ENUM('TW', 'US', 'CRYPTO');
CREATE TYPE "public"."sentiment" AS ENUM('bullish', 'bearish', 'neutral');
CREATE TYPE "public"."verification_result" AS ENUM('pending', 'hit', 'miss');

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE "tips" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_user_id"    bigint NOT NULL,
  "telegram_chat_id"    bigint NOT NULL,
  "telegram_message_id" bigint NOT NULL,
  "raw_text"            text NOT NULL,
  "ticker"              text,
  "market"              "market",
  "sentiment"           "sentiment",
  "summary"             text,
  "target_price"        numeric(14, 4),
  "confidence"          integer,
  "source_label"        text,
  "ai_classified"       boolean DEFAULT false NOT NULL,
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"          timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tip_verifications" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tip_id"         uuid NOT NULL REFERENCES "tips"("id") ON DELETE cascade,
  "check_days"     integer NOT NULL,
  "price_at_tip"   numeric(14, 4),
  "price_at_check" numeric(14, 4),
  "result"         "verification_result" DEFAULT 'pending' NOT NULL,
  "checked_at"     timestamp with time zone,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Fast lookup by ticker for daily briefing queries
CREATE INDEX idx_tips_ticker ON tips(ticker) WHERE ticker IS NOT NULL;
-- Fast lookup for unclassified tips (T6 AI worker picks these up)
CREATE INDEX idx_tips_unclassified ON tips(created_at) WHERE ai_classified = false;
-- Time-ordered listing for dashboard
CREATE INDEX idx_tips_created_at ON tips(created_at DESC);
-- Verification worker: find pending checks that are due
CREATE INDEX idx_verifications_pending ON tip_verifications(tip_id) WHERE result = 'pending';

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tips_updated_at
  BEFORE UPDATE ON tips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE tips             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tip_verifications ENABLE ROW LEVEL SECURITY;

-- ANON key (web dashboard): read-only
CREATE POLICY "anon can read tips"
  ON tips FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon can read verifications"
  ON tip_verifications FOR SELECT
  TO anon
  USING (true);

-- authenticated role (future: user-specific filtering can be added here)
CREATE POLICY "authenticated can read tips"
  ON tips FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated can read verifications"
  ON tip_verifications FOR SELECT
  TO authenticated
  USING (true);

-- service_role bypasses RLS automatically — no policy needed for writes.
-- Bot webhook + GitHub Actions workers use service_role key.
