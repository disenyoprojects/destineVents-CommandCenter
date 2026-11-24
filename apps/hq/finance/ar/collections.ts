// Receivables → Collections: one view of every Statement of Billing with what
// was billed, collected and is still owed, and who needs chasing today
// (handover §3, §5). Also owns recording a payment against a statement, since
// a part payment is just "one more receipt against this SOB".
import { formatCurrency } from '@shared/utils/formatUtils.ts';
import { todayISO } from '@shared/utils/dateUtils.ts';
import { escapeHtml } from '@shared/utils/helpers.ts';
import { nextDocNumber } from '@shared/services/documents/docNumberService.ts';
import { logDocActivity } from '@shared/services/documents/activityLogService.ts';
import { getCurrentUser } from '@shared/core/authService.ts';
import { canTransition } from '@shared/documents/docTransitions.ts';
import { _invoices, _sobs, _projects } from '@hq/core/state.ts';
import { toast, openModal, closeModal } from '@hq/core/ui.ts';
import type { Invoice, InvoiceLineItem, SOB } from '@shared/types.ts';
import { createInvoice, upsertLineItems } from '@hq/finance/financeService.ts';
import { fetchSOBLineItems, updateSOB } from '@hq/finance/sobService.ts';
import {
  collectionFor, collectionsSummary, receiptsForSOB, sobOutcome, type SOBCollection,
} from '../collectionsCalc.ts';
import {
  collectionsStatsHTML, collectionsFilterHTML, collectionRowHTML, sobPaymentFormHTML,
  matchesCollectionsFilter, COLLECTIONS_FILTERS, type CollectionsFilter,
} from '../templates/collections.ts';
import { syncInvoiceToLedger } from './invoiceLedger.ts';
import { printOfficialReceipt } from './ar.ts';
// Circular by module graph, safe by use: only called inside a function body.
import { loadFinance } from '../finance.ts';

let _filter: CollectionsFilter = 'attention';
let _payingSOBId: number | null = null;
let _followUpSOBId: number | null = null;

const inputVal = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';

async function currentActor(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.name ?? user?.email ?? null;
}

// Chase-today rows first, then soonest due; statements with no due date last.
function collectionRows(): SOBCollection[] {
  const today = todayISO();
  return _sobs
    .filter(s => !s.archived_at)
    .map(s => collectionFor(s, _invoices, today))
    .sort((a, b) =>
      Number(b.needsAttention) - Number(a.needsAttention)
      || (a.sob.due_date ?? '9999').localeCompare(b.sob.due_date ?? '9999'));
}

function projectFor(sob: SOB) {
  return sob.project_id ? _projects.find(p => p.id === sob.project_id) : undefined;
}

export function renderCollections() {
  const statsEl   = document.getElementById('collections-stats');
  const filterEl  = document.getElementById('collections-filters');
  const tbodyEl   = document.getElementById('collections-tbody');
  if (!statsEl || !filterEl || !tbodyEl) return;

  const rows = collectionRows();
  statsEl.innerHTML = collectionsStatsHTML(collectionsSummary(rows));

  const counts = Object.fromEntries(
    COLLECTIONS_FILTERS.map(f => [f.key, rows.filter(r => matchesCollectionsFilter(r, f.key)).length]),
  ) as Record<CollectionsFilter, number>;
  filterEl.innerHTML = collectionsFilterHTML(_filter, counts);

  const visible = rows.filter(r => matchesCollectionsFilter(r, _filter));
  tbodyEl.innerHTML = visible.length
    ? visible.map(r => {
        const project = projectFor(r.sob);
        return collectionRowHTML(r, project, sobOutcome(r, project?.status ?? null));
      }).join('')
    : `<tr><td colspan="11"><div class="empty-state">${
        _filter === 'attention' ? 'Nobody needs chasing today' : 'No statements in this view'
      }</div></td></tr>`;
}

