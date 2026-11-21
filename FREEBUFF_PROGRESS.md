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
- Merged to `main` by the user via PR (all of the above).

## In progress
- Nothing is half-done in code. All changes are committed. Build passed on the latest code.
- Next time, start from the To do list below. Ask the user which page to work on first.

## To do
- (none from the user yet; waiting for the next page guidance)

## API/backend changes
- None. Frontend only. No files under `supabase/` changed.
- Note: the branch dropdown in Supply requests uses `GET /supply-requests?view=active` (paged), because `/branches` is admin and logistics only.

## Notes / questions for me
- Products preview modal: exit fade is 150 ms; user asked for about 1 s. Not changed yet, waiting for confirmation.
- Supply requests changes not yet checked visually in dark mode (light mode is gone).
- Supply status tabs: collapsed tabs are still keyboard-focusable. Fix with `inert` if wanted.
- Should the free-text request-number search come back as a separate box? It was removed when it became a branch dropdown.
- Checks run before the last merge: `npm run build` passed; `npm run test:lib` 96/96; `npm run test:api` 280/280.
