import { describe, it, expect } from 'vitest';
import type { Meeting } from '@shared/types.ts';
import {
  zonedWallTimeToUtc, utcToZonedWallTime, isValidTimezone,
  meetingStats, upcomingMeetings, parseExternalParticipants, formatExternalParticipants,
} from './meetingCalc.ts';

const NOW = new Date('2026-11-24T04:00:00Z'); // 12:00 noon in Manila

const meeting = (over: Partial<Meeting> = {}) => ({
  id: 1, client_id: null, stage: 'Discovery', status: 'Scheduled', title: 'Call',
  start_datetime: '2026-11-25T02:00:00Z', end_datetime: '2026-11-25T03:00:00Z',
  ...over,
} as unknown as Meeting);

describe('timezones', () => {
  it('reads a Manila wall time as UTC+8', () => {
    expect(zonedWallTimeToUtc('2026-11-24T10:30', 'Asia/Manila')).toBe('2026-11-24T02:30:00.000Z');
  });
  it('shows a UTC instant as Manila wall time', () => {
    expect(utcToZonedWallTime('2026-11-24T02:30:00Z', 'Asia/Manila')).toBe('2026-11-24T10:30');
  });
  it('round-trips through a zone with daylight saving', () => {
    const utc = zonedWallTimeToUtc('2026-07-01T09:00', 'America/New_York');
    expect(utc).toBe('2026-07-01T13:00:00.000Z');
    expect(utcToZonedWallTime(utc!, 'America/New_York')).toBe('2026-07-01T09:00');
  });
  it('uses standard time outside daylight saving', () => {
    expect(zonedWallTimeToUtc('2026-12-01T09:00', 'America/New_York')).toBe('2026-12-01T14:00:00.000Z');
  });
  it('crosses midnight correctly', () => {
    expect(utcToZonedWallTime('2026-11-24T17:15:00Z', 'Asia/Manila')).toBe('2026-11-25T01:15');
  });
  it('returns null or empty for unreadable input', () => {
    expect(zonedWallTimeToUtc('', 'Asia/Manila')).toBeNull();
    expect(zonedWallTimeToUtc('not a time', 'Asia/Manila')).toBeNull();
    expect(utcToZonedWallTime(null, 'Asia/Manila')).toBe('');
  });
  it('knows a real timezone from a made-up one', () => {
    expect(isValidTimezone('Asia/Manila')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('meetingStats', () => {
  it('counts every dashboard figure from the records', () => {
    const stats = meetingStats([
      meeting({ id: 1 }),                                                       // tomorrow
      meeting({ id: 2, start_datetime: '2026-12-10T02:00:00Z' }),               // upcoming, beyond 7 days
      meeting({ id: 3, start_datetime: '2026-11-20T02:00:00Z' }),               // scheduled but past
      meeting({ id: 4, status: 'Completed', start_datetime: '2026-11-03T02:00:00Z' }),
      meeting({ id: 5, status: 'Completed', start_datetime: '2026-10-30T02:00:00Z' }),
      meeting({ id: 6, status: 'No Show', start_datetime: '2026-09-01T02:00:00Z' }),
      meeting({ id: 7, status: 'Cancelled', start_datetime: '2026-11-26T02:00:00Z' }),
    ], NOW);
    expect(stats.upcoming).toBe(2);
    expect(stats.completedThisMonth).toBe(1);
    expect(stats.noShows).toBe(1);
    expect(stats.total).toBe(7);
    expect(stats.next7Days.map(m => m.id)).toEqual([1]);
  });
  it('is all zeros with no meetings', () => {
    expect(meetingStats([], NOW)).toEqual({ upcoming: 0, completedThisMonth: 0, noShows: 0, total: 0, next7Days: [] });
  });
});

describe('upcomingMeetings', () => {
  it('lists future scheduled meetings soonest first', () => {
    const list = upcomingMeetings([
      meeting({ id: 1, start_datetime: '2026-12-10T02:00:00Z' }),
      meeting({ id: 2, start_datetime: '2026-11-25T02:00:00Z' }),
      meeting({ id: 3, status: 'Cancelled' }),
      meeting({ id: 4, start_datetime: null }),
    ], NOW);
    expect(list.map(m => m.id)).toEqual([2, 1]);
  });
});

describe('external participants', () => {
  it('reads "Name <email>", a bare email, "Name, email" and a bare name', () => {
    const { participants, invalid } = parseExternalParticipants(
      'Ana Cruz <ana@client.ph>\nben@client.ph\nCarla Reyes, carla@client.ph\nDon Santos\n\n',
    );
    expect(invalid).toEqual([]);
    expect(participants).toEqual([
      { name: 'Ana Cruz', email: 'ana@client.ph', internal: false },
      { name: 'ben@client.ph', email: 'ben@client.ph', internal: false },
      { name: 'Carla Reyes', email: 'carla@client.ph', internal: false },
      { name: 'Don Santos', email: null, internal: false },
    ]);
  });
  it('drops angle brackets from a name so it reads back the same way', () => {
    const { participants } = parseExternalParticipants('A <b, x@y.co');
    expect(participants[0].name).toBe('A b');
    expect(parseExternalParticipants(formatExternalParticipants(participants)).invalid).toEqual([]);
  });
  it('flags a line with a broken email', () => {
    expect(parseExternalParticipants('Ana <ana@client>').invalid).toEqual(['Ana <ana@client>']);
  });
  it('writes them back one per line', () => {
    expect(formatExternalParticipants([
      { name: 'Ana Cruz', email: 'ana@client.ph', internal: false },
      { name: 'Don Santos', email: null, internal: false },
      { name: 'Gab', email: 'gab@hq.ph', internal: true },
    ])).toBe('Ana Cruz <ana@client.ph>\nDon Santos');
  });
});
