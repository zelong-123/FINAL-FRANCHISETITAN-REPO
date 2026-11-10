# Migration review — 20261108000001 to 20261108000005

Before `supabase db push`, review these five migrations against the existing live data. Every
migration is additive: it adds columns, tables, indexes, constraints and triggers. None of them
drops or rewrites data, and none edits an older migration. The only data any of them writes is the
Sales backfill in 000001.

## What each migration does to existing rows

| Migration | Touches existing rows? | Can it fail on existing data? |
|---|---|---|
| `000001_accountability` | Backfills `applicants.assigned_sales_user_id` from `franchise_inquiries.endorsed_to_user_id`, but only when that user is an **active Sales** user. Adds one `sales_assigned` history row per backfilled applicant. `updated_at` is not changed (the trigger is disabled only for the backfill). | No. The new columns are nullable, and the new FKs point to columns that are still empty. |
| `000002_activity_completion_brand` | No. It adds new nullable columns and the `applicant_brand_confirmations` table. | No. |
| `000003_stage_requirements` | No. It adds the `applicant_requirements` table and the `loi_returned_*` columns. | No. |
| `000004_payment_record` | No. It adds `payments.or_number` and the `returned_*` columns. | No. The two unique indexes only cover rows **with an `or_number`**. That column is new, so no existing row is covered and old duplicate reference numbers cannot break the index build. |
| `000005_monitoring` | No. It adds the `follow_ups` and `follow_up_reminders` tables and four plain indexes. | No. |

Each migration file runs in its own transaction. If one fails, that file rolls back completely.

## Risks

### Data and operations
1. **Import order (the backfill can miss data).** The README applies the migrations *before* the
   MySQL import. In that order the 000001 backfill runs on empty tables and assigns nobody. If the
   live data is (re)imported after the push, run the post-import backfill below once.
2. **Hard-deleting a user fails once history exists.** `applicant_stage_histories.changed_by_user_id`,
   `applicant_status_histories.changed_by_user_id`, `audit_logs.user_id` and `follow_ups.user_id`
   are `ON DELETE SET NULL`. Postgres carries out a set-null as an UPDATE of the history row, and the
   new append-only trigger refuses that UPDATE. So `delete from users …`, or deleting the user in the
   Supabase dashboard table editor, fails for any user who has history. *The app is not affected:*
   "Delete" on the Users screen only deactivates the account. The only hard delete in the API
   removes a branch account it has just created when a request fails, and that account has no history.
   **Rule: deactivate users; never hard-delete them.**
3. **Re-running a migration by hand fails.** The `alter table … add constraint` lines have no
   `if not exists`, so pasting a migration into the SQL editor a second time stops with "constraint
   already exists". `supabase db push` runs each file only once, so this matters only for manual runs.
4. **Short table locks.** Creating the indexes and adding the FKs briefly locks `applicants`,
   `payments`, `activity_schedules` and `applicant_stage_histories`. At this data size it takes a
   few seconds. Push during a quiet time anyway.

