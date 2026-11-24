import { describe, it, expect } from 'vitest';
import type { Invoice, SOB } from '@shared/types.ts';
import {
  isBilledSOB, sobCollected, collectionFor, collectionsSummary, sobOutcome,
  isCoveredBySOB, addDays, sobForInvoice, receiptsForSOB,
} from './collectionsCalc.ts';

const TODAY = '2026-11-24';

const sob = (over: Partial<SOB> = {}) => ({
  id: 1, sob_num: 'SOB-2026-001', client: 'Acme', project_id: null,
  issue_date: '2026-11-01', due_date: '2026-12-01', status: 'Sent',
  total_amount: 10000, linked_invoice_id: null, archived_at: null,
  last_followup_at: null, superseded_by: null,
  ...over,
} as unknown as SOB);

const or = (over: Partial<Invoice> = {}) => ({
  id: 100, or_num: 'OR-2026-001', status: 'Paid', amount: 4000,
  sob_id: 1, archived_at: null, payment_date: '2026-11-10',
  ...over,
} as unknown as Invoice);

describe('addDays', () => {
  it('moves across a month end', () => {
    expect(addDays('2026-11-28', 7)).toBe('2026-12-05');
  });
  it('moves backwards', () => {
    expect(addDays('2026-12-01', -7)).toBe('2026-11-24');
  });
});

describe('isBilledSOB', () => {
  it('counts a sent statement as billed', () => {
    expect(isBilledSOB(sob())).toBe(true);
  });
  it('does not count a draft — it has not gone to the client', () => {
    expect(isBilledSOB(sob({ status: 'Draft' }))).toBe(false);
  });
  it('does not count cancelled, superseded or archived statements', () => {
    expect(isBilledSOB(sob({ status: 'Cancelled' }))).toBe(false);
    expect(isBilledSOB(sob({ status: 'Superseded' }))).toBe(false);
    expect(isBilledSOB(sob({ archived_at: '2026-11-02' }))).toBe(false);
  });
  it('still counts a statement someone marked Paid by hand — money comes from receipts', () => {
    expect(isBilledSOB(sob({ status: 'Paid' }))).toBe(true);
  });
});

describe('sobCollected', () => {
  it('adds up every paid receipt against the statement', () => {
    expect(sobCollected(sob(), [or({ id: 1, amount: 4000 }), or({ id: 2, amount: 3500 })])).toBe(7500);
  });
  it('ignores receipts that are not paid, are archived, or belong elsewhere', () => {
    expect(sobCollected(sob(), [
      or({ id: 1, status: 'Issued' }),
      or({ id: 2, archived_at: '2026-11-11' }),
      or({ id: 3, sob_id: 99 }),
    ])).toBe(0);
  });
  it('finds the receipt an older conversion linked only through linked_invoice_id', () => {
    expect(sobCollected(sob({ linked_invoice_id: 7 }), [or({ id: 7, sob_id: null, amount: 10000 })])).toBe(10000);
  });
  it('does not count a receipt twice when both links point at it', () => {
    expect(sobCollected(sob({ linked_invoice_id: 7 }), [or({ id: 7, sob_id: 1, amount: 10000 })])).toBe(10000);
  });
});

describe('collectionFor — billed, collected, outstanding', () => {
  it('works out outstanding as billed minus collected', () => {
    const row = collectionFor(sob(), [or({ amount: 4000 })], TODAY);
    expect(row.billed).toBe(10000);
    expect(row.collected).toBe(4000);
    expect(row.outstanding).toBe(6000);
  });
  it('never shows a negative balance when a client overpays', () => {
    expect(collectionFor(sob(), [or({ amount: 12000 })], TODAY).outstanding).toBe(0);
  });
  it('bills nothing for a draft', () => {
    const row = collectionFor(sob({ status: 'Draft' }), [], TODAY);
    expect(row.billed).toBe(0);
    expect(row.outstanding).toBe(0);
  });
  it('bills nothing for a cancelled statement, even with a stray receipt', () => {
    const row = collectionFor(sob({ status: 'Cancelled' }), [or()], TODAY);
    expect(row.billed).toBe(0);
    expect(row.outstanding).toBe(0);
  });
});

