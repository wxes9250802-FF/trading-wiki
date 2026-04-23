-- Manual migration: create pending_sells for the interactive /sell flow.
-- Apply via Supabase SQL Editor (Database → SQL Editor) or drizzle-kit push
-- when network connectivity to 6543/5432 is available.

CREATE TABLE IF NOT EXISTS "pending_sells" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "symbol" text NOT NULL,
  "price" numeric(14, 4) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "pending_sells"
    ADD CONSTRAINT "pending_sells_user_id_user_profiles_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
