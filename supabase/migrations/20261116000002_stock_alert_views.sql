-- When each Admin / Logistics user last marked the Branches stock alerts as seen ("+N new" badges).
create table if not exists public."stock_alert_views" (
  "user_id" bigint primary key references public."users" ("id") on delete cascade,
  "last_seen_at" timestamptz not null,
  "created_at" timestamptz default now(),
  "updated_at" timestamptz default now()
);
alter table public."stock_alert_views" enable row level security;
revoke all on public."stock_alert_views" from anon, authenticated;
create trigger set_updated_at before update on public."stock_alert_views" for each row execute function public.set_updated_at();