### Behaviour changes that existing records will meet (by design, but warn the users)
5. **Applicants with no Sales assigned.** Every applicant the backfill could not match shows
   **Unassigned**. Sales cannot act on them until Admin assigns a Sales user ("Admin must assign a
   Sales user first").
6. **Requirements.** Applicants still in `converted` must submit the Qualification requirements
   before **Confirm Qualified**. Applicants already past a stage are never sent back.
   - An applicant at the LOI stage needs the LOI scan before **Signed LOI**.
   - An applicant in `approved` needs the **Signed franchise agreement** before Active Franchisee.
7. **The 80% rule is gone.** A `for_approval` applicant who has paid 80–99% can no longer be
   approved. Approval now requires **Fully Paid**.
8. **Old payment plans.** An applicant mid-payment keeps their stored total after discount as the
   agreed amount. An applicant with no payment state must have the Agreed Package Amount set
   before entries can be recorded. Old entries without a receipt show **"Legacy - no receipt captured"**.
9. **Overdue badges.** Any applicant or inquiry that has sat in its stage for more than 7 days is
   shown as **Overdue** right after the push. Expect many badges on day one.

## Impact queries (run them on the COPY, read-only)

```sql
-- How many applicants the backfill will assign, and how many stay Unassigned
select count(*) filter (where u.id is not null) as will_be_assigned,
       count(*) filter (where u.id is null)     as stays_unassigned
from applicants a
left join franchise_inquiries fi on fi.id = a.inquiry_id
left join users u on u.id = fi.endorsed_to_user_id and u.account_status = 'active'
                 and u.role_id = (select id from roles where name = 'sales')
where a.archived_at is null and a.status not in ('rejected', 'active_franchisee');

-- Applicants per stage (who will meet the new requirement rules)
select status, count(*) from applicants where archived_at is null group by status order by 2 desc;

-- for_approval applicants who are NOT fully paid (80% no longer enough)
select a.id, a.full_name, p.total_required_amount, coalesce(sum(pm.amount) filter (where pm.status = 'verified'), 0) as paid
from applicants a
join applicant_payment_plans p on p.applicant_id = a.id
left join payments pm on pm.applicant_id = a.id
where a.status = 'for_approval'
group by a.id, a.full_name, p.total_required_amount
having coalesce(sum(pm.amount) filter (where pm.status = 'verified'), 0) < p.total_required_amount;

-- Users who could no longer be hard-deleted (they have history)
select u.id, u.email from users u
where exists (select 1 from applicant_stage_histories h where h.changed_by_user_id = u.id)
   or exists (select 1 from applicant_status_histories h where h.changed_by_user_id = u.id)
   or exists (select 1 from audit_logs l where l.user_id = u.id);

-- Old reference numbers already used twice (the API refuses re-using them in new entries)
select lower(btrim(reference_number)) as ref, count(*) from payments
where reference_number is not null and btrim(reference_number) <> ''
group by 1 having count(*) > 1;
```

Column names in these queries follow `20261107000001_schema.sql`. If a column is named
differently on the copy, adjust the query; never adjust the live database.

## Post-import backfill (only if data is imported AFTER the push)

This is the same statement as section 6 of `000001`. It is safe to run twice: it only touches
applicants that are still unassigned.

```sql
begin;
alter table public."applicants" disable trigger set_updated_at;
with picked as (
  select a.id as applicant_id, fi.endorsed_to_user_id as sales_id, a.status
  from public."applicants" a
  join public."franchise_inquiries" fi on fi.id = a.inquiry_id
  join public."users" u on u.id = fi.endorsed_to_user_id
  join public."roles" r on r.id = u.role_id
  where a.assigned_sales_user_id is null and r.name = 'sales' and u.account_status = 'active'
), updated as (
  update public."applicants" a set assigned_sales_user_id = p.sales_id, assigned_sales_at = now()
  from picked p where a.id = p.applicant_id
  returning a.id, a.status, a.assigned_sales_user_id
)
insert into public."applicant_stage_histories" (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, step, actor_role, new_values)
select id, status, status, 'Assigned from the inquiry endorsement when assignment was introduced.', null, now(), 'sales_assigned', 'assignment', 'system',
  jsonb_build_object('assigned_sales_user_id', assigned_sales_user_id)
from updated;
alter table public."applicants" enable trigger set_updated_at;
commit;
```

## Safe test on a copy of the live data

Nothing below writes to the live project. The only live step is the read-only dump in step 1.

1. **Dump the live data (read-only).** Run it from the Supabase dashboard's connection string, or:
   ```bash
   npx supabase db dump --linked -f backup/live-schema.sql
   npx supabase db dump --linked --data-only -f backup/live-data.sql
   ```
2. **Start a throwaway Postgres on this machine** (Docker), never the live project:
   ```bash
   docker run --name ft-copy -e POSTGRES_PASSWORD=copy -p 55432:5432 -d postgres:15
   ```
   Alternative: create a separate, new Supabase project just for this test.
3. **Restore the copy:** first the schema, then the data:
   ```bash
   psql "postgresql://postgres:copy@127.0.0.1:55432/postgres" -f backup/live-schema.sql
   psql "postgresql://postgres:copy@127.0.0.1:55432/postgres" -f backup/live-data.sql
   ```
   (The dump may reference Supabase roles such as `authenticated` or `anon`. Create them first, or
   ignore those GRANT errors, because they do not affect this test.)
4. **Run the impact queries** above. Save the numbers to compare against later.
5. **Apply the five migrations in order** on the copy:
   ```bash
   for f in supabase/migrations/20261108*.sql; do psql "postgresql://postgres:copy@127.0.0.1:55432/postgres" -v ON_ERROR_STOP=1 -1 -f "$f" || break; done
   ```
   Every file must finish without an error.
6. **Check the result on the copy:**
   - row counts of `applicants`, `payments`, `applicant_stage_histories` and `franchise_inquiries`
     are unchanged, except for the new `sales_assigned` history rows
   - `select count(*) from applicants where assigned_sales_user_id is not null` matches "will_be_assigned"
   - `\d payments` shows both unique indexes
   - `update applicant_stage_histories set remarks = 'x' where id = (select min(id) from applicant_stage_histories);`
     is refused with "History rows are append-only"
7. **Optional: point the local API at the copy** and click through a few real applicants (Admin and
   Sales). Read-only clicks are enough.
8. **Throw the copy away:** run `docker rm -f ft-copy` and delete the `backup/` files (they contain
   real personal data, so never commit them).
