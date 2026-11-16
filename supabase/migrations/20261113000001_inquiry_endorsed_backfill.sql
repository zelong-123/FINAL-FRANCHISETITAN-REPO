-- Existing endorsed leads were endorsed before the red dot existed, so they have no
-- notification. Give the receiving user one unread notification per endorsed lead
-- (opening the lead marks it read, as for new endorsements). Re-running adds nothing.
insert into public."system_notifications" (user_id, type, title, message, data, created_at)
select i.endorsed_to_user_id,
       'inquiry_endorsed',
       'New inquiry endorsed',
       'Inquiry from ' || i.lead_name || ' has been endorsed to you.',
       jsonb_build_object('inquiry_id', i.id),
       coalesce(i.updated_at, now())
from public."franchise_inquiries" i
where i.status = 'endorsed'
  and i.archived_at is null
  and i.endorsed_to_user_id is not null
  and not exists (
    select 1 from public."system_notifications" n
    where n.user_id = i.endorsed_to_user_id
      and n.type = 'inquiry_endorsed'
      and (n.data ->> 'inquiry_id')::bigint = i.id
  );
