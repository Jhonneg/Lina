CREATE TABLE "api_rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_rate_count_positive" CHECK ("api_rate_buckets"."count" > 0)
);
--> statement-breakpoint
CREATE INDEX "api_rate_expiry_idx" ON "api_rate_buckets" USING btree ("expires_at");