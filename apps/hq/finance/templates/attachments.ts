// Markup for a record's receipt list and the file picker. The list is drawn
// into a container with a stable id so it can be refreshed in place — inside
// the expense or ledger form as well as in its own modal.
import { escapeHtml } from '@shared/utils/helpers.ts';
import { formatDateShort } from '@shared/utils/dateUtils.ts';
import {
  RECEIPT_ACCEPT, formatFileSize, type AttachmentRecordType, type ListedAttachment,
} from '../attachmentCalc.ts';
import { toLocalDate } from '../collectionsCalc.ts';

export function attachmentListId(type: AttachmentRecordType, id: number): string {
  return `att-list-${type}-${id}`;
}

const linkBtn = 'background:none;border:none;padding:0;cursor:pointer;font:inherit;text-decoration:underline';

function uploadedLine(a: ListedAttachment): string {
  if (a.legacy) return 'Attached before upload details were recorded';
  const when = a.uploaded_at ? formatDateShort(toLocalDate(a.uploaded_at) ?? '') : 'date unknown';
  const size = formatFileSize(a.size_bytes);
  return [`Uploaded ${when}`, a.uploaded_by_name ? `by ${escapeHtml(a.uploaded_by_name)}` : '', size]
    .filter(Boolean).join(' · ');
}

export function attachmentRowsHTML(
  type: AttachmentRecordType,
  id: number,
  items: ListedAttachment[],
  canRemove: boolean,
): string {
  if (!items.length) {
    return '<div style="font-size:11px;color:var(--ink-3)">No receipts attached yet.</div>';
  }
  return items.map((a, i) => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--ink-4)">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--ink);overflow-wrap:anywhere">&#128206; ${escapeHtml(a.file_name)}</div>
        <div style="font-size:10.5px;color:var(--ink-3)">${uploadedLine(a)}</div>
      </div>
      <div style="display:flex;gap:10px;font-size:11px;white-space:nowrap">
        <button type="button" style="${linkBtn};color:var(--blue)" onclick="viewRecordAttachment('${type}',${id},${i})">View</button>
        <button type="button" style="${linkBtn};color:var(--blue)" onclick="downloadRecordAttachment('${type}',${id},${i})">Download</button>
        ${canRemove && !a.legacy ? `<button type="button" style="${linkBtn};color:var(--red)" onclick="removeRecordAttachment('${type}',${id},${i})">Remove</button>` : ''}
      </div>
    </div>`).join('');
}

// The picker every form uses. `multiple`, and the same type list the bucket
// enforces, so the browser filters the file dialog to what will be accepted.
export function receiptPickerHTML(inputId: string): string {
  return `<input class="form-input" id="${inputId}" type="file" multiple accept="${RECEIPT_ACCEPT}" style="padding:6px"/>
    <div style="margin-top:4px;font-size:11px;color:var(--ink-3)">PDF, JPG or PNG — up to 5 MB each. You can pick several.</div>`;
}

// A record's files plus the picker, as used inside the expense and ledger forms.
export function attachmentSectionHTML(
  type: AttachmentRecordType,
  id: number | null | undefined,
  items: ListedAttachment[],
  canRemove: boolean,
  inputId: string,
): string {
  const list = id
    ? `<div id="${attachmentListId(type, id)}" style="margin-bottom:8px">${attachmentRowsHTML(type, id, items, canRemove)}</div>`
    : '';
  return `${list}${receiptPickerHTML(inputId)}`;
}
