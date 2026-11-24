// Markup for the Receivables → Collections tab and the statement payment form.
// The numbers all come from collectionsCalc.ts; nothing here does arithmetic
// beyond formatting.
import { formatCurrency } from '@shared/utils/formatUtils.ts';
import { formatDateShort } from '@shared/utils/dateUtils.ts';
import { escapeHtml } from '@shared/utils/helpers.ts';
import type { Invoice, Project } from '@shared/types.ts';
import { toLocalDate } from '../collectionsCalc.ts';
import type {
  CollectionStatus, CollectionsSummary, SOBCollection, SOBOutcome,
} from '../collectionsCalc.ts';

export type CollectionsFilter = 'attention' | 'open' | 'overdue' | 'paid' | 'closed' | 'all';

export const COLLECTIONS_FILTERS: ReadonlyArray<{ key: CollectionsFilter; label: string }> = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'open',      label: 'Open' },
  { key: 'overdue',   label: 'Overdue' },
  { key: 'paid',      label: 'Paid' },
  { key: 'closed',    label: 'Cancelled / superseded' },
  { key: 'all',       label: 'All' },
];

const OPEN_STATUSES: ReadonlyArray<CollectionStatus> = ['Upcoming', 'SOB Sent', 'Due', 'Partially Paid', 'Overdue'];

export function matchesCollectionsFilter(row: SOBCollection, filter: CollectionsFilter): boolean {
  switch (filter) {
    case 'attention': return row.needsAttention;
    case 'open':      return OPEN_STATUSES.includes(row.status);
    case 'overdue':   return row.status === 'Overdue';
    case 'paid':      return row.status === 'Paid';
    case 'closed':    return row.status === 'Cancelled' || row.status === 'Superseded';
    case 'all':       return true;
  }
}

const STATUS_BADGE: Record<CollectionStatus, string> = {
  'Upcoming':       'draft',
  'SOB Sent':       'sent',
  'Due':            'pending',
  'Partially Paid': 'issued',
  'Overdue':        'overdue',
  'Paid':           'paid',
  'Cancelled':      'cancelled',
  'Superseded':     'expired',
};

export function collectionBadgeClass(status: CollectionStatus): string {
  return STATUS_BADGE[status];
}

function displayDate(val: string | null | undefined): string {
  if (!val) return '—';
  return /^\d{4}-\d{2}-\d{2}/.test(val) ? formatDateShort(val.slice(0, 10)) : escapeHtml(val);
}

function statCard(label: string, value: string, color: string, sub = ''): string {
  return `
      <div class="stat-card" style="padding:10px 12px">
        <div class="stat-label">${label}</div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:700;color:${color}">${value}</div>
        ${sub ? `<div style="font-size:10px;color:var(--ink-3);margin-top:2px">${sub}</div>` : ''}
      </div>`;
}

