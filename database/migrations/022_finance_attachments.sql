-- Finance attachments — several receipts per record, who uploaded them, when
--
-- November handover §15. Expenses (bills.receipt_url) and Cash Ledger entries
-- (cash_ledger.attachment_url) could hold exactly one file each, and nothing
-- recorded who attached it or when. This adds one row per file instead.
--
-- What this does:
--   1. Creates finance_attachments: which record a file belongs to, where it
--      sits in the receipts bucket, its name/type/size, who uploaded it and
--      when. "Removing" a file only sets removed_at — the file itself is never
--      deleted, so originals are always kept (§15C/§15D).
--   2. Copies every existing receipt into it. Rows written before Aug 2026
--      hold an old signed URL; the file's path is read back out of it. The
--      upload date and uploader come from Supabase's own record of the file
--      where it still exists. bills.receipt_url and cash_ledger.attachment_url
--      are left exactly as they are.
--   3. Limits the receipts bucket to PDF, JPG and PNG up to 5 MB — checked by
--      Supabase itself, not just the browser.
--   4. Limits who can see receipts to the finance roles (they were readable by
--      every logged-in user, interns included), and stops anyone but an admin
--      deleting a stored file.
--
-- Safe to re-run. Run this in Supabase -> SQL Editor, BEFORE deploying the
-- app version with multiple receipts (it reads and writes finance_attachments).

-- ── 1. The table ─────────────────────────────────────────────────────────────
create table if not exists finance_attachments (
  id               bigint generated always as identity primary key,
  record_type      text        not null check (record_type in ('bill', 'ledger')),
  record_id        bigint      not null,
  storage_path     text        not null,
  file_name        text,
  mime_type        text,
  size_bytes       bigint,
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz default now(),
  removed_at       timestamptz,
  removed_by_name  text,
  unique (record_type, record_id, storage_path)
);

create index if not exists finance_attachments_record_idx
  on finance_attachments (record_type, record_id);

alter table finance_attachments enable row level security;

-- Same tiers as the Cash Ledger (schema/hq/finance/finance-permissions.sql).
-- No delete policy: a file is removed from view with removed_at, never erased.
drop policy if exists "finance_attachments_read"  on finance_attachments;
drop policy if exists "finance_attachments_write" on finance_attachments;
drop policy if exists "finance_attachments_edit"  on finance_attachments;

-- A receipt on an expense is only listed to someone who can see that expense
-- (bills are admin-only today), so the attachment never reaches further than
-- the record it belongs to. Ledger receipts follow the ledger's own tiers.
create policy "finance_attachments_read" on finance_attachments
  for select to authenticated
  using (
    public.current_user_role() in ('admin', 'finance_officer', 'supervisor', 'external_accountant')
    and (record_type <> 'bill' or exists (select 1 from bills b where b.id = record_id))
  );

create policy "finance_attachments_write" on finance_attachments
  for insert to authenticated
  with check (
    public.current_user_role() in ('admin', 'finance_officer')
    and (record_type <> 'bill' or exists (select 1 from bills b where b.id = record_id))
  );

create policy "finance_attachments_edit" on finance_attachments
  for update to authenticated
  using (public.current_user_role() in ('admin', 'finance_officer'))
  with check (public.current_user_role() in ('admin', 'finance_officer'));

-- ── 2. Copy existing receipts in ─────────────────────────────────────────────
-- The path is what follows "/object/<sign|public|authenticated>/receipts/" in
-- an old URL, percent-decoded ("My%20scan" → "My scan"), or the value itself
-- when it is already a path — the same rule as storagePathFromAttachment in
-- apps/hq/finance/receiptAttachment.ts, so both find the same file.
create or replace function pg_temp.url_decode(input text) returns text
language plpgsql immutable as $$
declare
  bytes bytea := '';
  i     int   := 1;
begin
  if input is null then return null; end if;
  while i <= length(input) loop
    if substr(input, i, 1) = '%' and substr(input, i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
      bytes := bytes || decode(substr(input, i + 1, 2), 'hex');
      i := i + 3;
    else
      bytes := bytes || convert_to(substr(input, i, 1), 'UTF8');
      i := i + 1;
    end if;
  end loop;
  return convert_from(bytes, 'UTF8');
exception when others then
  return input;  -- not valid UTF-8 once decoded: keep it as written
end;
$$;

with legacy as (
  select 'bill'::text as record_type, id as record_id, receipt_url as ref
    from bills
   where coalesce(receipt_url, '') <> ''
  union all
  select 'ledger', id, attachment_url
    from cash_ledger
   where coalesce(attachment_url, '') <> ''
), paths as (
  select record_type, record_id,
         ltrim(coalesce(
           pg_temp.url_decode(substring(btrim(ref) from '/object/(?:sign|public|authenticated)/receipts/([^?]+)')),
           btrim(ref)
         ), '/') as storage_path
    from legacy
)
insert into finance_attachments
  (record_type, record_id, storage_path, file_name, mime_type, size_bytes,
   uploaded_by, uploaded_by_name, uploaded_at)
select p.record_type,
       p.record_id,
       p.storage_path,
       regexp_replace(p.storage_path, '^.*/', ''),
       o.metadata ->> 'mimetype',
       nullif(o.metadata ->> 'size', '')::bigint,
       coalesce(o.owner, nullif(o.owner_id, '')::uuid),
       u.name,
       o.created_at
  from paths p
  left join storage.objects o on o.bucket_id = 'receipts' and o.name = p.storage_path
  left join intern_users u    on u.id = coalesce(o.owner, nullif(o.owner_id, '')::uuid)
 where p.storage_path !~ '^https?://'
on conflict (record_type, record_id, storage_path) do nothing;

-- ── 3. What the bucket accepts ───────────────────────────────────────────────
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'],
       file_size_limit    = 5242880
 where id = 'receipts';

-- ── 4. Who can reach the files ───────────────────────────────────────────────
drop policy if exists "auth_receipts_insert" on storage.objects;
drop policy if exists "auth_receipts_select" on storage.objects;
drop policy if exists "auth_receipts_delete" on storage.objects;
drop policy if exists "finance_receipts_insert" on storage.objects;
drop policy if exists "finance_receipts_select" on storage.objects;
drop policy if exists "finance_receipts_delete" on storage.objects;

create policy "finance_receipts_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts'
              and public.current_user_role() in ('admin', 'finance_officer'));

create policy "finance_receipts_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts'
         and public.current_user_role() in ('admin', 'finance_officer', 'supervisor', 'external_accountant'));

create policy "finance_receipts_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and public.current_user_role() = 'admin');

-- ── Check (read-only) — read this right after running ────────────────────────
-- Every existing receipt should now have a row: expect each pair of counts to
-- match. (Once new receipts are being uploaded, use
-- database/ops/check-receipt-files.sql instead — it checks record by record.)
select 'expenses with a receipt' as what, count(*) from bills where coalesce(receipt_url, '') <> ''
union all
select 'expense receipts copied', count(distinct record_id) from finance_attachments where record_type = 'bill'
union all
select 'ledger entries with a receipt', count(*) from cash_ledger where coalesce(attachment_url, '') <> ''
union all
select 'ledger receipts copied', count(distinct record_id) from finance_attachments where record_type = 'ledger';
