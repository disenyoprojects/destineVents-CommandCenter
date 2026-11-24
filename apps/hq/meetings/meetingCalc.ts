// Pure, DOM-free meeting maths: timezones, the dashboard figures, and reading
// participants out of the form. Unit-tested in meetingCalc.test.ts.
import type { Meeting, MeetingParticipant } from '@shared/types.ts';

// ── Timezones ────────────────────────────────────────────────────────────────
// A meeting's start and end are stored as instants (UTC). The form shows and
// takes them as wall-clock time in the meeting's own timezone, so a call with a
// client in Sydney can be entered in Sydney time. The browser only knows its
// own zone, so the conversion goes through Intl.

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallParts(date: Date, tz: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

// Minutes the zone is ahead of UTC at that instant (480 for Manila).
function offsetMinutes(date: Date, tz: string): number {
  const p = wallParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

// 'YYYY-MM-DDTHH:mm' in `tz` → ISO instant. The offset is checked twice so a
// time next to a daylight-saving change lands on the right side of it.
export function zonedWallTimeToUtc(wall: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m || !isValidTimezone(tz)) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = offsetMinutes(new Date(guess), tz);
  let ts = guess - first * 60_000;
  const second = offsetMinutes(new Date(ts), tz);
  if (second !== first) ts = guess - second * 60_000;
  return new Date(ts).toISOString();
}

// ISO instant → 'YYYY-MM-DDTHH:mm' wall time in `tz`, for a datetime-local box.
export function utcToZonedWallTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimezone(tz)) return '';
  const p = wallParts(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Scheduled and still ahead, soonest first.
export function upcomingMeetings(meetings: Meeting[], now: Date): Meeting[] {
  return meetings
    .filter(m => m.status === 'Scheduled' && m.start_datetime && new Date(m.start_datetime) > now)
    .sort((a, b) => new Date(a.start_datetime!).getTime() - new Date(b.start_datetime!).getTime());
}

export interface MeetingStats {
  upcoming: number;
  completedThisMonth: number;
  noShows: number;
  total: number;
  next7Days: Meeting[];
}

// Every figure on the Meetings overview, straight from the records (§13.2).
// "Completed this month" goes by when the meeting was held, in the viewer's
// calendar month.
export function meetingStats(meetings: Meeting[], now: Date): MeetingStats {
  const upcoming = upcomingMeetings(meetings, now);
  const completedThisMonth = meetings.filter(m => {
    if (m.status !== 'Completed' || !m.start_datetime) return false;
    const d = new Date(m.start_datetime);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  return {
    upcoming: upcoming.length,
    completedThisMonth,
    noShows: meetings.filter(m => m.status === 'No Show').length,
    total: meetings.length,
    next7Days: upcoming.filter(m => new Date(m.start_datetime!).getTime() <= now.getTime() + WEEK_MS),
  };
}

// ── Participants ─────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

// One person per line, as "Name <email>", "Name, email", a bare email or a
// bare name. Lines that look like they hold an email but do not parse are
// returned in `invalid` so the form can say which.
export function parseExternalParticipants(text: string): { participants: MeetingParticipant[]; invalid: string[] } {
  const participants: MeetingParticipant[] = [];
  const invalid: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const angled = /^(.*?)\s*<([^>]*)>$/.exec(line);
    const comma  = /^([^,]+),\s*(\S+)$/.exec(line);
    const [name, email] = angled ? [angled[1].trim(), angled[2].trim()]
      : comma ? [comma[1].trim(), comma[2].trim()]
      : line.includes('@') ? [line, line]
      : [line, ''];
    if (email && !EMAIL.test(email)) { invalid.push(line); continue; }
    participants.push({ name: name || email, email: email || null, internal: false });
  }
  return { participants, invalid };
}

export function formatExternalParticipants(participants: MeetingParticipant[]): string {
  return participants
    .filter(p => !p.internal)
    .map(p => (p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name))
    .join('\n');
}
