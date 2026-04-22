CREATE TYPE "public"."market" AS ENUM('TW', 'US', 'CRYPTO');--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('bullish', 'bearish', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."verification_result" AS ENUM('pending', 'hit', 'miss');--> statement-breakpoint
CREATE TABLE "tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"raw_text" text NOT NULL,
	"ticker" text,
	"market" "market",
	"sentiment" "sentiment",
	"summary" text,
	"target_price" numeric(14, 4),
	"confidence" integer,
	"source_label" text,
	"ai_classified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tip_id" uuid NOT NULL,
	"check_days" integer NOT NULL,
	"price_at_tip" numeric(14, 4),
	"price_at_check" numeric(14, 4),
	"result" "verification_result" DEFAULT 'pending' NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tip_verifications" ADD CONSTRAINT "tip_verifications_tip_id_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."tips"("id") ON DELETE cascade ON UPDATE no action;