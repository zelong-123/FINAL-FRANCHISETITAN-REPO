# Franchise Titan: React + Tailwind + Supabase + PostgreSQL

Conversion of Herald 2.0 (React with CSS, Laravel, MySQL). **Work in progress: see Migration status.**

## How it is built

| Before | Now |
|---|---|
| MySQL, 54 migrations | PostgreSQL: `supabase/migrations/`, generated from the final migrated schema |
| Laravel controllers and services | One Edge Function, `supabase/functions/api/` (Hono + TypeScript), serving the same `/api/v1` routes |
| `api_tokens` table | Supabase Auth |
| `users.password` | `auth.users`, linked by `users.auth_user_id` |
| Laravel cache (login throttle) | `login_attempts` table |
| 20 CSS files | Tailwind v4: utility classes in the JSX, shared setup in `src/tailwind.css` |

**Why an API function instead of calling tables from React:** stage gates, atomic stock deduction and
scheduling rules are server-side business rules, and the existing pages already speak `/api/v1`.
Browsers get no table access: RLS is on with no policies and `anon`/`authenticated` hold no grants. Only
the function reaches the data, and it applies the same role checks Laravel did.

**Things that behave differently from MySQL, and how the port handles them**
- `=` and `LIKE` are case-sensitive in Postgres. Searches use `ILIKE`, and `unique:` checks compare with `lower()`.
- Timestamps are `timestamptz`. "Today" means Asia/Manila (`manilaToday()`), not the server's clock.
- A foreign key target must have a unique key, so composite targets got unique indexes.
- JWTs outlive sign-out, so every request also checks the session row. Logout and blocks stay immediate.

## Run it locally (no Docker, no Supabase project)

```bash
npm install
```

```bash
npm run dev:api
```

```bash
npm run dev
```

`.env.local` points the frontend at `dev:api`, which runs the real API on in-memory Postgres with a stand-in
for Supabase Auth. Data resets on restart. Open http://localhost:5173. Seed accounts are in `src/components/Log.jsx`'s
development hint.

## Tests

```bash
npm run test:api
```

```bash
node --no-warnings tools/route-coverage.mjs --list
```

The coverage tool compares against Laravel's real route table (`docs/laravel-routes.json`).

```bash
npm run test:import
```

This runs the MySQL importer on real Postgres against a made-up dump, `tests/fixtures/phpmyadmin-sample.sql`.

## Deploy to Supabase

Not yet run against a real project (see below). The steps, once you have one:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

```bash
npx supabase db push
```

```bash
npx supabase functions deploy api --no-verify-jwt
```

```bash
npx supabase secrets set ALLOWED_ORIGINS=https://franchisetitan-staff.vercel.app,https://franchisetitan-branch.vercel.app FEATURE_COSTING=false
```

For a development project only: run `supabase/seed.sql`, fill in `.env` from `.env.example`, then `npm run users:create`.
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` wherever the frontend is built. Turn off public sign-ups
in the dashboard if `config.toml` was not applied.

## Deploy to Vercel (two portals)

The frontend ships as two Vercel projects built from this same repo. Both use the same root directory and the same
`vercel.json`, which already rewrites every route to `/index.html`, so refreshing a deep link does not 404. They also
share one Supabase project and database. Only `VITE_PORTAL` differs:

| Project | Serves | `/` opens |
| --- | --- | --- |
| Staff (`VITE_PORTAL=staff`) | Admin, Marketing, Sales, Logistics | staff login |
| Branch (`VITE_PORTAL=branch`) | franchisee (branch) accounts only | branch login |

Environment variables for both projects: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The staff project also
sets `VITE_PORTAL=staff`, and the branch project sets `VITE_PORTAL=branch`. If `VITE_PORTAL` is not set, every route
is available, which is how local development works. Any other value stops the app at start-up.

**Never put `SUPABASE_SERVICE_ROLE_KEY` or any other secret in Vercel or in a `VITE_` variable.** Every `VITE_`
value is built into the public JavaScript.

Neither site links to the other. If a session from the wrong portal reaches a site, the app signs it out and shows a
short notice. The API also refuses the wrong portal at login.

After both projects have their URLs, allow them in CORS (see `ALLOWED_ORIGINS` above).

To try both portals locally, run `npm run dev:api` and then start each portal in its own terminal:

```bash
VITE_PORTAL=staff npx vite --port 5173 --strictPort
```

```bash
VITE_PORTAL=branch npx vite --port 5174 --strictPort
```

In PowerShell, set the variable first, for example `$env:VITE_PORTAL='branch'; npx vite --port 5174 --strictPort`.
Variables set in the shell override `.env` files.

For the supply workflow demo (Objective 3), run `npm run dev:api:demo` instead of `npm run dev:api`: the same local
API with branch inventory, usage history and requests in every state (`supabase/seed/supplyDemo.ts`, local only).
Point both portals at it by also setting `VITE_SUPABASE_URL=http://127.0.0.1:54321` and
`VITE_SUPABASE_ANON_KEY=local-dev-anon-key` in the shell, so the `.env` values are not used. The walkthrough is in
`docs/defense-demo.md` (Objective 3).

