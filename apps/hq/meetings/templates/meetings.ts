import type { Meeting, Client, InternUser, Proposal } from '@shared/types';
import { escapeHtml } from '@shared/utils/helpers.ts';
import { APP_SETTINGS } from '@config/settings.ts';
import {
  meetingStats, utcToZonedWallTime, formatExternalParticipants, isValidTimezone,
} from '../meetingCalc.ts';

// Stage is the CRM pipeline step (it drives the client's stage label on the
// Clients page); type is what kind of meeting it is (§13.3). Types and
// timezones are configured in config/settings.ts.
export const MEETING_STAGES = ['Discovery', 'Strategy & Proposal', 'Kickoff'] as const;
export const MEETING_STATUSES = ['Not Scheduled', 'Scheduled', 'Completed', 'Cancelled', 'No Show'] as const;
export const MEETING_TYPES: readonly string[] = APP_SETTINGS.meetings.types;
export const MEETING_TIMEZONES: readonly string[] = APP_SETTINGS.meetings.timezones;
export const DEFAULT_MEETING_TZ = APP_SETTINGS.meetings.defaultTimezone;

export const MEETING_STATUS_CLASS: Record<string, string> = {
  'Not Scheduled': 'pending',
  'Scheduled':     'active',
  'Completed':     'completed',
  'Cancelled':     'cancelled',
  'No Show':       'lost',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// A meeting's time is shown in its own timezone, named when it is not the
// default — "Nov 25, 2026 9:00 AM (Australia/Sydney)".
// A zone this browser cannot read falls back to the default rather than
// breaking the page — the column is free text.
export function meetingTz(m: Partial<Meeting>): string {
  return m.timezone && isValidTimezone(m.timezone) ? m.timezone : DEFAULT_MEETING_TZ;
}

function fmtDatetime(dt: string | null, tz: string = DEFAULT_MEETING_TZ): string {
  if (!dt) return '—';
  const d = new Date(dt);
  const text = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }) +
    ' ' + d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
  return tz === DEFAULT_MEETING_TZ ? text : `${text} <span style="color:var(--ink-3);font-size:10px">(${escapeHtml(tz)})</span>`;
}

