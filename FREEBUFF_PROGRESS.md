# FREEBUFF Progress

## Branch
`freebuff/all-UI-change-5`

## Goal
Overall UI + basic function fixes across the whole system (small backend changes allowed, see Rules), guided by the user page by page.

## Done
<!-- one line per fix: page -> what changed -> files -->
- Activities & schedules → Master Schedule (Admin + Sales) -> a pinned session card now gets a **red outline + soft red glow** as soon as one seated applicant did not attend, and the red **fully replaces** the green/status stroke (the calendar event border colour itself turns red, so only one stroke colour shows at a time — red when triggered, status colour otherwise): red when the applicant's activity is marked No Show, and also when the session is still pending/confirmed while a seat was never completed after its start time (the same “did not attend” rule the Activities table badge uses); the red clears by itself once that applicant's schedule activity is adjusted (Set Again / Adjust) or marked Attended; the hover tooltip adds “An applicant did not attend — adjust their schedule activity.” -> `src/pages/MasterSchedule.jsx` (no CSS file, no backend change)
- Applicants → Application Detail modal -> the plain “Loading the Application Detail…” text (and “Loading…” title) is now a **skeleton** with the same moving shimmer as the Applicant Stage modal (`.ap-skeleton`): header title bar, page-tab pills, label/value card, row cards -> `src/components/applicants/ApplicationDetailReport.jsx` (reuses `src/tailwind.css`)
- Applicants → Application Detail (folder view) -> removed the outer panel (no large border, background panel, rounded wrapper or shadow): the folder tabs, the Grid/List toggle and the record cards now sit straight on the page -> `src/pages/Applicants.jsx`, `src/tailwind.css`
- Applicants → Application Detail -> Grid/List toggle kept and pinned to the right of the same row as the status filters; spacing between the view tabs, the status filters and the cards made one consistent 16px rhythm; the in-panel divider/padding removed from the pagination -> `src/pages/Applicants.jsx`, `src/components/applicants/RecordFolders.jsx`
- Warehouse inventory (Admin) -> new **Adjust** button on each row (Admin only) opening a Low / Critical threshold setter: live status preview, decimal support, critical-must-not-exceed-low validation, saves to the existing endpoint -> `src/pages/Inventory.jsx`, `src/lib/roleAccess.js`
- Permissions -> new key `inventory.thresholds` = admin only (UI gate + mirrored server-side matrix) -> `src/lib/roleAccess.js`, `supabase/functions/api/config/roles.ts`
- Warehouse thresholds API -> `PATCH /inventories/:id/thresholds` now accepts decimal levels (`integer` -> `numeric`) so an existing 2.5 level saved by Add Product can be edited -> `supabase/functions/api/routes/inventory.ts`

## In progress
- Nothing in progress. Dev server running at http://localhost:5173. Waiting for the next request.

## To do
_awaiting user requests_

## API/backend changes
- `supabase/functions/api/config/roles.ts` -> added `inventory.thresholds: ['admin']` so the server-side permission matrix matches the UI (`can()`); additive, nothing reads it for enforcement yet.
- `supabase/functions/api/routes/inventory.ts` -> `PATCH /inventories/:id/thresholds` validation relaxed from `integer` to `numeric` on `reorder_level` / `critical_level` (the column is `numeric(14,2)`); backward compatible, the route path, fields and response are unchanged.
- No route added, renamed or removed. No migration touched.
- Deploy status: NOT deployed yet

## Notes / questions for me
- **Expected banner:** because `supabase/functions` changed, your local dev will now show the “Live API is older than this app” warning until a deploy. That is expected for this job.
- **Permission question (needs your OK, not done):** the threshold endpoint `PATCH /inventories/:id/thresholds` still allows Logistics at the API level (there is no Logistics UI for it — Logistics only sees the quantity Adjust). The UI is Admin-only as you asked. Making the *API* strictly Admin-only changes who is allowed to do what, so per the rules I have not done it — say the word and I will log it for the Claude Code handoff.
- Master Schedule red card: it is derived from the session data (participant `attendance_status` + session time), so nothing new is stored. It turns red for a No Show **or** for a live session whose start time already passed while a seat is still `scheduled` — that is exactly the state the Activities table shows as “Applicant did not attend”, so the card warns you before anyone marks the activity. If you want red ONLY for a formally marked No Show (never for “past start, not marked yet”), say the word and I will switch it.
- Thresholds are set per item from the row’s Adjust button. If you also want a single worksheet to set Low/Critical for a whole brand at once, ask and I will add it.
- The Applicants toolbar above the folder tabs (Pipeline / Franchisees / Archive / Application Detail + search + status) still has its own box: it is shared by all four tabs and the pipeline table sits inside it. Say the word if you want it flattened for this page only.

## Rules
- I only give guidance. You do all edits, builds and progress-file updates yourself; never ask me to run commands. I watch the changes on the dev server in real time / on refresh.
- If the dev server crashes or a change breaks a page, fix it right away and tell me to refresh.
- Work ONLY on `freebuff/all-UI-change-5`. Never commit to or push to `main`. Never merge anything.
- Do NOT push to GitHub until I say "finish". Commit locally when I say "save point" (or before a big risky change).
- After every finished fix: run `npm run build` yourself (without stopping the dev server) and update `FREEBUFF_PROGRESS.md` immediately, so nothing is lost if the session ends. Run `npm run test:lib` if you touched `src/lib`, and `npm run test:api` if you touched `supabase/functions`.
- Scope: UI, layout, wording, light/dark readability, responsiveness, and small function fixes. Small backend changes under `supabase/functions` are ALLOWED when a fix needs them (for example an optional parameter, a filter, a small endpoint), but they must be backward compatible (old app versions must not break), must be listed in "API/backend changes" immediately, and must have tests passing. STOP and write it under "Notes / questions for me" instead if a request needs a database migration, or changes scheduling, payment or approval logic, or changes who is allowed to do what (permissions). That work goes to Claude Code.
- Never remove or disable an existing user capability (for example creating, rejecting, approving, archiving, editing) unless I explicitly ask for it. If a fix seems to require it, ask me first.
- Never create or edit files in `supabase/migrations`. Never run `deploy:api` or any Supabase deploy command, EXCEPT when I say "merged" after finish.
- When you change anything under `supabase/functions`, warn me right away that the "Live API is older than this app" banner will appear on my local dev until deploy, and that this is expected.
- Local dev (`.env.local`) is connected to LIVE data. When testing in the browser, only LOOK. Do not create, edit, approve, delete, schedule or submit anything.
- Keep existing behavior working: don't remove features, don't rename routes/API fields, keep both light and dark mode readable.
- Never commit `image.png`, `.env` files, tokens or passwords.
- Keep changes small and focused per request; no big refactors unless I ask.
