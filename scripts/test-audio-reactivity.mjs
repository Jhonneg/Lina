import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."), output = mkdtempSync(join(tmpdir(), "lain-audio-tests-"));
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--rootDir", root, "--outDir", output, join(root, "tests/audio/reactivity.test.ts")], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--test", "--test-isolation=none", join(output, "tests/audio/reactivity.test.js")], { cwd: root, stdio: "inherit" });
} catch { process.exitCode = 1; }
finally { rmSync(output, { recursive: true, force: true }); }
