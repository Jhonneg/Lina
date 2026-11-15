import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."), output = mkdtempSync(join(tmpdir(), "lain-session-cleanup-"));
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--target", "ES2022", "--module", "Node16", "--moduleResolution", "Node16",
    "--esModuleInterop", "--strict", "--skipLibCheck", "--rootDir", root, "--outDir", output, join(root, "src/server/abuse/cleanup-cli.ts")], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--conditions=react-server", join(output, "src/server/abuse/cleanup-cli.js"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
} catch { process.exitCode = 1; }
finally { rmSync(output, { recursive: true, force: true }); }
