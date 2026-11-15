import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."), output = mkdtempSync(join(tmpdir(), "lain-cloud-voice-tests-"));
const files = ["server.test", "client.test", "chat.test", "chat-server.test", "design.test", "progressive.test"];
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node", "--esModuleInterop", "--resolveJsonModule", "--strict", "--skipLibCheck", "--rootDir", root, "--outDir", output, ...files.map(file => join(root, `tests/cloud-voice/${file}.ts`))], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--conditions=react-server", "--test", "--test-isolation=none", ...files.map(file => join(output, `tests/cloud-voice/${file}.js`))], { cwd: root, stdio: "inherit" });
} catch { process.exitCode = 1; }
finally { rmSync(output, { recursive: true, force: true }); }
