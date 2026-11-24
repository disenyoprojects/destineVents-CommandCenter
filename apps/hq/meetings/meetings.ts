import type { InternUser, Meeting, MeetingParticipant } from '@shared/types';
import { _meetings, setMeetings, _clients, setClients, _proposals, setProposals } from '@hq/core/state.ts';
import { toast, openModal, closeModal } from '@hq/core/ui.ts';
import { escapeHtml } from '@shared/utils/helpers.ts';
import { getCurrentUser } from '@shared/core/authService.ts';
import { fetchUsers } from '@shared/core/userService.ts';
import { logDocActivity } from '@shared/services/documents/activityLogService.ts';
import { HQ_ROLES } from '@config/roles.ts';
import { fetchClients } from '@hq/clients/clientService.ts';
import { fetchProposals } from '@hq/proposals/proposalService.ts';
import {
  fetchMeetings, fetchMeetingsByClient,
  createMeeting, updateMeeting, deleteMeeting,
} from './meetingService.ts';
import {
  MEETING_STAGES, MEETING_STATUSES, MEETING_TYPES, DEFAULT_MEETING_TZ,
  meetingTableHTML, meetingFormHTML, meetingOverviewHTML, meetingTz,
  clientMeetingTimelineHTML, getCrmStageLabel,
} from './templates/meetings.ts';
import {
  isValidTimezone, parseExternalParticipants, upcomingMeetings, utcToZonedWallTime, zonedWallTimeToUtc,
} from './meetingCalc.ts';

export { fetchMeetingsByClient, clientMeetingTimelineHTML, getCrmStageLabel };

// ── Module state ──────────────────────────────────────────────────────────────

let _editingMeetingId: number | null = null;
let _reschedulingFrom: string | null = null;
let _hqUsers: InternUser[] = [];
let _meetingSearch = '';
let _meetingFilterType = '';
let _meetingFilterStage = '';
let _meetingFilterStatus = '';
let _meetingFilterDateFrom = '';
let _meetingFilterDateTo = '';
let _activeMeetingTab = 'overview';

