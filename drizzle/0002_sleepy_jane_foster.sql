CREATE TYPE "public"."usage_kind" AS ENUM('text', 'speech');--> statement-breakpoint
CREATE TYPE "public"."usage_state" AS ENUM('reserved', 'settled', 'uncertain', 'voided');--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"request_id" uuid NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"segment" integer DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"ip_hash" text,
	"model" text NOT NULL,
	"pricing" jsonb NOT NULL,
	"reserved_micro" bigint NOT NULL,
	"charged_micro" bigint NOT NULL,
	"actual_usage" jsonb,
	"state" "usage_state" DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "usage_session_request_segment_unique" UNIQUE("session_id","kind","request_id","segment"),
	CONSTRAINT "usage_nonnegative_cost" CHECK ("usage_reservations"."reserved_micro" >= 0 AND "usage_reservations"."charged_micro" >= 0),
	CONSTRAINT "usage_segment_bounds" CHECK ("usage_reservations"."segment" >= 0 AND "usage_reservations"."segment" <= 2)
);
--> statement-breakpoint
CREATE TABLE "usage_utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"request_id" uuid NOT NULL,
	"progressive" boolean NOT NULL,
	"next_segment" integer DEFAULT 0 NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"generation_ms" integer DEFAULT 0 NOT NULL,
	"audio_bytes" integer DEFAULT 0 NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_utterance_session_request_unique" UNIQUE("session_id","request_id"),
	CONSTRAINT "usage_utterance_bounds" CHECK ("usage_utterances"."chars" >= 0 AND "usage_utterances"."chars" <= 800 AND "usage_utterances"."next_segment" BETWEEN 0 AND 3 AND "usage_utterances"."generation_ms" >= 0 AND "usage_utterances"."audio_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_utterances" ADD CONSTRAINT "usage_utterances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_session_created_idx" ON "usage_reservations" USING btree ("session_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "usage_ip_created_idx" ON "usage_reservations" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "usage_reservations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_active_idx" ON "usage_reservations" USING btree ("state","lease_until");