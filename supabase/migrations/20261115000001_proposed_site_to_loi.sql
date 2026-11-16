-- The Proposed site requirement moves from Qualification to the LOI Submission stage.
-- The requirement list lives in the API config (services/requirements.ts); this only re-labels
-- the stage of the rows that are kept: applicants AT or PAST LOI Submission keep their Proposed
-- site data and review status, now shown under LOI Submission. Nothing is deleted here.
-- (Rows of applicants before LOI Submission are removed separately by
-- supabase/scripts/remove_early_proposed_site.mjs, which also deletes their files in storage.)
update public."applicant_requirements" r
set "stage" = 'loi'
from public."applicants" a
where a."id" = r."applicant_id"
  and r."requirement_key" = 'proposed_site'
  and r."stage" <> 'loi'
  and a."status" in ('loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee', 'rejected');
