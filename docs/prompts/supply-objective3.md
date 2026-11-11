# Supply Request and Fulfillment Coordination (Objective 3): implementation brief

You are working in `C:\Users\John Rey\Documents\franchisetitan-supabase` (React 19 + Vite + Tailwind; Supabase Postgres with RLS that denies all browser table access; a single Hono Edge Function API at `supabase/functions/api`, `/api/v1`).

Your job is to redesign the Supply Request workflow between **Branch (franchisee), Admin and Logistics** so it works like a real franchise supply operation. Every decision must carry proof and a recorded reason, and each role does only its own part (maker-checker).

Work in **phases**. At the end of each phase, stop and report:
- the files you changed;
- the test results;
- any deviation from this brief;
- any open questions.

Then wait for me to say "continue". Do not start the next phase on your own.

---

## Ground rules (read first)

1. **Do not break existing functions.**
   - Supply statuses are read in many places. At least these files depend on them: `routes/analytics.ts`, `routes/branches.ts`, `routes/branchPortal.ts`, `routes/branchWorkspace.ts`, `services/forecast.ts`, `services/supplyWorkflow.ts`, `routes/supply.ts`, `src/components/dashboard/Charts.jsx`, `src/components/supply/*`, `src/lib/branchWorkspace.js`, `src/lib/supplyActions.js`, `src/pages/Branches.jsx` and `src/pages/SupplyRequests.jsx`.
   - Find **every** consumer with a search, and update each one.
   - Note that `under_review` also appears in inquiries and applicants. Those are other entities, so do not touch them.
2. **Forecasting is out of scope.** Do **not** change how forecasts, suggested reorder, days of cover or `lead_time_days` are calculated. The only two forecast-related changes allowed are:
   - **(a) The "on order" fix.** `services/forecast.ts` (around the query on `request.status in ('submitted','under_review','endorsed','preparing','dispatched')`) must count every *open* status of the new workflow, including the backorder child requests. This prevents double suggestions.
   - **(b) Read-only reuse.** You may *read* the existing forecast figures (suggested quantity and days of cover) to show them in Supply screens and to drive the bulk check.
3. **Keep the current UI theme.** Use the Tailwind tokens, components and look of the existing app. The mockup at `docs/prompts/supply-ui-mockup.html` (a self-contained HTML file; read its markup, CSS and script, and open it in the browser) is a **layout and flow reference only**. Do not copy its colors, gradient or "HERALD OPERATIONS" header. Its mock logic has known bugs; for example, "Return for correction" closes the request there, and that is wrong.
4. **Never touch production.**
   - Do not run `supabase db push`, `functions deploy`, `secrets` commands, or any SQL against the live project. Do not run `npm run users:create` against live.
   - Do not `git push`.
   - Write the migrations and tell me the exact commands; I run them myself.
5. **Never print secrets,** passwords or the DB URL. Do not commit or read the `backup/` folder (it holds real personal data).
6. **Testing.**
   - Test locally with `npm run dev:api` (PGlite plus fake auth on `127.0.0.1:54321`).
   - Run, and keep passing: `npm run test:api`, `npm run test:import`, and `node --test src/lib/*.test.mjs`.
   - `npm run lint` must add no new problems (153 already exist).
   - Build both portals into a scratch folder, not `dist`: `VITE_PORTAL=staff` and `VITE_PORTAL=branch`.
7. **Commit locally** at the end of each phase, with a clear message and a tag `supply-phase-N`. Do not push.
8. **Server-side enforcement.** Every rule below must be enforced by the API, not only hidden in the UI. Return clear 422 messages.

---

## The agreed workflow

### Roles
| Role | Does |
|---|---|
| Branch (franchisee) | Creates, edits and cancels its own requests (only while editable); confirms receipt per item; reports damaged or short items with proof |
| Admin | Reviews; endorses with a Fulfillment Decision; returns, rejects or cancels; approves date changes; resumes held requests; resolves discrepancies |
| Logistics | Confirms the schedule or requests a new date; reports shortages; prepares; dispatches; encodes POD |

### Statuses (keys are a suggestion; confirm in Phase 0)

The main path:
`draft` → `submitted` → `under_review` → `waiting_logistics` → `scheduled` → `preparing` → `dispatched` → `delivered` → `completed`

Side and terminal statuses:
- `returned` (back to the branch for correction)
- `on_hold` (restock)
- `discrepancy_review`
- `completed_with_discrepancy`
- `rejected`
- `cancelled`

