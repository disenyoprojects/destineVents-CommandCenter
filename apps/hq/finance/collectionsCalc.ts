// Pure, DOM-free collections maths for Statements of Billing. Unit-tested in
// collectionsCalc.test.ts.
//
// The model: a Statement of Billing (SOB) is what we *billed*. Every payment
// the client makes is its own Official Receipt (an `invoices` row) pointing
// back at the statement through `sob_id`, so a downpayment and the balance are
// two receipts against one SOB. Collected is the sum of the paid receipts;
// Outstanding is billed minus collected. Nothing here is stored — status and
// the follow-up step are worked out from the dates every time, the same way
// arCalc.ts derives Overdue, so they are right the morning a date passes with
// no scheduled job.
//
// Only confirmed money counts (handover §2): a draft has not been billed, a
// cancelled or superseded statement is not owed, and a statement someone
// marked "Paid" by hand without a receipt has collected nothing.
import type { Invoice, SOB } from '@shared/types.ts';
import { localISODate } from '@shared/utils/dateUtils.ts';
import { calendarDay, daysPastDue, OVERDUE_AFTER_DAYS } from './arCalc.ts';

export type CollectionStatus =
  | 'Upcoming' | 'SOB Sent' | 'Due' | 'Partially Paid' | 'Overdue' | 'Paid'
  | 'Cancelled' | 'Superseded';

export type SOBOutcome =
  | 'Draft' | 'Active' | 'Completed & Paid' | 'Completed but Unpaid'
  | 'Partially Paid' | 'Cancelled / Not Proceeded' | 'Amended / Superseded';

export interface FollowUp {
  date: string;      // YYYY-MM-DD the step falls on
  action: string;    // what to do, in words
  due: boolean;      // true = do it now; false = this is the next one coming
}

export interface SOBCollection {
  sob: SOB;
  billed: number;
  collected: number;
  outstanding: number;
  status: CollectionStatus;
  followUp: FollowUp | null;
  needsAttention: boolean;
}

// Statuses that take a statement out of the money entirely.
const NOT_BILLED_STATUSES: ReadonlyArray<string> = ['Draft', 'Cancelled', 'Superseded'];

// The handover's §5 ladder, as days relative to the due date.
const REMINDER_DAYS_BEFORE = 7;
const FOLLOW_UP_DAYS_AFTER = 3;
const FIRM_FOLLOW_UP_ACTION = 'Firm follow-up — overdue';
const FOLLOW_UP_LADDER: ReadonlyArray<{ offset: number; action: string }> = [
  { offset: -REMINDER_DAYS_BEFORE, action: 'Send payment reminder' },
  { offset: 0,                     action: 'Due today — confirm payment' },
  { offset: FOLLOW_UP_DAYS_AFTER,  action: 'Follow up — 3 days late' },
  { offset: OVERDUE_AFTER_DAYS,    action: FIRM_FOLLOW_UP_ACTION },
];
const DRAFT_LADDER: ReadonlyArray<{ offset: number; action: string }> = [
  { offset: -REMINDER_DAYS_BEFORE, action: 'Send the SOB' },
];

// Calendar arithmetic on YYYY-MM-DD strings. Done in UTC so a daylight-saving
// shift can never make a day 23 hours long and land on the wrong date.
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A bare date is taken as-is; a full timestamp becomes the user's local date —
// a follow-up logged at 7 AM in Manila is stored as the previous day in UTC.
export function toLocalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : localISODate(d);
}

// Sent to the client and still standing — the only statements that are owed.
export function isBilledSOB(sob: SOB): boolean {
  return !sob.archived_at && !NOT_BILLED_STATUSES.includes(sob.status);
}

// Receipts written before migration 021 are linked only from the statement's
// side (linked_invoice_id), so both directions are honoured.
function belongsTo(invoice: Invoice, sob: SOB): boolean {
  return invoice.sob_id === sob.id || invoice.id === sob.linked_invoice_id;
}

// The statement a receipt collects against, if any.
export function sobForInvoice(invoice: Invoice, sobs: SOB[]): SOB | undefined {
  return sobs.find(s => belongsTo(invoice, s));
}

// Every receipt raised against a statement, paid or not.
export function receiptsForSOB(sob: SOB, invoices: Invoice[]): Invoice[] {
  return invoices.filter(i => !i.archived_at && belongsTo(i, sob));
}

export function sobCollected(sob: SOB, invoices: Invoice[]): number {
  return invoices
    .filter(i => i.status === 'Paid' && !i.archived_at && belongsTo(i, sob))
    .reduce((s, i) => s + (i.amount || 0), 0);
}

