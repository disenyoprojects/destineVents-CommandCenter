import { _accounts } from '@hq/core/state.ts';
import type { Invoice } from '@shared/types.ts';
import { syncSourceLedger } from '../ledgerPosting.ts';

// Single source of truth for what a paid invoice looks like in the Cash Ledger.
// Called both when a payment is first recorded and whenever the invoice is
// edited afterwards — editing a paid invoice's amount or payment date used to
// leave the ledger row (and so the whole dashboard) showing the old figure.
export async function syncInvoiceToLedger(invoice: Invoice, createdBy: string | null = null) {
  return syncSourceLedger({
    isCash: invoice.status === 'Paid' && !invoice.archived_at,
    sourceType: 'invoice', sourceId: invoice.id, moduleSource: 'AR',
    category: 'Client Payment',
    description: `Client payment — ${invoice.client ?? 'Invoice'}${invoice.or_num ? ` (${invoice.or_num})` : ''}`,
    txnDate: invoice.payment_date ?? invoice.date ?? null,
    referenceNo: invoice.or_num ?? null,
    accounts: _accounts,
    projectId: invoice.project_id ?? null,
    paymentMethod: invoice.payment_method ?? null,
    cashIn: invoice.amount,
    createdBy: createdBy ?? invoice.received_by ?? null,
  });
}
