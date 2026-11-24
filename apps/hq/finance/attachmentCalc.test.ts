import { describe, it, expect } from 'vitest';
import type { FinanceAttachment } from '@shared/types.ts';
import {
  validateReceiptFile, receiptObjectPath, attachmentsFor, formatFileSize, receiptMimeType,
} from './attachmentCalc.ts';

const MB = 1024 * 1024;

const row = (over: Partial<FinanceAttachment> = {}) => ({
  id: 1, record_type: 'bill', record_id: 10, storage_path: 'receipts/a.pdf',
  file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 2048,
  uploaded_by: null, uploaded_by_name: 'Gab', uploaded_at: '2026-11-20T02:00:00Z',
  removed_at: null, removed_by_name: null,
  ...over,
} as FinanceAttachment);

describe('validateReceiptFile', () => {
  it('accepts PDF, JPG, JPEG and PNG up to 5 MB', () => {
    expect(validateReceiptFile({ name: 'r.pdf', size: MB, type: 'application/pdf' })).toBeNull();
    expect(validateReceiptFile({ name: 'r.JPG', size: MB, type: 'image/jpeg' })).toBeNull();
    expect(validateReceiptFile({ name: 'r.jpeg', size: MB, type: 'image/jpeg' })).toBeNull();
    expect(validateReceiptFile({ name: 'r.png', size: 5 * MB, type: 'image/png' })).toBeNull();
  });
  it('refuses other types, even images', () => {
    expect(validateReceiptFile({ name: 'r.heic', size: MB, type: 'image/heic' })).toMatch(/PDF, JPG or PNG/);
    expect(validateReceiptFile({ name: 'r.docx', size: MB, type: '' })).toMatch(/PDF, JPG or PNG/);
  });
  it('refuses a file over 5 MB and names it', () => {
    expect(validateReceiptFile({ name: 'big.pdf', size: 5 * MB + 1, type: 'application/pdf' })).toMatch(/big\.pdf.*5 MB/);
  });
  it('refuses an empty file', () => {
    expect(validateReceiptFile({ name: 'r.pdf', size: 0, type: 'application/pdf' })).toMatch(/empty/);
  });
  it('accepts a right extension when the browser reports no type', () => {
    expect(validateReceiptFile({ name: 'r.pdf', size: MB, type: '' })).toBeNull();
  });
});

describe('receiptMimeType', () => {
  it('keeps what the browser reports', () => {
    expect(receiptMimeType({ name: 'r.pdf', type: 'application/pdf' })).toBe('application/pdf');
  });
  it('works it out from the extension when the browser reports nothing', () => {
    expect(receiptMimeType({ name: 'R.PDF', type: '' })).toBe('application/pdf');
    expect(receiptMimeType({ name: 'r.jpeg', type: '' })).toBe('image/jpeg');
    expect(receiptMimeType({ name: 'r.png', type: '' })).toBe('image/png');
  });
});

describe('receiptObjectPath', () => {
  it('keeps a normalised extension under the given folder', () => {
    expect(receiptObjectPath('receipts', 'Scan 01.JPEG', 'u-1')).toBe('receipts/u-1.jpeg');
  });
  it('falls back to bin for a name without an extension', () => {
    expect(receiptObjectPath('ledger', 'scan', 'u-2')).toBe('ledger/u-2.bin');
  });
});

describe('attachmentsFor', () => {
  it('lists the record\'s live files, oldest first', () => {
    const list = attachmentsFor('bill', 10, [
      row({ id: 2, storage_path: 'receipts/b.pdf', uploaded_at: '2026-11-22T00:00:00Z' }),
      row({ id: 1 }),
      row({ id: 3, record_id: 99 }),
      row({ id: 4, record_type: 'ledger' }),
    ], null);
    expect(list.map(a => a.id)).toEqual([1, 2]);
  });
  it('hides removed files', () => {
    expect(attachmentsFor('bill', 10, [row({ removed_at: '2026-11-23' })], null)).toEqual([]);
  });
  it('shows a receipt still held only in the old single-file column', () => {
    const list = attachmentsFor('bill', 10, [], 'receipts/old.pdf');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: null, storage_path: 'receipts/old.pdf', file_name: 'old.pdf', legacy: true });
  });
  it('reads the path out of an old signed URL in that column', () => {
    const url = 'https://x.supabase.co/storage/v1/object/sign/receipts/ledger/9f.jpg?token=t';
    expect(attachmentsFor('ledger', 10, [], url)[0].storage_path).toBe('ledger/9f.jpg');
  });
  it('does not list the old column twice once it has been copied into the table', () => {
    expect(attachmentsFor('bill', 10, [row()], 'receipts/a.pdf')).toHaveLength(1);
  });
  it('does not bring back a copied receipt that was later removed', () => {
    expect(attachmentsFor('bill', 10, [row({ removed_at: '2026-11-23' })], 'receipts/a.pdf')).toEqual([]);
  });
});

describe('formatFileSize', () => {
  it('reads naturally', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(1.5 * MB)).toBe('1.5 MB');
    expect(formatFileSize(null)).toBe('');
  });
});
