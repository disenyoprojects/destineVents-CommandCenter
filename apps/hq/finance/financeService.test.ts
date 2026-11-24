import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Invoice, Bill, SOB } from '@shared/types.ts';
import { sb } from '@shared/core/supabase';
import { calcFinanceSummary, billPaidDate, createInvoice } from './financeService.ts';

// handleServiceError raises a toast, which needs a page this test does not have.
vi.mock('@shared/core/serviceError.ts', () => ({ handleServiceError: vi.fn() }));

// Fixed clock so month/day boundaries are deterministic.
const NOW = new Date(2026, 7, 6, 9, 0, 0); // 2026-08-06 local

const inv = (status: string, amount?: number, over: Partial<Invoice> = {}) =>
  ({ status, amount, due: null, date: null, payment_date: null, archived_at: null, ...over } as unknown as Invoice);
const bill = (status: string, amount?: number, over: Partial<Bill> = {}) =>
  ({ status, amount, date: null, paid_at: null, archived_at: null, ...over } as unknown as Bill);

const summary = (invoices: Invoice[], bills: Bill[] = []) =>
  calcFinanceSummary(invoices, bills, [], NOW);

describe('calcFinanceSummary', () => {
  it('calculates AR outstanding from unpaid invoices only', () => {
    expect(summary([inv('Unpaid', 5000), inv('Paid', 3000)]).arOutstanding).toBe(5000);
  });

  it('calculates revenue collected from paid invoices only', () => {
    expect(summary([inv('Paid', 3000), inv('Unpaid', 1000)]).revenueCollected).toBe(3000);
  });

  it('calculates net position as revenue minus AP outstanding', () => {
    expect(summary([inv('Paid', 5000)], [bill('Unpaid', 2000)]).netPosition).toBe(3000);
  });

  it('returns zeros when both arrays are empty', () => {
    const result = summary([], []);
    expect(result.arOutstanding).toBe(0);
    expect(result.revenueCollected).toBe(0);
    expect(result.overdueCount).toBe(0);
  });

  it('treats missing amount field as zero', () => {
    expect(summary([inv('Unpaid')]).arOutstanding).toBe(0);
  });

  // ── Cancelled / archived no longer inflate the cards ───────────────────────
  it('excludes cancelled invoices from AR outstanding', () => {
    expect(summary([inv('Issued', 5000), inv('Cancelled', 9000)]).arOutstanding).toBe(5000);
  });

  it('excludes archived invoices from AR outstanding', () => {
    const archived = inv('Issued', 9000, { archived_at: '2026-08-01T00:00:00Z' });
    expect(summary([inv('Issued', 5000), archived]).arOutstanding).toBe(5000);
  });

  it('excludes archived invoices from revenue collected', () => {
    const archived = inv('Paid', 9000, { archived_at: '2026-08-01T00:00:00Z' });
    expect(summary([inv('Paid', 3000), archived]).revenueCollected).toBe(3000);
  });

  it('excludes archived bills from AP outstanding', () => {
    const archived = bill('Pending', 9000, { archived_at: '2026-08-01T00:00:00Z' });
    expect(summary([], [bill('Pending', 2000), archived]).apOutstanding).toBe(2000);
  });

  // ── Overdue is derived from the due date, never stored ─────────────────────
  it('derives overdue from the due date without a stored status', () => {
    const result = summary([
      inv('Issued', 1500, { due: '2026-07-01' }),
      inv('Issued', 700,  { due: '2026-07-30' }),
      inv('Issued', 500,  { due: '2026-08-05' }),   // 1 day late: still Due
      inv('Issued', 4000, { due: '2026-09-01' }),
    ]);
    expect(result.overdueCount).toBe(2);
    expect(result.overdueTotal).toBe(2200);
  });

  it('does not count paid or cancelled invoices as overdue', () => {
    const result = summary([
      inv('Paid', 1000, { due: '2026-01-01' }),
      inv('Cancelled', 1000, { due: '2026-01-01' }),
    ]);
    expect(result.overdueCount).toBe(0);
    expect(result.overdueTotal).toBe(0);
  });

  it('still honours a manually stored Overdue status past its due date', () => {
    expect(summary([inv('Overdue', 1500, { due: '2026-07-01' })]).overdueCount).toBe(1);
  });

  // ── Collected / paid figures key off the date cash moved ───────────────────
  it('counts collections in the month the payment landed', () => {
    const result = summary([
      inv('Paid', 1000, { date: '2026-06-01', payment_date: '2026-08-03' }),
      inv('Paid', 250,  { date: '2026-08-01', payment_date: '2026-07-30' }),
    ]);
    expect(result.collectedThisMonth).toBe(1000);
  });

  it('counts collections landing today', () => {
    const result = summary([
      inv('Paid', 700, { payment_date: '2026-08-06' }),
      inv('Paid', 300, { payment_date: '2026-08-05' }),
    ]);
    expect(result.collectedToday).toBe(700);
  });

  it('counts an expense in the month it was paid, not the month it was dated', () => {
    const result = summary([], [
      bill('Paid', 4000, { date: '2026-06-15', paid_at: '2026-08-02' }),
      bill('Paid', 900,  { date: '2026-08-15', paid_at: '2026-07-02' }),
    ]);
    // 4000 paid in Aug; the Jun-dated bill no longer hides from the Aug figure.
    expect(result.cashFlowThisMonth).toBe(-4000);
  });

  it('falls back to the bill date when paid_at has not been backfilled', () => {
    const result = summary([], [bill('Paid', 500, { date: '2026-08-04', paid_at: null })]);
    expect(result.cashFlowThisMonth).toBe(-500);
  });
});