Notes:
- **Starting review.** Admin moves `submitted` → `under_review` ("Start review"). From then on, the branch can no longer edit or cancel.
- **Pending sub-states.** A Logistics **date-change request** and a **shortage report** are pending sub-states that Admin must answer. They are not new main stages. Show them as "New date requested" and "Shortage reported", with the owner shown as Admin.
- **The two delivery confirmations are independent.** POD (by Logistics) and Receipt (by the branch) can arrive in **either order**. The branch may confirm receipt as soon as the status is `dispatched`, because a truck can arrive before Logistics encodes the POD. Show "Received – POD pending" or "Delivered – waiting for branch receipt" as appropriate.
- **Closing happens only when both POD and receipt exist:**
  - With no discrepancy, the request goes to `completed` automatically.
  - With any damaged or short item, it goes to `discrepancy_review`.

### Owner of the next action (drives "Needs my action")
| Owner | Statuses |
|---|---|
| Admin | `submitted`, `under_review`, `on_hold`, `discrepancy_review`, plus any pending date-change or shortage report |
| Logistics | `waiting_logistics`, `scheduled`, `preparing`, `dispatched` (POD) |
| Branch | `draft`, `returned`; also `dispatched` or `delivered` while the receipt is not yet confirmed |

---

## Rules and validations

### 1. Creating a request (Branch; Admin may also create, as today)

**Items**
- Items come from the catalog that is valid for the branch's brand.
- No duplicate product in one request.
- Quantity must be a positive number in the product's unit.

**Urgency**
- `normal`, `urgent` or `critical`.
- `urgent` and `critical` require an `urgency_reason`.

**Target delivery date**
- It must be at least **2 working days** after the request date.
- Working days are Monday to Friday. Weekends are not counted, and holidays are not tracked.
- Examples:
  | Request day | Earliest target date |
  |---|---|
  | Mon | Wed |
  | Thu | Mon |
  | Fri | Tue |
  | Sat or Sun | Wed |
- `urgent` and `critical` requests may choose an earlier date (minimum: the next working day), with a reason. Admin still decides.
- The target date itself may fall on a weekend, because branches open on weekends. Show a non-blocking warning: "Target date is a weekend. Make sure the branch can receive."
- The 2 working days is a **supply setting** (`supply_lead_time_working_days`, default 2), editable by Admin.
  - It is **not** the forecast's `lead_time_days`. Leave that one alone.
  - Show the earliest allowed date in the form: "Earliest delivery date: Wed, Nov 13".

**Bulk check**
- Read the existing estimated-requirement suggestion for the branch and product (the same source `EstimateHint` uses).
- If a requested quantity is **more than 50% above the suggested quantity**, a `bulk_reason` is required. This is not a block.
- If there is no suggestion yet, skip the check.
- The threshold is a supply setting (`bulk_threshold_percent`, default 50), editable by Admin.

**Other checks**
- **Duplicate warning (non-blocking):** if the branch has another open request containing the same product, show "You have a pending request for X (SR-…)".
- **Account and branch:** both must be active. Suspended or inactive accounts cannot submit.

**Editing**
- The branch may edit or cancel only in `draft`, `submitted` or `returned`.
- A `returned` request is edited and **resubmitted under the same number**. The history is kept.

### 2. Admin review

For each item, Admin sees:
- Requested;
- Warehouse available (net of reservations);
- Unavailable;
- Branch stock status (Normal / Low / Critical / Out);
- Days covered (read from the existing forecast; "—" when there is none);
- Suggested (existing forecast).

Admin also sees the urgency and its reason, and the bulk reason.

**Critical item flag (automatic):**
- Mark an item **Critical** when the branch's stock for it is Critical or Out.
- Also mark it Critical when its days covered is below the supply lead time.
- This is information only; Admin still decides.

**Actions** (each one recorded):
- **Endorse – Full.** Allowed only when every item is fully available.
  - If anything is short, the button is disabled, with the explanation "Stock is short; choose a Fulfillment Decision."
- **Endorse with a Fulfillment Decision.** Required when any item is short. It records, **per item**: Available qty, Unavailable qty, and Expected Restock Date (required when unavailable > 0). It also records the fulfillment type and an Admin reason (required). The types:
  - **Hold for Restock.** Nothing ships yet, and the status goes to `on_hold`.
  - **Partial – Ship Now.**
    - The available quantities continue to `waiting_logistics`.
    - The unavailable quantities become a **backorder child request** linked to the parent:
      - It uses the same number plus `-B`, then `-B2` and so on.
      - Its status is `on_hold`, and it carries the restock date.
    - Show a preview before confirming: "SR-… -B will be created for Coffee beans 4 kg".
  - **Partial – Consolidated.**
    - The available quantities are **reserved**.
    - The request goes to `on_hold` until the shortfall is restocked.
    - Then everything ships together. The reason field must say why, for example "same trip".
    - Delivery cost is **not** recorded or computed.
