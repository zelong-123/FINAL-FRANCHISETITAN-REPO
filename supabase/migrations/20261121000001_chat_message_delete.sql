-- Chat message delete. Additive only.
-- "Delete for everyone" (the sender only) sets deleted_at; the original text stays stored for the record but
-- the API never returns it (it shows "This message was deleted"). "Delete for me" hides it for that user only.
-- Both are written to audit_logs.
alter table public."chat_messages" add column if not exists "deleted_at" timestamptz;

create table if not exists public."chat_message_hidden" (
  "message_id" bigint not null references public."chat_messages" ("id") on delete cascade,
  "user_id" bigint not null references public."users" ("id") on delete cascade,
  "created_at" timestamptz default now(),
  primary key ("message_id", "user_id")
);
alter table public."chat_message_hidden" enable row level security;
