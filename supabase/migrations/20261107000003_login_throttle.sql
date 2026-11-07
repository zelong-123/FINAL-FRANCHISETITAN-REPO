-- Failed sign-in counter, per account + client IP. Edge Function instances keep no memory
-- between requests, so what Laravel kept in its cache has to live in the database.
create table public.login_attempts (
  throttle_key text primary key,
  attempts integer not null default 0,
  reset_at timestamptz not null
);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;
