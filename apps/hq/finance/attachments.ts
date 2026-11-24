// Receipt attachments on expenses and Cash Ledger entries (handover §15):
// several files per record, each with who uploaded it and when, viewable and
// downloadable through a fresh short-lived link. Removing a file only hides it;
// the stored original is never deleted.
import { sb } from '@shared/core/supabase.ts';
import { getCurrentUser } from '@shared/core/authService.ts';
import { logDocActivity } from '@shared/services/documents/activityLogService.ts';
import { _attachments, _bills, _ledger, setAttachments } from '@hq/core/state.ts';
import { toast, openModal, closeModal } from '@hq/core/ui.ts';
import { RECEIPTS_BUCKET, signAttachment } from './receiptAttachment.ts';
import {
  attachmentsFor, receiptObjectPath, validateReceiptFile,
  type AttachmentRecordType, type ListedAttachment,
} from './attachmentCalc.ts';
import { fetchAttachments, insertAttachment, markAttachmentRemoved } from './attachmentService.ts';
import { updateBill } from './financeService.ts';
import { updateLedgerEntry } from './ledgerService.ts';
import { canManageFinance } from './financePermissions.ts';
import { attachmentListId, attachmentRowsHTML, receiptPickerHTML } from './templates/attachments.ts';
// Circular by module graph, safe by use: only called inside a function body.
import { loadFinance } from './finance.ts';

// Payables has always filed under receipts/, the ledger under ledger/.
const FOLDER: Record<AttachmentRecordType, string> = { bill: 'receipts', ledger: 'ledger' };

function legacyRef(type: AttachmentRecordType, id: number): string | null {
  return type === 'bill'
    ? _bills.find(b => b.id === id)?.receipt_url ?? null
    : _ledger.find(e => e.id === id)?.attachment_url ?? null;
}

function recordLabel(type: AttachmentRecordType, id: number): string | null {
  return type === 'bill'
    ? _bills.find(b => b.id === id)?.expense_number ?? null
    : _ledger.find(e => e.id === id)?.reference_no ?? null;
}

export function recordAttachments(type: AttachmentRecordType, id: number): ListedAttachment[] {
  return attachmentsFor(type, id, _attachments, legacyRef(type, id));
}

export function pickedFiles(inputId: string): File[] {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  return Array.from(input?.files ?? []);
}

// Checked before the record itself is saved, so a wrong file stops the save
// with a reason instead of leaving a half-finished record behind.
export function checkPickedFiles(files: File[]): string | null {
  return files.map(validateReceiptFile).find(Boolean) ?? null;
}

// Before migration 022 there is no attachments table; the record's own
// single-file column is all there is, and only an empty one may be filled.
async function saveToOldColumn(type: AttachmentRecordType, id: number, path: string): Promise<boolean> {
  if (legacyRef(type, id)) return false;
  return type === 'bill'
    ? updateBill(id, { receipt_url: path })
    : updateLedgerEntry(id, { attachment_url: path });
}

// Uploads each file and records it against the record. Returns how many were
// saved and a message for each one that was not.
export async function uploadRecordFiles(
  type: AttachmentRecordType,
  id: number,
  files: File[],
): Promise<{ saved: number; problems: string[] }> {
  const problems: string[] = [];
  let saved = 0;
  const user  = await getCurrentUser();
  const actor = user?.name ?? user?.email ?? null;

  for (const file of files) {
    const invalid = validateReceiptFile(file);
    if (invalid) { problems.push(invalid); continue; }

    const path = receiptObjectPath(FOLDER[type], file.name, crypto.randomUUID());
    const { error } = await sb.storage.from(RECEIPTS_BUCKET)
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (error) {
      console.error('receipt upload failed:', error);
      problems.push(`${file.name} could not be uploaded`);
      continue;
    }

    const row = await insertAttachment({
      record_type: type, record_id: id, storage_path: path,
      file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
      uploaded_by: user?.id ?? null, uploaded_by_name: actor,
      uploaded_at: new Date().toISOString(),
    });
    if (row === 'missing-table') {
      if (await saveToOldColumn(type, id, path)) { saved++; continue; }
      problems.push(`${file.name} was uploaded, but only one receipt per record is possible until database migration 022 is run`);
      continue;
    }
    if (!row) { problems.push(`${file.name} was uploaded but could not be recorded`); continue; }
    saved++;
    await logDocActivity(type, id, recordLabel(type, id), 'updated', actor, `Receipt attached: ${file.name}`);
  }
  return { saved, problems };
}

