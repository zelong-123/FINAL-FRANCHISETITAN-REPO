-- Demo data from the Laravel seeders. Development only. Sign-ins are created separately by
-- scripts/create-auth-users.mjs, because passwords live in Supabase Auth.
insert into public."brands" ("id", "name", "code", "description", "is_active", "created_at", "updated_at") overriding system value values
  (1, 'Kkopi', 'KKOPI', 'Kkopi franchise brand', true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08'),
  (2, 'GoDo', 'GODO', 'GoDo franchise brand', true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08'),
  (3, 'Daily Dash', 'DAILY_DASH', 'Daily Dash franchise brand', true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08'),
  (4, 'La Pasta', 'LA_PASTA', 'La Pasta franchise brand', true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08');
select setval(pg_get_serial_sequence('public.brands', 'id'), (select max("id") from public."brands"));
insert into public."chat_channels" ("id", "slug", "name", "type", "department", "description", "created_at", "updated_at") overriding system value values
  (1, 'general', 'General / All Departments', 'department', null, 'Company-wide updates, announcements, and inter-department coordination.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08'),
  (2, 'admin', 'Administration & Executive', 'department', 'admin', 'Executive decisions, policy administration, and system governance.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08'),
  (3, 'marketing', 'Marketing Department', 'department', 'marketing', 'Campaigns, lead acquisition, branding, and promotional strategy.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08'),
  (4, 'sales', 'Sales & Franchise Pipeline', 'department', 'sales', 'Franchise applicant pipeline, discovery calls, contracts, and conversions.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08'),
  (5, 'logistics', 'Logistics & Warehouse', 'department', 'logistics', 'Warehouse stock, inventory replenishment, and supply fulfillment.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08'),
  (6, 'franchisee', 'Franchisee & Branch Operations', 'department', 'franchisee', 'Branch operations, store management, and franchisee support.', '2026-11-07 12:47:54+08', '2026-11-07 12:47:54+08');
select setval(pg_get_serial_sequence('public.chat_channels', 'id'), (select max("id") from public."chat_channels"));
insert into public."users" ("id", "role_id", "full_name", "email", "phone", "email_verified_at", "account_status", "created_at", "updated_at", "archived_at", "archived_by_user_id", "last_seen_at", "suspended_from", "suspended_until", "user_code") overriding system value values
  (1, 3, 'System Administrator', 'admin@franchisetitan.local', null, null, 'active', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08', null, null, null, null, null, 'USR-2026-00001'),
  (2, 1, 'Marketing User', 'marketing@franchisetitan.local', null, null, 'active', '2026-11-07 12:48:01+08', '2026-11-07 12:48:01+08', null, null, null, null, null, 'USR-2026-00002'),
  (3, 2, 'Sales User', 'sales@franchisetitan.local', null, null, 'active', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, 'USR-2026-00003'),
  (4, 4, 'Logistics User', 'logistics@franchisetitan.local', null, null, 'active', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, 'USR-2026-00004'),
  (5, 5, 'Sample Franchisee', 'franchisee@franchisetitan.local', null, null, 'active', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, 'USR-2026-00005'),
  (6, 5, 'Branch 1 Operator', 'branch1@herald.local', '09171110001', null, 'active', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, 'USR-2026-00006'),
  (7, 5, 'Branch 2 Operator', 'branch2@herald.local', '09171110002', null, 'active', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, 'USR-2026-00007'),
  (8, 5, 'Branch 3 Operator', 'branch3@herald.local', '09171110003', null, 'active', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, 'USR-2026-00008'),
  (9, 5, 'Branch 4 Operator', 'branch4@herald.local', '09171110004', null, 'active', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, 'USR-2026-00009');
select setval(pg_get_serial_sequence('public.users', 'id'), (select max("id") from public."users"));
insert into public."warehouse_backup_categories" ("id", "source_category_id", "name", "backed_up_at") overriding system value values
  (1, 1, 'Dairy', '2026-11-07 12:47:58+08'),
  (2, 2, 'Bases', '2026-11-07 12:47:58+08'),
  (3, 3, 'Flavoring', '2026-11-07 12:47:58+08'),
  (4, 4, 'Sweetener', '2026-11-07 12:47:58+08'),
  (5, 5, 'Toppings', '2026-11-07 12:47:58+08'),
  (6, 6, 'Dessert', '2026-11-07 12:47:58+08'),
  (7, 7, 'Packaging', '2026-11-07 12:47:58+08'),
  (8, 8, 'Syrups', '2026-11-07 12:47:58+08'),
  (9, 9, 'Pasta', '2026-11-07 12:47:58+08'),
  (10, 10, 'Grains', '2026-11-07 12:47:58+08'),
  (11, 11, 'Sauces', '2026-11-07 12:47:58+08'),
  (12, 12, 'Ingredients', '2026-11-07 12:47:58+08'),
  (13, 13, 'Tools', '2026-11-07 12:47:58+08'),
  (14, 14, 'Powder', '2026-11-07 12:47:58+08');
select setval(pg_get_serial_sequence('public.warehouse_backup_categories', 'id'), (select max("id") from public."warehouse_backup_categories"));
insert into public."applicants" ("id", "inquiry_id", "user_id", "preferred_brand_id", "full_name", "email", "phone", "address", "status", "application_date", "approved_at", "rejected_at", "notes", "created_at", "updated_at", "archived_at", "archived_by_user_id", "milestones", "milestone_details", "loi_confirmed_at", "loi_confirmed_by_user_id", "loi_remarks", "payment_confirmed_at", "payment_confirmed_by_user_id", "payment_remarks", "reviewed_at", "reviewed_by_user_id", "review_remarks", "package_name", "total_required_amount", "initial_payment_amount", "other_fees", "loi_submission_date", "loi_received_by", "loi_submission_type", "loi_verification_status", "payment_stage_state", "total_required_set_at", "total_required_set_by_user_id", "payment_turned_over_at", "payment_turned_over_by_user_id", "payment_returned_at", "payment_returned_by_user_id", "payment_returned_note", "payments_fully_paid_on", "total_required_original_amount", "total_required_discount_percent", "qualified_at", "qualified_by_user_id", "approved_by_user_id", "applicant_code", "loi_status", "loi_proceeded_at", "loi_proceeded_by_user_id", "loi_completed_at", "loi_completed_by_user_id") overriding system value values
  (1, null, 5, 1, 'Sample Franchisee', 'franchisee@franchisetitan.local', '09170000000', 'Las Piñas City', 'active_franchisee', '2026-09-07 00:00:00', '2026-10-07 12:48:02+08', null, null, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'APL-2026-00001', null, null, null, null, null),
  (2, null, 6, 1, 'Branch 1 Operator', 'branch1@herald.local', '09171110001', 'Las Piñas City, Philippines', 'active_franchisee', '2026-08-07 00:00:00', '2026-09-07 12:48:02+08', null, null, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'APL-2026-00002', null, null, null, null, null),
  (3, null, 7, 2, 'Branch 2 Operator', 'branch2@herald.local', '09171110002', 'Makati City, Philippines', 'active_franchisee', '2026-08-07 00:00:00', '2026-09-07 12:48:03+08', null, null, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'APL-2026-00003', null, null, null, null, null),
  (4, null, 8, 3, 'Branch 3 Operator', 'branch3@herald.local', '09171110003', 'Quezon City, Philippines', 'active_franchisee', '2026-08-07 00:00:00', '2026-09-07 12:48:03+08', null, null, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'APL-2026-00004', null, null, null, null, null),
  (5, null, 9, 4, 'Branch 4 Operator', 'branch4@herald.local', '09171110004', 'Pasig City, Philippines', 'active_franchisee', '2026-08-07 00:00:00', '2026-09-07 12:48:03+08', null, null, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'APL-2026-00005', null, null, null, null, null);
select setval(pg_get_serial_sequence('public.applicants', 'id'), (select max("id") from public."applicants"));
insert into public."product_categories" ("id", "name", "created_at", "updated_at", "brand_id", "name_normalized") overriding system value values
  (15, 'Syrup / Flavoring', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'syrup / flavoring'),
  (16, 'Powder / Mixes', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'powder / mixes'),
  (17, 'Tea Base', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'tea base'),
  (18, 'Coffee Base', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'coffee base'),
  (19, 'Dairy / Creamer', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'dairy / creamer'),
  (20, 'Toppings', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'toppings'),
  (21, 'Sweeteners', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'sweeteners'),
  (22, 'Frappe Ingredients', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'frappe ingredients'),
  (23, 'Other Ingredients', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'other ingredients'),
  (24, 'Packaging', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', 1, 'packaging');
select setval(pg_get_serial_sequence('public.product_categories', 'id'), (select max("id") from public."product_categories"));
insert into public."applicant_status_histories" ("id", "applicant_id", "from_status", "to_status", "remarks", "changed_by_user_id", "created_at", "updated_at") overriding system value values
  (1, 1, 'approved', 'active_franchisee', 'Seed franchisee account.', 1, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08');
select setval(pg_get_serial_sequence('public.applicant_status_histories', 'id'), (select max("id") from public."applicant_status_histories"));
insert into public."franchisees" ("id", "applicant_id", "user_id", "business_name", "franchise_status", "approval_date", "created_at", "updated_at") overriding system value values
  (1, 1, 5, 'Kkopi Sample Branch', 'active', '2026-10-07 00:00:00', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08'),
  (2, 2, 6, 'Herald Branch 1 - Las Piñas', 'active', '2026-09-07 00:00:00', '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08'),
  (3, 3, 7, 'Herald Branch 2 - Makati', 'active', '2026-09-07 00:00:00', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08'),
  (4, 4, 8, 'Herald Branch 3 - Quezon City', 'active', '2026-09-07 00:00:00', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08'),
  (5, 5, 9, 'Herald Branch 4 - Pasig', 'active', '2026-09-07 00:00:00', '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08');
select setval(pg_get_serial_sequence('public.franchisees', 'id'), (select max("id") from public."franchisees"));
insert into public."franchise_locations" ("id", "franchisee_id", "brand_id", "name", "type", "address", "city", "province", "region", "contact_number", "is_active", "created_at", "updated_at", "branch_code", "preferred_branch_type", "opening_date", "is_demo", "archived_at", "archived_by_user_id", "archive_reason") overriding system value values
  (1, null, null, 'Franchise Titan Central Warehouse', 'warehouse', 'Las Piñas City, Philippines', 'Las Piñas', null, 'NCR', null, true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, false, null, null, null),
  (2, 1, 1, 'Kkopi - Las Piñas Sample', 'franchise', 'Las Piñas City, Philippines', 'Las Piñas', null, 'NCR', '09170000000', true, '2026-11-07 12:48:02+08', '2026-11-07 12:48:02+08', null, null, null, true, null, null, null),
  (3, 2, 1, 'Herald Branch 1 - Las Piñas', 'franchise', 'Las Piñas City, Philippines', 'Las Piñas', null, 'NCR', '09171110001', true, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', 'branch-1', null, null, true, null, null, null),
  (4, 3, 2, 'Herald Branch 2 - Makati', 'franchise', 'Makati City, Philippines', 'Makati', null, 'NCR', '09171110002', true, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', 'branch-2', null, null, true, null, null, null),
  (5, 4, 3, 'Herald Branch 3 - Quezon City', 'franchise', 'Quezon City, Philippines', 'Quezon', null, 'NCR', '09171110003', true, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', 'branch-3', null, null, true, null, null, null),
  (6, 5, 4, 'Herald Branch 4 - Pasig', 'franchise', 'Pasig City, Philippines', 'Pasig', null, 'NCR', '09171110004', true, '2026-11-07 12:48:03+08', '2026-11-07 12:48:03+08', 'branch-4', null, null, true, null, null, null);
select setval(pg_get_serial_sequence('public.franchise_locations', 'id'), (select max("id") from public."franchise_locations"));
