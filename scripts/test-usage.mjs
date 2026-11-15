import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."), output = mkdtempSync(join(tmpdir(), "lain-usage-tests-"));
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node", "--esModuleInterop", "--resolveJsonModule", "--strict", "--skipLibCheck", "--rootDir", root, "--outDir", output, join(root, "tests/usage/policy.test.ts")], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--conditions=react-server", "--test", "--test-isolation=none", join(output, "tests/usage/policy.test.js")], { cwd: root, stdio: "inherit" });
} catch { process.exitCode = 1; }
finally { rmSync(output, { recursive: true, force: true }); }
