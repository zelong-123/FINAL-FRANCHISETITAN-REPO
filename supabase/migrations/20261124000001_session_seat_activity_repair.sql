-- Session seats always have a live activity record (fix for: joining a session did not schedule the applicant).
-- Safe to run again: step 1 uses if (not) exists, step 2 only touches seats that are still broken.

-- 1. One live record per applicant, title and start time. The old index also counted cancelled and
--    rejected records, so a new schedule could not take the time of a cancelled one: the join then
--    re-used the cancelled record and the applicant stayed "Not scheduled". Cancelled / rejected
--    records stay as history; the rule now matches the API's duplicate check (live records only).
create unique index if not exists "activity_schedules_unique_live_slot" on public."activity_schedules" ("applicant_id", "title", "starts_at")
  where "status" in ('pending', 'confirmed') and "approval_status" <> 'rejected';
drop index if exists public."activity_schedules_unique_slot";

-- 2. Repair: every active seat in a live session whose linked record is missing or no longer live gets a
--    NEW record that mirrors its session (the old record is not changed), the seat is linked to it, and the
--    repair is logged in audit_logs and the applicant's stage history (append-only).
with broken as (
  select p.id as participant_id, p.applicant_id, s.id as session_id, s.activity_type, s.start_at, s.end_at, s.venue, s.meeting_link, s.handler_id,
    s.status as session_status, coalesce(s.legacy_session_key, 'session-' || s.id) as session_key, p.activity_schedule_id as old_activity_id,
    a.status as applicant_status,
    coalesce(
      (select h.changed_by_user_id from public."applicant_stage_histories" h
        where h.applicant_id = p.applicant_id and h.event in ('participant_added', 'scheduled') and h.context->>'session_id' = s.id::text and h.changed_by_user_id is not null
        order by h.id desc limit 1),
      s.created_by,
      (select u.id from public."users" u join public."roles" r on r.id = u.role_id where r.name = 'admin' order by u.id limit 1)
    ) as scheduled_by
  from public."schedule_session_participants" p
  join public."schedule_sessions" s on s.id = p.session_id
  join public."applicants" a on a.id = p.applicant_id
  left join public."activity_schedules" x on x.id = p.activity_schedule_id
  where p.attendance_status = 'scheduled' and s.status in ('pending', 'confirmed') and s.activity_type in ('orientation', 'training')
    and (x.id is null or x.status not in ('pending', 'confirmed') or x.approval_status = 'rejected')
    -- never a second live record for the same activity
    and not exists (select 1 from public."activity_schedules" y where y.applicant_id = p.applicant_id and y.activity_type = s.activity_type
      and y.status in ('pending', 'confirmed') and y.approval_status <> 'rejected')
),
created as (
  insert into public."activity_schedules" (applicant_id, activity_type, title, starts_at, ends_at, duration_minutes, venue, meeting_link, assigned_to_user_id,
    session_key, approval_status, status, participants, scheduled_by_user_id, live_key)
  select b.applicant_id, b.activity_type, case b.activity_type when 'orientation' then 'Orientation/Tasting' else 'Training' end, b.start_at, b.end_at,
    (extract(epoch from (b.end_at - b.start_at)) / 60)::smallint, b.venue, b.meeting_link, b.handler_id, b.session_key,
    case when b.session_status = 'pending' then 'pending_admin' else 'immediate' end, 'confirmed', '[]'::jsonb, b.scheduled_by, b.applicant_id || ':' || b.activity_type
  from broken b
  returning id, applicant_id, activity_type
),
linked as (
  update public."schedule_session_participants" p set activity_schedule_id = c.id, updated_at = now()
  from created c join broken b on b.applicant_id = c.applicant_id and b.activity_type = c.activity_type
  where p.id = b.participant_id
  returning p.id as participant_id, c.id as activity_id, b.applicant_id, b.session_id, b.activity_type, b.start_at, b.old_activity_id, b.applicant_status
),
audited as (
  insert into public."audit_logs" (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at)
  select null, 'activity.created', 'App\Models\ActivitySchedule', l.activity_id, null,
    jsonb_build_object('repair', 'session seat without a live activity record', 'session_id', l.session_id, 'participant_id', l.participant_id,
      'previous_activity_id', l.old_activity_id, 'migration', '20261124000001_session_seat_activity_repair'),
    now()
  from linked l
  returning id
)
insert into public."applicant_stage_histories" (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, context, step)
select l.applicant_id, l.applicant_status, l.applicant_status,
  'Repaired: the seat in session #' || l.session_id || ' had no live activity record; a new record was created and linked.', null, now(), 'scheduled',
  jsonb_build_object('session_id', l.session_id, 'activity_id', l.activity_id, 'activity_type', l.activity_type, 'start_at', l.start_at, 'via', 'repair',
    'audit_count', (select count(*) from audited)),
  'scheduled'
from linked l;
