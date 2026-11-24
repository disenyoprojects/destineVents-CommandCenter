-- Which meetings may have been moved by the old edit bug?
--
-- Until 24 Nov 2026 the meeting form filled its date-time boxes in UTC, then
-- read them back as Manila time on save. So every time a meeting was edited and
-- saved, its start and end moved 8 hours earlier — even if nobody touched the
-- times. A meeting edited twice moved 16 hours.
--
-- The database cannot know what the time used to be, so this lists every
-- meeting that has been saved since it was created, in Manila time, for someone
-- who knows the real schedule to check. A 2 AM "client meeting" is the tell.
--
-- This file is READ-ONLY. It changes nothing. Run it in Supabase -> SQL Editor.

select
  m.id,
  c.name                                                        as client,
  m.title,
  m.status,
  to_char(m.start_datetime at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') as starts_manila,
  to_char(m.end_datetime   at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') as ends_manila,
  extract(hour from m.start_datetime at time zone 'Asia/Manila') not between 7 and 20
                                                                as odd_hour,
  to_char(m.updated_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')     as last_saved_manila
from meetings m
left join clients c on c.id = m.client_id
where m.updated_at is not null
  and m.updated_at > m.created_at + interval '1 minute'
  and m.start_datetime is not null
order by odd_hour desc, m.start_datetime desc;
