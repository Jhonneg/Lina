import "server-only";
import { getDatabase } from "../db";
import { abusePolicy } from "./policy";
import { runSessionCleanup } from "./cleanup-core";

export async function cleanupExpiredSessions({ apply = false } = {}, database = getDatabase, policyFactory = abusePolicy) {
  return runSessionCleanup(database, policyFactory(), apply);
}
