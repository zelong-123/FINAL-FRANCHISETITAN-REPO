// Fails when a relative import's letter case does not match the file on disk. Windows and macOS
// ignore case, so `import './AuthCard'` finds Authcard.jsx locally, but Linux (CI, Vercel) does not
// and the build breaks. Run in CI before the tests:  npm run check:imports
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOTS = ['src', 'supabase/functions', 'supabase/scripts', 'tests', 'tools'];
const CODE = /\.(m?js|jsx|ts|tsx)$/;
const EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
const SKIP = new Set(['node_modules', 'dist', '.git']);
const root = process.cwd();

const listing = new Map();
const entries = (dir) => {
  if (!listing.has(dir)) { try { listing.set(dir, readdirSync(dir)); } catch { listing.set(dir, null); } }
  return listing.get(dir);
};
const walk = (dir) => (entries(dir) ?? []).flatMap((name) => {
  if (SKIP.has(name)) return [];
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : CODE.test(name) ? [full] : [];
});

/** The exact-case path, or null; `found` tells whether it exists ignoring case. */
function exactCase(absolute) {
  const parts = relative(root, absolute).split(sep);
  let dir = root;
  let wrong = null;
  for (const part of parts) {
    const names = entries(dir);
    if (!names) return { exists: false };
    if (!names.includes(part)) {
      const other = names.find((n) => n.toLowerCase() === part.toLowerCase());
      if (!other) return { exists: false };
      wrong ??= { wanted: part, actual: other };
      dir = join(dir, other);
    } else dir = join(dir, part);
  }
  return { exists: true, wrong };
}

const IMPORT = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const problems = [];
let checked = 0;
for (const file of ROOTS.flatMap((r) => walk(join(root, r)))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    checked += 1;
    const base = resolve(dirname(file), spec);
    let result = null;
    for (const ext of EXTENSIONS) {
      const r = exactCase(base + ext);
      if (r.exists) { result = r; break; }
    }
    if (result?.wrong) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${relative(root, file)}:${line}  imports '${spec}' but the file is '${result.wrong.actual}' (case differs: '${result.wrong.wanted}')`);
    }
  }
}
if (problems.length) {
  console.error(`✖ ${problems.length} import(s) whose letter case does not match the file (works on Windows, fails on Linux/Vercel):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ ${checked} relative imports checked: letter case matches the files.`);
