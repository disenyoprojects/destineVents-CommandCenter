import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatDate, formatDateShort, todayISO, getQuarter, localDateTimeInput } from './dateUtils.ts';

describe('formatDate', () => {
  it('returns em dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });
  it('returns em dash for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });
  it('returns em dash for empty string', () => {
    expect(formatDate('')).toBe('—');
  });
  it('includes the year for a valid ISO date', () => {
    expect(formatDate('2026-07-01')).toContain('2026');
  });
  it('includes a month abbreviation for a valid ISO date', () => {
    expect(formatDate('2026-07-01')).toContain('Jul');
  });
});

describe('formatDateShort', () => {
  it('includes month abbreviation and year', () => {
    const result = formatDateShort('2026-01-15');
    expect(result).toContain('Jan');
    expect(result).toContain('2026');
  });
  it('returns em dash for null', () => {
    expect(formatDateShort(null)).toBe('—');
  });
});

describe('todayISO', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getQuarter', () => {
  it('returns Q1 for January', () => {
    expect(getQuarter(new Date('2026-01-15'))).toBe('Q1 2026');
  });
  it('returns Q3 for July', () => {
    expect(getQuarter(new Date('2026-07-01'))).toBe('Q3 2026');
  });
  it('returns Q4 for December', () => {
    expect(getQuarter(new Date('2026-12-01'))).toBe('Q4 2026');
  });
});

describe('localDateTimeInput', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('shows a stored UTC time in Manila time, not UTC', () => {
    vi.stubEnv('TZ', 'Asia/Manila');
    expect(localDateTimeInput('2026-11-24T02:30:00Z')).toBe('2026-11-24T10:30');
  });
  it('rolls over to the next day when Manila is already past midnight', () => {
    vi.stubEnv('TZ', 'Asia/Manila');
    expect(localDateTimeInput('2026-11-24T17:15:00Z')).toBe('2026-11-25T01:15');
  });
  it('round-trips through the form unchanged, so saving without edits keeps the time', () => {
    vi.stubEnv('TZ', 'Asia/Manila');
    const stored = '2026-11-24T02:30:00.000Z';
    expect(new Date(localDateTimeInput(stored)).toISOString()).toBe(stored);
  });
  it('returns empty for missing or unreadable values', () => {
    expect(localDateTimeInput(null)).toBe('');
    expect(localDateTimeInput(undefined)).toBe('');
    expect(localDateTimeInput('not a date')).toBe('');
  });
});