describe('billPaidDate', () => {
  it('prefers paid_at', () => {
    expect(billPaidDate(bill('Paid', 1, { date: '2026-06-01', paid_at: '2026-08-02' }))).toBe('2026-08-02');
  });

  it('falls back to the bill date', () => {
    expect(billPaidDate(bill('Paid', 1, { date: '2026-06-01' }))).toBe('2026-06-01');
  });

  it('tolerates a full timestamp', () => {
    expect(billPaidDate(bill('Paid', 1, { paid_at: '2026-08-02T10:00:00Z' }))).toBe('2026-08-02');
  });
});

describe('calcFinanceSummary — receivables from Statements of Billing', () => {
  const sob = (over: Partial<SOB> = {}) => ({
    id: 1, status: 'Sent', total_amount: 10000, due_date: '2026-09-01',
    linked_invoice_id: null, archived_at: null, ...over,
  } as unknown as SOB);
  const withSOBs = (invoices: Invoice[], sobs: SOB[]) =>
    calcFinanceSummary(invoices, [], [], NOW, sobs);

  it('counts what a sent statement still has owing after part payments', () => {
    const result = withSOBs([
      inv('Paid', 4000, { id: 11, sob_id: 1 }),
      inv('Paid', 1000, { id: 12, sob_id: 1 }),
    ], [sob()]);
    expect(result.arOutstanding).toBe(5000);
  });

  it('does not count an unpaid receipt on top of its own statement', () => {
    const result = withSOBs([inv('Issued', 10000, { id: 11, sob_id: 1 })], [sob()]);
    expect(result.arOutstanding).toBe(10000);
  });

  it('still counts an invoice raised without a statement', () => {
    const result = withSOBs([inv('Issued', 2500, { id: 20 })], [sob()]);
    expect(result.arOutstanding).toBe(12500);
  });

  it('still counts an invoice raised from a draft statement — the draft adds nothing itself', () => {
    const result = withSOBs([inv('Issued', 50000, { id: 11, sob_id: 1 })], [sob({ status: 'Draft' })]);
    expect(result.arOutstanding).toBe(50000);
  });

  it('ignores draft, cancelled and superseded statements', () => {
    const result = withSOBs([], [
      sob({ id: 1, status: 'Draft' }),
      sob({ id: 2, status: 'Cancelled' }),
      sob({ id: 3, status: 'Superseded' }),
    ]);
    expect(result.arOutstanding).toBe(0);
  });

  it('reports a statement 7+ days late as overdue, by what is still owed', () => {
    const result = withSOBs(
      [inv('Paid', 4000, { id: 11, sob_id: 1 })],
      [sob({ due_date: '2026-07-01' }), sob({ id: 2, due_date: '2026-08-03', linked_invoice_id: null })],
    );
    expect(result.overdueCount).toBe(1);
    expect(result.overdueTotal).toBe(6000);
  });

  it('keeps Collected This Month on the receipts, one per payment', () => {
    const result = withSOBs([
      inv('Paid', 4000, { id: 11, sob_id: 1, payment_date: '2026-08-02' }),
      inv('Paid', 6000, { id: 12, sob_id: 1, payment_date: '2026-07-15' }),
    ], [sob()]);
    expect(result.collectedThisMonth).toBe(4000);
  });
});

describe('createInvoice — before a migration has been run', () => {
  type Insert = Record<string, unknown>;
  const missingColumn = { code: 'PGRST204', message: "Could not find the 'sob_id' column of 'invoices' in the schema cache" };

  // Each call to sb.from('invoices') answers with the next scripted result and
  // records what was inserted.
  function scriptInserts(results: Array<{ data: unknown; error: unknown }>) {
    const inserted: Insert[] = [];
    vi.spyOn(sb, 'from').mockImplementation((() => ({
      insert: (row: Insert) => {
        inserted.push(row);
        const next = results.shift()!;
        return { select: async () => next };
      },
    })) as unknown as typeof sb.from);
    return inserted;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it('retries without an optional column the database does not know yet', async () => {
    const inserted = scriptInserts([
      { data: null, error: missingColumn },
      { data: [{ id: 5, or_num: 'OR-1' }], error: null },
    ]);
    const result = await createInvoice({ or_num: 'OR-1', sob_id: 3 }, ['sob_id']);
    expect(result?.id).toBe(5);
    expect(inserted[1]).toEqual({ or_num: 'OR-1' });
  });

  it('fails rather than silently dropping a column that was not marked optional', async () => {
    const inserted = scriptInserts([{ data: null, error: missingColumn }]);
    expect(await createInvoice({ or_num: 'OR-1', sob_id: 3 })).toBeNull();
    expect(inserted).toHaveLength(1);
  });
});
