// Pure, DOM-free rules for receipt attachments. Unit-tested in
// attachmentCalc.test.ts.
//
// Since migration 022 an expense or Cash Ledger entry can carry several files,
// one finance_attachments row each. Records from before then hold a single
// file in their own column (bills.receipt_url / cash_ledger.attachment_url);
// the migration copies those in, and attachmentsFor still shows one that has
// not been copied yet, so nothing disappears in between.
import type { FinanceAttachment } from '@shared/types.ts';
import { storagePathFromAttachment } from './receiptAttachment.ts';

export type AttachmentRecordType = FinanceAttachment['record_type'];

// What the handover (§15A) accepts. The bucket enforces the same list.
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const RECEIPT_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};

// A file as listed for a record: a stored row, or (id null) the old column.
export interface ListedAttachment {
  id: number | null;
  storage_path: string;
  file_name: string;
  size_bytes: number | null;
  uploaded_by_name: string | null;
  uploaded_at: string | null;
  legacy: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Null when the file may be uploaded, otherwise what to tell the user.
export function validateReceiptFile(file: { name: string; size: number; type: string }): string | null {
  const typeOk = ALLOWED_EXTENSIONS.includes(extensionOf(file.name))
    && (!file.type || ALLOWED_MIME_TYPES.includes(file.type));
  if (!typeOk) return `${file.name} is not a PDF, JPG or PNG`;
  if (file.size <= 0) return `${file.name} is empty`;
  if (file.size > MAX_RECEIPT_BYTES) return `${file.name} is over 5 MB`;
  return null;
}

// The type to upload a file as. The bucket refuses anything off its list, and
// some browsers report no type at all for a perfectly good PDF — so the
// extension decides when the browser does not.
export function receiptMimeType(file: { name: string; type: string }): string | null {
  return file.type || MIME_BY_EXTENSION[extensionOf(file.name)] || null;
}

// Where a new file goes inside the receipts bucket. The name is random so two
// uploads never collide; the original name is kept on the row instead.
export function receiptObjectPath(folder: string, fileName: string, uuid: string): string {
  const ext = extensionOf(fileName).slice(0, 10) || 'bin';
  return `${folder}/${uuid}.${ext}`;
}

export function attachmentsFor(
  recordType: AttachmentRecordType,
  recordId: number,
  rows: FinanceAttachment[],
  legacyRef: string | null | undefined,
): ListedAttachment[] {
  const own = rows.filter(r => r.record_type === recordType && r.record_id === recordId);
  const listed: ListedAttachment[] = own
    .filter(r => !r.removed_at)
    .sort((a, b) => (a.uploaded_at ?? '').localeCompare(b.uploaded_at ?? '') || a.id - b.id)
    .map(r => ({
      id: r.id,
      storage_path: r.storage_path,
      file_name: r.file_name || r.storage_path.split('/').pop() || 'file',
      size_bytes: r.size_bytes,
      uploaded_by_name: r.uploaded_by_name,
      uploaded_at: r.uploaded_at,
      legacy: false,
    }));

  // Compared against every row, removed ones included, so removing a copied
  // receipt does not bring it straight back from the old column.
  const legacyPath = storagePathFromAttachment(legacyRef);
  if (legacyPath && !own.some(r => r.storage_path === legacyPath)) {
    listed.unshift({
      id: null,
      storage_path: legacyPath,
      file_name: legacyPath.split('/').pop() || 'file',
      size_bytes: null,
      uploaded_by_name: null,
      uploaded_at: null,
      legacy: true,
    });
  }
  return listed;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
