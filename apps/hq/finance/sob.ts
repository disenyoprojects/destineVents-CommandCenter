import { formatCurrency } from '@shared/utils/formatUtils.ts';
import { formatDateShort, todayISO } from '@shared/utils/dateUtils.ts';
import { escapeHtml, jsArg } from '@shared/utils/helpers.ts';
import { validateRequired } from '@shared/utils/validators.ts';
import { isFilledLineItem, itemsMissingDescription } from '@shared/documents/lineItems.ts';
import { APP_SETTINGS } from '@config/settings.ts';
import {
  fetchSOBs, fetchSOBLineItems, createSOB, updateSOB, deleteSOB, upsertSOBLineItems,
} from '@hq/finance/sobService.ts';
import { _clients, _projects, _invoices, _sobs, setSOBs } from '@hq/core/state.ts';
import { toast, openModal, closeModal } from '@hq/core/ui.ts';
import { collectionFor, receiptsForSOB } from './collectionsCalc.ts';
import { collectionBadgeClass } from './templates/collections.ts';
import type { SOB, SOBLineItem, InvoiceLineItem } from '@shared/types.ts';
import { nextDocNumber } from '@shared/services/documents/docNumberService.ts';
import { statusOptions } from '@shared/documents/docTransitions.ts';
import { logDocActivity } from '@shared/services/documents/activityLogService.ts';
import { getCurrentUser } from '@shared/core/authService.ts';
import { fetchProposalLineItems } from '@hq/proposals/proposalService.ts';
import {
  sobLineItemsFor, shouldAdvanceOnBilling, dueDateFrom, defaultPaymentInstructions,
} from './sobFromProject.ts';
import { updateProject } from '@hq/projects/projectService.ts';
// Circular by module graph, safe by use: only called inside a function body.
import { loadFinance } from './finance.ts';
import {
  buildDocPDF, docPDFLineItemsTable, docPDFTotals,
} from '@shared/documents/pdfTemplate.ts';
import { openDocEmail } from '@shared/documents/docEmail.ts';

let _editingSOBId: number | null  = null;
let _showArchivedSOBs             = false;
let _sobPage                      = 1;
const SOB_PAGE_SIZE               = 10;

function paginationBar(page: number, total: number, size: number, fn: string): string {
  if (total <= size) return '';
  const pages = Math.ceil(total / size);
  const from  = (page - 1) * size + 1;
  const to    = Math.min(page * size, total);
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-top:1px solid var(--ink-4);font-size:11px;color:var(--ink-3)"><span>${from}–${to} of ${total}</span><div style="display:flex;gap:6px;align-items:center"><button class="btn btn-ghost" style="padding:3px 10px;font-size:11px" ${page <= 1 ? 'disabled' : `onclick="${fn}(${page - 1})"`}>← Prev</button><span style="color:var(--ink-2);padding:0 2px">${page} / ${pages}</span><button class="btn btn-ghost" style="padding:3px 10px;font-size:11px" ${page >= pages ? 'disabled' : `onclick="${fn}(${page + 1})"`}>Next →</button></div></div>`;
}

