import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
try { await access(".next/BUILD_ID"); }
catch { console.error("No successful production build; bundle measurements unavailable."); process.exit(1); }
async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collect(path);
    if (!/\.(js|css)$/.test(entry.name)) return [];
    const bytes = await readFile(path); return [{ path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length }];
  })); return groups.flat();
}
const files = await collect(".next/static");
console.log(JSON.stringify({ description: "All emitted static JS/CSS assets, including lazy routes; NOT first-load or wire-transfer size.",
  totals: Object.fromEntries(["js", "css"].map(ext => [ext, files.filter(f => f.path.endsWith(`.${ext}`)).reduce((n, f) => ({ bytes: n.bytes + f.bytes, gzipBytes: n.gzipBytes + f.gzipBytes, files: n.files + 1 }), { bytes: 0, gzipBytes: 0, files: 0 })])),
  largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 10) }, null, 2));
