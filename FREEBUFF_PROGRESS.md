# Freebuff progress: overall UI fixes

## Branch
freebuff/overall-ui-fixes (based on main, not pushed, not merged)

## Done
- Products: hover preview card on each product row (shows after 0.5 s, fades out when the cursor leaves). Shows a larger picture, name, description, ID and brand (brand in its theme color), a divider, then the recipe with each ingredient's batch amount. Files: src/pages/Products.jsx
- Products, Branches, Inventory, Supply requests, Dashboard (admin view), Inquiries, Applicants, Activities, Forecasting (wrapper), History, Admin settings, Users: wider page container (less empty space on the sides and top). Files: the matching src/pages/*.jsx files
- Supply requests crash fix ("Herald could not display this screen"): the list used `lookups`, which only exists in the create modal. The list now loads its own branch options. Files: src/pages/SupplyRequests.jsx
- Supply requests > New supply request: Branch and Item product selects replaced with the searchable BranchCombobox, with guards ("Please select a branch.", "Please select a product for each item."). Files: src/pages/SupplyRequests.jsx, src/components/BranchCombobox.jsx (disabled prop)
- Supply requests list: the "Search city or request number" box is now a searchable branch dropdown (BranchCombobox). It lists only branches with an active (open) supply request, built from `/supply-requests?view=active` pages. The separate branch dropdown was removed. Same style as the other filter controls (TOOL). Placeholder: "Search or select branch...". Files: src/pages/SupplyRequests.jsx, src/components/BranchCombobox.jsx (optional className prop)
- Admin settings: tab counts show only archived items, in a blue circle badge; panel radius 19px to 10px. Files: src/pages/AdminSettings.jsx
- User management: SlidingPagination with 8 users per page; table radius 19px to 10px; name font 13px to 15px. Files: src/pages/Users.jsx

## In progress
- Supply requests status tabs: hidden by default (only "All" and the active tab show) with a "Show all" / "Hide" button. Slide animation is being added:
  - Done: the hidden tabs moved into a collapsible panel (`.tabs-collapse` / `.tabs-collapse-inner`) with the CSS in src/tailwind.css (grid-rows 0fr to 1fr transition, reduced-motion respected).
  - Next step: check in the browser that the slide works in both directions, and that the overdue tab and the active tab are not duplicated or lost when the panel is open or closed.
  - Files: src/pages/SupplyRequests.jsx, src/tailwind.css

## To do
- Products preview modal: exit fade is 150 ms; user asked for about 1 s. Not changed yet, waiting for confirmation.
- Verify the Supply requests changes visually in light and dark mode (not yet done).

## API/backend changes
- None. Frontend only. No files under supabase/ changed.
- Note: the branch dropdown uses `GET /supply-requests?view=active` (paged), because `/branches` is admin and logistics only.

## Notes / questions for me
- Dev server: http://localhost:5173 (kept running). Refresh the page to see the latest changes.
- Checkpoint commits only on "checkpoint"; push only on "finish".
- Should the free-text request-number search come back as a separate box? It was removed from the box when it became a branch dropdown.
