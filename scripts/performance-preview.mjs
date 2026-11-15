// Isolate performance runs from existing development servers, credentials and DBs.
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..'), preview = mkdtempSync('/tmp/lain-6c-preview-');
for (const path of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts']) cpSync(join(root, path), join(preview, path), { recursive: true });
writeFileSync(join(preview, 'next.config.ts'), readFileSync(join(preview, 'next.config.ts'), 'utf8').replace('turbopack: {', 'turbopack: { root: "/",'));
mkdirSync(join(preview, 'docs/references'), { recursive: true });
cpSync(join(root, 'docs/references/lain-voice-preset.json'), join(preview, 'docs/references/lain-voice-preset.json'));
symlinkSync(join(root, 'node_modules'), join(preview, 'node_modules'), 'dir');
writeFileSync('/tmp/lain-6c-preview-path', preview);
const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3160'], { cwd: preview, stdio: 'inherit', env: { ...process.env, OPENAI_API_KEY: '', DATABASE_URL: '', LAIN_AI_MODE: 'mock' } });
console.log(`Isolated preview ${preview}, PID ${server.pid}`);
writeFileSync('/tmp/lain-6c-preview-pid', String(server.pid));
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.kill(event));
server.on('exit', code => { process.exitCode = code ?? 0; });