describe('collectionFor — status', () => {
  const status = (over: Partial<SOB>, ors: Invoice[] = []) => collectionFor(sob(over), ors, TODAY).status;

  it('Upcoming for a draft not yet sent', () => {
    expect(status({ status: 'Draft' })).toBe('Upcoming');
  });
  it('SOB Sent while the due date is still ahead', () => {
    expect(status({ due_date: '2026-12-15' })).toBe('SOB Sent');
  });
  it('Due on the due date', () => {
    expect(status({ due_date: TODAY })).toBe('Due');
  });
  it('still Due up to 6 days late', () => {
    expect(status({ due_date: '2026-11-18' })).toBe('Due');
  });
  it('Overdue from 7 days late', () => {
    expect(status({ due_date: '2026-11-17' })).toBe('Overdue');
  });
  it('Partially Paid when some money is in and it is not yet overdue', () => {
    expect(status({ due_date: '2026-11-20' }, [or({ amount: 4000 })])).toBe('Partially Paid');
  });
  it('Overdue beats Partially Paid once 7 days late', () => {
    expect(status({ due_date: '2026-11-01' }, [or({ amount: 4000 })])).toBe('Overdue');
  });
  it('Paid once receipts cover the full amount', () => {
    expect(status({ due_date: '2026-11-01' }, [or({ amount: 10000 })])).toBe('Paid');
  });
  it('Cancelled and Superseded keep their own status', () => {
    expect(status({ status: 'Cancelled' })).toBe('Cancelled');
    expect(status({ status: 'Superseded' })).toBe('Superseded');
  });
  it('a hand-set Paid with no receipt is not Paid — no confirmed collection', () => {
    expect(status({ status: 'Paid', due_date: '2026-12-15' })).toBe('SOB Sent');
  });
  it('SOB Sent when there is no due date at all', () => {
    expect(status({ due_date: null })).toBe('SOB Sent');
  });
});

describe('collectionFor — follow-up ladder', () => {
  const follow = (over: Partial<SOB>, ors: Invoice[] = [], today = TODAY) =>
    collectionFor(sob(over), ors, today).followUp;

  it('shows the 7-days-before reminder as the next step while it is further out', () => {
    expect(follow({ due_date: '2026-12-15' })).toEqual({
      date: '2026-12-08', action: 'Send payment reminder', due: false,
    });
  });
  it('asks for the reminder once within 7 days of the due date', () => {
    expect(follow({ due_date: '2026-11-30' })).toEqual({
      date: '2026-11-23', action: 'Send payment reminder', due: true,
    });
  });
  it('once the reminder is logged, the next step is the due date', () => {
    expect(follow({ due_date: '2026-11-30', last_followup_at: '2026-11-23' })).toEqual({
      date: '2026-11-30', action: 'Due today — confirm payment', due: false,
    });
  });
  it('asks for the 3-days-late follow-up', () => {
    expect(follow({ due_date: '2026-11-21', last_followup_at: '2026-11-21' })).toEqual({
      date: '2026-11-24', action: 'Follow up — 3 days late', due: true,
    });
  });
  it('asks for the firm follow-up at 7 days late', () => {
    expect(follow({ due_date: '2026-11-17', last_followup_at: '2026-11-20' })).toEqual({
      date: '2026-11-24', action: 'Firm follow-up — overdue', due: true,
    });
  });
  it('a missed step still asks for the latest one, not every one', () => {
    expect(follow({ due_date: '2026-10-01' })).toEqual({
      date: '2026-10-08', action: 'Firm follow-up — overdue', due: true,
    });
  });
  it('after the firm follow-up is logged, repeats weekly while still unpaid', () => {
    expect(follow({ due_date: '2026-10-01', last_followup_at: '2026-11-20' })).toEqual({
      date: '2026-11-27', action: 'Firm follow-up — overdue', due: false,
    });
  });
  it('accepts a full timestamp for the last follow-up', () => {
    expect(follow({ due_date: '2026-11-30', last_followup_at: '2026-11-23T03:00:00Z' })?.due).toBe(false);
  });
  it('asks to send a draft once its due date is within a week', () => {
    expect(follow({ status: 'Draft', due_date: '2026-11-28' })).toEqual({
      date: '2026-11-21', action: 'Send the SOB', due: true,
    });
  });
  it('nothing to chase once paid, cancelled, or without a due date', () => {
    expect(follow({ due_date: '2026-11-01' }, [or({ amount: 10000 })])).toBeNull();
    expect(follow({ status: 'Cancelled', due_date: '2026-11-01' })).toBeNull();
    expect(follow({ due_date: null })).toBeNull();
  });
  it('flags the row as needing attention exactly when a step is due', () => {
    expect(collectionFor(sob({ due_date: '2026-11-30' }), [], TODAY).needsAttention).toBe(true);
    expect(collectionFor(sob({ due_date: '2026-12-15' }), [], TODAY).needsAttention).toBe(false);
  });
});

