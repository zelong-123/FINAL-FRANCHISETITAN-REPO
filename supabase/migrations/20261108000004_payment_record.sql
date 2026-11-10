-- Phase 4: Payment Record — recording payments that happened outside the system (no billing).
-- Additive only: new columns and indexes.

-- 1. What each recorded payment carries, and Admin's return of it.
alter table public."payments" add column if not exists "or_number" text;
alter table public."payments" add column if not exists "returned_reason" text;
alter table public."payments" add column if not exists "returned_at" timestamptz;
alter table public."payments" add column if not exists "returned_by_user_id" bigint;
alter table public."payments" add constraint "payments_returned_by_user_id_fkey"
  foreign key ("returned_by_user_id") references public."users" ("id") on delete set null;

-- 2. The same OR/AR number or reference number can never be recorded twice, even when two
--    entries are submitted at the same moment: the database refuses the second one.
--    Returned (and old rejected) entries do not count, so a corrected entry may reuse its number;
--    cash entries have no reference number. Only Payment Record entries (they always carry an
--    OR/AR number) are covered, so older imported rows can never make this migration fail;
--    the API also checks a new number against those older rows.
create unique index if not exists "payments_or_number_unique"
  on public."payments" (lower(btrim("or_number")))
  where "or_number" is not null and btrim("or_number") <> '' and "status" not in ('returned', 'rejected');
create unique index if not exists "payments_reference_number_unique"
  on public."payments" (lower(btrim("reference_number")))
  where "or_number" is not null and "reference_number" is not null and btrim("reference_number") <> '' and "status" not in ('returned', 'rejected');

-- 3. Where the Agreed Package Amount was taken from (e.g. "Signed LOI", "Package B").
alter table public."applicant_payment_plans" add column if not exists "agreed_amount_source" text;