function fmtDate(dt: string | null): string {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(dt: string | null): string {
  if (!dt) return '';
  return new Date(dt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function calcDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const mins = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (mins <= 0) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function clientName(m: Meeting, clients: Client[]): string {
  if (!m.client_id) return '—';
  const c = clients.find(c => c.id === m.client_id);
  return c ? escapeHtml(c.name) : '—';
}

function meetLinkHTML(m: Meeting): string {
  if (!m.google_meet_link) return '<span style="color:var(--ink-3)">—</span>';
  return `<a href="${escapeHtml(m.google_meet_link)}" target="_blank" rel="noopener"
    style="color:var(--blue);font-size:11px">Join Meet</a>`;
}

function actionButtons(m: Meeting): string {
  const editBtn = `<button role="menuitem" onclick="openEditMeeting(${m.id})">Edit</button>`;
  const delBtn  = `<button role="menuitem" style="color:var(--red)" onclick="handleDeleteMeeting(${m.id})">Delete</button>`;
  // JSON.stringify makes the title a safe JS string (quotes, backslashes,
  // newlines); escapeHtml then makes that safe inside the attribute.
  const logBtn  = `<button role="menuitem" onclick="openDocActivityLog('meeting',${m.id},${escapeHtml(JSON.stringify(m.title ?? 'Meeting'))})">Activity Log</button>`;

  let statusActions = '';
  if (m.status === 'Not Scheduled') {
    statusActions = `<button role="menuitem" onclick="openRescheduleMeeting(${m.id})">Schedule</button>`;
  } else if (m.status === 'Scheduled') {
    statusActions = `
      <button role="menuitem" onclick="markMeetingCompleted(${m.id})">Mark Completed</button>
      <button role="menuitem" onclick="openRescheduleMeeting(${m.id})">Reschedule</button>
      <button role="menuitem" onclick="markMeetingNoShow(${m.id})">No Show</button>
      <button role="menuitem" onclick="cancelMeeting(${m.id})">Cancel</button>`;
  } else if (m.status === 'Cancelled' || m.status === 'No Show') {
    statusActions = `<button role="menuitem" onclick="openRescheduleMeeting(${m.id})">Reschedule</button>`;
  }

  return `
    <div class="action-menu">
      <button class="btn btn-ghost btn-sm" onclick="toggleActionMenu(this)">Actions ▾</button>
      <div class="action-menu-dropdown" role="menu">
        ${statusActions}
        ${editBtn}
        ${logBtn}
        ${delBtn}
      </div>
    </div>`;
}

// ── Table row ─────────────────────────────────────────────────────────────────

export function meetingTableHTML(meetings: Meeting[], clients: Client[]): string {
  return meetings.map(m => {
    const cls = MEETING_STATUS_CLASS[m.status] ?? 'pending';
    const stageCls = m.stage === 'Kickoff' ? 'completed' : m.stage === 'Strategy & Proposal' ? 'sent' : 'pending';
    return `
    <tr>
      <td><span class="text-bold">${clientName(m, clients)}</span>${m.contact_name ? `<div style="font-size:10px;color:var(--ink-3)">${escapeHtml(m.contact_name)}</div>` : ''}</td>
      <td style="font-size:11px">${escapeHtml(m.meeting_type ?? '—')}<div><span class="badge badge-${stageCls}" style="font-size:9px">${escapeHtml(m.stage)}</span></div></td>
      <td><span class="badge badge-${cls}">${escapeHtml(m.status)}</span></td>
      <td>${escapeHtml(m.title ?? '—')}${m.owner_name ? `<div style="font-size:10px;color:var(--ink-3)">Owner: ${escapeHtml(m.owner_name)}</div>` : ''}</td>
      <td style="white-space:nowrap">${fmtDatetime(m.start_datetime, meetingTz(m))}</td>
      <td style="white-space:nowrap">${calcDuration(m.start_datetime, m.end_datetime)}</td>
      <td>${meetLinkHTML(m)}${m.location ? `<div style="font-size:10px;color:var(--ink-3)">${escapeHtml(m.location)}</div>` : ''}</td>
      <td>${actionButtons(m)}</td>
    </tr>`;
  }).join('');
}

// ── Form ──────────────────────────────────────────────────────────────────────

export interface MeetingFormOptions {
  clients: Client[];
  users: InternUser[];        // HQ users: owner and internal participants
  proposals: Proposal[];      // opportunities the meeting can be about
  heading?: string;           // e.g. a note shown when rescheduling
}

function options(values: readonly string[], selected: string | null | undefined): string {
  return values.map(v => `<option${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

const section = (title: string) =>
  `<div class="form-group full" style="margin-top:6px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)">${title}</div></div>`;

export function meetingFormHTML(m: Partial<Meeting> = {}, opts: MeetingFormOptions): string {
  const tz = meetingTz(m);
  const timezones = MEETING_TIMEZONES.includes(tz) ? MEETING_TIMEZONES : [tz, ...MEETING_TIMEZONES];
  const clientOpts = opts.clients.map(c =>
    `<option value="${c.id}"${m.client_id === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
  // A saved owner, participant or quotation that is not in today's lists (a
  // user since removed, a list that failed to load) is still shown and kept,
  // so an edit never wipes it without anyone noticing.
  const userIds = new Set(opts.users.map(u => u.id));
  const formerOwner = m.owner_id && !userIds.has(m.owner_id)
    ? `<option value="${escapeHtml(m.owner_id)}" selected>${escapeHtml(m.owner_name ?? 'Former owner')} (no longer in HQ)</option>` : '';
  const ownerOpts = formerOwner + opts.users.map(u =>
    `<option value="${escapeHtml(u.id)}"${m.owner_id === u.id ? ' selected' : ''}>${escapeHtml(u.name)}</option>`
  ).join('');
  const missingProposal = m.proposal_id && !opts.proposals.some(p => p.id === m.proposal_id)
    ? `<option value="${m.proposal_id}" selected>Quotation #${m.proposal_id} (not loaded)</option>` : '';
  const proposalOpts = missingProposal + opts.proposals.map(p =>
    `<option value="${p.id}"${m.proposal_id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}${p.client ? ` — ${escapeHtml(p.client)}` : ''} (${escapeHtml(p.status)})</option>`
  ).join('');
  const internal = (m.participants ?? []).filter(p => p.internal);
  const internalIds = new Set(internal.map(p => p.user_id));
  const box = (id: string, label: string, checked: boolean) => `
        <label style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 4px 0;font-size:12px">
          <input type="checkbox" class="mt-internal" value="${escapeHtml(id)}"${checked ? ' checked' : ''}/> ${label}
        </label>`;
  const formerBoxes = internal
    .filter(p => p.user_id && !userIds.has(p.user_id))
    .map(p => box(p.user_id!, `${escapeHtml(p.name)} (no longer in HQ)`, true)).join('');
  const internalBoxes = opts.users.length || formerBoxes
    ? formerBoxes + opts.users.map(u => box(u.id, escapeHtml(u.name), internalIds.has(u.id))).join('')
    : '<div style="font-size:11px;color:var(--ink-3)">No HQ users found.</div>';

  return `
  ${opts.heading ? `<div style="background:var(--linen-3);border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:var(--ink-2)">${opts.heading}</div>` : ''}
  <div class="form-grid">
    <div class="form-group full">
      <div class="form-label">Meeting Title <span class="req">*</span></div>
      <input class="form-input" id="mt-title" placeholder="e.g. Initial Discovery Call" value="${escapeHtml(m.title ?? '')}"/>
    </div>
    <div class="form-group">
      <div class="form-label">Type <span class="req">*</span></div>
      <select class="form-input" id="mt-type"><option value="">— Select —</option>${options(MEETING_TYPES, m.meeting_type)}</select>
    </div>
    <div class="form-group">
      <div class="form-label">CRM Stage</div>
      <select class="form-input" id="mt-stage">${options(MEETING_STAGES, m.stage ?? 'Discovery')}</select>
    </div>
    <div class="form-group">
      <div class="form-label">Status</div>
      <select class="form-input" id="mt-status">${options(MEETING_STATUSES, m.status ?? 'Scheduled')}</select>
    </div>
    <div class="form-group">
      <div class="form-label">Owner</div>
      <select class="form-input" id="mt-owner"><option value="">— Nobody yet —</option>${ownerOpts}</select>
    </div>

    ${section('When &amp; where')}
    <div class="form-group">
      <div class="form-label">Start</div>
      <input class="form-input" id="mt-start" type="datetime-local" value="${utcToZonedWallTime(m.start_datetime, tz)}"/>
    </div>
    <div class="form-group">
      <div class="form-label">End</div>
      <input class="form-input" id="mt-end" type="datetime-local" value="${utcToZonedWallTime(m.end_datetime, tz)}"/>
    </div>
    <div class="form-group">
      <div class="form-label">Timezone</div>
      <select class="form-input" id="mt-timezone" data-prev="${escapeHtml(tz)}" onchange="onMeetingTimezoneChange(this)">${options(timezones, tz)}</select>
      <div style="font-size:10.5px;color:var(--ink-3);margin-top:3px">Changing it keeps the same moment and converts the times.</div>
    </div>
    <div class="form-group">
      <div class="form-label">Location</div>
      <input class="form-input" id="mt-location" placeholder="Office, venue, or other link" value="${escapeHtml(m.location ?? '')}"/>
    </div>
    <div class="form-group">
      <div class="form-label">Google Meet Link</div>
      <input class="form-input" id="mt-meet" type="url" placeholder="https://meet.google.com/…" value="${escapeHtml(m.google_meet_link ?? '')}"/>
    </div>
    <div class="form-group">
      <div class="form-label">Recording Link</div>
      <input class="form-input" id="mt-recording" type="url" placeholder="https://…" value="${escapeHtml(m.recording_link ?? '')}"/>
    </div>

    ${section('Who')}
    <div class="form-group">
      <div class="form-label">Client</div>
      <select class="form-input" id="mt-client"><option value="">— No client (internal) —</option>${clientOpts}</select>
    </div>
    <div class="form-group">
      <div class="form-label">Contact Person</div>
      <input class="form-input" id="mt-contact" placeholder="Who you are meeting at the client" value="${escapeHtml(m.contact_name ?? '')}"/>
    </div>
    <div class="form-group full">
      <div class="form-label">Opportunity (quotation)</div>
      <select class="form-input" id="mt-proposal"><option value="">— None —</option>${proposalOpts}</select>
    </div>
    <div class="form-group full">
      <div class="form-label">Internal Participants</div>
      <div>${internalBoxes}</div>
    </div>
    <div class="form-group full">
      <div class="form-label">External Participants</div>
      <textarea class="form-input" id="mt-external" rows="3" placeholder="One per line — e.g. Ana Cruz &lt;ana@client.ph&gt;">${escapeHtml(formatExternalParticipants(m.participants ?? []))}</textarea>
    </div>

    ${section('Notes &amp; outcome')}
    <div class="form-group full">
      <div class="form-label">Meeting Notes</div>
      <textarea class="form-input" id="mt-notes" rows="3" placeholder="Key discussion points">${escapeHtml(m.meeting_notes ?? '')}</textarea>
    </div>
    <div class="form-group full">
      <div class="form-label">Outcome</div>
      <textarea class="form-input" id="mt-outcome" rows="2" placeholder="What was decided">${escapeHtml(m.outcome ?? '')}</textarea>
    </div>
    <div class="form-group">
      <div class="form-label">Follow-up Actions</div>
      <textarea class="form-input" id="mt-followups" rows="3" placeholder="Who does what, by when">${escapeHtml(m.follow_up_actions ?? '')}</textarea>
    </div>
    <div class="form-group">
      <div class="form-label">Next Steps</div>
      <textarea class="form-input" id="mt-next" rows="3" placeholder="e.g. Send quotation; book kickoff">${escapeHtml(m.next_steps ?? '')}</textarea>
    </div>
  </div>`;
}

// ── Overview: stat cards + upcoming list ──────────────────────────────────────

export function meetingOverviewHTML(meetings: Meeting[], now: Date): string {
  const { upcoming, completedThisMonth, noShows, total, next7Days: upcomingSoon } = meetingStats(meetings, now);

  const statsHTML = `
    <div class="finance-stat-grid" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-label">Upcoming</div>
        <div class="stat-value" style="font-size:28px;color:var(--blue)">${upcoming}</div>
        <div class="stat-change">${upcoming === 1 ? '1 scheduled' : `${upcoming} scheduled`}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed This Month</div>
        <div class="stat-value" style="font-size:28px;color:var(--green)">${completedThisMonth}</div>
        <div class="stat-change">${completedThisMonth === 1 ? '1 meeting' : `${completedThisMonth} meetings`}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">No Shows</div>
        <div class="stat-value" style="font-size:28px;color:var(--amber)">${noShows}</div>
        <div class="stat-change">all time</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Meetings</div>
        <div class="stat-value" style="font-size:28px">${total}</div>
        <div class="stat-change">all time</div>
      </div>
    </div>`;

  const upcomingHTML = upcomingSoon.length === 0
    ? `<div style="color:var(--ink-3);font-size:12px;padding:16px 0">No meetings in the next 7 days.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px">
        ${upcomingSoon.map(m => `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--linen);border:1px solid var(--ink-5);border-radius:8px">
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600">${escapeHtml(m.title ?? m.stage + ' Meeting')}</div>
              <div style="font-size:11px;color:var(--ink-3);margin-top:2px">
                <span class="badge badge-${MEETING_STATUS_CLASS[m.stage === 'Kickoff' ? 'Completed' : m.stage === 'Strategy & Proposal' ? 'Scheduled' : 'Not Scheduled']}" style="font-size:9px">${escapeHtml(m.stage)}</span>
                &nbsp;${fmtDatetime(m.start_datetime, meetingTz(m))}${m.meeting_type ? ` · ${escapeHtml(m.meeting_type)}` : ''}
              </div>
            </div>
            ${m.google_meet_link ? `<a href="${escapeHtml(m.google_meet_link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Join Meet</a>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="openEditMeeting(${m.id})">Edit</button>
          </div>`).join('')}
      </div>`;

  return statsHTML + `
    <div style="margin-bottom:8px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:10px">Next 7 Days</div>
      ${upcomingHTML}
    </div>`;
}

// ── CRM stage label (used in clients table) ───────────────────────────────────

export function getCrmStageLabel(meetings: Meeting[]): string {
  const has = (stage: string, status: string) =>
    meetings.some(m => m.stage === stage && m.status === status);
  if (has('Kickoff', 'Completed'))           return 'Kickoff Completed';
  if (has('Kickoff', 'Scheduled'))           return 'Kickoff Scheduled';
  if (has('Strategy & Proposal', 'Completed')) return 'S&P Completed';
  if (has('Strategy & Proposal', 'Scheduled')) return 'S&P Scheduled';
  if (has('Discovery', 'Completed'))         return 'Discovery Completed';
  if (has('Discovery', 'Scheduled'))         return 'Discovery Scheduled';
  return 'Waiting for Discovery';
}

// ── Client detail: Next Meeting + Meeting History ─────────────────────────────

export function clientMeetingTimelineHTML(meetings: Meeting[]): string {
  const now = new Date();

  const next = meetings
    .filter(m => m.status === 'Scheduled' && m.start_datetime && new Date(m.start_datetime) > now)
    .sort((a, b) => new Date(a.start_datetime!).getTime() - new Date(b.start_datetime!).getTime())[0] ?? null;

  const history = meetings
    .filter(m => ['Completed', 'No Show', 'Cancelled'].includes(m.status))
    .sort((a, b) => {
      if (!a.start_datetime) return 1;
      if (!b.start_datetime) return -1;
      return new Date(b.start_datetime).getTime() - new Date(a.start_datetime).getTime();
    });

  const nextHTML = next
    ? `<div style="background:var(--linen);border:1px solid var(--ink-4);border-radius:8px;padding:12px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-size:13px;font-weight:600">${escapeHtml(next.title ?? next.stage + ' Meeting')}</div>
            <div style="font-size:11px;color:var(--ink-3);margin-top:3px">
              <span class="badge badge-active" style="font-size:9px">${escapeHtml(next.stage)}</span>
              &nbsp;${fmtDate(next.start_datetime)} · ${fmtTime(next.start_datetime)}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${next.google_meet_link ? `<a href="${escapeHtml(next.google_meet_link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Join Meet</a>` : ''}
            ${next.calendar_event_link ? `<a href="${escapeHtml(next.calendar_event_link)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">View Calendar</a>` : ''}
          </div>
        </div>
      </div>`
    : `<div style="font-size:12px;color:var(--ink-3);padding:6px 0">No upcoming meetings scheduled.</div>`;

  const historyHTML = history.length === 0
    ? `<div style="font-size:12px;color:var(--ink-3);padding:6px 0">No completed meetings yet.</div>`
    : `<div style="overflow-x:auto">
        <table class="ledger-table" style="margin-top:4px">
          <thead><tr><th>Stage</th><th>Date</th><th>Duration</th><th>Status</th><th>Notes</th><th>Recording</th></tr></thead>
          <tbody>${history.map(m => {
            const cls = MEETING_STATUS_CLASS[m.status] ?? 'pending';
            const stageCls = m.stage === 'Kickoff' ? 'completed' : m.stage === 'Strategy & Proposal' ? 'sent' : 'pending';
            return `<tr>
              <td><span class="badge badge-${stageCls}" style="font-size:9px">${escapeHtml(m.stage)}</span></td>
              <td style="white-space:nowrap;font-size:11px">${fmtDate(m.start_datetime)}</td>
              <td style="font-size:11px">${calcDuration(m.start_datetime, m.end_datetime)}</td>
              <td><span class="badge badge-${cls}" style="font-size:9px">${escapeHtml(m.status)}</span></td>
              <td style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.meeting_notes ? escapeHtml(m.meeting_notes.slice(0, 80)) : '—'}</td>
              <td>${m.recording_link ? `<a href="${escapeHtml(m.recording_link)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--blue)">Watch</a>` : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

  return `
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:6px">Next Meeting</div>
    ${nextHTML}
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin:14px 0 6px">Meeting History</div>
    ${historyHTML}`;
}
