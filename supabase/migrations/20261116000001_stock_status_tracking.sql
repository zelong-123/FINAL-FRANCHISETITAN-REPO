-- Objective 2: branch inventory visibility. Each branch material remembers its stock status and
-- when it last CHANGED, so Admin and Logistics see new low / critical items on the Branches cards.
-- Additive only. The rule mirrors services/materialStock.ts evaluate() and defaultLevels().

alter table public."profittrack_materials" add column if not exists "stock_status" text;
alter table public."profittrack_materials" add column if not exists "stock_status_changed_at" timestamptz;
comment on column public."profittrack_materials"."stock_status" is
  'ok | low | critical | out, kept in step with the balance and levels by services/materialStock.ts syncStockStatus().';
comment on column public."profittrack_materials"."stock_status_changed_at" is
  'When stock_status last changed. Null for the first status (backfill or a new material), so nothing reads as new.';

-- Backfill the current status. stock_status_changed_at stays null: nothing shows as "new" after deploy.
update public."profittrack_materials" m
set "stock_status" = case
    when x.on_hand <= 0 then 'out'
    when x.on_hand <= x.critical then 'critical'
    when x.on_hand <= x.low then 'low'
    else 'ok' end
from (
  select m2.id,
         coalesce((select b.quantity_milli from public."profittrack_material_balances" b where b.material_id = m2.id limit 1), 0) / 1000.0 as on_hand,
         coalesce(m2.low_level, case when lower(btrim(m2.unit)) in ('g', 'ml') then 5000 when lower(btrim(m2.unit)) in ('kg', 'l') then 5 else 50 end) as low,
         coalesce(m2.critical_level, case when lower(btrim(m2.unit)) in ('g', 'ml') then 1000 when lower(btrim(m2.unit)) in ('kg', 'l') then 1 else 10 end) as critical
  from public."profittrack_materials" m2
) x
where x.id = m.id and m."stock_status" is null;

create index if not exists "profittrack_materials_stock_status_idx"
  on public."profittrack_materials" ("stock_status", "stock_status_changed_at") where "is_active" = true;
-- Last count per material comes from profittrack_counts joined to its operation.
create index if not exists "profittrack_counts_location_material_idx" on public."profittrack_counts" ("location_id", "material_id");

-- A franchisee physical count is ONE operation (count_batch) with one profittrack_counts row per
-- material. The old rule allowed one count row per operation; it becomes one row per material per
-- operation. Existing single counts already satisfy the new rule. No data or column changes.
create unique index if not exists "profittrack_counts_operation_material_unique" on public."profittrack_counts" ("operation_id", "material_id");
drop index if exists public."profittrack_counts_operation_id_unique";
