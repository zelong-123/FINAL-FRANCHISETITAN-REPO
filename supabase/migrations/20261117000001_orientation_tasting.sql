-- Orientation and Product Tasting become ONE activity: Orientation/Tasting (stored key 'orientation').
-- Completing it now carries attendance proof, a brand selection document and the selected brand, and
-- Admin must open every file before verifying. Additive only; the Product Tasting rows themselves are
-- removed separately by supabase/scripts/merge_product_tasting.ts (dry-run first).

-- 1. The brand the applicant inquired about, kept when Orientation/Tasting selects another one.
alter table public."applicants" add column if not exists "inquiry_brand_id" bigint references public."brands" ("id") on delete set null;
update public."applicants" a
set "inquiry_brand_id" = coalesce((select i.preferred_brand_id from public."franchise_inquiries" i where i.id = a.inquiry_id), a.preferred_brand_id)
where a."inquiry_brand_id" is null;

-- 2. The brand Sales selected when completing Orientation/Tasting (verified by Admin).
alter table public."activity_schedules" add column if not exists "selected_brand_id" bigint references public."brands" ("id") on delete set null;
-- Legacy: an Orientation completed under the old flow by an applicant already past Scheduling keeps
-- the applicant's current brand as its selected brand (no proof or brand document required).
update public."activity_schedules" s
set "selected_brand_id" = a.preferred_brand_id
from public."applicants" a
where a.id = s.applicant_id and s.activity_type = 'orientation' and s.status = 'completed' and s.selected_brand_id is null
  and a.status in ('loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee', 'rejected');

-- 3. Which Admin opened which submitted file, and when (Verify needs every current file opened
--    after the latest submission).
create table if not exists public."activity_document_views" (
  "document_id" bigint not null references public."documents" ("id") on delete cascade,
  "user_id" bigint not null references public."users" ("id") on delete cascade,
  "first_viewed_at" timestamptz not null default now(),
  "last_viewed_at" timestamptz not null default now(),
  primary key ("document_id", "user_id")
);
alter table public."activity_document_views" enable row level security;
revoke all on public."activity_document_views" from anon, authenticated;
