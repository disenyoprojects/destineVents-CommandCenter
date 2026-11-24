import { sb } from '@shared/core/supabase';
import { handleServiceError } from '@shared/core/serviceError.ts';
import { logger } from '@shared/utils/logger.ts';
import type { FinanceAttachment } from '@shared/types';

// The table arrives with migration 022. Until it is run, PostgREST reports it
// as unknown; the app then falls back to each record's single-file column
// rather than raising an error on every page load.
function isMissingTableError(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

export async function fetchAttachments(): Promise<FinanceAttachment[]> {
  const { data, error } = await sb.from('finance_attachments').select('*').order('id');
  if (error) {
    if (isMissingTableError(error)) {
      logger.warn('fetchAttachments', 'finance_attachments not found — run migration 022 in Supabase.');
      return [];
    }
    handleServiceError('fetchAttachments', error);
    return [];
  }
  return (data ?? []) as FinanceAttachment[];
}

export async function insertAttachment(
  row: Omit<FinanceAttachment, 'id' | 'removed_at' | 'removed_by_name'>,
): Promise<FinanceAttachment | 'missing-table' | null> {
  const { data, error } = await sb.from('finance_attachments').insert(row).select();
  if (error) {
    if (isMissingTableError(error)) return 'missing-table';
    handleServiceError('insertAttachment', error);
    return null;
  }
  return (data as FinanceAttachment[] | null)?.[0] ?? null;
}

// Takes a file out of view. The row and the stored file both stay.
export async function markAttachmentRemoved(id: number, removedBy: string | null): Promise<boolean> {
  const { error } = await sb
    .from('finance_attachments')
    .update({ removed_at: new Date().toISOString(), removed_by_name: removedBy })
    .eq('id', id);
  if (error) { handleServiceError('markAttachmentRemoved', error); return false; }
  return true;
}