- **Return for correction.** A reason is required, and the request goes back to the branch as `returned`.
- **Reject.** A reason is required. This is final.
- **Cancel.** A reason is required. Admin may cancel at any stage **before `dispatched`**, and doing so releases the reservations.

**On Hold**
- **Resume** checks that the warehouse can now cover the held quantities (net of other reservations). If not, it is blocked with a message.
- **Update restock date** requires a new date and a reason. Keep a revision count.
- **Overdue:** the request is overdue when its expected restock date has passed while it is still on hold.
- An Admin may not change a delivery or restock date without either an expected restock date or a reason.

### 3. Stock reservation and deduction
- **Reserve at Endorse.** This covers the available quantities, including Consolidated. Reserved stock cannot be endorsed to another request.
- **Deduct from the warehouse at Dispatch.** Use the prepared quantities. Release the reservation as you deduct.
- **Release reservations** on cancel or reject.
- First check how stock deduction works today (`stock_deducted_at`, `preparing_at`). Report the current behavior in Phase 0 before changing it.

### 4. Logistics confirmation (`waiting_logistics`)
- **Accept schedule.** The status becomes `scheduled`, and the confirmed date is shown to the branch.
- **Request new date.** Requires a proposed date and a reason. Admin approves or rejects; a reject needs a reason.
  - The existing `supply_request_date_revisions` table/flow currently works the other way: Admin proposes and Logistics confirms.
  - Adapt it, or add direction, and say which you chose in Phase 0.
- **Report shortage.** Requires the **actual count per item** and a reason. It goes back to Admin for a new Fulfillment Decision.
  - It must not silently change inventory. If the app has a stock-adjustment feature, point Logistics to it; otherwise report this in Phase 0.

### 5. Preparing
- The prepared quantity per item must not exceed the endorsed quantity.
- **Report shortage** is also available here.

### 6. Dispatch (Logistics)

Required fields:
- Driver name (letters, spaces and `.-'` only).
- Driver contact (11 digits).
- Plate number (a sane PH format; uppercase).
- Departure date and time (not in the future, within a few minutes of tolerance).
- ETA (must be on or after the departure).

Also:
- If the ETA falls on a weekend, show a non-blocking warning.
- Store these fields on `deliveries` (add columns).
- After dispatch, offer a **Print Delivery Receipt** with these details:
  - request number, branch, address and contact;
  - items with their prepared quantities;
  - driver and plate;
  - departure and ETA;
  - signature lines for "Released by" and "Received by".
- The branch sees the driver, plate and ETA.

### 7. POD (Logistics)

Required fields:
- **POD file**, a photo or signature image, kept in private storage. Use the existing POD endpoint `POST /supply-requests/:id/pod`; it currently has no frontend.
- Received-by name.
- **Actual delivery date and time.** It must be on or after the departure, and not in the future.

The POD may be encoded **on a later office day**. For example, a delivery that arrived on Sunday can be encoded on Monday using Sunday's actual time.

### 8. Confirm Receipt (Branch)
- It is available once the status is `dispatched`.
- Per item, the branch enters **good**, **damaged** and **short**. They must satisfy good + damaged + short = dispatched (prepared) quantity.
  - Damaged items require a reason **and a photo**.
  - Short items require a reason.
- **Only the good quantity is credited** to the branch inventory, immediately. Reuse the existing branch stock service.
- Damaged quantities are recorded as Damaged/Short and are **not** returned to the warehouse.
- Extend the existing `POST /supply-requests/:id/acknowledge`. The branch UI does not call it today.

### 9. Discrepancy review (Admin)
- Admin sees each item's good, damaged and short quantities, plus the branch's photos and reasons.
- Admin chooses one action, with **required remarks**:
  - **Accept loss**
  - **For Logistics investigation**
  - **Branch to re-request**
- The status then becomes `completed_with_discrepancy`. Notify Logistics and the branch.
- There is no automatic replacement; the branch creates a new request if it still needs the items.

### 10. SLA and overdue (working days, Mon–Fri)

These items are marked **Overdue**:
- `submitted` or `under_review` with no Admin action after 1 working day.
- `waiting_logistics` with no Logistics action after 1 working day.
- A pending date-change or shortage report that Admin has not answered within 1 working day.
- `on_hold` past the expected restock date.
- `dispatched` past the ETA with no POD after 1 working day.

