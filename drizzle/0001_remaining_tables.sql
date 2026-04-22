-- =============================================================================
-- Trading Intelligence Hub — Remaining Tables (T2 supplement)
-- Run AFTER 0000_setup.sql in Supabase SQL Editor
-- =============================================================================

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');
CREATE TYPE "public"."exchange" AS ENUM('TWSE', 'TPEx', 'NYSE', 'NASDAQ', 'CRYPTO', 'OTHER');
CREATE TYPE "public"."raw_message_status" AS ENUM('pending', 'processing', 'done', 'failed', 'ignored');

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE "user_profiles" (
  "id"              uuid PRIMARY KEY,          -- mirrors auth.users.id
  "telegram_id"     bigint,
  "display_name"    text,
  "role"            "user_role" DEFAULT 'member' NOT NULL,
  "allowlist_level" "user_role" DEFAULT 'member' NOT NULL,
  "invited_by"      uuid,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invite_codes" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code"        text NOT NULL,
  "created_by"  uuid NOT NULL,
  "used_by"     uuid,
  "expires_at"  timestamp with time zone NOT NULL,
  "used_at"     timestamp with time zone,
  "is_revoked"  boolean DEFAULT false NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
);

CREATE TABLE "tickers" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "symbol"       text NOT NULL,
  "name"         text NOT NULL,
  "exchange"     "exchange" NOT NULL,
  "aliases"      text,
  "last_updated" timestamp with time zone DEFAULT now() NOT NULL,
  "delisted_at"  timestamp with time zone,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tickers_symbol_unique" UNIQUE("symbol")
);

CREATE TABLE "raw_messages" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "telegram_update_id"   bigint NOT NULL,
  "telegram_user_id"     bigint NOT NULL,
  "telegram_chat_id"     bigint NOT NULL,
  "telegram_message_id"  bigint NOT NULL,
  "message_text"         text NOT NULL,
  "message_date"         timestamp with time zone NOT NULL,
  "status"               "raw_message_status" DEFAULT 'pending' NOT NULL,
  "truncated"            boolean DEFAULT false NOT NULL,
  "ai_tip_id"            uuid,
  "retry_count"          integer DEFAULT 0 NOT NULL,
  "created_at"           timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"           timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "raw_messages_telegram_update_id_unique" UNIQUE("telegram_update_id")
);

CREATE TABLE "ai_classifications" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "raw_message_id"   uuid NOT NULL,
  "tip_id"           uuid,
  "model"            text NOT NULL,
  "prompt_version"   text NOT NULL,
  "input_tokens"     integer NOT NULL,
  "output_tokens"    integer NOT NULL,
  "raw_response"     json,
  "user_confirmed"   boolean,
  "error"            text,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "tip_tickers" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tip_id"       uuid NOT NULL,
  "symbol"       text NOT NULL,
  "sentiment"    "sentiment" NOT NULL,
  "target_price" numeric(14, 4),
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL
);

-- ─── Foreign Keys ─────────────────────────────────────────────────────────────

-- user_profiles → Supabase auth.users (cascade delete when user is removed)
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_id_auth_users_fk"
  FOREIGN KEY ("id") REFERENCES auth.users("id") ON DELETE cascade;

-- user_profiles self-reference (invite chain)
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_invited_by_fk"
  FOREIGN KEY ("invited_by") REFERENCES "user_profiles"("id") ON DELETE set null;

-- invite_codes → user_profiles
ALTER TABLE "invite_codes"
  ADD CONSTRAINT "invite_codes_created_by_fk"
  FOREIGN KEY ("created_by") REFERENCES "user_profiles"("id") ON DELETE cascade;
ALTER TABLE "invite_codes"
  ADD CONSTRAINT "invite_codes_used_by_fk"
  FOREIGN KEY ("used_by") REFERENCES "user_profiles"("id") ON DELETE set null;

-- ai_classifications → raw_messages + tips
ALTER TABLE "ai_classifications"
  ADD CONSTRAINT "ai_classifications_raw_message_id_fk"
  FOREIGN KEY ("raw_message_id") REFERENCES "raw_messages"("id") ON DELETE cascade;
ALTER TABLE "ai_classifications"
  ADD CONSTRAINT "ai_classifications_tip_id_fk"
  FOREIGN KEY ("tip_id") REFERENCES "tips"("id") ON DELETE set null;

-- tip_tickers → tips
ALTER TABLE "tip_tickers"
  ADD CONSTRAINT "tip_tickers_tip_id_fk"
  FOREIGN KEY ("tip_id") REFERENCES "tips"("id") ON DELETE cascade;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- user_profiles: fast lookup by telegram_id (bot allowlist check per message)
CREATE UNIQUE INDEX idx_user_profiles_telegram_id
  ON user_profiles(telegram_id) WHERE telegram_id IS NOT NULL;

-- tickers: symbol is already unique; extra index for partial match / alias search
CREATE INDEX idx_tickers_exchange ON tickers(exchange);
CREATE INDEX idx_tickers_active ON tickers(symbol) WHERE delisted_at IS NULL;

-- raw_messages: worker picks up pending messages ordered by created_at
CREATE INDEX idx_raw_messages_pending
  ON raw_messages(created_at) WHERE status = 'pending';

-- ai_classifications: admin cost dashboard groups by day
CREATE INDEX idx_ai_classifications_created_at ON ai_classifications(created_at DESC);

-- tip_tickers: lookup all tips mentioning a symbol
CREATE INDEX idx_tip_tickers_symbol ON tip_tickers(symbol);

-- ─── updated_at triggers ──────────────────────────────────────────────────────

-- set_updated_at() function already created in 0000_setup.sql

CREATE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER raw_messages_updated_at
  BEFORE UPDATE ON raw_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE user_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tip_tickers      ENABLE ROW LEVEL SECURITY;

-- user_profiles: users can only read/update their own row
CREATE POLICY "users can read own profile"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- tickers: public read (ticker resolver + web dashboard)
CREATE POLICY "anon can read tickers"
  ON tickers FOR SELECT TO anon USING (true);
CREATE POLICY "authenticated can read tickers"
  ON tickers FOR SELECT TO authenticated USING (true);

-- tip_tickers: public read
CREATE POLICY "anon can read tip_tickers"
  ON tip_tickers FOR SELECT TO anon USING (true);
CREATE POLICY "authenticated can read tip_tickers"
  ON tip_tickers FOR SELECT TO authenticated USING (true);

-- raw_messages, ai_classifications, invite_codes: service_role only
-- (service_role bypasses RLS automatically — no explicit policy needed for writes)
-- Add read policy for admin dashboard (authenticated with role='admin')
CREATE POLICY "admin can read raw_messages"
  ON raw_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admin can read ai_classifications"
  ON ai_classifications FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
