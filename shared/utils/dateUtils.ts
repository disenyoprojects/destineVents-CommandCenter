export function formatDate(
  isoVal: string | null | undefined,
  locale?: string,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!isoVal) return '—';
  return new Date(isoVal + 'T12:00:00').toLocaleDateString(
    locale || 'en-US',
    options || {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }
  );
}

export function formatDateShort(isoVal: string | null | undefined): string {
  return formatDate(isoVal, 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The calendar date in the *user's own* timezone. toISOString() is UTC, which
// in Manila (UTC+8) returns yesterday's date between midnight and 8 AM — that
// pre-filled the wrong payment date on early-morning entries and made the
// "Collected Today" card compare against the wrong day.
export function localISODate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// A stored timestamp as a <input type="datetime-local"> value, in the user's
// own timezone. The input has no timezone of its own: whatever it shows is read
// back as local time on save. Filling it from toISOString() (UTC) meant every
// edit of a meeting in Manila moved it 8 hours earlier.
export function localDateTimeInput(isoVal: string | null | undefined): string {
  if (!isoVal) return '';
  const date = new Date(isoVal);
  if (Number.isNaN(date.getTime())) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${localISODate(date)}T${h}:${min}`;
}

export function todayISO(): string {
  return localISODate();
}

export function getQuarter(date?: Date): string {
  const d = date || new Date();
  return 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ' + d.getFullYear();
}

export function formatTime(isoVal: string | null | undefined): string {
  if (!isoVal) return '—';
  return new Date(isoVal).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