export function collectionsStatsHTML(summary: CollectionsSummary): string {
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
      ${statCard('Billed', formatCurrency(summary.billed), 'var(--ink)', 'Statements sent, not cancelled')}
      ${statCard('Collected', formatCurrency(summary.collected), 'var(--green)', 'Paid receipts against them')}
      ${statCard('Outstanding', formatCurrency(summary.outstanding), 'var(--amber)', 'Billed − collected')}
      ${statCard('Overdue', formatCurrency(summary.overdue), 'var(--red)', `${summary.overdueCount} account${summary.overdueCount !== 1 ? 's' : ''} · 7+ days late`)}
      ${statCard('Needs attention', String(summary.attentionCount), 'var(--blue)', 'Reminders or follow-ups due today')}
    </div>`;
}

export function collectionsFilterHTML(active: CollectionsFilter, counts: Record<CollectionsFilter, number>): string {
  return COLLECTIONS_FILTERS.map(f => `
    <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;${f.key === active ? 'background:var(--ink);color:var(--linen)' : ''}"
      onclick="setCollectionsFilter('${f.key}')">${f.label} (${counts[f.key]})</button>`).join('');
}

// Each action sits under the figure it acts on — Record payment under what is
// owed, Log follow-up under the step — so the table needs no actions column and
// fits a laptop screen without scrolling sideways.
const linkBtn = (color: string) =>
  `background:none;border:none;padding:0;margin-top:3px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:10.5px;font-weight:600;color:${color};text-decoration:underline;white-space:nowrap`;

function followUpCell(row: SOBCollection): string {
  const f = row.followUp;
  if (!f) return '<span style="font-size:11px;color:var(--ink-3)">—</span>';
  const when  = f.due ? '<strong style="color:var(--red)">Now</strong>' : displayDate(f.date);
  const color = f.due ? 'var(--ink)' : 'var(--ink-3)';
  return `<div style="font-size:11px;color:${color}">${escapeHtml(f.action)}</div>
    <div style="font-size:10px;color:var(--ink-3)">${when}${row.sob.last_followup_at ? ` · last chased ${displayDate(toLocalDate(row.sob.last_followup_at))}` : ''}</div>
    <button type="button" style="${linkBtn('var(--blue)')}" onclick="logSOBFollowUp(${row.sob.id})">Log follow-up</button>`;
}

export function collectionRowHTML(row: SOBCollection, project: Project | undefined, outcome: SOBOutcome): string {
  const { sob } = row;
  const open = OPEN_STATUSES.includes(row.status);
  const billedCell = row.status === 'Upcoming'
    ? `<span style="color:var(--ink-3)" title="Not counted until the statement is sent">${formatCurrency(sob.total_amount)}</span>`
    : formatCurrency(row.billed);
  const canPay = open && row.status !== 'Upcoming' && row.outstanding > 0;
  const payLink = canPay
    ? `<div><button type="button" style="${linkBtn('var(--green)')}" onclick="openSOBRecordPayment(${sob.id})">Record payment</button></div>` : '';

  return `<tr${row.needsAttention ? ' style="background:var(--linen-2)"' : ''}>
    <td style="font-weight:500;color:var(--ink)">${escapeHtml(sob.client ?? '—')}</td>
    <td style="font-size:11px;color:var(--ink-2)">${project ? escapeHtml(project.name) : '—'}${project ? `<div style="font-size:10px;color:var(--ink-3)">${escapeHtml(project.status)}</div>` : ''}</td>
    <td style="font-size:11px;color:var(--ink-3);white-space:nowrap">${escapeHtml(sob.sob_num)}</td>
    <td style="font-size:11px;color:var(--ink-3);white-space:nowrap">${displayDate(sob.issue_date)}</td>
    <td style="font-size:11px;color:var(--ink-3);white-space:nowrap">${displayDate(sob.due_date)}</td>
    <td class="amount-cell">${billedCell}</td>
    <td class="amount-cell" style="color:var(--green)">${row.collected ? formatCurrency(row.collected) : '—'}</td>
    <td class="amount-cell" style="font-weight:600">${row.outstanding ? formatCurrency(row.outstanding) : '—'}${payLink}</td>
    <td>
      <span class="badge badge-${STATUS_BADGE[row.status]}">${escapeHtml(row.status)}</span>
      <div style="font-size:10px;color:var(--ink-3);margin-top:3px" title="Outcome for reconciliation">${escapeHtml(outcome)}</div>
    </td>
    <td style="min-width:120px">${followUpCell(row)}</td>
  </tr>`;
}

export const PAYMENT_METHODS = ['GCash', 'BPI', 'PayMongo', 'Cash', 'Check', 'Bank Transfer', 'Other'] as const;

export function sobPaymentFormHTML(
  row: SOBCollection,
  orNum: string,
  today: string,
  unpaidReceipts: Invoice[],
): string {
  const { sob } = row;
  const methodOpts = PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('');
  const strayNote = unpaidReceipts.length
    ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:8px 12px;margin-bottom:14px;font-size:11.5px;color:#92400e">
        ${unpaidReceipts.map(i => escapeHtml(i.or_num)).join(', ')} was raised for this statement earlier and is not marked paid.
        Recording the payment here creates a new receipt — cancel the earlier one afterwards if it is no longer needed.
      </div>`
    : '';
  return `
    ${strayNote}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;font-size:12px">
      <div><div class="form-label">Billed</div><div style="font-weight:600">${formatCurrency(row.billed)}</div></div>
      <div><div class="form-label">Collected so far</div><div style="font-weight:600;color:var(--green)">${formatCurrency(row.collected)}</div></div>
      <div><div class="form-label">Still owed</div><div style="font-weight:600;color:var(--amber)">${formatCurrency(row.outstanding)}</div></div>
    </div>
    <div class="form-grid">
      <div class="form-group"><div class="form-label">Amount received (₱) *</div>
        <input class="form-input" id="sp-amount" type="number" min="0.01" step="0.01" value="${row.outstanding}"/>
        <div style="font-size:10.5px;color:var(--ink-3);margin-top:4px">Enter less than the balance for a part payment.</div>
      </div>
      <div class="form-group"><div class="form-label">OR #</div><input class="form-input" id="sp-or" value="${escapeHtml(orNum)}"/></div>
      <div class="form-group"><div class="form-label">Payment Method *</div>
        <select class="form-input" id="sp-method"><option value="">— select —</option>${methodOpts}</select>
      </div>
      <div class="form-group"><div class="form-label">Reference / Check #</div><input class="form-input" id="sp-ref" placeholder="GCash ref, BPI confirmation, etc."/></div>
      <div class="form-group"><div class="form-label">Payment Date *</div><input class="form-input" id="sp-date" type="date" value="${today}"/></div>
      <div class="form-group"><div class="form-label">Received By</div><input class="form-input" id="sp-received" placeholder="Your name or team member"/></div>
    </div>
    <div style="font-size:10.5px;color:var(--ink-3);margin-top:10px">
      Saves an Official Receipt against ${escapeHtml(sob.sob_num)} and posts the amount to the Cash Ledger.
    </div>`;
}
