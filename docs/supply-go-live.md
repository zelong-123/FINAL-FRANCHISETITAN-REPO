# Supply workflow (Objective 3): go-live runbook

Everything here is run **by the project owner**, from the repo root in PowerShell, on the linked project
`jqnnkjmogjxjikiyrtbx` (`npx supabase link` is already done: `supabase/.temp/linked-project.json`). Nothing in this
file is run by tools or by the assistant. No Docker is needed. Never paste secrets or connection strings into chats
or tickets.

What goes live together: migration `20261111000001_supply_workflow.sql`, the `api` function (repo `main`), and the
frontend, which runs locally with `npm run dev` from `main` (`.env` points to live; Vercel is not deployed yet).
Do the steps **in one sitting**, in this order, so the old function never runs against the new statuses for long
and the new frontend never runs against the old function. Do not `git push`.

Rollback point for the function: tag **`live-function-v24`** (branch `live-v24`). It is the exact code of the live
function v24 (downloaded and diffed on 2026-11-11: postgres@3.4.4, `ssl: false`). Do **not** use the older tag
`before-live-deploy`: it lacks that database config and would bring back the TLS error.

## 0. Before you start

```powershell
git status --short          # no output (nothing uncommitted)
git log --oneline -1        # the runbook commit on top of supply-phase-5
npm run test:api            # all pass
npx supabase secrets list --project-ref jqnnkjmogjxjikiyrtbx   # names only. DATABASE_URL must NOT be listed (it caused the earlier outage)
```

## 1. Read-only backup of live

```powershell
node supabase/seed/backup-tables.mjs pre-supply
```
The script reads `SUPABASE_DB_URL` from `.env` and reads every `public` table inside one read-only transaction; it
writes nothing to the database. `backup/` is git-ignored: it holds real personal data, never commit it.

Check:
- A new folder `backup/pre-supply-<timestamp>/` exists, with one `<table>.json` per table and `_manifest.json`.
- The terminal says `Backup written to backup\pre-supply-…: N tables, M rows.`
- `_manifest.json` has a row count for every table. Compare with the before-numbers:
  ```powershell
  $latest = Get-ChildItem backup -Directory -Filter 'pre-supply-*' | Sort-Object Name | Select-Object -Last 1
  $m = Get-Content (Join-Path $latest.FullName '_manifest.json') -Raw | ConvertFrom-Json
  $m.tables.supply_requests, $m.tables.deliveries, $m.tables.supply_request_date_revisions   # expected: 31, 20, 0
  ```
Then, in the Supabase dashboard → SQL editor, save the **before** numbers per status (read-only):

```sql
select status, count(*) from supply_requests group by status order by status;
```
Expected (from 2026-11-11): completed 20, submitted 3, under_review 2, endorsed 3, preparing 2, dispatched 1
(31 in total, the same as `supply_requests` in `_manifest.json`). If they differ, stop and tell the developer before
pushing (the migration handles any old status, but the checks below assume these numbers).

## 2. Push the migration

```powershell
npx supabase migration list --linked     # only 20261111000001_supply_workflow is "local only"
npx supabase db push --linked --dry-run  # must list exactly that one file
npx supabase db push --linked
```
Check: `npx supabase migration list --linked` shows `20261111000001` on both sides. Then in the SQL editor (read-only):

```sql
select status, count(*) from supply_requests group by status order by status;
-- expected: completed 20, dispatched 1, preparing 2, scheduled 3, submitted 3, under_review 2 (no endorsed, no delivered)

select count(*) filter (where reservation_incomplete) as flagged, count(*) as scheduled
from supply_requests where status = 'scheduled';
-- flagged = the endorsed requests the warehouse could not fully reserve (Logistics sees "Reservation incomplete")

select status, count(*), sum(quantity) from supply_reservations group by status;
-- only 'active' rows, for the 3 scheduled requests

select count(*) from supply_request_status_histories where action = 'migrated';
-- 3 (one per old endorsed request)

select count(*) from supply_requests where status = 'dispatched' and stock_deducted_at is not null;
-- 1 (the old dispatched request, already deducted at the old Preparing)
```
If the push fails: run `migration list` and the status query above, keep the old function running, and send the
error to the developer. The file is re-runnable (every step checks before it changes; the tests run it three
times in a row), so once the cause is fixed it is simply pushed again.

## 3. Deploy the function (right after step 2)

```powershell
npx supabase functions deploy api --no-verify-jwt --use-api
npx supabase functions list              # api: a new version number, status ACTIVE
```
Check:
```powershell
Invoke-RestMethod https://jqnnkjmogjxjikiyrtbx.supabase.co/functions/v1/api/v1/health
# status: ok, database: ok
```
Dashboard → Edge Functions → `api` → Logs: no errors (especially no `ERR_NOT_IMPLEMENTED` / TLS errors).

