-- Roles and units: required for the app to run in every environment.
insert into public."roles" ("id", "name", "label", "created_at", "updated_at") overriding system value values
  (1, 'marketing', 'Marketing Personnel', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08'),
  (2, 'sales', 'Sales Personnel', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08'),
  (3, 'admin', 'Administrator', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08'),
  (4, 'logistics', 'Logistics Personnel', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08'),
  (5, 'franchisee', 'Applicant / Franchisee', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08');
select setval(pg_get_serial_sequence('public.roles', 'id'), (select max("id") from public."roles"));
insert into public."units" ("id", "name", "name_normalized", "created_at", "updated_at") overriding system value values
  (1, 'pcs', 'pcs', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (2, 'g', 'g', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (3, 'kg', 'kg', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (4, 'ml', 'ml', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (5, 'L', 'l', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (6, 'oz', 'oz', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (7, 'lb', 'lb', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (8, 'pack', 'pack', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (9, 'box', 'box', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (10, 'bottle', 'bottle', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (11, 'can', 'can', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (12, 'sachet', 'sachet', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (13, 'bag', 'bag', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (14, 'tray', 'tray', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (15, 'sack', 'sack', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08'),
  (16, 'piece', 'piece', '2026-11-07 12:47:58+08', '2026-11-07 12:47:58+08');
select setval(pg_get_serial_sequence('public.units', 'id'), (select max("id") from public."units"));