// One toast for the whole batch.
export function reportUpload(result: { saved: number; problems: string[] }): void {
  if (result.problems.length) {
    toast(result.problems.join(' · '), 'error');
  } else if (result.saved) {
    toast(`${result.saved} receipt${result.saved !== 1 ? 's' : ''} attached`, 'success');
  }
}

async function refreshAttachments(type: AttachmentRecordType, id: number): Promise<void> {
  setAttachments(await fetchAttachments());
  const list = document.getElementById(attachmentListId(type, id));
  if (list) list.innerHTML = attachmentRowsHTML(type, id, recordAttachments(type, id), canManageFinance());
}

// ── View / download / remove ─────────────────────────────────────────────────

// The blank tab is opened synchronously — a window.open after an await is
// blocked as a popup. 'noopener' is deliberately not passed: it makes
// window.open return null; the opener is severed by hand instead.
async function openSigned(stored: string, downloadAs?: string): Promise<void> {
  const tab = window.open('', '_blank');
  const url = await signAttachment(stored, downloadAs);
  if (!url) {
    tab?.close();
    toast('Could not open the receipt — it may have been removed from storage', 'error');
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
  } else {
    toast('Allow pop-ups for this site to view receipts', 'error');
  }
}

export function viewRecordAttachment(type: AttachmentRecordType, id: number, index: number) {
  const a = recordAttachments(type, id)[index];
  if (a) void openSigned(a.storage_path);
}

export function downloadRecordAttachment(type: AttachmentRecordType, id: number, index: number) {
  const a = recordAttachments(type, id)[index];
  if (a) void openSigned(a.storage_path, a.file_name);
}

export async function removeRecordAttachment(type: AttachmentRecordType, id: number, index: number) {
  if (!canManageFinance()) { toast('You do not have permission to change finance records', 'error'); return; }
  const a = recordAttachments(type, id)[index];
  if (!a?.id) return;
  if (!confirm(`Remove ${a.file_name} from this record? The original file is kept in storage.`)) return;
  const user  = await getCurrentUser();
  const actor = user?.name ?? user?.email ?? null;
  if (!(await markAttachmentRemoved(a.id, actor))) return;
  await logDocActivity(type, id, recordLabel(type, id), 'updated', actor, `Receipt removed: ${a.file_name}`);
  toast('Receipt removed', '');
  await refreshAttachments(type, id);
}

// ── The record's receipts in their own window ────────────────────────────────

export function openRecordAttachments(type: AttachmentRecordType, id: number) {
  const canManage = canManageFinance();
  const items = recordAttachments(type, id);
  const label = recordLabel(type, id) ?? (type === 'bill' ? 'Expense' : 'Ledger entry');
  const body = `
    <div id="${attachmentListId(type, id)}" style="margin-bottom:14px">${attachmentRowsHTML(type, id, items, canManage)}</div>
    ${canManage ? `<div class="form-group"><div class="form-label">Add receipts</div>${receiptPickerHTML('ra-files')}</div>` : ''}`;

  openModal(`Receipts — ${label}`, body, async () => {
    const files = canManage ? pickedFiles('ra-files') : [];
    if (!files.length) { closeModal(); return; }
    const invalid = checkPickedFiles(files);
    if (invalid) { toast(invalid, 'error'); return; }
    const result = await uploadRecordFiles(type, id, files);
    reportUpload(result);
    if (!result.saved) return;
    closeModal();
    await loadFinance();
  }, canManage ? 'Upload' : 'Close');
}

// The paperclip on a table row: one file opens straight away, several (or a
// record that needs files added) open the list.
export function openRecordPaperclip(type: AttachmentRecordType, id: number) {
  const items = recordAttachments(type, id);
  if (items.length === 1) { void openSigned(items[0].storage_path); return; }
  openRecordAttachments(type, id);
}

export function paperclipHTML(type: AttachmentRecordType, id: number, color: string): string {
  const count = recordAttachments(type, id).length;
  if (!count) return '';
  const label = count === 1 ? 'View receipt' : `View ${count} receipts`;
  return ` <button type="button" title="${label}" aria-label="${label}" onclick="openRecordPaperclip('${type}',${id})" style="background:none;border:none;padding:0;cursor:pointer;color:${color};font-size:10px">&#128206;${count > 1 ? `<span style="font-size:9px">${count}</span>` : ''}</button>`;
}
