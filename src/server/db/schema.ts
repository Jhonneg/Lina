import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, jsonb, index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const messageStatus = pgEnum("message_status", ["completed", "interrupted", "failed", "pending"]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique("sessions_token_hash_unique"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("sessions_expires_at_idx").on(table.expiresAt)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("conversations_session_updated_idx").on(table.sessionId, table.updatedAt.desc(), table.id)]);

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  status: messageStatus("status").notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt, table.id)]);

export const streamRequestState = pgEnum("stream_request_state", ["running", "completed", "interrupted", "failed"]);
export const streamRequests = pgTable("stream_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id").notNull().unique().references(() => messages.id, { onDelete: "cascade" }),
  assistantMessageId: uuid("assistant_message_id").notNull().unique().references(() => messages.id, { onDelete: "cascade" }),
  state: streamRequestState("state").notNull().default("running"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [unique("stream_requests_session_request_unique").on(table.sessionId, table.requestId)]);


export const usageKind = pgEnum("usage_kind", ["text", "speech"]);
export const usageState = pgEnum("usage_state", ["reserved", "settled", "uncertain", "voided"]);
export const usageReservations = pgTable("usage_reservations", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  requestId: uuid("request_id").notNull(), kind: usageKind("kind").notNull(), segment: integer("segment").notNull().default(0),
  fingerprint: text("fingerprint").notNull(), ipHash: text("ip_hash"), model: text("model").notNull(),
  pricing: jsonb("pricing").$type<{ input: number; cached: number; output: number; audio: number }>().notNull(),
  reservedMicro: bigint("reserved_micro", { mode: "number" }).notNull(),
  chargedMicro: bigint("charged_micro", { mode: "number" }).notNull(),
  actualUsage: jsonb("actual_usage").$type<{ input: number; cached: number; output: number; audio: number }>(),
  state: usageState("state").notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }), finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  unique("usage_session_request_segment_unique").on(table.sessionId, table.kind, table.requestId, table.segment),
  index("usage_session_created_idx").on(table.sessionId, table.kind, table.createdAt),
  index("usage_ip_created_idx").on(table.ipHash, table.createdAt),
  index("usage_created_idx").on(table.createdAt), index("usage_active_idx").on(table.state, table.leaseUntil),
  check("usage_nonnegative_cost", sql`${table.reservedMicro} >= 0 AND ${table.chargedMicro} >= 0`),
  check("usage_segment_bounds", sql`${table.segment} >= 0 AND ${table.segment} <= 2`),
]);
export const usageUtterances = pgTable("usage_utterances", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }), requestId: uuid("request_id").notNull(),
  progressive: boolean("progressive").notNull(), nextSegment: integer("next_segment").notNull().default(0),
  chars: integer("chars").notNull().default(0), generationMs: integer("generation_ms").notNull().default(0),
  audioBytes: integer("audio_bytes").notNull().default(0), closed: boolean("closed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [unique("usage_utterance_session_request_unique").on(table.sessionId, table.requestId),
  check("usage_utterance_bounds", sql`${table.chars} >= 0 AND ${table.chars} <= 800 AND ${table.nextSegment} BETWEEN 0 AND 3 AND ${table.generationMs} >= 0 AND ${table.audioBytes} >= 0`)]);


// Fixed-window counters, not one row per request. No raw IPs, cookies or content.
export const apiRateBuckets = pgTable("api_rate_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("api_rate_expiry_idx").on(table.expiresAt), check("api_rate_count_positive", sql`${table.count} > 0`)]);
