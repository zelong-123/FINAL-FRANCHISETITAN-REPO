// Safe deploy of the `api` Edge Function. Refuses unless ALL of these hold:
//   1. the current branch is main;
//   2. the working tree is completely clean (no modified or untracked files — they would be uploaded);
//   3. HEAD is exactly origin/main (after a fetch) — so what is deployed is what the team merged;
//   4. the library and API tests pass;
//   5. no local migration is missing on the database (push migrations first, the API depends on them).
// Then it deploys and VERIFIES: it downloads the live source and compares every file with HEAD.
//
//   npm run deploy:api            # project ref from SUPABASE_PROJECT_REF or supabase/.temp/project-ref
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20, ...opts });
  if (r.error) throw r.error;
  return r;
};
const git = (...args) => {
  const r = run('git', args);
  if (r.status !== 0) stop(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
function stop(message) {
  console.error(`\n✖ Not deployed: ${message}`);
  process.exit(1);
}
const step = (text) => console.log(`\n▶ ${text}`);

const ref = (process.env.SUPABASE_PROJECT_REF || (existsSync('supabase/.temp/project-ref') ? readFileSync('supabase/.temp/project-ref', 'utf8') : '')).trim();
if (!/^[a-z0-9]{20}$/.test(ref)) stop('no project ref: set SUPABASE_PROJECT_REF or run `npx supabase link --project-ref <ref>` first.');

step('Checking git');
const branch = git('branch', '--show-current');
if (branch !== 'main') stop(`you are on "${branch || 'a detached HEAD'}". Deploy only from main: git checkout main && git pull`);
const dirty = git('status', '--porcelain', '--untracked-files=all');
if (dirty) stop(`the working tree is not clean (commit, stash or remove these first):\n${dirty}`);
git('fetch', 'origin', 'main', '--quiet');
const head = git('rev-parse', 'HEAD');
const remote = git('rev-parse', 'origin/main');
if (head !== remote) stop(`HEAD (${head.slice(0, 7)}) is not origin/main (${remote.slice(0, 7)}). Run: git pull --ff-only (and push any local commits through a PR).`);
console.log(`  main = origin/main = ${head.slice(0, 7)} · clean`);

step('Running the tests');
for (const script of ['test:lib', 'test:api']) {
  const r = run('npm', ['run', script], { stdio: 'inherit' });
  if (r.status !== 0) stop(`npm run ${script} failed.`);
}

step('Checking migrations on the database');
const list = run('npx', ['supabase', 'migration', 'list', '--linked']);
if (list.status !== 0) stop(`could not list migrations: ${(list.stderr || list.stdout).trim().split('\n').slice(-3).join(' ')}`);
// The CLI prints JSON when piped, a table otherwise: read either, never skip the check silently.
const json = /\{[\s\S]*"migrations"[\s\S]*\}/.exec(list.stdout);
const rows = json
  ? JSON.parse(json[0]).migrations.map((m) => ({ local: m.local || '', remote: m.remote || '' }))
  : list.stdout.split('\n').map((l) => l.split('|').map((c) => c.replace(/[`\s]/g, ''))).filter((c) => c.length >= 2 && /^\d{14}$/.test(c[0] || c[1])).map((c) => ({ local: c[0], remote: c[1] }));
if (!rows.length) stop('could not read the migration list.');
const pending = rows.filter((m) => m.local && !m.remote).map((m) => m.local);
if (pending.length) stop(`migrations not on the database yet: ${pending.join(', ')}. Push them first (npx supabase db push --linked --dry-run, then without --dry-run).`);
console.log('  all migrations applied');

step(`Deploying api (${head.slice(0, 7)}) to ${ref}`);
// Deploy from a temporary worktree of HEAD with build-info.ts stamped (the repo itself stays clean).
const apiTree = git('rev-parse', 'HEAD:supabase/functions/api');
const stamp = { commit: head, api_tree: apiTree, deployed_at: new Date().toISOString() };
const buildInfo = (b) => `// Written by tools/deploy-api.mjs for this deploy (the committed file keeps nulls).\nexport const BUILD: { commit: string | null; api_tree: string | null; deployed_at: string | null } = ${JSON.stringify(b, null, 2)};\n`;
const work = mkdtempSync(join(tmpdir(), 'api-deploy-'));
rmSync(work, { recursive: true, force: true });
git('worktree', 'add', '--detach', work, head);
try {
  writeFileSync(join(work, 'supabase', 'functions', 'api', 'build-info.ts'), buildInfo(stamp));
  const deploy = run('npx', ['supabase', 'functions', 'deploy', 'api', '--no-verify-jwt', '--use-api', '--project-ref', ref, '--workdir', work, '--yes'], { stdio: 'inherit' });
  if (deploy.status !== 0) stop('supabase functions deploy failed.');
} finally {
  run('git', ['worktree', 'remove', '--force', work]);
}

step('Verifying the live source equals HEAD (plus the build stamp)');
const dir = mkdtempSync(join(tmpdir(), 'api-live-'));
try {
  const dl = run('npx', ['supabase', 'functions', 'download', 'api', '--project-ref', ref, '--use-api', '--workdir', dir]);
  if (dl.status !== 0) stop(`deployed, but the download for verification failed: ${dl.stderr.trim()}`);
  const root = join(dir, 'supabase', 'functions', 'api');
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const norm = (s) => s.replace(/\r/g, '').replace(/\n+$/, '');
  const differ = walk(root).map((f) => relative(root, f).split('\\').join('/')).filter((f) => {
    const live = norm(readFileSync(join(root, f), 'utf8'));
    if (f === 'build-info.ts') return live !== norm(buildInfo(stamp));
    const committed = run('git', ['show', `HEAD:supabase/functions/api/${f}`]);
    return committed.status !== 0 || norm(committed.stdout) !== live;
  });
  if (differ.length) stop(`deployed, but the live source differs from HEAD in: ${differ.join(', ')}`);
  const health = await fetch(`https://${ref}.supabase.co/functions/v1/api/v1/health`).then((r) => r.json()).catch(() => null);
  if (health?.api_tree !== apiTree) stop(`deployed, but /health reports api_tree ${health?.api_tree ?? 'none'} (expected ${apiTree.slice(0, 7)}).`);
  console.log(`\n✔ Deployed and verified: the live api function is ${head.slice(0, 7)} (api code ${apiTree.slice(0, 7)}, ${walk(root).length} files match; /health agrees).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
