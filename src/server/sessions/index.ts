import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDatabase } from "../db";
import { sessions } from "../db/schema";

export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function sessionCookieSettings(production = process.env.NODE_ENV === "production") {
  return {
    name: production ? "__Host-lain_session" : "lain_session",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: production,
    path: "/",
  };
}

export type SessionMetadata = { id: string; expiresAt: Date };
export interface SessionStore {
  findByHash(tokenHash: string): Promise<SessionMetadata | null>;
  insert(tokenHash: string, expiresAt: Date): Promise<SessionMetadata>;
}
const fields = { id: sessions.id, expiresAt: sessions.expiresAt };
const postgresStore: SessionStore = {
  async findByHash(tokenHash) {
    const [row] = await getDatabase().select(fields).from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  },
  async insert(tokenHash, expiresAt) {
    const [row] = await getDatabase().insert(sessions).values({ tokenHash, expiresAt }).returning(fields);
    if (!row) throw new Error("Session could not be created.");
    return row;
  },
};
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }

export function createSessionService(store: SessionStore = postgresStore, now = () => new Date()) {
  // Read-only operation for future endpoints that must not create sessions.
  async function getExistingSession(token: string | undefined): Promise<SessionMetadata | null> {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const session = await store.findByHash(hashToken(token));
    if (!session || session.expiresAt.getTime() <= now().getTime()) return null;
    return { id: session.id, expiresAt: session.expiresAt };
  }

  async function getOrCreateSession(token: string | undefined) {
    const existing = await getExistingSession(token);
    if (existing) return { session: existing, newToken: undefined };
    const newToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(now().getTime() + SESSION_LIFETIME_SECONDS * 1000);
    const session = await store.insert(hashToken(newToken), expiresAt);
    return { session: { id: session.id, expiresAt: session.expiresAt }, newToken };
  }
  return { getExistingSession, getOrCreateSession };
}
