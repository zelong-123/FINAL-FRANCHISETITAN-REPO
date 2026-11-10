-- First sign-in password change. Additive only.
-- An account created with a system-generated temporary password must set its own password
-- before it can use the system. Existing accounts keep working: the flag defaults to false.
alter table public."users" add column if not exists "must_change_password" boolean not null default false;
alter table public."users" add column if not exists "password_changed_at" timestamptz;