describe('collectionsSummary', () => {
  // The draft (due 1 Dec) needs sending within the week, so it is chased too —
  // billing attention, not collection — but adds nothing to the money totals.
  it('totals only what was billed, and counts what needs chasing', () => {
    const rows = [
      collectionFor(sob({ id: 1, due_date: '2026-11-01' }), [or({ sob_id: 1, amount: 4000 })], TODAY),
      collectionFor(sob({ id: 2, due_date: '2026-12-15', total_amount: 5000 }), [], TODAY),
      collectionFor(sob({ id: 3, status: 'Draft', total_amount: 9999 }), [], TODAY),
      collectionFor(sob({ id: 4, status: 'Cancelled', total_amount: 9999 }), [], TODAY),
    ];
    expect(collectionsSummary(rows)).toEqual({
      billed: 15000, collected: 4000, outstanding: 11000,
      overdue: 6000, overdueCount: 1, attentionCount: 2,
    });
  });
});

describe('sobOutcome', () => {
  const outcome = (over: Partial<SOB>, ors: Invoice[], projectStatus: string | null) =>
    sobOutcome(collectionFor(sob(over), ors, TODAY), projectStatus);

  it('Completed & Paid only when paid in full and the project is done', () => {
    expect(outcome({}, [or({ amount: 10000 })], 'Completed')).toBe('Completed & Paid');
  });
  it('paid but the project still running is Active, not completed', () => {
    expect(outcome({}, [or({ amount: 10000 })], 'Payment')).toBe('Active');
  });
  it('paid with no project to wait on counts as Completed & Paid', () => {
    expect(outcome({}, [or({ amount: 10000 })], null)).toBe('Completed & Paid');
  });
  it('Completed but Unpaid when the work is done and nothing came in', () => {
    expect(outcome({}, [], 'Completed')).toBe('Completed but Unpaid');
  });
  it('Partially Paid when some money came in', () => {
    expect(outcome({}, [or({ amount: 4000 })], 'Completed')).toBe('Partially Paid');
  });
  it('an issued statement is just Active — not assumed done or paid', () => {
    expect(outcome({}, [], 'Statement of Billing')).toBe('Active');
  });
  it('names cancelled, superseded and draft statements as such', () => {
    expect(outcome({ status: 'Cancelled' }, [], null)).toBe('Cancelled / Not Proceeded');
    expect(outcome({ status: 'Superseded' }, [], null)).toBe('Amended / Superseded');
    expect(outcome({ status: 'Draft' }, [], null)).toBe('Draft');
  });
});

describe('isCoveredBySOB', () => {
  it('a receipt on a sent statement is covered by its balance', () => {
    expect(isCoveredBySOB(or({ sob_id: 1 }), [sob({ id: 1 })])).toBe(true);
  });
  it('is not covered when its statement is not loaded', () => {
    expect(isCoveredBySOB(or({ sob_id: 1 }), [])).toBe(false);
  });
  it('knows a receipt an SOB points at through linked_invoice_id', () => {
    expect(isCoveredBySOB(or({ id: 7, sob_id: null }), [sob({ linked_invoice_id: 7 })])).toBe(true);
  });
  it('a standalone invoice is not covered', () => {
    expect(isCoveredBySOB(or({ id: 8, sob_id: null }), [sob({ linked_invoice_id: 7 })])).toBe(false);
  });
  it('is not covered by a draft, cancelled or archived statement — those add nothing', () => {
    expect(isCoveredBySOB(or({ sob_id: 1 }), [sob({ id: 1, status: 'Draft' })])).toBe(false);
    expect(isCoveredBySOB(or({ sob_id: 1 }), [sob({ id: 1, status: 'Cancelled' })])).toBe(false);
    expect(isCoveredBySOB(or({ sob_id: 1 }), [sob({ id: 1, archived_at: '2026-11-02' })])).toBe(false);
  });
});

describe('free-text due dates', () => {
  it('does not throw on a due date of "—" and treats it as having none', () => {
    const row = collectionFor(sob({ due_date: '—' }), [], TODAY);
    expect(row.status).toBe('SOB Sent');
    expect(row.followUp).toBeNull();
  });
  it('reads a written-out due date', () => {
    expect(collectionFor(sob({ due_date: 'Nov 1, 2026' }), [], TODAY).status).toBe('Overdue');
  });
});

describe('sobForInvoice / receiptsForSOB', () => {
  it('finds the statement a receipt belongs to, by either link', () => {
    const a = sob({ id: 1 });
    const b = sob({ id: 2, linked_invoice_id: 7 });
    expect(sobForInvoice(or({ sob_id: 1 }), [a, b])).toBe(a);
    expect(sobForInvoice(or({ id: 7, sob_id: null }), [a, b])).toBe(b);
    expect(sobForInvoice(or({ id: 9, sob_id: null }), [a, b])).toBeUndefined();
  });
  it('lists a statement\'s live receipts, paid or not, but not archived ones', () => {
    const list = receiptsForSOB(sob(), [
      or({ id: 1 }), or({ id: 2, status: 'Issued' }), or({ id: 3, archived_at: '2026-11-11' }),
    ]);
    expect(list.map(i => i.id)).toEqual([1, 2]);
  });
});
