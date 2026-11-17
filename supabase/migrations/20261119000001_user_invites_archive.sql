-- Account invitations and archive/suspend. Additive; existing accounts are unchanged.
--
-- Invitations: every new account (staff, Admin, Franchisee) is created as account_status 'invited'
-- and gets an email from Supabase Auth; accepting it (setting a password) makes it 'active',
-- declining makes it 'declined'. 'expired' is worked out from invited_at, not stored.
alter table public."users" add column if not exists "invited_at" timestamptz;
alter table public."users" add column if not exists "invited_by_user_id" bigint references public."users" ("id") on delete set null;
alter table public."users" add column if not exists "invite_accepted_at" timestamptz;
alter table public."users" add column if not exists "invite_declined_at" timestamptz;

-- Archive (suspend): a start time (now or later) and an optional end time; the account is restored
-- by itself once the end has passed (checked on sign-in, on every request and on list load).
alter table public."users" add column if not exists "archive_reason" text;

-- The suspension window becomes a point in time. A date-only suspension started at Manila midnight
-- and ran through its last day, so it ends at Manila midnight of the following day.
alter table public."users" alter column "suspended_from" type timestamptz
  using (case when "suspended_from" is null then null else ("suspended_from"::timestamp at time zone 'Asia/Manila') end);
alter table public."users" alter column "suspended_until" type timestamptz
  using (case when "suspended_until" is null then null else (("suspended_until" + 1)::timestamp at time zone 'Asia/Manila') end);