const gVal = (id: string) =>
  (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? '';

async function currentActor(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.name ?? user?.email ?? null;
}

// Every create, edit, reschedule, status change and delete lands in the same
// activity log the finance documents use (handover §13.6).
async function logMeeting(id: number, title: string | null, action: 'created' | 'updated' | 'cancelled' | 'deleted', notes?: string) {
  await logDocActivity('meeting', id, title, action, await currentActor(), notes);
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadMeetings(): Promise<void> {
  try {
    // Users and quotations are re-read every time: a list cached from earlier
    // would miss what someone else added since, and the form needs them.
    const [meetings, clients, users, proposals] = await Promise.all([
      fetchMeetings(),
      _clients.length ? Promise.resolve(_clients) : fetchClients(),
      fetchUsers(),
      fetchProposals(),
    ]);
    setMeetings(meetings || []);
    if (!_clients.length && clients) setClients(clients);
    if (proposals) setProposals(proposals);
    _hqUsers = (users || []).filter(u => HQ_ROLES.includes(u.role)).sort((a, b) => a.name.localeCompare(b.name));
    _renderActiveMeetingTab();
  } catch (error) {
    console.error('loadMeetings failed:', error);
    toast('Could not load meetings', 'error');
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

export function showMeetingTab(name: string, el: HTMLElement): void {
  _activeMeetingTab = name;
  document.querySelectorAll('.mtab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('mtab-' + name);
  if (tab) tab.classList.add('active');
  document.querySelectorAll('#meetings-subtabs .sub-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  _renderActiveMeetingTab();
}

function _renderActiveMeetingTab(): void {
  if (_activeMeetingTab === 'list') _renderMeetingList();
  else if (_activeMeetingTab === 'upcoming') _renderUpcoming();
  else _renderMeetingOverview();
}

// ── Overview ──────────────────────────────────────────────────────────────────

function _renderMeetingOverview(): void {
  const container = document.getElementById('mtab-overview');
  if (!container) return;
  container.innerHTML = meetingOverviewHTML(_meetings, new Date());
}

const TABLE_HEAD = `
  <thead>
    <tr>
      <th>Client</th>
      <th>Type / Stage</th>
      <th>Status</th>
      <th>Title</th>
      <th>Date & Time</th>
      <th>Duration</th>
      <th>Meet / Location</th>
      <th></th>
    </tr>
  </thead>`;

// ── Upcoming ──────────────────────────────────────────────────────────────────

function _renderUpcoming(): void {
  const container = document.getElementById('mtab-upcoming');
  if (!container) return;
  const upcoming = upcomingMeetings(_meetings, new Date());
  container.innerHTML = `
    <div class="page-actions" style="margin-bottom:12px">
      <div style="font-size:11px;color:var(--ink-3)">${upcoming.length} scheduled meeting${upcoming.length !== 1 ? 's' : ''} ahead, soonest first</div>
      <button class="btn btn-primary" onclick="openAddMeeting()">+ New Meeting</button>
    </div>
    <div style="overflow-x:auto">
      <table class="ledger-table">${TABLE_HEAD}
        <tbody>${upcoming.length
          ? meetingTableHTML(upcoming, _clients)
          : `<tr><td colspan="8"><div class="empty-state" style="padding:32px;text-align:center;color:var(--ink-3)">Nothing scheduled ahead.</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

// ── List (All Meetings) ───────────────────────────────────────────────────────

function _renderMeetingList(): void {
  const container = document.getElementById('mtab-list');
  if (!container) return;

  let filtered = [..._meetings];

  if (_meetingSearch) {
    const q = _meetingSearch.toLowerCase();
    filtered = filtered.filter(m => {
      const client = _clients.find(c => c.id === m.client_id);
      return [m.title, client?.name, m.contact_name, m.owner_name]
        .some(v => (v ?? '').toLowerCase().includes(q));
    });
  }
  if (_meetingFilterType) filtered = filtered.filter(m => m.meeting_type === _meetingFilterType);
  if (_meetingFilterStage) filtered = filtered.filter(m => m.stage === _meetingFilterStage);
  if (_meetingFilterStatus) filtered = filtered.filter(m => m.status === _meetingFilterStatus);
  // By the date the meeting falls on where it is held, not the UTC date.
  const day = (m: Meeting) => utcToZonedWallTime(m.start_datetime, meetingTz(m)).slice(0, 10);
  if (_meetingFilterDateFrom) filtered = filtered.filter(m =>
    m.start_datetime && day(m) >= _meetingFilterDateFrom
  );
  if (_meetingFilterDateTo) filtered = filtered.filter(m =>
    m.start_datetime && day(m) <= _meetingFilterDateTo
  );

  const hasFilters = !!(
    _meetingSearch || _meetingFilterType || _meetingFilterStage || _meetingFilterStatus ||
    _meetingFilterDateFrom || _meetingFilterDateTo
  );

  const opts = (values: readonly string[], selected: string) => values.map(s =>
    `<option value="${escapeHtml(s)}"${selected === s ? ' selected' : ''}>${escapeHtml(s)}</option>`
  ).join('');

  const rows = filtered.length
    ? meetingTableHTML(filtered, _clients)
    : `<tr><td colspan="8"><div class="empty-state" style="padding:32px;text-align:center;color:var(--ink-3)">No meetings found.</div></td></tr>`;

  container.innerHTML = `
    <div class="page-actions" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px;flex:1;flex-wrap:wrap;align-items:center">
        <input class="form-input" id="mt-search" placeholder="Search client, contact, owner or title…"
          value="${escapeHtml(_meetingSearch)}" oninput="setMeetingFilter()" style="width:240px"/>
        <select class="form-input" id="mt-filter-type" onchange="setMeetingFilter()" style="width:170px">
          <option value="">All Types</option>
          ${opts(MEETING_TYPES, _meetingFilterType)}
        </select>
        <select class="form-input" id="mt-filter-stage" onchange="setMeetingFilter()" style="width:170px">
          <option value="">All Stages</option>
          ${opts(MEETING_STAGES, _meetingFilterStage)}
        </select>
        <select class="form-input" id="mt-filter-status" onchange="setMeetingFilter()" style="width:150px">
          <option value="">All Statuses</option>
          ${opts(MEETING_STATUSES, _meetingFilterStatus)}
        </select>
        <input class="form-input" id="mt-date-from" type="date" value="${_meetingFilterDateFrom}"
          onchange="setMeetingFilter()" style="width:145px" title="From date"/>
        <input class="form-input" id="mt-date-to" type="date" value="${_meetingFilterDateTo}"
          onchange="setMeetingFilter()" style="width:145px" title="To date"/>
        ${hasFilters ? `<button class="btn btn-ghost" onclick="clearMeetingFilters()">Clear</button>` : ''}
      </div>
      <button class="btn btn-primary" onclick="openAddMeeting()">+ New Meeting</button>
    </div>
    <div style="overflow-x:auto">
      <table class="ledger-table">${TABLE_HEAD}
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export function setMeetingFilter(): void {
  _meetingSearch = (document.getElementById('mt-search') as HTMLInputElement | null)?.value.toLowerCase() ?? '';
  _meetingFilterType = (document.getElementById('mt-filter-type') as HTMLSelectElement | null)?.value ?? '';
  _meetingFilterStage = (document.getElementById('mt-filter-stage') as HTMLSelectElement | null)?.value ?? '';
  _meetingFilterStatus = (document.getElementById('mt-filter-status') as HTMLSelectElement | null)?.value ?? '';
  _meetingFilterDateFrom = (document.getElementById('mt-date-from') as HTMLInputElement | null)?.value ?? '';
  _meetingFilterDateTo = (document.getElementById('mt-date-to') as HTMLInputElement | null)?.value ?? '';
  _renderMeetingList();
}

export function clearMeetingFilters(): void {
  _meetingSearch = '';
  _meetingFilterType = '';
  _meetingFilterStage = '';
  _meetingFilterStatus = '';
  _meetingFilterDateFrom = '';
  _meetingFilterDateTo = '';
  _renderMeetingList();
}

// ── Form open/save ────────────────────────────────────────────────────────────

function formOptions(heading?: string) {
  return { clients: _clients, users: _hqUsers, proposals: _proposals, heading };
}

export function openAddMeeting(): void {
  _editingMeetingId = null;
  _reschedulingFrom = null;
  openModal('New Meeting', meetingFormHTML({ status: 'Scheduled', timezone: DEFAULT_MEETING_TZ }, formOptions()), saveMeeting);
}

export function openEditMeeting(id: number): void {
  const m = _meetings.find(x => x.id === id);
  if (!m) return;
  _editingMeetingId = id;
  _reschedulingFrom = null;
  openModal('Edit Meeting', meetingFormHTML(m, formOptions()), saveMeeting);
}

// Reschedule is an edit that puts the meeting back on Scheduled, and records
// where it moved from in the activity log.
export function openRescheduleMeeting(id: number): void {
  const m = _meetings.find(x => x.id === id);
  if (!m) return;
  _editingMeetingId = id;
  _reschedulingFrom = m.start_datetime;
  const note = m.start_datetime
    ? 'Pick the new date and time below. The meeting goes back to <strong>Scheduled</strong>.'
    : 'Pick a date and time below to schedule this meeting.';
  openModal(m.start_datetime ? 'Reschedule Meeting' : 'Schedule Meeting',
    meetingFormHTML({ ...m, status: 'Scheduled' }, formOptions(note)), saveMeeting);
}

function pick<T extends string>(raw: string, allowed: readonly T[] | readonly string[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

function _editingMeeting(): Meeting | undefined {
  return _editingMeetingId !== null ? _meetings.find(x => x.id === _editingMeetingId) : undefined;
}

// A ticked person no longer among HQ users keeps the details saved with the
// meeting, rather than being dropped on save.
function _readParticipants(): MeetingParticipant[] | string {
  const saved = (_editingMeeting()?.participants ?? []).filter(p => p.internal);
  const internal = Array.from(document.querySelectorAll<HTMLInputElement>('.mt-internal:checked'))
    .map((box): MeetingParticipant | undefined => {
      const u = _hqUsers.find(x => x.id === box.value);
      return u
        ? { name: u.name, email: u.email ?? null, internal: true, user_id: u.id }
        : saved.find(p => p.user_id === box.value);
    })
    .filter((p): p is MeetingParticipant => !!p);
  const { participants: external, invalid } = parseExternalParticipants(gVal('mt-external'));
  if (invalid.length) return `Check the email on: ${invalid.join('; ')}`;
  return [...internal, ...external];
}

function _readMeetingForm(): Partial<Meeting> | null {
  const title = gVal('mt-title').trim();
  if (!title) { toast('Give the meeting a title', 'error'); return null; }
  // Required for new meetings. One saved before types existed can still be
  // edited or rescheduled without picking one.
  const existing = _editingMeeting();
  const typeRaw = gVal('mt-type');
  const meeting_type = MEETING_TYPES.includes(typeRaw) ? typeRaw : null;
  if (!meeting_type && (!existing || existing.meeting_type)) { toast('Choose the meeting type', 'error'); return null; }

  const timezone = gVal('mt-timezone') || DEFAULT_MEETING_TZ;
  if (!isValidTimezone(timezone)) { toast('Choose a valid timezone', 'error'); return null; }
  const startRaw = gVal('mt-start');
  const endRaw = gVal('mt-end');
  const start_datetime = startRaw ? zonedWallTimeToUtc(startRaw, timezone) : null;
  const end_datetime = endRaw ? zonedWallTimeToUtc(endRaw, timezone) : null;
  if (start_datetime && end_datetime && end_datetime <= start_datetime) {
    toast('End time must be after start time', 'error');
    return null;
  }

  const status = pick(gVal('mt-status'), MEETING_STATUSES, 'Not Scheduled');
  if (status === 'Scheduled' && !start_datetime) {
    toast('A scheduled meeting needs a start date and time', 'error');
    return null;
  }

  const participants = _readParticipants();
  if (typeof participants === 'string') { toast(participants, 'error'); return null; }

  const ownerId = gVal('mt-owner');
  const hqOwner = _hqUsers.find(u => u.id === ownerId);
  const owner = hqOwner
    ? { id: hqOwner.id, name: hqOwner.name }
    : ownerId && existing?.owner_id === ownerId ? { id: ownerId, name: existing.owner_name ?? null } : null;
  const clientIdRaw = gVal('mt-client');
  const proposalRaw = gVal('mt-proposal');
  const text = (id: string) => gVal(id).trim() || null;

  return {
    title,
    meeting_type,
    stage: pick(gVal('mt-stage'), MEETING_STAGES, 'Discovery'),
    status,
    timezone,
    start_datetime,
    end_datetime,
    location: text('mt-location'),
    google_meet_link: text('mt-meet'),
    recording_link: text('mt-recording'),
    client_id: clientIdRaw ? Number(clientIdRaw) : null,
    contact_name: text('mt-contact'),
    proposal_id: proposalRaw ? Number(proposalRaw) : null,
    owner_id: owner?.id ?? null,
    owner_name: owner?.name ?? null,
    participants,
    meeting_notes: text('mt-notes'),
    outcome: text('mt-outcome'),
    follow_up_actions: text('mt-followups'),
    next_steps: text('mt-next'),
  };
}

function whenText(iso: string | null | undefined, tz: string): string {
  if (!iso) return 'no date';
  return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
}

const MIGRATION_HINT = ' If this keeps happening, database migration 023 may not have been run yet.';

export async function saveMeeting(): Promise<void> {
  const payload = _readMeetingForm();
  if (!payload) return;

  try {
    if (_editingMeetingId !== null) {
      const ok = await updateMeeting(_editingMeetingId, payload);
      if (!ok) { toast('Could not update meeting.' + MIGRATION_HINT, 'error'); return; }
      const moved = _reschedulingFrom !== null && payload.start_datetime != null
        && new Date(_reschedulingFrom).getTime() !== new Date(payload.start_datetime).getTime();
      await logMeeting(_editingMeetingId, payload.title ?? null, 'updated', moved
        ? `Rescheduled from ${whenText(_reschedulingFrom, meetingTz(payload))} to ${whenText(payload.start_datetime, meetingTz(payload))}`
        : undefined);
      toast(moved ? 'Meeting rescheduled' : 'Meeting updated', 'success');
    } else {
      const result = await createMeeting(payload);
      if (!result) { toast('Could not save meeting.' + MIGRATION_HINT, 'error'); return; }
      await logMeeting(result.id, result.title, 'created');
      toast('Meeting saved', 'success');
    }
    _reschedulingFrom = null;
    closeModal();
    await loadMeetings();
  } catch (error) {
    console.error('saveMeeting failed:', error);
    toast('An unexpected error occurred', 'error');
  }
}

// Switching the timezone keeps the meeting at the same moment: the times in
// the boxes are converted from the old zone to the new one.
export function onMeetingTimezoneChange(select: HTMLSelectElement): void {
  const from = select.dataset.prev || DEFAULT_MEETING_TZ;
  const to = select.value;
  for (const id of ['mt-start', 'mt-end']) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input?.value) continue;
    const instant = zonedWallTimeToUtc(input.value, from);
    if (instant) input.value = utcToZonedWallTime(instant, to);
  }
  select.dataset.prev = to;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function handleDeleteMeeting(id: number): Promise<void> {
  if (!confirm('Delete this meeting? This cannot be undone. To keep a record, cancel it instead.')) return;
  try {
    const m = _meetings.find(x => x.id === id);
    const ok = await deleteMeeting(id);
    if (!ok) { toast('Could not delete meeting', 'error'); return; }
    await logMeeting(id, m?.title ?? null, 'deleted');
    toast('Meeting deleted', 'success');
    await loadMeetings();
  } catch (error) {
    console.error('handleDeleteMeeting failed:', error);
    toast('An unexpected error occurred', 'error');
  }
}

// ── Quick status updates ──────────────────────────────────────────────────────

export async function markMeetingCompleted(id: number): Promise<void> {
  await _updateStatus(id, 'Completed', 'Meeting marked as completed');
}

export async function markMeetingNoShow(id: number): Promise<void> {
  await _updateStatus(id, 'No Show', 'Meeting marked as no show');
}

export async function cancelMeeting(id: number): Promise<void> {
  if (!confirm('Cancel this meeting? It stays on record as Cancelled.')) return;
  await _updateStatus(id, 'Cancelled', 'Meeting cancelled');
}

async function _updateStatus(id: number, status: string, successMsg: string): Promise<void> {
  try {
    const m = _meetings.find(x => x.id === id);
    const ok = await updateMeeting(id, { status });
    if (!ok) { toast('Could not update status', 'error'); return; }
    await logMeeting(id, m?.title ?? null, status === 'Cancelled' ? 'cancelled' : 'updated', `Marked ${status}`);
    toast(successMsg, 'success');
    await loadMeetings();
  } catch (error) {
    console.error('_updateStatus failed:', error);
    toast('An unexpected error occurred', 'error');
  }
}
