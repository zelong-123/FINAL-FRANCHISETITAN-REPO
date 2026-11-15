-- Diagnose Christian Lopez (APL-2026-00022). Read-only.
select id, full_name, applicant_code, status, milestones, preferred_brand_id
from applicants where applicant_code = 'APL-2026-00022';

select id, activity_type, status, starts_at, ends_at, completed_at, review_status,
       approval_status, tasted_brand_id, created_at, venue
from activity_schedules
where applicant_id = (select id from applicants where applicant_code = 'APL-2026-00022')
order by starts_at;

select id, session_id, applicant_id, attendance_status, sales_completed_at, admin_attended_at, activity_schedule_id
from schedule_session_participants
where applicant_id = (select id from applicants where applicant_code = 'APL-2026-00022');

select requirement_key, status from applicant_requirements
where applicant_id = (select id from applicants where applicant_code = 'APL-2026-00022')
order by requirement_key;

select id, type, original_name, documentable_type, documentable_id
from documents
where documentable_type = 'App\Models\ApplicantRequirement'
  and documentable_id in (select id from applicant_requirements where applicant_id = (select id from applicants where applicant_code = 'APL-2026-00022'));