## Import existing MySQL data

`scripts/import-mysql-dump.mjs` reads a phpMyAdmin or `mysqldump` export directly, so no MySQL server is needed.
The dump must hold only the Franchise Titan database. `--files` is Laravel's `storage/app` folder, which holds
`private/` and `public/`.

Rehearse first. This runs on in-memory Postgres with stand-ins for Auth and Storage, so nothing leaves your machine:

```bash
npm run import:mysql -- --target pglite --dump backup.sql --files path/to/storage/app
```

For the real project, apply the migrations, set `SUPABASE_DB_URL`, `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
in `.env`, then run:

```bash
npm run import:mysql -- --target supabase --dump backup.sql --files path/to/storage/app
```

The summary prints to the terminal and the full report goes to `import-report.json` (git-ignored). The exit code is
`0` only if everything finished. **Read the report before trusting an import:** a row the importer cannot load is
reported and left out, and that alone does not fail the run.

**Running it again.** Table data loads in one transaction, so a failure leaves the tables as they were. A database that
already holds data is refused unless you pass `--replace`, which erases all table data first. Sign-ins and files are not
in that transaction. If they stop partway, the status says `INCOMPLETE`: fix the cause and run again with `--replace`.

**What it converts**

| MySQL | Postgres |
|---|---|
| `TIMESTAMP` | `timestamptz`, read in the zone the export names (see below) |
| `DATETIME` | `timestamptz`, read as Manila time (`+08`) |
| `tinyint` on a boolean column | `boolean`; a `tinyint` on a `smallint` column stays a number |
| JSON stored as `longtext` | `jsonb`, an object rather than a string, with its digits unchanged |
| `0000-00-00` and other impossible dates | cleared, or the row is skipped if the column is required |
| ids and `AUTO_INCREMENT` | ids kept. Sequences continue past both the counter and the highest id in the dump, including skipped rows |

**Why `TIMESTAMP` and `DATETIME` differ.** Laravel writes Manila wall-clock time to both, but phpMyAdmin and `mysqldump`
export `TIMESTAMP` columns in UTC by default (`SET time_zone = "+00:00"` at the top of the file) and leave `DATETIME` as
stored. Adding `+08` to everything would put nearly every timestamp 8 hours late. If the dump names no zone, `TIMESTAMP`
is read as Manila. Override with `--timestamp-zone +00:00`. To check a result, the report's latest `created_at` should
fall just before the dump was made.

**Foreign keys.** Tables load parents first, in an order worked out from the schema's constraints. A row pointing at a
parent that does not exist has that link cleared if the column may be empty. Otherwise the row is skipped, along with
any rows that depended on it.

**Users.** Each user gets a Supabase Auth sign-in through the Admin API with their existing bcrypt hash, so they keep
their password, and `users.auth_user_id` is linked. `$2y$` hashes are sent as `$2a$`, the same algorithm under a prefix
every reader accepts. Everyone signs in again once, because `api_tokens` is not carried over. A sign-in that already
exists for that email is linked and its password left alone, since it may have changed since the last import. So a
later `--replace` does not bring back old passwords, and also leaves any sign-in that matches no user in place.

Not given a sign-in, and named in the report: users without a bcrypt hash, and users whose email differs from another's
only by letter case, which Supabase Auth treats as one account. They need a reset or a decision from you.

**Files.** Everything in `private/` and `public/` goes to the bucket of the same name, at the same path, overwriting what
is there. The report lists files that rows refer to but the folder lacks. Hidden files and any `backups/` folder are never
uploaded, because a database backup holds every password hash.

**Left out on purpose:** Laravel's `api_tokens`, `cache`, `cache_locks`, `failed_jobs`, `jobs`, `job_batches`, `migrations`,
`password_reset_tokens` and `sessions` tables, and `users.password` and `users.remember_token`. Any other table or column
the schema does not have is reported as `NOT IN THE TARGET SCHEMA`.

## Migration status

**API: 236 of 236 routes, all phases done.** Run the coverage tool to confirm. Any other path returns `404`.

| Phase | Area | Status |
|---|---|---|
| 1 | Schema, Auth, users, catalog, notifications, chat, system | done |
| 2 | Inquiries, Applicants pipeline and payments, Archive, file storage | done |
| 3 | Activities, Master Schedule | done |
| 4 | Warehouse, brand products, Supply Requests | done |
| 5 | Branch workspace and portal, ProfitTrack, Branches panel | done |
| 6 | Estimated Requirement, forecasts, analytics | done |

To run a suite through the production `postgres.js` driver on a single connection, set `TEST_DB_ADAPTER=postgres`.
A route that reaches past its open transaction hangs there instead of passing.

**Tailwind: 20 of 20 stylesheets, done.** No legacy stylesheet is left: `src/tailwind.css` is the only CSS file, with
Preflight on (`@import "tailwindcss"`). The two login screens were converted by hand. The other 18 sheets (13,400 lines)
were converted by a script, which turned each rule into utilities on the element it styles while keeping its specificity.
What to know when editing:
- **Long `className`s.** Rules that styled children (`.panel h2`) became arbitrary variants on the parent (`[&_h2]:…`), so
  many class strings are long. Some old class names stay on elements without styles, because a variant refers to them.
- **`later:` variants.** In the old CSS, of two rules with equal specificity the later one won. Tailwind orders utilities
  its own way, so a utility that must win such a tie carries `later:` (one extra `:not(z)`, see `src/tailwind.css`).
- **Class names built at runtime** (`status-${x}`, `classList.add`) stay named classes, defined in `src/tailwind.css`.
- **Browser defaults.** Pages were designed on them, so `src/tailwind.css` restores what Preflight resets (generated from
  `tailwindcss/preflight.css` with `revert`).
- **FullCalendar** injects unlayered CSS, which beats any layered utility, so the overrides of its markup stay plain rules.

Every page was compared before and after in the browser by computed style: all five roles, dark and light themes, desktop,
tablet and phone widths, plus the tabs and dialogs the pages open. Hover and focus states were converted rule by rule but
not compared in the browser. About 375 selectors that matched nothing were dropped, along with 12 unused files (old brand
images, the retired Analytics and ProfitTrack pages, an unused supply request view). The build grew by about 127 KB
gzipped (CSS 63 → 91 KB, JS 647 → 746 KB), because the class strings now live in the JavaScript.

**Not verified yet**
- Nothing has run on a real Supabase project or on Deno: `index.ts`, `services/supabaseAuth.ts`, `services/supabaseFiles.ts`,
  Supabase's real `auth.sessions` permissions. Tests use real Postgres and the production `postgres.js` adapter, with a
  stand-in for Auth and for Storage.
- The MySQL import has only been rehearsed on PGlite. `--target supabase` has never run, so these are still unproven:
  that Supabase Auth accepts the imported hashes and those passwords then sign in, Storage's rules on file names, and
  the permission to disable the `updated_at` trigger while linking users. Try a few real sign-ins before go-live.
- Under `dev:api`, uploaded files live in memory and public image URLs point at a placeholder host, so pictures do not display locally.
- 149 ESLint errors remain in the frontend, mostly `react-hooks` rules in pages carried over from the original.

**Bugs in the original, fixed here**
- Re-importing a manual raw material by CSV failed on the unique index. It now reuses the material.
- Branches operations returned no daily usage or days of cover, because it filtered on a movement type the ledger never
  writes. It now reads the last 7 days of production, leaving out voided batches. No screen displays these two fields yet.
- Branch production dashboard, year view: only January of each year was counted. Each bar now covers the whole year, and
  `series[].period` is `YYYY` in that view instead of `YYYY-01`.

**To decide before go-live:** the panels poll every 2.5 to 5 seconds, and each poll is now a billed Edge Function
call. Check that against your plan's quota. Supabase Realtime could replace polling later.
