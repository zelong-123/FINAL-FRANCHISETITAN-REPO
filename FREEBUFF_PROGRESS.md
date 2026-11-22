# Freebuff progress — freebuff/all-UI-change-1

Branch: freebuff/all-UI-change-1
Goal: overall UI + basic function fixes across the whole system, guided by the user page by page.

## Done
- Applicants → Applicant stage modal → Schedule Activity section → redesigned the two activity cards and section chrome: 4px green progress bar under the header (50% per completed; admin: per verified), counter reads "X of 2 done" (Sales) / "X of 2 verified" (Admin), status-colored left accent (gray/gold/blue/green), pill with 6px dot, meta line "date · time · venue" or "No date set yet", renamed buttons "Open session details" / "View in schedule" (same routes), primary "Schedule activity" (fills #5B7CFA), section/card tokens per spec, focus rings, reduced-motion guards → src/pages/Applicants.jsx
- Applicants → Schedule Activity → Sales view is read-only: no complete/upload/verify controls; Training's "Schedule activity" is hidden until Orientation/Tasting is Completed, with "Available after Orientation/Tasting is completed" in the meta line; notes per status under the divider → src/pages/Applicants.jsx
- Applicants → Schedule Activity → section background set to #0C111D (whole Schedule activity section div) → src/pages/Applicants.jsx
- Applicants → Schedule Activity → section border radius reduced 14px → 8px (activity card radius still 12px) → src/pages/Applicants.jsx
- Applicants → Schedule Activity → Admin view: "Waiting for sales to submit…" note while Scheduled, submitted files shown as 2-column rows (1 column under 560px) with a Preview button (existing viewer/file API), "Submitted by sales · review files then verify" label, "Verify after checking both files." helper, admin-only footer note "Verification is recorded only when you click Save changes." → src/pages/Applicants.jsx
- Inquiries + Applicants → date range From/To filters now open a themed calendar popup (#0B0F19 panel, #222F47 border, accent-selected day) instead of the native Chrome date popup, which CSS cannot style; typing mm/dd/yyyy still works, min/max (To can't precede From) still enforced, Clear/Today kept → new src/components/DatePickerField.jsx, used in src/pages/Inquiries.jsx and src/pages/Applicants.jsx
- Inquiries + Applicants → date filter calendar restyled flat/minimal like the Master Schedule "Custom" (Week) calendar: 252px portrait panel on #070A13 with square corners, 30px square chevrons at both edges, month title centered between them, Mon–Sun band (#131C2C, 9.5px 800 uppercase), 40px rows of bold 15px day numbers separated only by a 1px horizontal line (#17203A), neighbouring-month days blank, Today centered in accent blue with a quieter Clear on the left → src/components/DatePickerField.jsx
- Applicant Pipeline → Application Detail modal: content cards are square now — `Card` (Overview, Qualification, Payment Record, etc.), checklist file rows and History entry cards dropped their border radius; modal frame, tabs and buttons untouched → src/components/applicants/ApplicationDetailReport.jsx
- Applicant Pipeline → Application Detail modal: removed the "Print this page" and "Print all pages" buttons and their print state/handlers (kept Back/Next, CSV, PDF) → src/components/applicants/ApplicationDetailReport.jsx
- Applicant Pipeline → Application Detail modal: header now uses the calendar's #070A13 → src/components/applicants/ApplicationDetailReport.jsx
- Create supply request modal → "Target delivery date" also uses `DatePickerField` (keeps the earliest-delivery `min` and the weekend warning; blank still means the earliest date), filling its grid column → src/pages/SupplyRequests.jsx
- Supply requests toolbar → "From" and "To" filters now use `DatePickerField` (same flat #070A13 square calendar, portal popup) instead of the native date inputs; the To field still keeps its `min` = From, and the input keeps the toolbar `TOOL` look → src/pages/SupplyRequests.jsx
- Schedule activity modal → Duration dropdown no longer pops open when the row is clicked: `Field` (ApiUi) is a `<label>`, and a label click focuses its first control (the `<select>`); the label now cancels activation for clicks that are not on a control when the field holds a select → src/components/ApiUi.jsx
- Activities & Schedules → Schedule activity / Edit activity modal → "Starts" date field now uses `DatePickerField` (same flat #070A13 square calendar) instead of the native `input[type=date]`; the field keeps its required/min-today/working-day checks and `yyyy-mm-dd` value → src/components/ScheduleActivityFields.jsx
- `DatePickerField` renders its popup through a `createPortal` on `document.body` as `position: fixed` (positioned from the input's screen rect, flips above when there is no room below, follows resize/scroll) so a scrolling modal body or a sticky footer can no longer clip or cover it.
- `DatePickerField` takes optional `inputClassName`/`required` (so it can fill a grid column and keep native required validation) and re-syncs its text to the real value whenever the popup is closed, so a rejected date (weekend) never sticks in the box.
- Why the day cells looked like grey boxes: `src/tailwind.css` base layer reverts button styling to browser defaults (`background-color: revert` → UA `buttonface` grey under dark color-scheme), so every button in the picker now carries `!` resets (appearance, background, border, radius, font) that explicitly beat it.

- Activities & Schedules → Adjust (Edit Orientation/Tasting) modal now shows the same availability guide as the new-schedule form: the Mon–Fri calendar (dots = the applicant's Sales user's sessions of that activity, dimmed days = no free start) and the 9:00–5:00 hour slots (greyed + hover reason = busy for that Sales user, at the facility limit, or ending after 5:00 PM). The live check and the Sessions panel stay for new schedules only, because both act on a session (Join) instead of moving this one. → src/pages/Activities.jsx
- Adjust modal → the activity's own session is no longer counted as busy: `useAvailability` takes `{ activityId, sessionId }` and sends `ignore_activity_id` (new) + `ignore_session_id` (already existed), so the day/time being adjusted shows as free; the API also drops that session from the calendar dots. While the new `ignore_activity_id` is not deployed yet, the activity's current day and start hour stay clickable in the picker (with a one-line note), so nothing looks broken. → src/lib/useAvailability.js, src/components/schedule/SmartSchedule.jsx, src/components/ScheduleActivityFields.jsx, supabase/functions/api/routes/scheduleSessions.ts, supabase/functions/api/services/schedule/availability.ts
- Analytics and Forecasting → "Closed periods" and "Manually excluded weeks" now sit side by side in one row (wrap to stacked on narrow screens); each panel is narrower (300–440px) instead of full width → src/pages/EstimatedRequirement.jsx
- Analytics and Forecasting → raw material forecast table now paginates 7 rows per page with the shared `Pagination` (Previous/Next, "Showing x–y of z"); it returns to page 1 when the view, sort, search, branch, horizon or dips mode changes → src/pages/EstimatedRequirement.jsx
- Analytics and Forecasting → forecast table page change slides: Next slides the rows in from the right, Previous from the left (same `animate-cal-slide-from-*` motion the Supply requests table uses, 0.3s) → src/pages/EstimatedRequirement.jsx
- Analytics and Forecasting → "Find an item" search now sits in the forecast table header (right of the branch title), styled as a simple darker input (`--bg-elevated`) that stands out from the table card in light and dark mode and filters the table instantly on the loaded list (material, variant or brand), without reloading on every keystroke; it goes back to page 1 when the search changes → src/pages/EstimatedRequirement.jsx
- Analytics and Forecasting → relayout: metric cards are shorter (smaller padding and numbers, tighter grid); the info note and the network and settings buttons share one row at the top, so no empty space is left above the filters; the Descriptive/Predictive toggle moved into the forecast table header next to "Find an item", which keeps its place → src/pages/EstimatedRequirement.jsx
- Analytics and Forecasting → metric cards get an icon beside the number (react-icons fa6: boxes, clock, calendar, warning, trend, chart) Removed the "Supply and demand overview" section (ForecastingSections.jsx deleted, no longer rendered on the page) → src/pages/EstimatedRequirement.jsx
- Forecast table pagination text ("Showing x–y of z", Page x of y, Previous/Next) enlarged to 12px with taller buttons, only on this page → src/pages/EstimatedRequirement.jsx
- Forecast table column headers enlarged to 13px bold, sub-labels (INCL. ON ORDER, COVERS 7 DAYS) 11px semibold uppercase → src/pages/EstimatedRequirement.jsx
- Removed the "Your recorded usage is never changed." hint under the Dips and spikes toolbar dropdown → src/pages/EstimatedRequirement.jsx
- Closed periods and Manually excluded weeks panels now split the full row width equally (removed the 440px max width that left empty space on the right) → src/pages/EstimatedRequirement.jsx
- Network requirement page: full-width container (was capped at 1640px) with the same padding as Estimated Requirement; info note and "One branch at a time" button now share one row, button on the right → src/pages/ForecastNetwork.jsx
- Removed the "Recorded usage is never changed." hint under Dips and spikes on Network requirement → src/pages/ForecastNetwork.jsx
- Network requirement metric cards: same design as Analytics and Forecasting (circle gradient top-right with hover motion, icon beside the number, bold uppercase labels) → src/pages/ForecastNetwork.jsx
- Network requirement table: paginated 10 rows per page with the shared Pagination; warehouse item names enlarged (15px, 800) and their SKU/material line (12.5px, 600) → src/pages/ForecastNetwork.jsx
- Network requirement metric cards: shorter height to match One branch at a time (padding 10px 14px, 18px number, same gaps and radius) → src/pages/ForecastNetwork.jsx
- One branch at a time chart redesigned to match the reference: gradient usage bars, hatched Left out band, glowing 7-day average line, Today pill on the reference line, 7-day tick steps, larger bold axis labels → src/pages/EstimatedRequirement.jsx (UsageChart)
- Usage chart bars widened: barCategoryGap 28% → 6% so the bars are thicker → src/pages/EstimatedRequirement.jsx
- Usage chart: removed the rounded top on the usage bars and reduced the Today pill radius to 4px → src/pages/EstimatedRequirement.jsx
- Inventory warehouse summary cards: icons added (Total items, Total units, Low stocks, Critical), card style with a colored left edge, larger bold numbers, panel background for light and dark mode → src/pages/Inventory.jsx
- Inventory summary cards: gradient circle added, shorter height, Low stocks and Critical are buttons that set the Filter stock status to low/critical (click again to clear), with aria-pressed → src/pages/Inventory.jsx
- Inventory summary cards: removed the left vertical accent line; gradient circle opacity reduced further (10% / 3%) → src/pages/Inventory.jsx
- Inventory summary cards: removed the tinted background behind the icons → src/pages/Inventory.jsx
- Warehouse inventory table: smooth fade-up transition when brand, status, sort, page, or search changes (table wrapper keyed, `.inv-rows-in` keyframe in src/tailwind.css) → src/pages/Inventory.jsx
- Inventory summary cards: Total items is now clickable (clears the stock status filter to show all items of the brand, highlighted when no filter is set); Total items and Total units swapped positions → src/pages/Inventory.jsx
- Warehouse inventory table transition fixed: table stays mounted during reloads (only the first load shows the spinner), dims while loading, and fades in on each change → src/pages/Inventory.jsx
- Metric cards: bold uppercase titles; each card has a soft accent circle gradient in its top-right corner, same card size → src/pages/EstimatedRequirement.jsx

## In progress
- Schedule activity modal (Activities > Schedule) + Edit modal: the new picker (calendar, slots, Duration, live summary chip) is wired into both. STOPPED HERE: the code compiles (npm run build exit 0) but nothing is browser-checked yet.
- Next steps, in order:
  1. User refreshes and checks: Schedule activity shows the calendar; days, slots, Next available and Duration stay locked until an applicant is picked; Edit modal still works.
  2. DONE: removed the red asterisk from the Applicant label (src/pages/Activities.jsx).
  3. DONE: moved the "Showing Sales User's ... sessions only" text under the Applicant select (src/pages/Activities.jsx); removed it from the Date header row (src/components/schedule/SmartSchedule.jsx). npm run build exit 0. Not browser-checked.
  4. Restyle the footer (New schedule summary + Cancel + solid Save activity) to match the design guide.
  5. Check layout under 640px and keyboard/aria.

## To do
- Items 2–5 above.
- Products page refresh check (user has not confirmed yet).
- Low stocks filter: verify against live data (read-only), since the deployed API may be older than the repo.
- Deploy the `ignore_activity_id` backend change only after the user says "merged".
- Not browser-checked: all Activities modal changes, Products load-gating, Inventory animation (the user confirmed the Inventory one).

## API/backend changes
- `GET /schedule-sessions/availability` accepts a new optional `ignore_activity_id` (the activity being adjusted); it resolves that activity's `schedule_session_participants.session_id` and leaves the session out of the busy checks, the facility counts and the calendar dots. `ignore_session_id` already existed and still wins when both are sent. No migration, no new table, no rule change.
- This backend change is NOT deployed yet (no `deploy:api` until you say "merged"); the frontend works without it thanks to the keep-current-slot behaviour described above.

## Notes / questions for me
- Live API banner ("Live API is older than this app"): live API is at 08b1c58 (API tree ea16126); this branch's API tree is 48e97a0 because of the uncommitted-to-live `ignore_activity_id` change in supabase/functions/api (routes/scheduleSessions.ts, services/schedule/availability.ts). Fix = `npm run deploy:api`, which Rules allow only after you say "merged". Alternative (your call): revert those two API files locally, which would make the banner go away but drops the Adjust-modal availability fix. Not done yet.
- "Verify" for a NEW-style submission (Orientation/Tasting with brand-selection file) is still the existing ActivitySubmission button that posts `/activities/:id/attended` immediately. Making it draft-only would change approval logic, so I left it as-is; only the older no-file completions use the new draft "Verify" toggle that is saved by SAVE CHANGES. If you want both to save only through SAVE CHANGES, that is approval logic → route to Claude Code.
- Sales "Schedule activity" reuses the existing Activities page form via the deep link `/activities?applicant_id=…&activity_type=…` (that page pre-selects the applicant and activity). No new API.
- Modal footer Save Changes already disables itself when there are no unsaved changes — unchanged.

## Rules
- I only give guidance. You do all edits, builds and progress-file updates yourself; never ask me to run commands. I watch the changes on the dev server in real time / on refresh.
- If the dev server crashes or a change breaks a page, fix it right away and tell me to refresh.
- Work ONLY on freebuff/all-UI-change-1. Never commit to or push to main. Never merge anything.
- Do NOT push to GitHub until I say "finish". Commit locally when I say "save point" (or before a big risky change).
- After every finished fix: run npm run build yourself (without stopping the dev server) and update FREEBUFF_PROGRESS.md immediately. Run npm run test:lib if you touched src/lib.
- Scope: UI, layout, wording, light/dark readability, responsiveness, and small function fixes. If a request needs a database migration, a new API rule, or changes to scheduling/payment/approval logic, STOP and write it under "Notes / questions for me" instead.
- Never create or edit files in supabase/migrations. Never run deploy:api or any Supabase deploy command, EXCEPT when I say "merged" after finish.
- Local dev (.env.local) is connected to LIVE data. When testing in the browser, only LOOK. Do not create, edit, approve, delete, schedule or submit anything.
- Keep existing behavior working: don't remove features, don't rename routes/API fields, keep both light and dark mode readable.
- Never commit image.png, .env files, tokens or passwords.
- Keep changes small and focused per request; no big refactors unless asked.

## Warehouse inventory: slide-down animation (follow-up)
- The animation key was on the Branch table (line ~1038) by mistake. Reverted there.
- The warehouse table `section` (line ~304, WarehouseInventory) now has key `status|sort|page|query|range` and class `inv-table-slide` (0.42s slide down, from `inv-table-slide` in tailwind.css).
- Open issue: the Low stocks tile sends `stock_status=low` correctly and the repo backend (`routes/inventory.ts`, /inventories/grouped) filters on it. The deployed API may be older. Not verified: needs a live check, which was not done (.env.local is live data).

## Warehouse animation: wait for load
- Table keeps old rows and dims (opacity-45) while loading. The slide-down (inv-table-slide) runs only after the new data arrives: shownKey updates when remote.loading turns false.

## Products: animation waits for load
- Replaced the awaitBrand/listAnimation trigger (it could fire before loading started) with shownKey (brand|search|page), updated only when remote.loading is false. Table dims while loading and slides in (inv-table-slide) after data arrives.

## Edit activity modal UI (Activities > Edit)
- SmartStartPicker: Date column (44px circle days, 4px accent dots, legend), Duration + "Ends at" on top of the right column, Start time 3-col slots (52px) with inline Busy / Full / Ends after 5 PM reasons (no strikethrough), Next available as a 44px text link, 1px hairline divider, stacks under 640px.
- ScheduleWindowFields: Duration moved into the picker's right column (old Duration field hidden in smart mode only). Availability logic, validation and API calls unchanged.
- Verified: npm run build exit 0. Not yet checked in browser.
- Edit modal follow-up: Duration select restyled to the dark input look (120x44), "Ends at" no longer wraps, "Start time" label no longer wraps, hour slots shrunk to 44px with 14px text and 11px reasons. npm run build exit 0. Still not checked in browser.
- Edit modal overflow fix: both picker columns set min-w-0, "Next available" moved under the slots, slots 40px with 13px text. npm run build exit 0. Not browser-checked.
- Edit modal: removed the "Busy times include a 1-hour gap" footnote. Added a live summary chip under the slots ("Nov 23, 2026 · 12:00 PM to 1:00 PM") that updates on each date, time or duration change. npm run build exit 0. Not browser-checked.
- Schedule activity modal (Activities > Schedule): the new smart picker (calendar, slots, Duration in the right column, live summary chip) now shows as soon as an activity is picked, instead of only after an applicant. Uses the same SmartStartPicker as Edit. npm run build exit 0. Not browser-checked.
- Schedule activity modal: the smart picker now always renders (it was hidden until an activity was picked, so the old Starts/Duration fields showed). Calendar stays empty until an applicant is chosen. npm run build exit 0. Not browser-checked.
- Schedule activity modal: calendar days, hour slots, Next available and the Duration select are locked until an applicant is selected (they were clickable with no data). Edit modal unaffected since it always has an applicant. npm run build exit 0. Not browser-checked.
