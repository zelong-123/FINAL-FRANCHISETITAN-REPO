-- ROLLBACK for migrations 20261116000001_stock_status_tracking and 20261116000002_stock_alert_views
-- (Objective 2: stock alerts, stale data, physical count batches). NOT RUN AUTOMATICALLY.
--
-- Use only together with redeploying the previous api function (the copy downloaded before the
-- deploy), otherwise the deployed code will query columns and a table that no longer exist.
-- After running it, mark the migrations reverted:
--   npx supabase migration repair --status reverted 20261116000001 20261116000002
--
-- WARNING: the last statement recreates the old rule "one profittrack_counts row per operation".
-- It FAILS if any franchisee batch count (several materials under one count_batch operation) was
-- saved after the deploy. In that case keep the new index (skip that statement): the old code
-- works with it too, it only never writes more than one row per operation.

begin;

drop table if exists public."stock_alert_views";

drop index if exists public."profittrack_materials_stock_status_idx";
drop index if exists public."profittrack_counts_location_material_idx";
alter table public."profittrack_materials" drop column if exists "stock_status_changed_at";
alter table public."profittrack_materials" drop column if exists "stock_status";

-- Only succeeds when no operation has more than one count row (see the warning above).
create unique index if not exists "profittrack_counts_operation_id_unique" on public."profittrack_counts" ("operation_id");
drop index if exists public."profittrack_counts_operation_material_unique";

commit;
