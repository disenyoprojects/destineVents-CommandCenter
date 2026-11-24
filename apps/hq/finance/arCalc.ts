// Pure, DOM-free derivations for Accounts Receivable. Kept out of
// financeService.ts so they can be unit-tested without a Supabase client.
//
// The key idea: "Overdue" is *derived* from the due date, never stored. Nothing
// in the app ever wrote the 'Overdue' status, so the Overdue stat card sat at
// ₱0 forever. Deriving it means the card is correct the moment a due date
// passes, with no cron job and no migration.
import type { Invoice } from '@shared/types.ts';
import { localISODate } from '@shared/utils/dateUtils.ts';

// Statuses that mean the invoice is settled or void — no longer money owed.
export const AR_CLOSED_STATUSES: ReadonlyArray<string> = ['Paid', 'Cancelled'];

// Archived invoices are hidden from every table, so they must not count towards
// any figure either. This is the single gate every AR total goes through.
export function isCountableInvoice(invoice: Invoice): boolean {
  return !invoice.archived_at;
}

// Still owed: not archived, not paid, not cancelled.
export function isOutstandingInvoice(invoice: Invoice): boolean {
  return isCountableInvoice(invoice) && !AR_CLOSED_STATUSES.includes(invoice.status);
}

// How many days late before an unpaid bill counts as Overdue. The November
// handover's collections ladder (§5) marks it Due on the due date, follows up
// at +3, and calls it overdue at +7 — so the first six days late read as Due,
// not Overdue. Shared with collectionsCalc.ts so the invoice badge, the
// Overdue card and the collections view all agree.
export const OVERDUE_AFTER_DAYS = 7;

// A stored date as YYYY-MM-DD, or null when it cannot be read. Statement and
// invoice dates are free-text columns, and older rows hold values like '—' or
// 'Aug 5, 2026' — date maths on those used to throw and take the whole Finance
// page down with it. A value that starts with an ISO date is taken as written;
// anything else is parsed and read as the user's local date.
export function calendarDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : localISODate(d);
}

// Whole days from the due date to `today`: 0 on the day, negative before it,
// null when there is no due date. Both are ISO date strings (a timestamp's time
// part is ignored) so the caller controls the clock and tests stay deterministic.
export function daysPastDue(due: string | null | undefined, today: string): number | null {
  const dueDay = calendarDay(due);
  if (!dueDay) return null;
  const ms = Date.parse(`${today.slice(0, 10)}T00:00:00Z`) - Date.parse(`${dueDay}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

// Overdue = outstanding and at least OVERDUE_AFTER_DAYS past its due date.
export function isOverdueInvoice(invoice: Invoice, today: string): boolean {
  if (!isOutstandingInvoice(invoice)) return false;
  const late = daysPastDue(invoice.due, today);
  return late !== null && late >= OVERDUE_AFTER_DAYS;
}

// What the badge should say. The stored status is respected unless the invoice
// has quietly slipped past its due date.
export function invoiceDisplayStatus(invoice: Invoice, today: string): string {
  return isOverdueInvoice(invoice, today) ? 'Overdue' : invoice.status;
}

// The date a payment actually landed. Falls back to the issue date only as a
// last resort — see the note in calcFinanceSummary about why that fallback
// makes "Collected This Month" drift.
export function invoicePaymentDate(invoice: Invoice): string {
  return (invoice.payment_date ?? invoice.date ?? '').slice(0, 10);
}