export function setCollectionsFilter(filter: CollectionsFilter) {
  _filter = filter;
  renderCollections();
}

// ── Record a payment against a statement ─────────────────────────────────────

export function openSOBRecordPayment(id: number) {
  const sob = _sobs.find(s => s.id === id);
  if (!sob) return;
  const row = collectionFor(sob, _invoices, todayISO());

  if (row.status === 'Upcoming') {
    toast(`${sob.sob_num} is still a draft — mark it Sent before recording a payment against it`, 'error');
    return;
  }
  if (row.status === 'Cancelled' || row.status === 'Superseded') {
    toast(`${sob.sob_num} is ${row.status.toLowerCase()} — nothing is owed on it`, 'error');
    return;
  }
  if (row.outstanding <= 0) {
    toast(`${sob.sob_num} is already paid in full`, 'error');
    return;
  }

  _payingSOBId = id;
  const unpaid = receiptsForSOB(sob, _invoices).filter(i => !['Paid', 'Cancelled'].includes(i.status));
  const orNum  = nextDocNumber('OR', _invoices.map(i => i.or_num));
  openModal(`Record Payment — ${sob.sob_num}`,
    sobPaymentFormHTML(row, orNum, todayISO(), unpaid), saveSOBPayment, 'Save Payment');
}

// A payment of the whole bill in one go carries the statement's own lines onto
// the receipt; a part payment gets one line saying what it is for, since the
// statement's lines would add up to more than was received.
async function receiptLines(sob: SOB, amount: number, isWholeBill: boolean): Promise<InvoiceLineItem[]> {
  if (isWholeBill) {
    const lines = await fetchSOBLineItems(sob.id);
    if (lines.length) {
      return lines.map(({ description, quantity, unit_price, vat_rate }) => ({ description, quantity, unit_price, vat_rate }));
    }
  }
  const label = isWholeBill ? `Payment for ${sob.sob_num}` : `Part payment for ${sob.sob_num}`;
  return [{ description: label, quantity: 1, unit_price: amount, vat_rate: 0 }];
}

function readPaymentForm(row: SOBCollection): Partial<Invoice> | string {
  const amount = Math.round(Number(inputVal('sp-amount')) * 100) / 100;
  const or_num = inputVal('sp-or');
  const method = inputVal('sp-method');
  const date   = inputVal('sp-date');
  if (!(amount > 0))  return 'Enter the amount received';
  if (amount > row.outstanding + 0.005) {
    return `That is more than the ${formatCurrency(row.outstanding)} still owed — check the amount`;
  }
  if (!or_num) return 'Enter the OR number';
  if (_invoices.some(i => i.or_num === or_num)) return `${or_num} is already used — pick another OR number`;
  if (!method) return 'Please select a payment method';
  if (!date)   return 'Enter the date the payment was received';
  return {
    or_num,
    amount,
    payment_method:    method,
    payment_reference: inputVal('sp-ref') || null,
    payment_date:      date,
    received_by:       inputVal('sp-received') || null,
  };
}

// Keep the statement's own status in step for anyone reading the table
// directly. The screens work it out from the receipts either way.
async function advanceSOBStatus(sob: SOB, collectedAfter: number, billed: number) {
  const target = collectedAfter >= billed ? 'Paid' : 'Partially Paid';
  if (sob.status !== target && canTransition('sob', sob.status, target)) {
    await updateSOB(sob.id, { status: target } as Partial<SOB>);
  }
}