**Branch receipt** is never "overdue". If the POD exists and there is no receipt after 1 day, send the branch a **reminder notification**: "Please confirm the delivery you received."

### 11. Notifications (use the existing `services/notifications.ts`)
| Event | Notify |
|---|---|
| New or resubmitted request | Admin |
| Returned, rejected, on hold, endorsed, or restock date changed | Branch |
| Endorsed | Logistics |
| Date-change request or shortage report | Admin |
| Date approved or rejected | Logistics and the branch |
| Scheduled or dispatched | Branch |
| Receipt with a discrepancy | Admin and Logistics |
| Discrepancy resolved | Branch and Logistics |

### 12. Audit trail
Every action writes an append-only record (extend `supply_request_status_histories`) containing:
- who, their role, and when;
- the from and to status;
- the action name;
- the reason or remarks;
- an attached file id (POD or photo), if any;
- a JSON `details` field (for example per-item quantities, or the fulfillment type).

The detail view shows this record as a timeline. Nothing can be edited or deleted.

### 13. Existing data
Map existing live requests in old statuses safely to the new ones (for example `endorsed` → `scheduled`, or as you judge after reading the code).
- Propose the mapping in Phase 0, in a migration that is idempotent and keeps history.
- Do not delete any data.

---

## UI

### Staff: one unified Supply Requests page (Admin and Logistics)
Today, Submitted and Under Review requests live in the Branches panel, and the rest in `SupplyRequests.jsx`.
- Make **`SupplyRequests.jsx` the single place for all of them**.
- In the Branches panel, show a branch's requests as a compact read-only list. It should link to the page, filtered by that branch.

**Header and KPIs**
- **Clickable KPI cards:** Needs my action, Overdue, On hold, In transit, Discrepancies.
- Each card opens the matching **filtered** list. Overdue must filter to overdue only.

**Tabs (each with a count)**
- **Needs my action** (the default)
- All
- Under review
- On hold
- Scheduled / Preparing
- Dispatched
- Discrepancy
- Completed
- Closed (rejected and cancelled)

**Toolbar**
- **Search:** branch, city, or request number.
- **Filters:** **Brand**, Urgency, and **Date range** for the date requested (from–to).
- **Sort options:**
  - Priority (the default: overdue first, then Critical, Urgent, Normal)
  - **Date requested** (newest or oldest)
  - **Target delivery date**
  - Branch A–Z
  - **Brand**

**Table rows**
- **Main label:** "Branch · City". Show the request number small, underneath.
- **Items:** the count, plus the first two names.
- An **urgency chip**.
- A **progress bar** of the main stages, with the status text and "Waiting: Admin / Logistics / Branch".
- **Target date**, with an **OVERDUE** badge.
- **One action button** whose label depends on the role and stage: Review, Resume, Resolve, Review date, Confirm schedule, Start preparing, Dispatch, Encode POD.
- Rows that need my action carry a left accent marker.
- The table must work on mobile.

**Detail drawer (opens on the right)**
- Status and urgency chips, plus the Overdue chip.
- A stepper.
- The urgency and bulk reasons.
- **Next action:** the buttons for my role. Other roles see a read-only line: "Waiting for Logistics."
- **Details:**
  - target and confirmed date, address, and contact;
  - the branch's other open requests;
  - links to the parent or backorder request.
- **Items table:** Requested, Available, Unavailable (⚠ when short), Branch stock, Days covered, Suggested, Critical flag.
  - After later stages, also show Prepared, Delivered, and Received (good / damaged / short).
- **Fulfillment decision** summary, with the restock dates.
- **Delivery:** driver, contact, plate, departure, ETA, Print Delivery Receipt, POD (thumbnail and received-by), and the actual delivery time.
- **Receipt and discrepancy:** per-item quantities, plus the photos (thumbnails that enlarge).
- **Audit trail** timeline.

**Modals**
- Fulfillment Decision (per-item grid, with the backorder preview).
- Return, Reject, Cancel.
- Approve or reject a date.
- Update restock date.
- Request new date.
- Report shortage (per item).
- Dispatch.
- Encode POD.
- Resolve discrepancy.
- Every reason or remark field is required where the rules say so, and errors appear inline.

### Branch portal (`BranchSupplyPanel.jsx`)
**New Request form**
- Items with quantity and unit. Each item line has the existing `EstimateHint` plus days covered.
- Urgency, and a reason when it is Urgent or Critical.
- Target date, with the earliest-date hint and the weekend warning.
- A bulk-reason field that appears only when needed.
- The duplicate warning.
- Address and contact, defaulting to the branch's.
- Remarks.
- Save as draft, or Submit.

