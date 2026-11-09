import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = mkdtempSync(join(tmpdir(), "lain-server-tests-"));
try {
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--rootDir", root,
    "--outDir", output, join(root, "tests/server/chat.test.ts"), join(root, "tests/server/chat-stream.test.ts"),
  ], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--conditions=react-server", "--test", "--test-isolation=none", join(output, "tests/server/chat.test.js"), join(output, "tests/server/chat-stream.test.js")], {
    cwd: root, stdio: "inherit",
  });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