function toISODate(val: string | null | undefined) {
  if (!val || val === '—') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function displayDate(val: string | null | undefined) {
  if (!val || val === '—') return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return formatDateShort(val);
  return escapeHtml(String(val));
}

function sobLineItemRowHTML(item: Partial<SOBLineItem> = {}) {
  const lineTotal = (item.quantity ?? 1) * (item.unit_price ?? 0) * (1 + (item.vat_rate ?? 0) / 100);
  return `
    <tr class="sob-li-row">
      <td style="padding:3px 4px"><input class="form-input sob-li-desc" style="font-size:12px;padding:4px 6px" value="${escapeHtml(item.description || '')}" placeholder="Service / item" oninput="recalcSOB()"/></td>
      <td style="padding:3px 4px"><input class="form-input sob-li-qty" style="font-size:12px;padding:4px 6px;text-align:right" type="number" value="${item.quantity ?? 1}" min="0" step="any" oninput="recalcSOB()"/></td>
      <td style="padding:3px 4px"><input class="form-input sob-li-price" style="font-size:12px;padding:4px 6px;text-align:right" type="number" value="${item.unit_price ?? 0}" min="0" step="any" oninput="recalcSOB()"/></td>
      <td style="padding:3px 4px"><input class="form-input sob-li-vat" style="font-size:12px;padding:4px 6px;text-align:right" type="number" value="${item.vat_rate ?? 0}" min="0" max="100" step="any" oninput="recalcSOB()"/></td>
      <td class="sob-li-amt" style="padding:3px 4px;text-align:right;font-size:12px">${formatCurrency(lineTotal)}</td>
      <td style="padding:3px 4px"><button type="button" class="btn btn-ghost" style="padding:2px 6px;font-size:11px;color:var(--red)" onclick="this.closest('tr').remove();recalcSOB()">×</button></td>
    </tr>`;
}

// Paid and Partially Paid are worked out from the receipts recorded against a
// statement (collectionsCalc.ts), so they are not offered as something to set
// by hand — only kept when a statement already carries one.
const PAYMENT_STATUSES = ['Paid', 'Partially Paid', 'Viewed'];
function sobStatusChoices(current: string): string[] {
  return statusOptions('sob', current).filter(o => o === current || !PAYMENT_STATUSES.includes(o));
}

function sobFormHTML(s: Partial<SOB> = {}, items: SOBLineItem[] = []) {
  const clientOpts  = _clients.map(c => `<option value="${escapeHtml(c.name)}"/>`).join('');
  const projectOpts = `<option value="">— no project —</option>` +
    _projects.map(p => `<option value="${p.id}"${s.project_id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const hasItems    = items.length > 0;
  const subtotal    = items.reduce((sum, li) => sum + li.quantity * li.unit_price, 0);
  const vatAmt      = items.reduce((sum, li) => sum + li.quantity * li.unit_price * li.vat_rate / 100, 0);
  const discount    = s.discount ?? 0;
  const total       = subtotal + vatAmt - discount;
  const replacementOpts = `<option value="">— none —</option>` +
    _sobs.filter(x => x.id !== s.id && !x.archived_at)
      .map(x => `<option value="${x.id}"${s.superseded_by === x.id ? ' selected' : ''}>${escapeHtml(x.sob_num)} · ${escapeHtml(x.client ?? '')}</option>`).join('');

  return `<datalist id="sob-client-list">${clientOpts}</datalist>
  <div class="form-grid">
    <div class="form-group"><div class="form-label">SOB Number</div><input class="form-input" id="sob-num" value="${escapeHtml(s.sob_num || '')}" placeholder="SOB-2026-001"/></div>
    <div class="form-group"><div class="form-label">Client</div><input class="form-input" id="sob-client" value="${escapeHtml(s.client || '')}" list="sob-client-list" placeholder="Client name" autocomplete="off"/></div>
    <div class="form-group"><div class="form-label">Status</div>
      <select class="form-input" id="sob-status">
        ${sobStatusChoices(s.status || 'Draft')
          .map(o => `<option${o === (s.status || 'Draft') ? ' selected' : ''}>${o}</option>`).join('')}
      </select>
      <div style="font-size:10.5px;color:var(--ink-3);margin-top:4px">Paid / part-paid follows the payments recorded.</div>
    </div>
    <div class="form-group"><div class="form-label">Currency</div>
      <select class="form-input" id="sob-currency">
        <option value="PHP"${(s.currency ?? 'PHP') === 'PHP' ? ' selected' : ''}>PHP — Philippine Peso</option>
        <option value="USD"${s.currency === 'USD' ? ' selected' : ''}>USD — US Dollar</option>
      </select>
    </div>
    <div class="form-group"><div class="form-label">Issue Date</div><input class="form-input" id="sob-issue" type="date" value="${toISODate(s.issue_date)}"/></div>
    <div class="form-group"><div class="form-label">Due Date</div><input class="form-input" id="sob-due" type="date" value="${toISODate(s.due_date)}"/></div>
    <div class="form-group full"><div class="form-label">Project (optional)</div><select class="form-input" id="sob-project">${projectOpts}</select></div>
    <div class="form-group full"><div class="form-label">Description (optional)</div><textarea class="form-input" id="sob-desc" rows="2" placeholder="Brief description of services billed">${escapeHtml(s.description || '')}</textarea></div>
    <div class="form-group"><div class="form-label">Replaced by (if superseded)</div><select class="form-input" id="sob-superseded-by">${replacementOpts}</select></div>
    <div class="form-group"><div class="form-label">Outcome note</div><input class="form-input" id="sob-outcome-note" value="${escapeHtml(s.outcome_note || '')}" placeholder="Why it was cancelled or amended"/></div>
  </div>

  <div style="margin-top:18px">
    <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:8px">Line Items</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 6px;font-weight:600;color:var(--ink-3)">Description</th>
          <th style="text-align:right;padding:4px 6px;font-weight:600;color:var(--ink-3);width:56px">Qty</th>
          <th style="text-align:right;padding:4px 6px;font-weight:600;color:var(--ink-3);width:100px">Unit Price</th>
          <th style="text-align:right;padding:4px 6px;font-weight:600;color:var(--ink-3);width:50px">VAT%</th>
          <th style="text-align:right;padding:4px 6px;font-weight:600;color:var(--ink-3);width:100px">Amount</th>
          <th style="width:24px"></th>
        </tr>
      </thead>
      <tbody id="sob-line-rows">
        ${items.map(item => sobLineItemRowHTML(item)).join('')}
      </tbody>
    </table>
    <button type="button" class="btn btn-ghost" style="margin-top:8px;font-size:11px;padding:4px 10px" onclick="addSOBRow()">+ Add Row</button>
    <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
      <div style="display:flex;justify-content:flex-end;gap:16px;font-size:12px"><span style="color:var(--ink-3)">Subtotal</span><span id="sob-subtotal" style="font-weight:600;min-width:100px;text-align:right">${hasItems ? formatCurrency(subtotal) : '—'}</span></div>
      <div style="display:flex;justify-content:flex-end;gap:16px;font-size:12px;margin-top:4px"><span style="color:var(--ink-3)">VAT</span><span id="sob-vat-display" style="min-width:100px;text-align:right">${hasItems ? formatCurrency(vatAmt) : '—'}</span></div>
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:6px">
        <span style="font-size:12px;color:var(--ink-3)">Discount (₱)</span>
        <input class="form-input" id="sob-discount" type="number" value="${discount}" min="0" step="any" style="width:110px;font-size:12px;padding:4px 8px;text-align:right" oninput="recalcSOB()"/>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:16px;font-size:13px;margin-top:6px;font-weight:700"><span>Total</span><span id="sob-total-display" style="min-width:100px;text-align:right">${hasItems ? formatCurrency(total) : '—'}</span></div>
    </div>
  </div>

  <div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
    <div class="form-grid">
      <div class="form-group full"><div class="form-label">Payment Instructions (optional)</div><textarea class="form-input" id="sob-pay-instr" rows="2" placeholder="Bank transfer details, GCash, etc.">${escapeHtml(s.payment_instructions || '')}</textarea></div>
      <div class="form-group full"><div class="form-label">Notes (optional)</div><textarea class="form-input" id="sob-notes" rows="2" placeholder="Terms, remarks, etc.">${escapeHtml(s.notes || '')}</textarea></div>
      <div class="form-group"><div class="form-label">Prepared By</div><input class="form-input" id="sob-prepared-by" value="${escapeHtml(s.prepared_by || '')}" placeholder="Your name"/></div>
      <div class="form-group"><div class="form-label">Approved By</div><input class="form-input" id="sob-approved-by" value="${escapeHtml(s.approved_by || '')}" placeholder="Approver name"/></div>
    </div>
  </div>`;
}

export function renderSOB(sobs: SOB[]) {
  const visible = _showArchivedSOBs
    ? sobs.filter(s => s.archived_at)
    : sobs.filter(s => !s.archived_at);
  const today    = todayISO();
  const rowsById = new Map(visible.map(s => [s.id, collectionFor(s, _invoices, today)]));
  const billed    = [...rowsById.values()].reduce((sum, r) => sum + r.billed, 0);
  const collected = [...rowsById.values()].reduce((sum, r) => sum + r.collected, 0);
  const archivedCount = sobs.filter(s => s.archived_at).length;

  const summaryEl = document.getElementById('sob-summary');
  if (summaryEl) {
    summaryEl.textContent = `${visible.length} billing statement${visible.length !== 1 ? 's' : ''} · ${formatCurrency(billed)} billed · ${formatCurrency(collected)} collected`;
  }

  const toggleBtn = document.getElementById('sob-archive-toggle');
  if (toggleBtn) toggleBtn.textContent = _showArchivedSOBs ? 'Hide Archived' : `Archived (${archivedCount})`;

  const tbody  = document.getElementById('sob-tbody');
  const pagEl  = document.getElementById('sob-pagination');
  if (!tbody) return;

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${_showArchivedSOBs ? 'No archived billing statements' : 'No billing statements yet'}</div></td></tr>`;
    if (pagEl) pagEl.innerHTML = '';
    return;
  }

  const pStart   = (_sobPage - 1) * SOB_PAGE_SIZE;
  const pageRows = visible.slice(pStart, pStart + SOB_PAGE_SIZE);

  tbody.innerHTML = pageRows.map(s => {
    const isArchived  = !!s.archived_at;
    const row         = rowsById.get(s.id) ?? collectionFor(s, _invoices, today);
    const receipts    = receiptsForSOB(s, _invoices);
    const canConvert  = !receipts.length && !['Paid', 'Cancelled', 'Superseded'].includes(s.status) && !isArchived;
    const proj        = s.project_id ? _projects.find(p => p.id === s.project_id) : null;
    const primaryBtn = isArchived ? '' :
      canConvert
        ? `<button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;color:var(--gold)" onclick="convertSOBToInvoice(${s.id})">→ Invoice</button>`
        : receipts.length
          ? `<span style="font-size:10px;color:var(--green);padding:0 2px">${receipts.length === 1 ? escapeHtml(receipts[0].or_num) : `${receipts.length} receipts`}</span>`
          : '';
    const emailBtnVis = !isArchived
      ? `<button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;color:var(--blue)" onclick="openSOBSendEmail(${s.id})">Email</button>`
      : '';
    const recordItem = row.billed > 0 && row.outstanding > 0 && !isArchived
      ? `<button onclick="openSOBRecordPayment(${s.id})">Record Payment</button>` : '';
    const moreItems = isArchived
      ? `<button onclick="printSOB(${s.id})">Download PDF</button>
         <div class="action-menu-sep"></div>
         <button onclick="restoreSOB(${s.id})">Restore</button>
         <button class="menu-danger" onclick="handleDeleteSOB(${s.id})">Delete</button>`
      : [
          recordItem,
          `<button onclick="printSOB(${s.id})">Download PDF</button>`,
          `<button onclick="openEditSOB(${s.id})">Edit</button>`,
          `<button onclick="openDuplicateSOB(${s.id})">Duplicate</button>`,
          `<button onclick="openDocActivityLog('sob',${s.id},${jsArg(s.sob_num)})">Activity Log</button>`,
          `<div class="action-menu-sep"></div>`,
          `<button onclick="archiveSOB(${s.id})">Archive</button>`,
          `<button class="menu-danger" onclick="handleDeleteSOB(${s.id})">Delete</button>`,
        ].filter(Boolean).join('');
    return `
    <tr${isArchived ? ' style="opacity:0.6"' : ''}>
      <td style="font-size:11px;color:var(--ink-3)">${escapeHtml(s.sob_num)}</td>
      <td style="font-weight:500;color:var(--ink)">${escapeHtml(s.client ?? '—')}</td>
      <td style="font-size:11px;color:var(--ink-3)">${proj ? escapeHtml(proj.name) : '—'}</td>
      <td class="amount-cell">${formatCurrency(s.total_amount)}${row.collected > 0 && row.outstanding > 0 ? `<div style="font-size:10px;color:var(--green)">${formatCurrency(row.collected)} paid</div>` : ''}</td>
      <td style="font-size:11px;color:var(--ink-3)">${displayDate(s.issue_date)}</td>
      <td style="font-size:11px;color:var(--ink-3)">${displayDate(s.due_date)}</td>
      <td><span class="badge badge-${collectionBadgeClass(row.status)}">${escapeHtml(row.status)}</span></td>
      <td>
        <div class="flex-gap" style="gap:4px">
          ${primaryBtn}
          ${emailBtnVis}
          <div class="action-menu">
            <button class="action-menu-trigger" onclick="toggleActionMenu(this)">···</button>
            <div class="action-menu-dropdown">${moreItems}</div>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  if (pagEl) pagEl.innerHTML = paginationBar(_sobPage, visible.length, SOB_PAGE_SIZE, 'setSOBPage');
}

export function setSOBPage(page: number) {
  _sobPage = page;
  renderSOB(_sobs);
}

export function toggleArchivedSOBs() {
  _showArchivedSOBs = !_showArchivedSOBs;
  _sobPage = 1;
  renderSOB(_sobs);
}

// The Billing Pipeline's → SOB button.
//
// A project only reaches this stage by winning a quotation, and that quotation
// was itemised when it was written — so the statement opens on those same
// lines, VAT and all, rather than on an empty form. The pipeline used to write
// a single lump sum with no line items at all, which meant the invoice
// converted from it had none either, and every line was typed a third time.
//
// It also opens the real statement form rather than the five-field one it kept
// to itself, so a statement raised from a project can carry everything one
// raised from this tab can.
export async function openSOBForProject(projectId: number) {
  const p = _projects.find(x => x.id === projectId);
  if (!p) { toast('Project not found', 'error'); return; }
  _editingSOBId = null;

  const quoted = p.proposal_id ? await fetchProposalLineItems(p.proposal_id) : [];
  const items  = sobLineItemsFor(p, quoted);

  const user  = await getCurrentUser();
  const issue = todayISO();
  openModal('Statement of Billing — ' + p.name, sobFormHTML({
    sob_num:     nextDocNumber('SOB', _sobs.map(x => x.sob_num)),
    client:      p.client,
    project_id:  p.id,
    status:      'Draft',
    currency:    'PHP',
    issue_date:  issue,
    due_date:    dueDateFrom(issue),
    prepared_by: user?.name ?? user?.email ?? '',
    payment_instructions: defaultPaymentInstructions(),
  }, items), saveSOB);
}

export function openAddSOB() {
  _editingSOBId = null;
  const autoNum = nextDocNumber('SOB', _sobs.map(s => s.sob_num));
  openModal('New Statement of Billing', sobFormHTML({ sob_num: autoNum }), saveSOB);
}

export async function openEditSOB(id: number) {
  const s = _sobs.find(x => x.id === id);
  if (!s) return;
  _editingSOBId = id;
  const items = await fetchSOBLineItems(id);
  openModal('Edit Statement of Billing', sobFormHTML(s, items), saveSOB);
}

export async function openDuplicateSOB(id: number) {
  const original = _sobs.find(x => x.id === id);
  if (!original) return;
  const items = await fetchSOBLineItems(id);
  _editingSOBId = null;
  const autoNum = nextDocNumber('SOB', _sobs.map(s => s.sob_num));
  const draft: Partial<SOB> = {
    sob_num:              autoNum,
    client:               original.client,
    project_id:           original.project_id,
    description:          original.description,
    subtotal:             original.subtotal,
    discount:             original.discount,
    vat_amount:           original.vat_amount,
    total_amount:         original.total_amount,
    payment_instructions: original.payment_instructions,
    notes:                original.notes,
    prepared_by:          original.prepared_by,
    approved_by:          original.approved_by,
    status:               'Draft',
  };
  openModal('Duplicate Statement of Billing', sobFormHTML(draft, items), saveSOB);
  toast('Duplicated — SOB number auto-filled, save to confirm', '');
}

export async function saveSOB() {
  const sob_num = (document.getElementById('sob-num') as HTMLInputElement).value.trim();
  const err = validateRequired(sob_num, 'SOB number');
  if (err) { toast(err, 'error'); return; }
  if (_sobs.some(x => x.sob_num === sob_num && x.id !== _editingSOBId)) {
    toast(`${sob_num} is already used by another statement — pick another number`, 'error');
    return;
  }

  const rows = document.querySelectorAll<HTMLTableRowElement>('#sob-line-rows .sob-li-row');
  const lineItems: SOBLineItem[] = [];
  rows.forEach(row => {
    const description = (row.querySelector('.sob-li-desc') as HTMLInputElement).value.trim();
    const quantity    = +(row.querySelector('.sob-li-qty')   as HTMLInputElement).value || 1;
    const unit_price  = +(row.querySelector('.sob-li-price') as HTMLInputElement).value || 0;
    const vat_rate    = +(row.querySelector('.sob-li-vat')   as HTMLInputElement).value || 0;
    // Keep a priced row even with no wording yet — dropping it here is what let
    // a statement bill a client ₱0. The check below names what is missing.
    const item = { description, quantity, unit_price, vat_rate };
    if (isFilledLineItem(item)) lineItems.push(item);
  });

  if (itemsMissingDescription(lineItems).length > 0) {
    toast('Every line item needs a description — fill it in, or clear the row', 'error');
    return;
  }

  const subtotal  = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_price, 0);
  const vatAmount = lineItems.reduce((sum, li) => sum + li.quantity * li.unit_price * li.vat_rate / 100, 0);
  const discount  = +(document.getElementById('sob-discount') as HTMLInputElement).value || 0;
  const total     = subtotal + vatAmount - discount;

  // A statement of billing is what the client is asked to pay. Sending one for
  // ₱0 used to be silent.
  if (total <= 0) {
    toast('Add a line item with a quantity and unit price — this statement would bill ₱0', 'error');
    return;
  }

  const projVal = (document.getElementById('sob-project') as HTMLSelectElement).value;
  const payload: Partial<SOB> = {
    sob_num,
    client:    (document.getElementById('sob-client') as HTMLInputElement).value.trim() || null,
    status:    (document.getElementById('sob-status') as HTMLSelectElement).value,
    currency:  (document.getElementById('sob-currency') as HTMLSelectElement).value || 'PHP',
    issue_date: (document.getElementById('sob-issue') as HTMLInputElement).value || null,
    due_date:   (document.getElementById('sob-due')   as HTMLInputElement).value || null,
    subtotal,
    vat_amount:  vatAmount,
    discount,
    total_amount: lineItems.length > 0 ? total : 0,
  };
  if (projVal) payload.project_id = +projVal;

  const description    = (document.getElementById('sob-desc')        as HTMLTextAreaElement).value.trim();
  const payInstr       = (document.getElementById('sob-pay-instr')   as HTMLTextAreaElement).value.trim();
  const notes          = (document.getElementById('sob-notes')        as HTMLTextAreaElement).value.trim();
  const preparedBy     = (document.getElementById('sob-prepared-by') as HTMLInputElement).value.trim();
  const approvedBy     = (document.getElementById('sob-approved-by') as HTMLInputElement).value.trim();
  if (description) payload.description           = description;
  if (payInstr)    payload.payment_instructions  = payInstr;
  if (notes)       payload.notes                 = notes;
  if (preparedBy)  payload.prepared_by           = preparedBy;
  if (approvedBy)  payload.approved_by           = approvedBy;

  // Migration 021 columns: only sent when set, or when clearing a value the
  // statement already had, so saving still works before the migration is run.
  const existing      = editingSOB();
  const outcomeNote   = (document.getElementById('sob-outcome-note') as HTMLInputElement).value.trim();
  const supersededRaw = (document.getElementById('sob-superseded-by') as HTMLSelectElement).value;
  if (outcomeNote || existing?.outcome_note)   payload.outcome_note  = outcomeNote || null;
  if (supersededRaw || existing?.superseded_by) payload.superseded_by = supersededRaw ? +supersededRaw : null;
  if (payload.status === 'Superseded' && !supersededRaw && !outcomeNote) {
    toast('Say which statement replaces this one, or add an outcome note', 'error');
    return;
  }
  // A superseded statement stops counting, receipts and all — so one that has
  // already collected money would make its payments vanish from the client's
  // balance. Settle or cancel the remainder on this statement instead.
  if (existing && payload.status === 'Superseded' && existing.status !== 'Superseded') {
    const paid = collectionFor(existing, _invoices, todayISO()).collected;
    if (paid > 0) {
      toast(`${existing.sob_num} already has ${formatCurrency(paid)} paid against it — it cannot be superseded. Record or cancel the remaining balance on it instead.`, 'error');
      return;
    }
  }

  const user = await getCurrentUser();
  const actor = user?.name ?? user?.email ?? null;
  let sobId = _editingSOBId;
  if (sobId) {
    const ok = await updateSOB(sobId, payload);
    if (!ok) { toast('Could not update billing statement', 'error'); return; }
    toast('Billing statement updated', 'success');
    await logDocActivity('sob', sobId, sob_num, 'updated', actor);
  } else {
    const result = await createSOB(payload);
    if (!result) { toast('Could not create billing statement. Please try again.', 'error'); return; }
    sobId = result.id;
    toast('Billing statement created', 'success');
    await logDocActivity('sob', sobId, sob_num, 'created', actor);
    if (payload.project_id) await advanceProjectOnBilling(payload.project_id);
  }

  if (sobId && lineItems.length) {
    await upsertSOBLineItems(sobId, lineItems);
  }

  closeModal();
  // The whole tab is redrawn, not just this table: statements feed the
  // Collections tab and the receivables cards, and a project that just moved
  // along the pipeline shows on the Receivables overview.
  await loadFinance();
}

// Billing a project is what advances it, whichever door the statement came
// from. Raising one from this tab used to leave the project at Proposal
// Approved, so the pipeline went on offering → SOB and a duplicate statement
// was one click away — and nothing in the project form could correct the stage,
// which does not offer the pipeline's own statuses.
function editingSOB(): SOB | undefined {
  return _editingSOBId ? _sobs.find(x => x.id === _editingSOBId) : undefined;
}

async function advanceProjectOnBilling(projectId: number): Promise<boolean> {
  const proj = _projects.find(p => p.id === projectId);
  if (!shouldAdvanceOnBilling(proj)) return false;
  const ok = await updateProject(projectId, {
    status: 'Statement of Billing',
    updated_at: new Date().toISOString(),
  });
  if (ok) toast(`${proj.name} moved to Statement of Billing`, 'success');
  return ok;
}

export async function handleDeleteSOB(id: number) {
  if (!confirm('Delete this billing statement? This cannot be undone.')) return;
  const ok = await deleteSOB(id);
  if (!ok) { toast('Could not delete billing statement', 'error'); return; }
  toast('Billing statement deleted', '');
  // Statements feed the Collections tab and the receivables cards, not just
  // this table — redraw the lot so the totals move with it.
  await loadFinance();
}

export async function archiveSOB(id: number) {
  const sob = _sobs.find(x => x.id === id);
  const ok = await updateSOB(id, { archived_at: new Date().toISOString() } as Partial<SOB>);
  if (!ok) { toast('Could not archive billing statement', 'error'); return; }
  toast('Billing statement archived', '');
  const user = await getCurrentUser();
  await logDocActivity('sob', id, sob?.sob_num ?? null, 'archived', user?.name ?? user?.email ?? null);
  // Statements feed the Collections tab and the receivables cards, not just
  // this table — redraw the lot so the totals move with it.
  await loadFinance();
}

export async function restoreSOB(id: number) {
  const ok = await updateSOB(id, { archived_at: null } as Partial<SOB>);
  if (!ok) { toast('Could not restore billing statement', 'error'); return; }
  toast('Billing statement restored', '');
  // Statements feed the Collections tab and the receivables cards, not just
  // this table — redraw the lot so the totals move with it.
  await loadFinance();
}

export async function convertSOBToInvoice(id: number) {
  const sob = _sobs.find(x => x.id === id);
  if (!sob) return;
  if (receiptsForSOB(sob, _invoices).length) {
    toast('This SOB already has a receipt — use Record Payment for the next payment', 'error');
    return;
  }
  const sobItems = await fetchSOBLineItems(id);
  const lineItems: InvoiceLineItem[] = sobItems.map(({ description, quantity, unit_price, vat_rate }) => ({
    description, quantity, unit_price, vat_rate,
  }));
  window.openInvoiceFromSOB({
    client:     sob.client,
    amount:     sob.total_amount,
    status:     'Draft',
    date:       sob.issue_date,
    due:        sob.due_date,
    project_id: sob.project_id,
    notes:      sob.notes,
    subtotal:   sob.subtotal,
    vat_amount: sob.vat_amount,
    discount:   sob.discount,
  }, lineItems, id);
}

export function addSOBRow() {
  const tbody = document.getElementById('sob-line-rows');
  if (!tbody) return;
  tbody.insertAdjacentHTML('beforeend', sobLineItemRowHTML());
  recalcSOB();
}

export function recalcSOB() {
  const rows = document.querySelectorAll<HTMLTableRowElement>('#sob-line-rows .sob-li-row');
  let subtotal = 0;
  let vatTotal = 0;
  rows.forEach(row => {
    const qty   = +(row.querySelector('.sob-li-qty')   as HTMLInputElement).value || 0;
    const price = +(row.querySelector('.sob-li-price') as HTMLInputElement).value || 0;
    const vat   = +(row.querySelector('.sob-li-vat')   as HTMLInputElement).value || 0;
    const lineSub = qty * price;
    const lineVat = lineSub * vat / 100;
    subtotal += lineSub;
    vatTotal += lineVat;
    const amtCell = row.querySelector('.sob-li-amt');
    if (amtCell) amtCell.textContent = formatCurrency(lineSub + lineVat);
  });
  const discountEl = document.getElementById('sob-discount') as HTMLInputElement | null;
  const discount = discountEl ? +discountEl.value || 0 : 0;
  const total = subtotal + vatTotal - discount;
  const stEl  = document.getElementById('sob-subtotal');
  const vatEl = document.getElementById('sob-vat-display');
  const totEl = document.getElementById('sob-total-display');
  if (stEl)  stEl.textContent  = formatCurrency(subtotal);
  if (vatEl) vatEl.textContent = formatCurrency(vatTotal);
  if (totEl) totEl.textContent = formatCurrency(total);
}

export async function printSOB(id: number) {
  const sob = _sobs.find(x => x.id === id);
  if (!sob) return;
  const items     = await fetchSOBLineItems(id);
  const subtotal  = sob.subtotal  ?? items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  const vatAmount = sob.vat_amount ?? items.reduce((s, li) => s + li.quantity * li.unit_price * li.vat_rate / 100, 0);
  const discount  = sob.discount ?? 0;
  const { company, banking } = APP_SETTINGS;
  const proj = _projects.find(p => p.id === sob.project_id);

  const statusClass = sob.status === 'Paid' ? 'paid' : sob.status === 'Sent' ? 'sent' : 'draft';
  const body = `
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #e8e3da">
  <div>
    <div class="label">Billed To</div>
    <div class="value" style="font-weight:600;font-size:15px">${escapeHtml(sob.client ?? '—')}</div>
    ${proj ? `<div style="font-size:11px;color:#888;margin-top:3px">Project: ${escapeHtml(proj.name)}</div>` : ''}
  </div>
  <div>
    <div class="label">Issue Date</div>
    <div class="value">${sob.issue_date ? formatDateShort(sob.issue_date) : '—'}</div>
    <div class="label" style="margin-top:10px">Due Date</div>
    <div class="value">${sob.due_date ? formatDateShort(sob.due_date) : '—'}</div>
  </div>
  <div>
    ${sob.prepared_by ? `<div class="label">Prepared By</div><div class="value">${escapeHtml(sob.prepared_by)}</div>` : ''}
    ${sob.approved_by ? `<div class="label" style="margin-top:10px">Approved By</div><div class="value">${escapeHtml(sob.approved_by)}</div>` : ''}
  </div>
</div>
${sob.description ? `<div style="margin-bottom:24px;font-size:13px;color:#555;line-height:1.6">${escapeHtml(sob.description)}</div>` : ''}
${docPDFLineItemsTable(items)}
${docPDFTotals({ subtotal, vat: vatAmount, discount, total: sob.total_amount })}
${sob.payment_instructions ? `<div style="margin-top:24px;padding:14px;background:#f9f6f0;border-radius:6px;font-size:12px;color:#555;line-height:1.7"><strong>Payment Instructions:</strong> ${escapeHtml(sob.payment_instructions)}</div>` : ''}
${sob.notes ? `<div style="margin-top:12px;padding:14px;background:#f9f6f0;border-radius:6px;font-size:12px;color:#555;line-height:1.7"><strong>Notes:</strong> ${escapeHtml(sob.notes)}</div>` : ''}`

  const html = buildDocPDF({
    title: 'STATEMENT OF BILLING',
    number: sob.sob_num,
    status: sob.status,
    statusClass,
    company: {
      name: company.name,
      address: company.address,
      email: company.email,
      bankAccountName: banking.bpiAccountName,
      bankAccountNumber: banking.bpiAccountNumber,
    },
    showBanking: true,
    body,
    sigLeft:  sob.prepared_by ? { label: 'Prepared By', name: sob.prepared_by } : { label: 'Prepared By' },
    sigRight: sob.approved_by ? { label: 'Approved By', name: sob.approved_by } : { label: 'Approved By' },
  });

  const w = window.open('', '_blank', 'width=860,height=700');
  if (!w) { toast('Pop-up blocked — please allow pop-ups and try again', 'error'); return; }
  try {
    w.document.write(html);
    w.document.close();
    w.focus();
    const user = await getCurrentUser();
    await logDocActivity('sob', id, sob.sob_num, 'downloaded', user?.name ?? user?.email ?? null);
  } catch (error) {
    console.error('printSOB failed:', error);
    w.close();
    toast('Could not generate PDF. Please try again.', 'error');
  }
}

export function openSOBSendEmail(id: number) {
  const s = _sobs.find(x => x.id === id);
  if (!s) return;
  const { company } = APP_SETTINGS;
  const bodyLines = [
    `Dear ${s.client ?? 'Client'},`,
    '',
    `Please find attached the Statement of Billing ${s.sob_num} amounting to ${formatCurrency(s.total_amount)}.`,
    s.due_date ? `Payment is due on ${formatDateShort(s.due_date)}.` : '',
    s.payment_instructions ? `\nPayment Instructions:\n${s.payment_instructions}` : '',
    '',
    'Please do not hesitate to reach out should you have any questions.',
    '',
    'Thank you for your continued partnership.',
  ].filter(line => line !== undefined).join('\n');

  openDocEmail({
    modalTitle:     'Send SOB via Email',
    docSummary:     `${s.sob_num} · ${formatCurrency(s.total_amount)}${s.due_date ? ' · Due ' + formatDateShort(s.due_date) : ''}`,
    defaultSubject: `Statement of Billing ${s.sob_num} — ${s.client ?? company.name}`,
    defaultBody:    bodyLines,
    pdfHint:        'Download the PDF first to attach it to your email.',
    onSend: async () => {
      await updateSOB(id, { status: 'Sent' } as Partial<SOB>);
      const emailUser = await getCurrentUser();
      await logDocActivity('sob', id, s.sob_num, 'sent', emailUser?.name ?? emailUser?.email ?? null);
      toast('Email client opened — SOB marked as Sent', 'success');
      const fresh = await fetchSOBs();
      setSOBs(fresh);
      renderSOB(fresh);
    },
  });
}

// Extend Window to include the cross-module SOB↔Invoice bridges
declare global {
  interface Window {
    openInvoiceFromSOB: (draft: Partial<import('@shared/types.ts').Invoice>, items: InvoiceLineItem[], sobId: number) => void;
  }
}
