-- Chat message delete: "delete for everyone" marks the row deleted_at; "delete for me" hides it per user.
alter table public."chat_messages" add column if not exists "deleted_at" timestamptz;

create table if not exists public."chat_message_hidden" (
  "message_id" bigint not null references public."chat_messages" ("id") on delete cascade,
  "user_id" bigint not null references public."users" ("id") on delete cascade,
  "created_at" timestamptz default now(),
  primary key ("message_id", "user_id")
);
alter table public."chat_message_hidden" enable row level security;
