# Freebuff progress: overall UI + basic function fixes

## Goal
Overall UI and basic function fixes across the whole admin system, on one branch, guided by the user page by page. The user gives guidance only. The assistant does all edits, builds and commits.

## Branch
- Working branch: `freebuff/overall-ui-fixes`
- Status: the first batch was merged into `main` by the user (PR "Finish overall UI fixes across admin pages", commit `e614804` on this branch). Any new work continues on this branch and needs a new PR.

## Rules
- One branch only. Never commit to `main`. Never touch `stash@{0}`.
- Do not push until the user says "finish".
- No migrations. Never edit `supabase/migrations`. Never run deploy commands.
- No deploy unless the user says "merged".
- Local dev uses LIVE data (`.env.local`). Only look in the browser, never test writes.
- Commit locally only on "checkpoint". Save point commits use the message the user gives.
- Reply to the user in Taglish.
- Keep light and dark mode readable where light mode still exists (light mode is removed now: dark only).
- Keep existing behavior, routes and API fields. Small `str_replace` edits only; never rewrite an existing file with `write_file`.
- Never commit `image.png`, `.env` files, tokens or passwords.
- Database, API, scheduling, payment or approval logic changes go under "Notes / questions for me".
- After every fix: run `npm run build` (`npm run build 2>&1 | tail -n 3; echo EXIT=${PIPESTATUS[0]}`) and update this file.
- Keep the dev server at http://localhost:5173 running while working.

## Done (page → what changed → files)
- **Products**: hover preview card on each row (shows after 0.5 s, fades out on leave). Shows picture, name, description, ID, brand (brand theme color), recipe with batch amounts. Files: `src/pages/Products.jsx`.
- **Wider containers** (less empty space on sides/top): Products, Branches, Inventory, Supply requests, Dashboard (admin), Inquiries, Applicants, Activities, Forecasting (wrapper), History, Admin settings, Users. Files: the matching `src/pages/*.jsx`.
- **Supply requests crash fix** ("Herald could not display this screen"): the list used `lookups`, which only exists in the create modal. The list now loads its own branch options. Files: `src/pages/SupplyRequests.jsx`.
- **Supply requests > New supply request**: Branch and Item product selects replaced with searchable `BranchCombobox`, with guards ("Please select a branch.", "Please select a product for each item."). Files: `src/pages/SupplyRequests.jsx`, `src/components/BranchCombobox.jsx` (disabled prop).
- **Supply requests list search**: the "Search city or request number" box is a branch dropdown (`BranchCombobox`) listing only branches with an open supply request, built from `/supply-requests?view=active` pages. Files: `src/pages/SupplyRequests.jsx`, `src/components/BranchCombobox.jsx` (optional className prop).
- **Supply requests status tabs**: hidden by default with "Show all" / "Hide" toggle and slide animation (`.tabs-collapse` / `.tabs-collapse-inner`, reduced-motion respected). Files: `src/pages/SupplyRequests.jsx`, `src/tailwind.css`.
- **Admin settings**: tab counts show only archived items, in a blue circle badge; panel radius 10px. Files: `src/pages/AdminSettings.jsx`.
- **Users**: pagination 8 per page (`SlidingPagination`); table radius 10px; name font 15px. Files: `src/pages/Users.jsx`.
- **Light mode removed** (user-approved): app always dark. `ThemeContext` always sets dark. Theme toggle removed from admin Header and login. Light CSS overrides left unused. Files: `src/context/ThemeContext.jsx`, `index.html`, `src/components/ADMIN/HeaderAndNav/Header.jsx`, `src/components/Log.jsx`.
- **Applicant pipeline filters**: From/To date fields show "mm/dd/yyyy" placeholder (hidden once a date is picked); "Date applied" placeholder; Brand and Assigned Sales show their name as the empty option; labels kept as sr-only; min-width 175px. Files: `src/pages/Applicants.jsx`.
- **Inquiries** (admin and marketing): same date placeholders and 175px min-width. Files: `src/pages/Inquiries.jsx`.
- **Warehouse inventory stat cards**: solid `#070A12`, 2px `border-line-strong`. Files: `src/pages/Inventory.jsx`.
- **Warehouse inventory toolbar**: brand dropdown first, then the date range dropdown. Files: `src/pages/Inventory.jsx`.
- **Warehouse inventory table caption**: brand name bold, uppercase, in `brandColor()`. Files: `src/pages/Inventory.jsx`.
- **Add warehouse product modal**: bigger labels (13px bold) and inputs (46px, 15px text), scoped with class `wh-product-form` so other modals are unchanged. Files: `src/pages/Inventory.jsx`, `src/tailwind.css`.
- **Master schedule mini calendar (Day view)**:
  - Dots: scheduled (not done) = green `#22c55e`; completed = blue `#3b82f6`. `dayDots()` returns `done` (completed participants). Files: `src/lib/masterScheduleDays.js`, `src/lib/masterScheduleDays.test.mjs`.
  - Dots sit above the selected circle (`relative z-[1]` on dots, `z-0` on circle).
  - Selected-day circle: background `#070A13` (same as calendar) with 2px border `#5b7fc0`. Files: `src/components/schedule/MasterSchedulePanels.jsx`.
