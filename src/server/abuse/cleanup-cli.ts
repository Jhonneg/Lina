import { loadEnvConfig } from "@next/env";
import { cleanupExpiredSessions } from "./cleanup";
import { getDatabase } from "../db";
loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply") || args.length > 1) throw Error("Invalid arguments");
  console.log(JSON.stringify(await cleanupExpiredSessions({ apply: args.includes("--apply") })));
}
void main().catch(() => { console.error("Session cleanup failed; database details withheld."); process.exitCode = 1; })
  .finally(async () => { try { await getDatabase().$client.end(); } catch { /* No configured connection. */ } });