## 4. Restart the local frontend from `main` (right after step 3)

1. Stop every running `npm run dev` (Ctrl+C in its terminal; close any old dev-server windows).
2. In a fresh PowerShell window at the repo root, make sure no local-demo overrides are left in the shell, so the app
   uses `.env` (which points to live), then start it:
   ```powershell
   git log --oneline -1                    # the current main commit
   Remove-Item Env:VITE_SUPABASE_URL, Env:VITE_SUPABASE_ANON_KEY, Env:VITE_PORTAL -ErrorAction SilentlyContinue
   npm run dev -- --port 5173 --strictPort
   ```
   Use a port that `ALLOWED_ORIGINS` allows (5173–5179). If 5173 is taken, use `--port 5174` (up to 5179) instead.
3. Open `http://localhost:5173/` (staff login) and `http://localhost:5173/branch-portal/login` (branch login). With
   `VITE_PORTAL` unset, one dev server serves both.

Check: both login pages load. In DevTools → Network, API requests go to `jqnnkjmogjxjikiyrtbx.supabase.co` (live)
without CORS errors.

## 5. Smoke tests on live

1. **Login:** Admin and Logistics on the staff login; a branch account on the branch login. All three sign in.
2. **Staff page:** as Admin and as Logistics, **Supply requests** opens: KPI cards, tabs with counts, the list.
   The 3 migrated requests show **Scheduled**; a flagged one shows **Reservation incomplete** in its drawer.
   No Endorse or Review buttons remain on the **Branches** page (read-only list + **Open in Supply Requests**).
3. **The old dispatched request** (only when the delivery has really arrived, because this changes branch stock):
   - Branch login → **Supply Request Panel** → the request shows **On the way** → **Confirm receipt** with the real
     counts (good, damaged, short). Only the good quantity is added to the branch stock.
   - Staff login, Logistics → open it → **Encode POD** with the real photo or signed slip, received-by and time.
   - It becomes **Completed** (or **Discrepancy review** if anything was damaged or short).
4. **Health and logs** again (step 3 checks).

## 6. If something fails

| What failed | What to do | Undone? |
|---|---|---|
| Step 1 (backup) | Do not continue. Send the error. Nothing was changed. | — |
| Step 2 (db push) | Keep the old function. Send the error with the `migration list` output; push again once fixed (the file is re-runnable). If some statuses were already mapped, use the down-mapping below until then. | Yes |
| Step 3 (deploy) | The previous function version keeps serving. Retry the deploy. If it still fails, see "back to the old system" below, because the old function does not know the new statuses. | — |
| Smoke tests, small bug | Fix forward: the developer fixes, you redeploy the function only. | — |
| Must go back to the old system | Redeploy the old function and run the status down-mapping below. | Partly |

**Redeploy the old function** (from a scratch copy of the tag, never by checking out the repo itself):
```powershell
git worktree add ..\ft-live-v24 live-function-v24
Set-Location ..\ft-live-v24
npx supabase functions deploy api --no-verify-jwt --use-api --project-ref jqnnkjmogjxjikiyrtbx
Set-Location ..\franchisetitan-supabase; git worktree remove ..\ft-live-v24
```
Then stop the local `npm run dev` from `main`: its new screens need the new function.

**Status down-mapping** (SQL editor, after the old function is back). The old code knows only draft, submitted,
under_review, endorsed, preparing, dispatched, delivered, completed, rejected and cancelled:
```sql
begin;
alter table supply_requests drop constraint if exists supply_requests_status_check;
update supply_reservations set status = 'released', released_at = now() where status = 'active';
update supply_requests set status = 'endorsed'     where status in ('waiting_logistics', 'scheduled')
                                                   or (status = 'preparing' and stock_deducted_at is null);
update supply_requests set status = 'under_review' where status = 'on_hold';
update supply_requests set status = 'submitted'    where status = 'returned';
update supply_requests set status = 'dispatched'   where status = 'delivered' and branch_received_at is null;
update supply_requests set status = 'completed'    where status in ('discrepancy_review', 'completed_with_discrepancy');
commit;
```

What **can** be undone: the function (redeploy); every status (the mapping above); the reservations (released).
The new tables and columns stay but the old function ignores them; they are harmless.

What **cannot** be undone:
- **History rows** written by the new workflow stay: they are append-only by design (the trigger refuses updates).
- **Stock already moved** stays moved: warehouse deductions at dispatch, and branch credits of the good quantity at
  receipt. The old flow credited the full quantity at Delivered; any receipt confirmed in the new flow has already
  credited only the good part, and that is not redone.
- **Uploaded POD and damage photos** stay in storage.
- **Restoring the database from the step 1 backup** is not a one-command restore: the JSON files are a record to
  compare against and to re-insert specific rows from by hand, and doing that would also overwrite every change made
  after the backup by anyone. It is a last resort, done carefully with the developer (or on a copy first).