// A receipt collecting against a *billed* statement is already inside that
// statement's balance, so the receivables total must not add it again. One
// raised from a draft, cancelled, superseded or archived statement is not —
// that statement adds nothing — so it still counts on its own.
export function isCoveredBySOB(invoice: Invoice, sobs: SOB[]): boolean {
  const sob = sobForInvoice(invoice, sobs);
  return sob !== undefined && isBilledSOB(sob);
}

function collectionStatus(sob: SOB, billed: number, collected: number, today: string): CollectionStatus {
  if (sob.status === 'Cancelled')  return 'Cancelled';
  if (sob.status === 'Superseded') return 'Superseded';
  if (sob.status === 'Draft')      return 'Upcoming';
  if (billed > 0 && collected >= billed) return 'Paid';
  const late = daysPastDue(sob.due_date, today);
  if (late !== null && late >= OVERDUE_AFTER_DAYS) return 'Overdue';
  if (collected > 0) return 'Partially Paid';
  if (late !== null && late >= 0) return 'Due';
  return 'SOB Sent';
}

// Which chase step applies today. The latest step already reached is due unless
// someone logged a follow-up on or after it; otherwise the next step ahead is
// shown. Once past the firm follow-up, it repeats a week after each one logged.
function nextFollowUp(sob: SOB, status: CollectionStatus, today: string): FollowUp | null {
  const open = status === 'Upcoming' || status === 'SOB Sent' || status === 'Due'
    || status === 'Partially Paid' || status === 'Overdue';
  const due = calendarDay(sob.due_date);
  if (!open || !due) return null;

  const lastLogged = toLocalDate(sob.last_followup_at);
  const ladder = (status === 'Upcoming' ? DRAFT_LADDER : FOLLOW_UP_LADDER)
    .map(step => ({ date: addDays(due, step.offset), action: step.action }));
  const reached = ladder.filter(step => step.date <= today);
  const current = reached[reached.length - 1];
  const ahead   = ladder.find(step => step.date > today);

  if (current && (!lastLogged || lastLogged < current.date)) {
    return { ...current, due: true };
  }
  if (ahead) return { ...ahead, due: false };
  if (status === 'Upcoming' || !lastLogged) return null;

  const repeat = addDays(lastLogged, OVERDUE_AFTER_DAYS);
  return { date: repeat, action: FIRM_FOLLOW_UP_ACTION, due: repeat <= today };
}

export function collectionFor(sob: SOB, invoices: Invoice[], today: string): SOBCollection {
  const billed      = isBilledSOB(sob) ? (sob.total_amount || 0) : 0;
  const collected   = billed > 0 ? sobCollected(sob, invoices) : 0;
  const outstanding = Math.max(billed - collected, 0);
  const status      = collectionStatus(sob, billed, collected, today);
  const followUp    = nextFollowUp(sob, status, today);
  return { sob, billed, collected, outstanding, status, followUp, needsAttention: !!followUp?.due };
}

export interface CollectionsSummary {
  billed: number;
  collected: number;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  attentionCount: number;
}

export function collectionsSummary(rows: SOBCollection[]): CollectionsSummary {
  const overdueRows = rows.filter(r => r.status === 'Overdue');
  return {
    billed:         rows.reduce((s, r) => s + r.billed, 0),
    collected:      rows.reduce((s, r) => s + r.collected, 0),
    outstanding:    rows.reduce((s, r) => s + r.outstanding, 0),
    overdue:        overdueRows.reduce((s, r) => s + r.outstanding, 0),
    overdueCount:   overdueRows.length,
    attentionCount: rows.filter(r => r.needsAttention).length,
  };
}

// The handover's §2 reconciliation outcome. Being billed never implies the work
// was finished, and being paid never implies it either — completion comes only
// from the project itself.
export function sobOutcome(row: SOBCollection, projectStatus: string | null): SOBOutcome {
  if (row.status === 'Cancelled')  return 'Cancelled / Not Proceeded';
  if (row.status === 'Superseded') return 'Amended / Superseded';
  if (row.status === 'Upcoming')   return 'Draft';
  const projectDone = projectStatus === null || projectStatus === 'Completed';
  if (row.status === 'Paid') return projectDone ? 'Completed & Paid' : 'Active';
  if (row.collected > 0) return 'Partially Paid';
  if (projectStatus === 'Completed') return 'Completed but Unpaid';
  return 'Active';
}
