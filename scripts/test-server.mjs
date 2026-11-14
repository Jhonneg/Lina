import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = mkdtempSync(join(tmpdir(), "lain-server-tests-"));
try {
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "commonjs", "--moduleResolution", "node",
    "--jsx", "react-jsx", "--esModuleInterop", "--strict", "--skipLibCheck", "--rootDir", root,
    "--outDir", output, join(root, "node_modules/next/types/global.d.ts"), join(root, "tests/server/chat.test.ts"), join(root, "tests/server/chat-stream.test.ts"), join(root, "tests/chat/chat-stream.test.ts"), join(root, "tests/db/schema.test.ts"), join(root, "tests/sessions/session.test.ts"), join(root, "tests/conversations/storage.test.ts"), join(root, "tests/server/persisted-stream.test.ts"), join(root, "tests/chat/chat-persistence.test.ts"), join(root, "tests/chat/chat-history.test.ts"), join(root, "tests/conversations/management.test.ts"), join(root, "tests/chat/chat-management.test.ts"), join(root, "tests/server/personality.test.ts"), join(root, "tests/chat/markdown.test.tsx"),
  ], { cwd: root, stdio: "inherit" });
  symlinkSync(join(root, "node_modules"), join(output, "node_modules"), "dir");
  execFileSync(process.execPath, ["--conditions=react-server", "--test", "--test-isolation=none", join(output, "tests/server/chat.test.js"), join(output, "tests/server/chat-stream.test.js"), join(output, "tests/chat/chat-stream.test.js"), join(output, "tests/db/schema.test.js"), join(output, "tests/sessions/session.test.js"), join(output, "tests/conversations/storage.test.js"), join(output, "tests/server/persisted-stream.test.js"), join(output, "tests/chat/chat-persistence.test.js"), join(output, "tests/chat/chat-history.test.js"), join(output, "tests/conversations/management.test.js"), join(output, "tests/chat/chat-management.test.js"), join(output, "tests/server/personality.test.js")], {
    cwd: root, stdio: "inherit",
  });
  // Render UI tests with normal React, separately from server-only module tests.
  // CSS modules are class-name stubs here; the browser workflow verifies styling.
  for (const file of ["chat.module.css", "markdown.module.css"]) {
    writeFileSync(join(output, "src/components/chat", file), "");
  }
  const cssSetup = join(output, "ui-test-setup.cjs");
  writeFileSync(cssSetup, 'require.extensions[".css"] = module => { module.exports = new Proxy({}, { get: (_, key) => key === "__esModule" ? false : String(key) }); };');
  execFileSync(process.execPath, ["--require", cssSetup, "--test", "--test-isolation=none", join(output, "tests/chat/markdown.test.js")], {
    cwd: root, stdio: "inherit",
  });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
