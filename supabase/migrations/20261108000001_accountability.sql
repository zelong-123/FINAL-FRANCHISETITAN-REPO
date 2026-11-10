-- Phase 1: access and accountability. Additive only: new columns, an index, append-only
-- protection for history rows and a one-time backfill of the new assignment column.

-- 1. Assigned Sales user per applicant.
alter table public."applicants" add column if not exists "assigned_sales_user_id" bigint;
alter table public."applicants" add column if not exists "assigned_sales_at" timestamptz;
alter table public."applicants" add column if not exists "assigned_sales_by_user_id" bigint;
alter table public."applicants" add constraint "applicants_assigned_sales_user_id_fkey"
  foreign key ("assigned_sales_user_id") references public."users" ("id") on delete set null;
alter table public."applicants" add constraint "applicants_assigned_sales_by_user_id_fkey"
  foreign key ("assigned_sales_by_user_id") references public."users" ("id") on delete set null;
create index if not exists "applicants_assigned_sales_user_id_idx" on public."applicants" ("assigned_sales_user_id");

-- 2. Inquiry duplicate acknowledgement and rejection reason.
alter table public."franchise_inquiries" add column if not exists "duplicate_reason" text;
alter table public."franchise_inquiries" add column if not exists "duplicate_matches" jsonb;
alter table public."franchise_inquiries" add column if not exists "rejected_reason" text;
alter table public."franchise_inquiries" add column if not exists "rejected_at" timestamptz;
alter table public."franchise_inquiries" add column if not exists "rejected_by_user_id" bigint;
alter table public."franchise_inquiries" add constraint "franchise_inquiries_rejected_by_user_id_fkey"
  foreign key ("rejected_by_user_id") references public."users" ("id") on delete set null;

-- 3. The applicant action log (applicant_stage_histories) records who, role, step, old/new values
--    and attached files for every action.
alter table public."applicant_stage_histories" add column if not exists "actor_role" text;
alter table public."applicant_stage_histories" add column if not exists "step" text;
alter table public."applicant_stage_histories" add column if not exists "old_values" jsonb;
alter table public."applicant_stage_histories" add column if not exists "new_values" jsonb;
alter table public."applicant_stage_histories" add column if not exists "attachments" jsonb;
create index if not exists "applicant_stage_histories_applicant_changed_idx" on public."applicant_stage_histories" ("applicant_id", "changed_at");

-- 4. Files are never hard-deleted while linked to an applicant: a removal or a replacement is a mark.
alter table public."documents" add column if not exists "replaced_at" timestamptz;
alter table public."documents" add column if not exists "replaced_by_document_id" bigint;
alter table public."documents" add column if not exists "removed_at" timestamptz;
alter table public."documents" add column if not exists "removed_by_user_id" bigint;
alter table public."documents" add column if not exists "removed_reason" text;
alter table public."documents" add constraint "documents_removed_by_user_id_fkey"
  foreign key ("removed_by_user_id") references public."users" ("id") on delete set null;

-- 5. History rows are append-only: an update is refused. (Deleting a whole applicant still
--    cascades, as before.)
create or replace function public.refuse_history_update() returns trigger language plpgsql as $$
begin
  raise exception 'History rows are append-only (%).', tg_table_name;
end;
$$;
drop trigger if exists "applicant_stage_histories_append_only" on public."applicant_stage_histories";
create trigger "applicant_stage_histories_append_only" before update on public."applicant_stage_histories"
  for each row execute function public.refuse_history_update();
drop trigger if exists "applicant_status_histories_append_only" on public."applicant_status_histories";
create trigger "applicant_status_histories_append_only" before update on public."applicant_status_histories"
  for each row execute function public.refuse_history_update();
drop trigger if exists "audit_logs_append_only" on public."audit_logs";
create trigger "audit_logs_append_only" before update on public."audit_logs"
  for each row execute function public.refuse_history_update();

-- 6. Backfill: an applicant whose inquiry was endorsed to an active Sales user gets that user.
--    updated_at is left alone so "Last Updated" keeps meaning a real change.
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