- **Supply requests > All tab**: completed requests (`completed`, `completed_with_discrepancy`) are no longer in the All list or its count. They stay in the Completed tab. Backend change: `S.TABS.all` in `supabase/functions/api/services/supplyStatus.ts`; test updated in `tests/api/supply_scenarios.test.ts`. Checks: `supply_scenarios` + `supply_demo` 13/13 pass, `npm run build` passes. Not committed yet (waiting for "checkpoint").
  - Live page still showed completed rows because the local dev server calls the deployed API. Frontend fix added in `src/pages/SupplyRequests.jsx`: the All rows are filtered with `DONE_STATUSES`, and the All count is `tabs.all - tabs.completed`. Build passes.
  - Fix 2 (`src/pages/SupplyRequests.jsx`): the All tab fetches up to 100 rows (page 1), removes completed rows, then pages locally at 7 rows per page with its own `allMeta` (total = open rows). Other tabs use server paging at 7 per page (`PAGE_SIZE`). The shared `Pagination` component in `ApiUi.jsx` is unchanged. Build passes. Not checked in the browser yet.
  - Fix 3 (`src/pages/SupplyRequests.jsx`): page change animation. Next slides in from the right, Previous from the left, using the existing `animate-cal-slide-*` utilities (reduced-motion already handled globally in `tailwind.css`). The list is keyed by page, so it re-animates on each change. Build passes. Not checked in the browser yet.
  - Fix 4 (`src/pages/SupplyRequests.jsx`): removed the "Analytics and Forecasting" button from the page header. The forecasting page itself is unchanged and still reachable from the sidebar. Build passes.
  - Fix 5 (`src/pages/SupplyRequests.jsx`): removed the empty header row (`PageHeader`, which only rendered the action buttons since the title is in the breadcrumb). Status tabs (All / Hide / Show all) and the Supply settings / New supply request buttons now share one row, tabs on the left and admin buttons on the right. Build passes.
  - Fix 6 (`src/pages/SupplyRequests.jsx`): added outline icons from `react-icons/md` (already a dependency) before each status tab label and the Overdue tab. Colors, positions and counts are unchanged. Build passes.
  - Fix 7 (`src/pages/SupplyRequests.jsx`): larger pagination text ("Showing 1–7 of 11", "Page 1 of 2", Previous/Next) by overriding font size on the wrapper. The shared `Pagination` in `ApiUi.jsx` is unchanged, so other pages keep their size. Build passes.
  - Fix 8 (`src/pages/SupplyRequests.jsx`): row action buttons in the table Next step column and the mobile cards now show an icon before the label (Review: FindInPage, Resolve: FactCheck, Resume / Start preparing: PlayCircle, Dispatch: LocalShipping, Encode POD: Inventory2, Confirm schedule: CalendarMonth). Labels and click behavior are unchanged. "View" stays text-only. Build passes.
  - Fix 9 (`src/pages/SupplyRequests.jsx`, `src/tailwind.css`): on hover, only the action button's icon moves. Review (magnifier) scans in a small loop while the paper stays still. Resolve/Encode POD/Confirm schedule tilt; Resume/Start preparing/Dispatch/Complete lift. Uses `.supply-action-btn` and `.supply-action-icon` classes. Reduced-motion users get no icon motion. Build passes. Not yet checked in the browser.
  - Fix 10 (`src/components/supply/supplyUi.jsx`, `src/tailwind.css`): the Stepper progress bar's in-progress segment has no color at rest. Its accent fill grows from empty to full and drains back smoothly (`.supply-stepper-live::after`, `stepper-fill`, alternate 2.4s), while the request is still in process. The glow (`box-shadow`) is back on the current segment. Finished and todo segments are unchanged. Reduced-motion users get no animation. Build passes. Not yet checked in the browser.
  - Fix 11 (`src/components/supply/supplyUi.jsx`): the "Returned – waiting for branch" chip in the Supply table no longer has a border. It is a new `borderless` prop on `Chip`. Text and background are unchanged. Build passes.
  - Fix 12 (`src/components/supply/SupplyDrawer.jsx`, `supplyUi.jsx`): Supply drawer redesign, UI only. Close is icon-only 44px with aria-label. Title is 24px, with a muted priority line and no Overdue pill. Overdue is a soft tinted banner with no border. Start review is the only filled button, and Reject and Cancel are text-only danger buttons. Details uses a hairline 2-column grid with the renamed labels (Branch, Requested by, Requested on, No contact). Items table has no outer card. Endorsed quantity is a simple list. Activity is a timeline, newest first, with only the latest dot in accent. Not done: the stage bar 8-segment layout, Items stock text ("Branch stock normal/low") under item names, and the Next-stage label. Build passes. Not yet checked in the browser.
  - Fix 13 (`src/components/supply/SupplyDrawer.jsx`): the drawer header (request ID, branch title, status, and priority) is now sticky at the top while the rest scrolls under it. The close button is absolutely positioned at the top right. Build passes. Not yet checked in the browser.
  - Fix 14 (`src/pages/SupplyRequests.jsx`): tab count badges are colored by value. Needs my action, Discrepancy, and Overdue are red when 1 or more. Under review, On hold, Scheduled / Preparing, and Dispatched are blue when 1 or more. Completed is green when 1 or more. Zero, All, and Closed keep the neutral color. The colored badges are stronger: background 38% (was 18%) and bold number. Build passes. Not yet checked in the browser.
  - Once the API change is deployed ("merged"), the frontend subtraction must be removed, or the All count will be too low. Note for the deploy step.
- Merged to `main` by the user via PR (all of the above).

## In progress
- Nothing is half-done in code. All changes are committed. Build passed on the latest code.
- Next time, start from the To do list below. Ask the user which page to work on first.

## To do
- (none. Supply requests > All tab done; waiting for the next page guidance)

## API/backend changes
- None. Frontend only. No files under `supabase/` changed.
- Note: the branch dropdown in Supply requests uses `GET /supply-requests?view=active` (paged), because `/branches` is admin and logistics only.

## Notes / questions for me
- Products preview modal: exit fade is 150 ms; user asked for about 1 s. Not changed yet, waiting for confirmation.
- Supply requests changes not yet checked visually in dark mode (light mode is gone).
- Supply status tabs: collapsed tabs are still keyboard-focusable. Fix with `inert` if wanted.
- Should the free-text request-number search come back as a separate box? It was removed when it became a branch dropdown.
- Checks run before the last merge: `npm run build` passed; `npm run test:lib` 96/96; `npm run test:api` 280/280.
