CREATE TYPE "public"."stream_request_state" AS ENUM('running', 'completed', 'interrupted', 'failed');--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'pending';--> statement-breakpoint
CREATE TABLE "stream_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"state" "stream_request_state" DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "stream_requests_user_message_id_unique" UNIQUE("user_message_id"),
	CONSTRAINT "stream_requests_assistant_message_id_unique" UNIQUE("assistant_message_id"),
	CONSTRAINT "stream_requests_session_request_unique" UNIQUE("session_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "stream_requests" ADD CONSTRAINT "stream_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_requests" ADD CONSTRAINT "stream_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_requests" ADD CONSTRAINT "stream_requests_user_message_id_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_requests" ADD CONSTRAINT "stream_requests_assistant_message_id_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;