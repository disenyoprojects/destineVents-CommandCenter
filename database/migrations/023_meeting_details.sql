-- Meetings — type, timezone, location, owner, participants, outcome
--
-- November handover §13.3. The meetings table only ever existed in
-- database/schema/hq/meetings/meetings.sql; this makes it part of the numbered
-- migrations (creating it if that file was never run) and adds what a meeting
-- record is missing:
--
--   meeting_type        Discovery / Sales / Project Consultation / Client Review /
--                       Internal (the list lives in config/settings.ts). The old
--                       `stage` stays as it is — it drives the client's CRM label.
--   timezone            the timezone the start and end were entered in
--   location            a place, or a link other than the Google Meet one
--   owner_id/owner_name the internal person responsible
--   contact_name        the person met at the client
--   proposal_id         the quotation (opportunity) the meeting is about
--   participants        internal and external attendees, as a list of
--                       { name, email, internal, user_id }
--   outcome, follow_up_actions, next_steps — what came of it
--
-- Nothing existing is changed or removed. Safe to re-run.
-- Run this in Supabase -> SQL Editor, BEFORE deploying the app version with
-- the new meeting form (it reads and writes these columns).

-- ── The table, if meetings.sql was never run ─────────────────────────────────
create table if not exists meetings (
  id                  bigint primary key default extract(epoch from now())::bigint,
  client_id           bigint references clients(id) on delete set null,
  stage               text not null default 'Discovery',
  status              text not null default 'Not Scheduled',
  title               text,
  start_datetime      timestamptz,
  end_datetime        timestamptz,
  meeting_notes       text,
  google_meet_link    text,
  calendar_event_link text,
  google_event_id     text,
  recording_link      text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table meetings enable row level security;

-- Access is unchanged: admin only, as before. Widening it waits on the lead's
-- decision about who may manage meetings.
drop policy if exists "meetings_admin" on meetings;
create policy "meetings_admin" on meetings for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ── New columns ──────────────────────────────────────────────────────────────
alter table meetings
  add column if not exists meeting_type      text,
  add column if not exists timezone          text not null default 'Asia/Manila',
  add column if not exists location          text,
  add column if not exists owner_id          uuid,
  add column if not exists owner_name        text,
  add column if not exists contact_name      text,
  add column if not exists proposal_id       bigint references proposals(id) on delete set null,
  add column if not exists participants      jsonb not null default '[]'::jsonb,
  add column if not exists outcome           text,
  add column if not exists follow_up_actions text,
  add column if not exists next_steps        text;

create index if not exists meetings_start_idx    on meetings (start_datetime);
create index if not exists meetings_client_idx   on meetings (client_id);
create index if not exists meetings_proposal_idx on meetings (proposal_id);

-- ── Check (read-only) ────────────────────────────────────────────────────────
-- Expect one row per meeting status, and every meeting on Asia/Manila.
select status, timezone, count(*) as meetings
  from meetings
 group by status, timezone
 order by status;
