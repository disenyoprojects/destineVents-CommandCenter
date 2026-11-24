-- Are all receipts still reachable? (handover §15D)
--
-- Lists receipts whose file can no longer be found, receipts still recorded
-- only as an old signed URL, and files sitting in storage that no record
-- points at. Run after migration 022, and again after any storage move or
-- restore from backup.
--
-- This file is READ-ONLY. It changes nothing. Run it in Supabase -> SQL Editor.
-- Every section should come back empty except (3), which is informational.

-- 1. Receipts on a record whose file is missing from storage — these will not
--    open. Restore the file from the backup (scripts/backup-receipts.mjs).
select a.record_type, a.record_id, a.file_name, a.storage_path, a.uploaded_at
  from finance_attachments a
  left join storage.objects o on o.bucket_id = 'receipts' and o.name = a.storage_path
 where a.removed_at is null
   and o.id is null
 order by a.record_type, a.record_id;

-- 2. Old single-file columns not yet copied into finance_attachments
--    (expect none once migration 022 has run).
select 'bill' as record_type, b.id as record_id, b.receipt_url as stored_value
  from bills b
 where coalesce(b.receipt_url, '') <> ''
   and not exists (select 1 from finance_attachments a where a.record_type = 'bill' and a.record_id = b.id)
union all
select 'ledger', l.id, l.attachment_url
  from cash_ledger l
 where coalesce(l.attachment_url, '') <> ''
   and not exists (select 1 from finance_attachments a where a.record_type = 'ledger' and a.record_id = l.id);

-- 3. Files in the receipts bucket that no record points at. Usually receipts
--    replaced before multiple files were possible — kept on purpose, since
--    originals are never deleted. Informational only.
select o.name, o.created_at, o.metadata ->> 'size' as size_bytes
  from storage.objects o
 where o.bucket_id = 'receipts'
   and not exists (select 1 from finance_attachments a where a.storage_path = o.name)
 order by o.created_at;