export async function saveSOBPayment() {
  const sob = _sobs.find(s => s.id === _payingSOBId);
  if (!sob) return;
  const row = collectionFor(sob, _invoices, todayISO());
  const form = readPaymentForm(row);
  if (typeof form === 'string') { toast(form, 'error'); return; }

  const amount      = form.amount ?? 0;
  const isWholeBill = row.collected === 0 && amount === row.billed;
  const isPart      = amount < row.outstanding;
  const payload: Partial<Invoice> = {
    ...form,
    client:     sob.client,
    status:     'Paid',
    date:       form.payment_date,
    due:        sob.due_date,
    project_id: sob.project_id,
    sob_id:     sob.id,
    notes:      `${isPart ? 'Part payment' : 'Payment'} against ${sob.sob_num}`,
  };
  if (isWholeBill) {
    payload.subtotal   = sob.subtotal;
    payload.vat_amount = sob.vat_amount;
    payload.discount   = sob.discount;
  }

  const created = await createInvoice(payload);
  if (!created) {
    toast('Could not save the payment. If this keeps happening, database migration 021 may not have been run yet.', 'error');
    return;
  }
  await upsertLineItems(created.id, await receiptLines(sob, amount, isWholeBill));

  const actor = await currentActor();
  const ledger = await syncInvoiceToLedger({ ...created, ...payload } as Invoice, form.received_by ?? actor);
  if (ledger === 'no-account') {
    toast('Payment saved, but it is NOT on the dashboard yet — add a financial account under Finance → Settings, then reopen this receipt and save it.', 'error');
  }
  await advanceSOBStatus(sob, row.collected + amount, row.billed);
  await logDocActivity('invoice', created.id, created.or_num, 'paid', actor, `Against ${sob.sob_num}`);
  await logDocActivity('sob', sob.id, sob.sob_num, 'paid', actor,
    `${formatCurrency(amount)} received — ${created.or_num}${isPart ? ' (part payment)' : ''}`);

  toast(isPart
    ? `Part payment recorded — ${formatCurrency(row.outstanding - amount)} still owed on ${sob.sob_num}`
    : `Payment recorded — ${sob.sob_num} is paid in full`, 'success');
  _payingSOBId = null;
  closeModal();
  await loadFinance();
  setTimeout(() => printOfficialReceipt(created.id), 400);
}

// ── Log a follow-up ──────────────────────────────────────────────────────────

export function logSOBFollowUp(id: number) {
  const sob = _sobs.find(s => s.id === id);
  if (!sob) return;
  const row = collectionFor(sob, _invoices, todayISO());
  if (!row.followUp) return;
  _followUpSOBId = id;
  openModal(`Log follow-up — ${sob.sob_num}`, `
    <div style="font-size:13px;color:var(--ink-2);margin-bottom:12px">
      <strong>${escapeHtml(row.followUp.action)}</strong> · ${escapeHtml(sob.client ?? '')}
      · ${formatCurrency(row.outstanding || sob.total_amount)}
    </div>
    <div class="form-group full">
      <div class="form-label">What happened? (optional)</div>
      <textarea class="form-input" id="fu-note" rows="3" placeholder="e.g. Sent reminder via Messenger; client says payment on Friday"></textarea>
    </div>
    <div style="font-size:10.5px;color:var(--ink-3);margin-top:8px">
      Saved to the statement's activity log. The next follow-up is worked out from today.
    </div>`, saveSOBFollowUp, 'Log Follow-up');
}

export async function saveSOBFollowUp() {
  const sob = _sobs.find(s => s.id === _followUpSOBId);
  if (!sob) return;
  const row  = collectionFor(sob, _invoices, todayISO());
  const note = (document.getElementById('fu-note') as HTMLTextAreaElement | null)?.value.trim() ?? '';

  const ok = await updateSOB(sob.id, { last_followup_at: new Date().toISOString() } as Partial<SOB>);
  if (!ok) {
    toast('Could not log the follow-up. If this keeps happening, database migration 021 may not have been run yet.', 'error');
    return;
  }
  const action = row.followUp?.action ?? 'Follow-up';
  await logDocActivity('sob', sob.id, sob.sob_num, 'followed_up', await currentActor(),
    note ? `${action}: ${note}` : action);
  toast('Follow-up logged', 'success');
  _followUpSOBId = null;
  closeModal();
  await loadFinance();
}
