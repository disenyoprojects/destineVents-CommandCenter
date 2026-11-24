-- Statements of Billing — part payments, outcomes and follow-ups
--
-- November handover §2, §3, §5. Until now a statement converted into exactly
-- one invoice/OR (statements_of_billing.linked_invoice_id), and recording the
-- payment marked that whole OR paid — so a 50% downpayment could not be
-- recorded at all. From here a statement is what was *billed*, and each payment
-- is its own Official Receipt pointing back at it through invoices.sob_id.
-- Collected and outstanding are worked out in the app (collectionsCalc.ts).
--
-- What this adds:
--   1. invoices.sob_id — the statement a receipt collects against. Filled in
--      for every receipt already linked the old way. linked_invoice_id stays.
--   2. statements_of_billing.superseded_by / outcome_note — for a statement
--      that was amended and replaced, or cancelled, and why.
--   3. statements_of_billing.last_followup_at — when the client was last
--      chased; drives the "Next follow-up" column.
--   4. 'Superseded' as a statement status the database accepts.
--   5. One statement per SOB number, when the existing data allows it.
--
-- Nothing is deleted or rewritten except the new sob_id links. Safe to re-run.
--
-- Run this in Supabase -> SQL Editor, BEFORE deploying the app version that
-- records part payments (it writes invoices.sob_id).

-- ── 1. Receipts point at their statement ─────────────────────────────────────
alter table invoices
  add column if not exists sob_id bigint references statements_of_billing(id) on delete set null;

create index if not exists invoices_sob_id_idx on invoices (sob_id);

update invoices i
   set sob_id = s.id
  from statements_of_billing s
 where s.linked_invoice_id = i.id
   and i.sob_id is null;

-- ── 2 & 3. Outcome and follow-up columns ─────────────────────────────────────
alter table statements_of_billing
  add column if not exists superseded_by    bigint references statements_of_billing(id) on delete set null,
  add column if not exists outcome_note     text,
  add column if not exists last_followup_at timestamptz;

-- ── 4. 'Superseded' in the statement state machine ───────────────────────────
-- Same rules as database/schema/hq/documents/doc-state-machine.sql, plus a way
-- into Superseded from any statement that is not yet settled or void. Mirrored
-- in shared/documents/docTransitions.ts — change them together.
create or replace function trg_sob_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  perform check_doc_status_transition(
    'SOB', old.status, new.status,
    array[
      array['Draft',         'Sent'],
      array['Draft',         'Cancelled'],
      array['Draft',         'Superseded'],
      array['Sent',          'Viewed'],
      array['Sent',          'Partially Paid'],
      array['Sent',          'Paid'],
      array['Sent',          'Cancelled'],
      array['Sent',          'Superseded'],
      array['Viewed',        'Partially Paid'],
      array['Viewed',        'Paid'],
      array['Viewed',        'Cancelled'],
      array['Viewed',        'Superseded'],
      array['Partially Paid','Paid'],
      array['Partially Paid','Cancelled'],
      array['Partially Paid','Superseded']
    ]
  );
  return new;
end;
$$;

drop trigger if exists sob_status_transition on statements_of_billing;
create trigger sob_status_transition
  before update of status on statements_of_billing
  for each row execute function trg_sob_status_transition();

-- ── 5. One statement per SOB number ──────────────────────────────────────────
-- Numbers are suggested by the app but typed freely, so duplicates may already
-- exist. If they do, the index is skipped and the duplicates are listed by the
-- check at the bottom — fix them by hand, then re-run this file.
do $$
begin
  if not exists (
    select 1 from statements_of_billing group by sob_num having count(*) > 1
  ) then
    create unique index if not exists statements_of_billing_sob_num_key
      on statements_of_billing (sob_num);
  else
    raise notice 'Duplicate SOB numbers exist — unique index NOT created. See the check below.';
  end if;
end $$;

-- ── Checks (read-only) — read these results after running ────────────────────

-- a) Duplicate SOB numbers, if any (expect no rows).
select sob_num, count(*) as statements
  from statements_of_billing
 group by sob_num
having count(*) > 1;

-- b) Statements someone marked Paid / Partially Paid by hand with no paid
--    receipt behind them. Collections now only counts confirmed receipts, so
--    these will show as still owed until a payment is recorded against them
--    (expect no rows; any that appear need a payment recorded, or a decision).
select s.sob_num, s.client, s.status, s.total_amount
  from statements_of_billing s
 where s.status in ('Paid', 'Partially Paid')
   and s.archived_at is null
   and not exists (
     select 1 from invoices i
      where i.sob_id = s.id and i.status = 'Paid' and i.archived_at is null
   );
