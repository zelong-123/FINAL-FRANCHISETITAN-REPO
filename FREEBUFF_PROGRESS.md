# FREEBUFF PROGRESS — freebuff/all-UI-change-3

**Branch:** `freebuff/all-UI-change-3`
**Goal:** Overall UI + basic function fixes across the whole system, guided by the user page by page.
Last updated: 2026-11-23 (save point 1)

## Done
- Setup — branch `freebuff/all-UI-change-3` created from `main` at `faef263`; progress file added.
- Supply Requests (Logistics) → **Encode POD** (`Proof of delivery`) → rebuilt the modal UI: header with package icon, subtitle and 44px close; Request ID / Branch / status pill summary card; drag-and-drop dropzone replacing the native file input (real `<input type="file">` covering it, thumbnail via object URL revoked on remove/unmount, PDF icon, file name/type/size, green "Ready to attach", Remove button, JPG/PNG/PDF validation with inline error + shake); Received by with person icon; native datetime-local kept with a human-readable echo and a "Use current time" button; optional Note with live counter that turns amber near the limit; every field tagged Required/Optional; sticky footer with a hint that swaps ("Still needed: …" → "All required details are filled in") and disabled-until-complete Save (spinner → drawn check → exit). Dialog has role/aria-modal/aria-labelledby, focus trap, Escape, focus return, reduced-motion fallbacks. Files: `src/components/supply/MarkDeliveredModal.jsx`, `src/tailwind.css` (pod keyframes + classes).
- POD modal **pass 2 (colour/size alignment + minimalism)**: rebuilt the same modal on the app's own palette instead of its own look — header/footer now use the shared dialog chrome (`color-mix(--panel 96%)` + hairline border), and every nested block (summary card, dropzone, file card, inputs) uses the single `--input-bg` inset tone with `--border` / `--input-line` hairlines, so nothing reads as a different grey. Inputs use the same recipe as the shared `Field` (`h-[42px]`, `rounded-[11px]`, `--input-bg`, accent focus ring at 11%), with `[color-scheme:dark] light:[color-scheme:light]` so the native date icon matches the theme. **Received by and Actual delivery date and time now sit in one row** (`grid-cols-2`, identical height/size/background/border; stacks at ≤520px), and the human echo + "Use current time" link sit under the date column instead of a chunky button. Also trimmed the header icon to 34px, labels to 12px, dropzone to a horizontal icon+text layout, smaller radii/paddings and a lighter footer, keeping the same fields, validation, save call, animations and a11y. Files: `src/components/supply/MarkDeliveredModal.jsx` only (no new CSS).
- POD modal **pass 3 (feedback round)**: bumped the small type by ~0.5–1px (labels 12.5, values/inputs 13–13.5, title 16, hints 11–11.5) and cut the border radius of the dialog and its inner blocks (panel 16→10px, fields/cards 11→9px, thumbs 8→6px). `Received by` now strips anything that is not a letter or space as you type (digits/symbols), so only names can be entered. Added an attachment **viewer**: the file thumbnail and a new **View** button open the chosen file inside the modal (image shown contained, PDF in an embedded frame, dark backdrop, “Open in new tab”, X to close; Escape closes the viewer first, not the dialog) — the same blob that will be uploaded, so the file can be checked before saving. Replaced the native `datetime-local` with a **themed date+time picker** (`PodDateTimePicker`) because the native Chrome panel cannot be recoloured: popup background `#070A13`, hairline `#1B2437`, muted weekday strip, calendar grid + hour/minute/AM-PM scroll columns, selected cell in the accent tint, future days/hours/minutes disabled, “Now” and “Done”, `data-pod-picker` guard so clicking the popup never closes the dialog, Escape captured so it only closes the popup. Number size in the picker stays at the native-looking 13px. Still the same `POST /supply-requests/:id/pod` payload — value is still the same local `YYYY-MM-DDTHH:mm` string. File: `src/components/supply/MarkDeliveredModal.jsx` only.

## In progress
- Nothing half-done. Pass 3 is built, linted and committed as a local save point; waiting for the user to check it on the dev server.
- If she wants more tweaks: sizes/spacing live inside `MarkDeliveredModal.jsx` (`FIELD`, `SURFACE`, `LABEL`, `TAG`, `GHOST` constants at the top); motion lives in the `pod-*` block at the end of `src/tailwind.css`.

## To do
- (empty — no other requests given yet)

## API/backend changes
- none — frontend only.

## Notes / questions for me
- **Save logic untouched.** It is still the single multipart `POST /supply-requests/:id/pod` call with `file`, `received_by`, `actual_delivered_at` (ISO) and optional `notes`. The API itself stores the file in the POD bucket (`storeDocument`), writes the `documents` + `deliveries` rows and moves the request to `delivered`, so there is no client-side Storage upload, no service-role key and nothing to clean up on a failed write in the browser.
- **No schema change needed.** Existing `deliveries` columns cover it: `recipient_name`, `actual_delivered_at` / `delivered_at` / `delivery_date`, `pod_document_id`, `notes`. The uploaded file's storage path stays in `documents` as before. No migration SQL was required or added.
- Existing file previews elsewhere go through the authenticated API blob route (`fetchBlob`), not public URLs; the POD modal itself only ever encodes a first POD (the action appears only when `pod_encoded` is false), so there is no existing POD to preview here.
- Server rules the form cannot pre-check: the actual delivery time must be on or after the dispatch departure, and re-encoding an already-encoded POD is rejected. Both surface in the error banner and the inputs are kept.
- `npm run build` exit 0 (12.3s) and `npx eslint src/components/supply/MarkDeliveredModal.jsx` clean after pass 3; dev server untouched and still serving.
- The date+time picker is UI only: it still emits the same local `YYYY-MM-DDTHH:mm` string the route converts with `new Date(...).toISOString()`, and the server rules (no future time, on/after departure) are unchanged and still enforced server-side.
- Local `.env.local` is LIVE data — the user does the visual checks; I only look.

## Rules (for this whole job)
- I only give guidance. You do all edits, builds and progress-file updates yourself; never ask me to run commands. I watch the changes on the dev server in real time / on refresh.
- If the dev server crashes or a change breaks a page, fix it right away and tell me to refresh.
- Work ONLY on freebuff/all-UI-change-3. Never commit to or push to main. Never merge anything.
- Do NOT push to GitHub until I say "finish". Commit locally when I say "save point" (or before a big risky change).
- After every finished fix: run npm run build yourself (without stopping the dev server) and update FREEBUFF_PROGRESS.md immediately, so nothing is lost if the session ends. Run npm run test:lib if you touched src/lib.
- Scope: UI, layout, wording, light/dark readability, responsiveness, and small function fixes. If a request needs a database migration, a new API rule, or changes to scheduling/payment/approval logic, STOP and write it under "Notes / questions for me" instead. That work goes to Claude Code.
- Never create or edit files in supabase/migrations. Never run deploy:api or any Supabase deploy command, EXCEPT when I say "merged" after finish.
- Local dev (.env.local) is connected to LIVE data. When testing in the browser, only LOOK. Do not create, edit, approve, delete, schedule or submit anything.
- Keep existing behavior working: don't remove features, don't rename routes/API fields, keep both light and dark mode readable.
- Never commit image.png, .env files, tokens or passwords.
- Keep changes small and focused per request; no big refactors unless I ask.
