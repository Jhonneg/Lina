import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import nextEnv from "@next/env";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(root);
const database = `lain_stream_it_${randomBytes(8).toString("hex")}`;
let admin;
let output;
let created = false;
try {
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      (url.port || "5432") !== "5432" || url.pathname !== "/lain_dev") {
    throw new Error("Expected local Compose configuration");
  }
  const maintenance = new URL(url); maintenance.pathname = "/postgres";
  admin = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await admin.connect();
  // Only this randomly named, newly created database can be mutated or removed.
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  url.pathname = `/${database}`;
  console.log(`Disposable integration database: ${database}`);
  output = mkdtempSync(join(tmpdir(), "lain-stream-postgres-"));
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--rootDir", root,
    "--outDir", output, join(root, "tests/server/persisted-stream.postgres.test.ts"),
  ], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, [
    "--conditions=react-server", "--test", "--test-isolation=none",
    join(output, "tests/server/persisted-stream.postgres.test.js"),
  ], {
    cwd: root, stdio: "inherit", timeout: 60_000,
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.toString(), LAIN_AI_MODE: "mock",
      OPENAI_API_KEY: "", OPENAI_MODEL: "", LAIN_STREAM_INTEGRATION_DATABASE: database },
  });
} catch {
  console.error("Streaming persistence PostgreSQL verification failed; private database details withheld.");
  process.exitCode = 1;
} finally {
  if (output) rmSync(output, { recursive: true, force: true });
  if (created) {
    try {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      console.log(`Removed disposable integration database: ${database}`);
    } catch {
      console.error(`Could not remove disposable integration database: ${database}`);
      process.exitCode = 1;
    }
  }
  await admin?.end().catch(() => {});
}