**My requests**
- A simple tracker with 4 steps: **Submitted → Approved → On the way → Received**.
- Show the hold or returned reason clearly. A returned request shows "Edit and resubmit".
- Cancel is available while the request is editable.

**Confirm Receipt form**
- Per item: good, damaged, short, with the sum check.
- Reason and photo upload for damaged items; reason for short items.
- Show the driver, plate and ETA while the request is in transit.

---

## Phases

### Phase 0: Read and plan (no code changes)
Read the current supply code end to end, then report:
- The current statuses and transitions, and the current stock deduction and credit points.
- How POD, acknowledge and date revision work today.
- How settings are stored. Is there a settings table you can reuse for the two new supply settings?
- Every file that reads supply statuses, and what each one does.
- Whether a stock-adjustment feature exists for Logistics.
- Your proposed: status keys; schema changes (tables and columns); the old→new status mapping for existing data; and the endpoint list.
- Any rule in this brief that conflicts with the current code, and your recommendation for each.

Then **stop and wait.**

### Phase 1: Data model and workflow core
- Write the migration(s):
  - new statuses;
  - urgency fields;
  - bulk reason;
  - fulfillment type and per-item available, unavailable and restock date;
  - parent/backorder link;
  - reservations;
  - delivery driver fields;
  - receipt per item (good, damaged, short, reason, photo);
  - discrepancy resolution;
  - richer history;
  - the 2 supply settings;
  - the safe old→new status mapping.
- Write the workflow service:
  - transitions and owner;
  - a working-day helper with tests (Mon/Thu/Fri/Sat/Sun cases);
  - reservation, deduction and credit logic;
  - the overdue calculator.
- Write the **forecast "on order" fix** (and nothing else in the forecast).
- Update every status consumer (analytics, dashboard charts, branch workspace, branch portal, and the rest) so that nothing breaks.
- Add tests.

### Phase 2: API endpoints
Implement every action above with server-side validation, required reasons, audit records and notifications:
- create, edit, submit, cancel, return and resubmit;
- start review;
- endorse full;
- the fulfillment decision (with the backorder);
- resume;
- update restock date;
- reject;
- logistics accept, new date (with Admin approve or reject), and shortage;
- prepare;
- dispatch (with the Delivery Receipt data);
- POD;
- receipt;
- discrepancy resolve;
- list filters, sorts and counts for the tabs and KPIs.

Add API tests that cover these 10 scenarios:
1. Normal, full stock, end to end.
2. Short stock, not urgent: Hold for Restock, then Resume after restock. Resume is blocked before the restock.
3. Short and Critical: Partial – Ship Now creates the `-B` backorder. Both requests complete separately.
4. Partial – Consolidated reserves stock that another request cannot take, then ships together.
5. Bulk: over 50% without a reason is rejected (422); with a reason it passes. Admin returns it, and the branch edits and resubmits.
6. Logistics requests a new date; Admin approves it (and, in another case, rejects it with a reason).
7. Logistics reports a shortage per item, which leads back to Admin and a new decision.
8. Dispatched Thursday with an ETA on Sunday: the branch confirms on Sunday (before the POD), the POD is encoded Monday with Sunday's time, and the request completes.
9. Damaged items: only the good quantity is credited, then discrepancy review, then completed with discrepancy.
10. Permissions: the branch cannot act on other branches or after review starts; Logistics cannot endorse; Admin cannot cancel after dispatch; no action works with a missing reason.

### Phase 3: Staff UI (unified Supply Requests page)
Build everything in the "Staff" UI section, in the current theme. Verify it in the browser at desktop and mobile widths, and check the console for errors.

### Phase 4: Branch portal UI
Build everything in the "Branch portal" UI section. Verify it with `VITE_PORTAL=branch`.

### Phase 5: Polish, docs, final checks
- Print the Delivery Receipt.
- Add the overdue and reminder notifications.
- Check empty, loading and error states.
- Update `docs/defense-demo.md` (Taglish) with an **Objective 3** section:
  - a walkthrough of the 10 scenarios;
  - answers for likely panel questions: proof per step, why partial vs hold, why the 50% bulk check, weekends, damaged items, and why delivery cost is not computed.
- Add these limitations:
  - holidays are not counted;
  - one lead time for all branches;
  - no GPS (dispatch details are records only);
  - delivery cost is not computed;
  - no automatic replacement for damaged items.
- Provide local-only demo data for the scenarios (never on live).
- Run all tests, lint and both builds. Then give me the exact list of commands I must run for live, in order (migration push and function deploy), and what to check after each.
