# FREEBUFF PROGRESS — freebuff/all-UI-change-2

Last updated: 2026-11-23 (save point 2)

## Done
- **Adjust Inventory modal compacted** (`src/pages/Inventory.jsx`, `AdjustQuantityModal` + `ADJUST_STEPPER_CLASS` / `ADJUST_CHIP_CLASS`): title 20px, section labels 14px, current/new stock 26px, direction cards 62px with 34px icon, quantity input 46px at 20px, steppers 46px, quick chips 32px at 12px, note 76px at 13px, footer buttons 42px at 14px. Before/after summary, stepper, +1/+5/+10 and "All" chips, inline validation and the `All` shortcut are UI only — the same `api.post('/inventory/:id/adjust')` call, props and modal lifecycle are unchanged.
  - The visible box around the whole form is gone: the `fieldset` gets `border-0! p-0` because shared form/fieldset styling was drawing it.
- **Product archive (franchisee only, `is_active` based, no migration)** — `src/components/branch/BranchProductsPanel.jsx`, `supabase/functions/api/routes/branchWorkspace.ts`, `tests/api/branch_product_archive.test.ts`:
  - Active / Archived tabs in the Products header (archived tab requests `?archived=1`).
  - Archive / Unarchive lives in the **ProductModal body status toolbar** (right aligned next to an "Active · …" / "Archived · …" label). It is not in the modal header because header `actions` slots never rendered for the user.
  - Confirmation `Modal` before the change; success/error `Notice` at the top of the panel; list reloads silently after the action.
  - Server refuses unarchive when the product has no recipe ingredient, and producing an archived product stays blocked (`produce-product` still requires `is_active = true`).
- Earlier UI commits already on this branch: `c60613c` (branch supply request panel + page width), `2835a77` (branch dashboard, transactions, inventory views), `6456505` (branch workspace panels restyle).

## In progress
- **Nothing is half-done.** Every uncommitted change compiles and is committed here.
- Exactly where the last session stopped: the compact Adjust modal was built, `npm run build` passed, and the served dev module was confirmed to contain it — but the user had **not yet looked at it on screen**. Her last feedback was "maganda, pero wag masyadong malalaki ang Font text at mga elements like buttons. dapat sakto lang as Modal", and this build is the answer to that; it is unconfirmed visually.
- Next steps:
  1. Open Warehouse → Inventory → Adjust on a stock item (e.g. 25 kg) at desktop width and at ~500px and check the modal feels "sakto" without a scrollbar.
  2. If she wants more tuning, only Tailwind classes inside `AdjustQuantityModal` change (sizes listed under Done). Keep logic/props/API intact.
  3. Open a product as franchisee to confirm the Archive button is visible in the modal body toolbar.

## To do
- Visual confirmation of the compact Adjust modal (user-driven; `.env.local` is LIVE data so no automated browser checks here).
- Visual confirmation of Product archive/unarchive for a franchisee account. Diagnostic if the button is missing: status text present but no button → `canArchive` is false at runtime (`role !== 'franchisee'`); neither present → the browser is running a stale bundle (hard refresh / check the dev-server URL).
- No other feature was requested or started. Nothing queued.

## API/backend changes
- `supabase/functions/api/routes/branchWorkspace.ts`:
  - `GET /branch/workspace/products` accepts `?archived=1`. Default is `is_active = true`; with `archived=1` it returns `is_active = false`. Response rows now include `is_active`.
  - `POST /branch/workspace/products/:product/archive` and `.../unarchive` — `franchisee` role only, scoped to the caller's brand, writes an `audit()` event (`brand_product.archived` / `brand_product.restored`), and returns a human message. Idempotent calls return "already archived/active".
  - Unarchive is rejected when no `brand_product_ingredients` row exists.
  - `POST /branch/workspace/produce-product` is untouched and still blocks archived products.
- **No DB migration** was added (agreed with the user): the feature reuses the existing `brand_products.is_active` column.
- Not deployed. Never run `npm run deploy:api` or any Supabase deploy command without an explicit request.

## Notes
- Branch: `freebuff/all-UI-change-2`. Never commit to `main`. Do not touch the git stash.
- `.env.local` points at LIVE data → the user does the browsing; no browser/screenshot automation. Dev server: `http://localhost:5173` (`[::1]:5173` also listens; `curl` needs `-g` for the IPv6 URL).
- Checks at this save point: `npm run build` (`vite build`) **exit 0**, 859 modules; `node --no-warnings --test tests/api/branch_product_archive.test.ts` → **2/2 pass**; earlier broad runs: `npm run test:api` 282/282 and `npm run test:lib` 101 pass.
- Known non-blocking build warning: duplicate `disabled` attribute in `src/components/schedule/SessionDetail.jsx` (pre-existing, not from this work).
- Pre-existing eslint issues, not introduced here: `src/pages/Inventory.jsx` around lines 95/127/162, and `react-hooks/set-state-in-effect` in `BranchProductsPanel` / `BranchProductionPanel` `load()`.
- Shared `ApiUi.jsx` `Modal` footer CSS has `later` / `later-2` variants written as `&:not(z)` (always active) that override button styling — that is why the Adjust footer buttons use `!` important utilities. `ApiUi.jsx` itself was restored to its original state.
- `formatNumber(value, 2)` is used in the Adjust modal so decimals (e.g. 0.44 kg) are not rounded away.
- Frontend uses `api.get('/branch/workspace/products', branchQuery)`; the archive POST passes `{ query: branchQuery }` so Admin branch switching keeps working.

## Rules
- Reply in a Tagalog/English mix; dark theme; do **not** add dependencies.
- **No commit, merge, push or deploy unless the user explicitly asks.** This save point is one such explicit request.
- For UI work: keep existing logic, API calls, props and styling conventions; change presentation only.
- Do not edit `supabase/migrations` for the archive feature — `is_active` is the agreed mechanism.
- Leave `src/components/ApiUi.jsx` alone unless a change is truly needed by the request.
