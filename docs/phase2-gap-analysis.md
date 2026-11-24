# HQ November Handover: Gap Analysis

Prepared by Gab · 24 Nov 2026 · For approval before development (handover §10, §13.9, §14)

## What already exists and works

- **SOBs.** Statements of Billing are linked to projects. Line items carry through from the quotation to the SOB and then to the Official Receipt (OR).
- **Cash Ledger.** Paying an OR posts it to the Cash Ledger automatically, and the same payment is never posted twice.
- **Overdue.** HQ works out "Overdue" from the due date.
- **Costs against projects.** Expenses and purchase orders can be tagged to a project. Reports show revenue, costs and net per project.
- **Meetings dashboard.** The five counts come from real records: Upcoming, Completed This Month, No Shows, Total, Next 7 Days.
- **Receipt files.** They are stored privately, and links are created fresh on every click, so they no longer expire.
- **Old 'Unpaid' invoices.** The default was fixed in August; none were stuck.

## Needs adjustment

| Area | Gap |
|---|---|
| Payments | There are no part payments. Recording a payment marks the whole OR as paid. **Proposed fix:** one SOB can have several ORs (one per payment), with Outstanding = Billed − Collected. |
| Collections view | The details are split across the SOB and OR tables. Collected, Outstanding and Next Follow-up are missing. Statuses Upcoming, Due and Partially Paid are missing. |
| Projections | They are only the past monthly average × months. They ignore open bills, contracts and upcoming expenses. |
| Profitability | There is no margin %. The overview's "Project Profitability" chart shows sales, not profit. |
| CEO snapshot | About half of the 10 numbers exist. The rest need adding. |
| Permissions | The screens let the Finance Officer into invoices and bills, but the database blocks them. Receipts are readable by any logged-in user, including interns. |
| Meetings | Fields are missing: type, timezone, location, owner, participants, outcome, next steps, and a link to a quotation. Editing a meeting moves it 8 hours earlier (bug). |
| Receipts | Only one file per expense. Who uploaded it and when is not recorded. File type and size are checked only in the browser. One "view receipt" link is broken (bug). |

## Missing (to be built)

- A way to mark an SOB as Superseded or Cancelled, with a reason. Historical SOB import, once the tracker and PDFs are provided.
- Recurring/retainer contracts (Ongkoleyt): month X of Y, billed, collected, remaining, next billing date.
- Follow-up reminders at −7, 0, +3 and +7 days, plus a "needs attention" list.
- A monthly revenue target and the gap to it.
- Google Calendar sync and Gmail sending, with a log of every email sent. Today, email only opens the user's own mail app.
- A file-backup procedure. Supabase database backups do not include uploaded files.
- Reimbursements. No feature exists. **Proposed:** out of scope for now.

## Decisions needed from you

1. **Profit per project.** Should revenue be the *amount billed* or *cash collected*? Proposed: billed.
2. **Target maths.** Proposed definitions:
   - Committed = SOBs issued this month plus retainer fees due.
   - Expected = Won quotations not yet billed.
   - Gap = Target − Committed − Expected.
3. **Access.**
   - Should the Finance Officer get invoices and bills? Payroll as well? That would show salaries.
   - Who besides admin may manage meetings and send emails?
4. **Google account.** `destinevents.biz@gmail.com` is a regular Gmail account, not Google Workspace.
   - Calendar and Gmail-send access need a Google verification review before going live: a privacy-policy page and a verified domain, usually 1–6 weeks.
   - Until it passes, the connection must be redone every 7 days.
   - Who will set up the Google Cloud project? Is Workspace an option?
5. **Official Receipt numbering.** Since the 2024 EOPT Act, BIR treats the Sales Invoice as the main document for services. Please confirm with the accountant which document and number series to use.
6. **Why was the finance overview reorder reverted?** It was reverted in commit `954d91e`. The CEO snapshot changes the same page.
7. **Source files.** Please send the historical SOB PDFs and the SOB & Collections Tracker spreadsheet.

## Owner actions needed

- Run the database scripts Gab prepares in Supabase.
- Set up Google Cloud: OAuth consent screen, Calendar and Gmail APIs, and the verification request.
- Add three settings in Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY`.
- Provide a non-admin test account.
- **Cost:** no Google API charges are expected at this volume.

## Effort (rough)

| Area | Effort |
|---|---|
| Finance | 8–11 days, plus your review of the historical import |
| Receipts | 2–3 days |
| Meetings fields | 2 days |
| Google Calendar and Gmail | 5–7 days, plus Google's review wait |

**Proposed order:** bug fixes → part payments and collections view → historical import → retainers → projections, profit and target → CEO snapshot → receipts → meetings → Google.

**Two-way calendar sync** (edits made in Google flowing back to HQ) is not planned. Sync is one-way, from HQ to Google, as the handover allows.
