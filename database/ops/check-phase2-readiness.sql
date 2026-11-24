-- Which earlier database scripts have actually been run in this Supabase project?
--
-- The schema files under database/schema/ and database/migrations/ are run by
-- hand in the SQL Editor, so the repo cannot tell what the live database holds.
-- The November handover (§11) asks to confirm the payroll un-pay script, the
-- legacy 'Unpaid' invoices and the remaining housekeeping before Phase 2 work
-- builds on top of them. This answers all of that in one result table.
--
-- This file is READ-ONLY. It changes nothing. Run it in Supabase -> SQL Editor
-- and paste the result back. Every row should read ok = true; a false row names
-- the file that still needs running.

with checks(check_name, ok, detail) as (
  -- Payroll un-pay (database/schema/hq/documents/payroll-allow-unpay.sql)
  select 'payroll un-pay allowed (payroll-allow-unpay.sql)',
         coalesce((select prosrc ~ '''Paid''\s*,\s*''Pending'''
                     from pg_proc where proname = 'trg_payroll_status_transition'
                    limit 1), false),
         'Paid -> Pending transition present in the payroll trigger'

  -- Legacy invoice statuses (QA Test 04, migration 020)
  union all
  select 'no invoices stuck on Unpaid (020_invoice_status_default.sql)',
         not exists (select 1 from invoices where status is null or status = 'Unpaid'),
         (select count(*) from invoices where status is null or status = 'Unpaid')::text
           || ' invoice(s) on null/Unpaid'
  union all
  select 'invoice default is Draft (020_invoice_status_default.sql)',
         coalesce((select column_default like '%Draft%'
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'invoices'
                      and column_name = 'status'), false),
         coalesce((select column_default
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'invoices'
                      and column_name = 'status'), '(no default)')

  -- Tables Phase 2 builds on
  union all
  select 'statements_of_billing table (schema/hq/finance/sob.sql)',
         to_regclass('public.statements_of_billing') is not null, ''
  union all
  select 'sob_line_items table (schema/hq/finance/sob.sql)',
         to_regclass('public.sob_line_items') is not null, ''
  union all
  select 'contracts table (schema/hq/documents/contracts.sql)',
         to_regclass('public.contracts') is not null, ''
  union all
  select 'meetings table (schema/hq/meetings/meetings.sql)',
         to_regclass('public.meetings') is not null, ''
  union all
  select 'document_activity_logs table (schema/hq/documents/activity-log.sql)',
         to_regclass('public.document_activity_logs') is not null, ''
  union all
  select 'budgets table (schema/hq/finance/budgets.sql)',
         to_regclass('public.budgets') is not null, ''

  -- Columns added by finance schema files
  union all
  select 'cash_ledger.source_type (schema/hq/finance/finance-integration.sql)',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'cash_ledger'
                    and column_name = 'source_type'), ''
  union all
  select 'cash_ledger.company (schema/hq/finance/ledger-company.sql)',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'cash_ledger'
                    and column_name = 'company'), ''
  union all
  select 'bills.paid_at (schema/hq/finance/paid-date-tracking.sql)',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bills'
                    and column_name = 'paid_at'), ''
  union all
  select 'invoices.payment_date (schema/hq/finance/invoice-line-items.sql)',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoices'
                    and column_name = 'payment_date'), ''
  union all
  select 'projects.proposal_id (019_project_proposal_link.sql)',
         exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects'
                    and column_name = 'proposal_id'), ''

  -- Receipts (§11, §15): the private bucket, and rows still holding an old
  -- signed URL instead of a storage path. Those still open — the app reads the
  -- path back out of the URL — but they are the ones to migrate.
  union all
  select 'receipts bucket is private (014_hq_receipts_bucket.sql)',
         coalesce((select not public from storage.buckets where id = 'receipts'), false),
         coalesce((select case when public then 'PUBLIC' else 'private' end
                     from storage.buckets where id = 'receipts'), 'bucket missing')
  union all
  select 'expense receipts stored as paths',
         not exists (select 1 from bills where receipt_url like 'http%'),
         (select count(*) from bills where receipt_url like 'http%')::text
           || ' expense(s) still holding an old URL'
  union all
  select 'ledger attachments stored as paths',
         not exists (select 1 from cash_ledger where attachment_url like 'http%'),
         (select count(*) from cash_ledger where attachment_url like 'http%')::text
           || ' ledger row(s) still holding an old URL'
)
select check_name, ok, detail
from checks
order by ok, check_name;
