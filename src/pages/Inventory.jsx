import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FaBoxesStacked, FaChevronDown, FaCircleExclamation, FaCubesStacked, FaFileCsv, FaPlus, FaTrashCan, FaTriangleExclamation } from 'react-icons/fa6';
import { api, downloadFile, firstValidationMessage } from '../lib/api';
import { can } from '../lib/roleAccess';
import useRemote from '../lib/useRemote';
import { formatDate, formatNumber, titleCase } from '../lib/format';
import { brandColor } from '../lib/brandColors';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, Pagination, StatusBadge } from '../components/ApiUi';
import SlidingPagination from '../components/SlidingPagination';
import { useAuth } from '../context/AuthContext';

const PAGE_SIZE = 10;

// Warehouse toolbar. Date range: by stock activity (any stock movement) or by date added.
const RANGE_PERIODS = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']];
const SORT_OPTIONS = [
  ['item', 'Item'], ['item_desc', 'Item Z–A'], ['sku', 'SKU'], ['quantity_desc', 'Quantity, high'], ['quantity_asc', 'Quantity, low'],
  ['status', 'Status'], ['recent', 'Recent activity'], ['newest', 'Newest'],
];
// Product and Action are always shown; the rest can be turned off (remembered in this browser).
const COLUMN_OPTIONS = [
  ['sku', 'SKU', true], ['unit', 'Unit', true], ['quantity', 'Quantity', true], ['reorder_level', 'Reorder level', true],
  ['status', 'Status', true], ['last_activity', 'Last activity', false], ['added', 'Date added', false],
];
const COLUMNS_KEY = 'ft.warehouse.columns';
function readColumns() {
  const defaults = Object.fromEntries(COLUMN_OPTIONS.map(([key, , on]) => [key, on]));
  try {
    const saved = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}
const rangeLabel = (value) => {
  if (value === 'all') return 'All time';
  const [basis, period] = value.split(':');
  return `${RANGE_PERIODS.find(([key]) => key === period)?.[1] || period} · ${basis === 'added' ? 'added' : 'activity'}`;
};
const EMPTY_PRODUCT = { name: '', brand_id: '', category_id: '', unit: '', opening_quantity: '', reorder_level: '', critical_level: '' };

/**
 * Warehouse & Inventory. Admin and Logistics get one brand at a time: metrics,
 * search, status and the product list all read only the selected brand. Admin
 * can add products; Logistics additionally sets quantities, imports/exports CSV
 * and deletes (archives) products. Franchisees keep their own branch view.
 */
export default function Inventory() {
  const { role } = useAuth();
  return ['admin', 'logistics'].includes(role) ? <WarehouseInventory role={role} /> : <BranchInventory role={role} />;
}

function WarehouseInventory({ role }) {
  const [brandId, setBrandId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [success, setSuccess] = useState('');
  const [actionError, setActionError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState(null);
  // Admin only: the row whose Low / Critical thresholds are being set.
  const [thresholdItem, setThresholdItem] = useState(null);
  // Delete (Logistics): the row being confirmed, the request in flight and the result toast.
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [removedIds, setRemovedIds] = useState([]);
  const [toast, setToast] = useState(null);
  const deleteLock = useRef(false);
  // Toolbar: date range ("all", or "<basis>:<period>"), sort and the visible columns.
  const [range, setRange] = useState('all');
  const [sort, setSort] = useState('item');
  const [columns, setColumns] = useState(readColumns);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef(null);

  const remote = useRemote(async () => {
    const [basis, period] = range === 'all' ? [] : range.split(':');
    const response = await api.get('/inventories/grouped', {
      page,
      per_page: PAGE_SIZE,
      sort,
      ...(period ? { period, period_basis: basis } : {}),
      ...(brandId ? { brand_id: brandId } : {}),
      ...(status ? { stock_status: status } : {}),
      ...(query ? { search: query } : {}),
    });
    return response.data;
  }, [page, brandId, status, query, range, sort]);

  // The table slides in only once the new data has arrived; while loading it keeps the old rows, dimmed.
  const requestKey = `${status}|${sort}|${page}|${query}|${range}`;
  const [shownKey, setShownKey] = useState(requestKey);
  useEffect(() => {
    if (!remote.loading) setShownKey(requestKey);
  }, [remote.loading, requestKey]);

  // Customize Columns closes on a click outside it; the choice is remembered in this browser.
  useEffect(() => {
    if (!columnsOpen) return undefined;
    const close = (event) => { if (!columnsRef.current?.contains(event.target)) setColumnsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [columnsOpen]);
  const toggleColumn = (key) => {
    const next = { ...columns, [key]: !columns[key] };
    setColumns(next);
    try { window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep for this visit only */ }
  };

  const { reload } = remote;
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload({ silent: true });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [reload]);

  // Search only inside the selected brand; debounce so each keystroke is not a request.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The API picks the first active brand when none is chosen; keep the selector in sync.
  useEffect(() => {
    if (!brandId && remote.data?.brand?.id) setBrandId(String(remote.data.brand.id));
  }, [remote.data, brandId]);

  const brands = remote.data?.brands || [];
  const brand = remote.data?.brand || null;
  const items = useMemo(
    () => (remote.data?.items || (remote.data?.groups || []).flatMap((group) => group.items || [])).filter((item) => !removedIds.includes(item.id)),
    [remote.data, removedIds],
  );
  const filtered = Boolean(query || status || range !== 'all');
  const summary = remote.data?.summary;
  const meta = remote.data?.meta;
  // Admin: view, Add Product and the Low / Critical thresholds. Logistics: Adjust quantities,
  // Import CSV, Export CSV and Delete. The API enforces the same rules (routes/inventory.ts).
  const canAdd = can(role, 'inventory.add');
  const canAdjust = can(role, 'inventory.adjust');
  const canThresholds = can(role, 'inventory.thresholds');
  const canImportExport = role === 'logistics';
  const canDelete = role === 'logistics';

  // The stats always describe the whole selected brand, whatever the filters show.
  const tiles = useMemo(() => (([
    ['Total units', summary?.total_units, 'Units on hand', FaCubesStacked, 'var(--success)'],
    ['Total items:', summary?.total_items, 'Product lines in this brand', FaBoxesStacked, 'var(--accent)', 'all'],
    ['Low stocks', summary?.low, 'At or below reorder level', FaTriangleExclamation, 'var(--warning)', 'low'],
    ['Critical', summary?.critical, 'At or below critical level', FaCircleExclamation, 'var(--danger)', 'critical'],
  ])), [summary]);

  const changeBrand = (value) => {
    setBrandId(value);
    setPage(1);
    setSearch('');
    setStatus('');
  };

  useEffect(() => {
    if (!remote.loading && remote.data && items.length === 0 && page > 1) setPage(page - 1);
  }, [remote.loading, remote.data, items.length, page]);

  // The toast closes by itself.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Runs only after the confirmation modal: the row disappears at once, then the list and the
  // stats are fetched again (no page reload).
  const deleteProduct = async () => {
    if (deleteLock.current || !deleteItem) return;
    deleteLock.current = true;
    setDeleting(true);
    setActionError('');
    setSuccess('');
    const target = deleteItem;
    try {
      await api.delete('/inventories/items', { body: { inventory_ids: [target.id] } });
      setDeleteItem(null);
      setRemovedIds((ids) => [...ids, target.id]);
      setToast({ type: 'success', text: `“${target.name || 'Product'}” was deleted.` });
      await reload();
    } catch (error) {
      setDeleteItem(null);
      setToast({ type: 'error', text: firstValidationMessage(error) });
    } finally {
      deleteLock.current = false;
      setDeleting(false);
    }
  };

  const exportCsv = async () => {
    if (!brandId) return;
    setActionError('');
    try {
      await downloadFile('/warehouse/export', { brand_id: brandId }, 'warehouse.csv');
    } catch (error) {
      setActionError(firstValidationMessage(error));
    }
  };

  return (
    <div className="page-container w-full m-[0_auto] p-[clamp(10px,_1.2vw,_16px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] inventory-page [&_.filter-chips]:flex [&_.filter-chips]:flex-wrap [&_.filter-chips]:gap-2 [&_td_small]:block [&_td_small]:mt-[2px] [&_td_small]:text-muted later-2:[&_td_small]:text-[9px]">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <section className="flex flex-wrap gap-[10px]" aria-label="Warehouse summary">
          {tiles.map(([label, value, caption, Icon, tone, filterValue]) => {
            const body = (
              <>
                <span aria-hidden="true" className="relative z-1 flex-none grid place-items-center w-[34px] h-[34px] rounded-[10px] text-[15px] [color:var(--tile-tone)]"><Icon /></span>
                <div className="relative z-1 flex flex-col min-w-0 text-left">
                  <span className="text-text-secondary text-[12px] font-[600] whitespace-nowrap">{label}</span>
                  <strong className="text-text text-[20px] font-[800] leading-[1.1] tabular-nums">{formatNumber(value ?? 0)}</strong>
                </div>
              </>
            );
            const cardClass = 'relative isolate overflow-hidden flex items-center gap-3 min-w-[180px] p-[9px_14px] border border-line rounded-[10px] [background:var(--panel)] after:content-[""] after:absolute after:-top-[34px] after:-right-[34px] after:w-[84px] after:h-[84px] after:rounded-full after:[background:radial-gradient(circle_at_30%_30%,_color-mix(in_srgb,_var(--tile-tone)_10%,_transparent),_color-mix(in_srgb,_var(--tile-tone)_3%,_transparent)_70%)] after:-z-10 after:[transition:transform_.35s_cubic-bezier(.2,_.8,_.2,_1)] hover:after:[transform:translate(-6px,_6px)_scale(1.12)]';
            if (!filterValue) {
              return <article key={label} title={caption} className={cardClass} style={{ '--tile-tone': tone }}>{body}</article>;
            }
            const active = filterValue === 'all' ? !status : status === filterValue;
            return (
              <button
                key={label}
                type="button"
                title={`${caption} — click to ${active ? 'clear the filter' : `show ${titleCase(filterValue)} items`}`}
                aria-pressed={active}
                onClick={() => { setStatus(active || filterValue === 'all' ? '' : filterValue); setPage(1); }}
                className={`${cardClass} cursor-pointer [transition:border-color_.16s_ease,_box-shadow_.16s_ease] hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ${active ? 'border-accent [box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_18%,_transparent)]' : ''}`}
                style={{ '--tile-tone': tone }}
              >
                {body}
              </button>
            );
          })}
        </section>
        <div className="flex flex-wrap items-center gap-3 ml-auto">
          {canImportExport && (
            <>
              <button type="button" className="inline-flex items-center justify-center gap-2 min-h-[40px] p-[0_18px] border border-line-strong rounded-[8px] [background:var(--panel)] text-text text-[13px] font-[750] whitespace-nowrap [transition:border-color_.16s_ease,_background_.16s_ease] hover:border-accent hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]" onClick={() => setImportOpen(true)}>Import CSV</button>
              <button type="button" className="inline-flex items-center justify-center gap-2 min-h-[40px] p-[0_18px] border border-line-strong rounded-[8px] [background:var(--panel)] text-text text-[13px] font-[750] whitespace-nowrap [transition:border-color_.16s_ease,_background_.16s_ease] hover:border-accent hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]" onClick={() => void exportCsv()}>Export CSV</button>
            </>
          )}
          {canAdd && (
            <button type="button" className="primary-button inline-flex items-center justify-center gap-2 min-h-[40px] p-[0_18px] border border-transparent rounded-[8px] text-[#fff] text-[13px] font-[760] whitespace-nowrap [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_10px_24px_color-mix(in_srgb,_var(--accent)_22%,_transparent)] [transition:filter_.16s_ease] hover:[filter:saturate(1.1)_brightness(1.05)]" onClick={() => { setActionError(''); setAddOpen(true); }}>
              <FaPlus aria-hidden="true" /> Add Product
            </button>
          )}
        </div>
      </div>
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>

      <div className="flex flex-wrap items-center gap-2 mb-3 p-[6px] border border-line rounded-[8px] [background:color-mix(in_srgb,_var(--panel)_92%,_transparent)]" role="toolbar" aria-label="Warehouse filters">
        <select className="min-h-[36px] p-[0_12px] border border-line rounded-[8px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[11px] font-[600] tracking-[.04em] uppercase [outline:none] cursor-pointer hover:border-line-strong focus:border-accent w-[120px]" value={brandId} onChange={(event) => changeBrand(event.target.value)} aria-label="Filter by brand">
          {brands.length === 0 && <option value="">Loading brands…</option>}
          {brands.map((option) => <option key={option.id} value={option.id}>{option.name.toUpperCase()}</option>)}
        </select>
        <select className="min-h-[36px] p-[0_12px] border border-line rounded-[8px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[11px] font-[600] tracking-[.04em] uppercase [outline:none] cursor-pointer hover:border-line-strong focus:border-accent w-[176px]" value={range} onChange={(event) => { setRange(event.target.value); setPage(1); }} aria-label="Date range">
          <option value="all">All time</option>
          <optgroup label="Stock activity">
            {RANGE_PERIODS.map(([key]) => <option key={`activity-${key}`} value={`activity:${key}`}>{rangeLabel(`activity:${key}`)}</option>)}
          </optgroup>
          <optgroup label="Date added">
            {RANGE_PERIODS.map(([key]) => <option key={`added-${key}`} value={`added:${key}`}>{rangeLabel(`added:${key}`)}</option>)}
          </optgroup>
        </select>
        <select className="min-h-[36px] p-[0_12px] border border-line rounded-[8px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[11px] font-[600] tracking-[.02em] [outline:none] cursor-pointer hover:border-line-strong focus:border-accent w-[158px]" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }} aria-label="Sort by">
          {SORT_OPTIONS.map(([key, label]) => <option key={key} value={key}>{`Sort By: (${label.toUpperCase()})`}</option>)}
        </select>
        <div className="relative" ref={columnsRef}>
          <button
            type="button"
            className="min-h-[36px] p-[0_12px] border border-line rounded-[8px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[11px] font-[600] tracking-[.02em] [outline:none] cursor-pointer hover:border-line-strong focus:border-accent inline-flex items-center gap-[10px]"
            onClick={() => setColumnsOpen((open) => !open)}
            aria-expanded={columnsOpen}
            aria-haspopup="true"
          >
            Customize Columns <FaChevronDown aria-hidden="true" className="text-[10px]" />
          </button>
          {columnsOpen && (
            <div className="absolute left-0 top-[calc(100%_+_6px)] z-[30] min-w-[200px] grid gap-[2px] p-[8px] border border-line-strong rounded-[10px] [background:var(--panel)] [box-shadow:var(--shadow-md)]" role="group" aria-label="Visible columns">
              {COLUMN_OPTIONS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-[9px] p-[6px_8px] rounded-[6px] text-text text-[13px] cursor-pointer hover:[background:var(--hover)]">
                  <input type="checkbox" className="[accent-color:var(--accent)]" checked={Boolean(columns[key])} onChange={() => toggleColumn(key)} />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
        <input
          type="search"
          className="flex-[1_1_160px] min-w-[140px] min-h-[36px] p-[0_18px] border border-line-strong rounded-[999px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[12px] [outline:none] placeholder:uppercase placeholder:tracking-[.06em] placeholder:text-[color:var(--placeholder,_var(--muted))] focus:border-accent"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          aria-label={`Search ${brand?.name || 'this brand'} products`}
        />
        <select className="min-h-[36px] p-[0_12px] border border-line rounded-[8px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[11px] font-[600] tracking-[.04em] uppercase [outline:none] cursor-pointer hover:border-line-strong focus:border-accent w-[150px]" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Filter stock status">
          <option value="">All items/status</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
          <option value="critical">Critical</option>
        </select>
      </div>

      <section key={shownKey} className={`${remote.loading ? 'opacity-45 [transition:opacity_.18s_ease]' : 'inv-table-slide'} data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]`}>
        {remote.loading && !remote.data ? <LoadingState /> : !items.length ? (
          <EmptyState
            label={filtered ? 'No products match the current filters.' : `No products under ${brand?.name || 'this brand'}.`}
            detail={filtered ? 'Choose All time, clear the search or pick another status.' : (canAdd ? 'Add a product, or choose another brand from the filter.' : 'Choose another brand from the filter.')}
          />
        ) : (
          <>
            <p className="text-muted later:m-0 p-[12px_18px] border-b border-b-line later:text-[13px]">{meta?.total ?? items.length} on this page · <strong className="font-[800] uppercase" style={{ color: brandColor(brand?.name) }}>{brand?.name || 'Brand'}</strong></p>
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer readable-list [&_table]:text-[14px] [&_th]:text-[12px] [&_th]:tracking-[.06em] [&_td_strong]:text-[15px] [&_td_strong]:font-[600] [&_td_small]:text-[13px] [&_td_button]:text-[13px]">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    {columns.sku && <th>SKU</th>}
                    {columns.unit && <th>Unit</th>}
                    {columns.quantity && <th>Quantity</th>}
                    {columns.reorder_level && <th>Reorder level</th>}
                    {columns.status && <th>Status</th>}
                    {columns.last_activity && <th>Last activity</th>}
                    {columns.added && <th>Date added</th>}
                    {(canThresholds || canAdjust || canDelete) && <th>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.name || '—'}</strong><small>{item.category || ''}</small></td>
                      {columns.sku && <td>{item.sku || '—'}</td>}
                      {columns.unit && <td>{item.unit || '—'}</td>}
                      {columns.quantity && <td><strong>{formatNumber(item.quantity)}</strong></td>}
                      {columns.reorder_level && <td>{formatNumber(item.reorder_level)}</td>}
                      {columns.status && <td><StatusBadge value={item.status} /></td>}
                      {columns.last_activity && <td>{item.last_activity_at ? formatDate(item.last_activity_at, true) : '—'}</td>}
                      {columns.added && <td>{item.added_at ? formatDate(item.added_at) : '—'}</td>}
                      {(canThresholds || canAdjust || canDelete) && (
                        <td>
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            {canThresholds && (
                              <button
                                type="button"
                                className="min-w-[72px]"
                                onClick={() => { setActionError(''); setSuccess(''); setThresholdItem(item); }}
                                title={`Set the Low and Critical thresholds for ${item.name || 'this item'} (Admin only)`}
                              >
                                Adjust
                              </button>
                            )}
                            {canAdjust && (
                              <button type="button" className="min-w-[72px]" onClick={() => { setActionError(''); setSuccess(''); setAdjustItem(item); }}>
                                Adjust
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                className="min-w-[72px] border-[rgba(255,_107,_107,_.38)]! text-[#ff9ca3]! [background:rgba(255,_107,_107,_.08)]! hover:[background:rgba(255,_107,_107,_.16)]! hover:border-[rgba(255,_107,_107,_.6)]!"
                                onClick={() => { setActionError(''); setSuccess(''); setDeleteItem(item); }}
                                aria-label={`Delete ${item.name || 'product'}`}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <SlidingPagination meta={meta} onPage={setPage} />
          </>
        )}
      </section>

      {addOpen && (
        <AddProductModal
          role={role}
          brands={brands}
          defaultBrandId={brandId}
          onClose={() => setAddOpen(false)}
          onSaved={async (name) => {
            setAddOpen(false);
            setActionError('');
            setSuccess(`“${name}” was added to warehouse inventory.`);
            await reload();
          }}
        />
      )}

      {importOpen && (
        <ImportCsvModal
          brand={brand}
          onClose={() => setImportOpen(false)}
          onImported={async (result = {}) => {
            setImportOpen(false);
            setActionError('');
            const updated = result.updated || 0;
            const unchanged = result.unchanged || 0;
            setSuccess(
              updated === 0 && unchanged > 0
                ? 'Nothing to change: every row already matches the warehouse quantity.'
                : `${updated} product(s) updated from the CSV import.` +
                  (unchanged > 0 ? ` ${unchanged} row(s) already matched and were left unchanged.` : ''),
            );
            await reload();
          }}
        />
      )}

      {deleteItem && (
        <Modal
          title="Delete product"
          onClose={() => (deleting ? null : setDeleteItem(null))}
          size="small"
          footer={(
            <>
              <button type="button" onClick={() => setDeleteItem(null)} disabled={deleting}>Cancel</button>
              <button
                type="button"
                className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)]"
                onClick={() => void deleteProduct()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </>
          )}
        >
          <p className="m-0 text-text">Delete {deleteItem.name || 'this product'}? This cannot be undone.</p>
        </Modal>
      )}

      {toast && (
        <div
          className={`fixed right-[20px] bottom-[20px] z-[1000] max-w-[min(420px,_calc(100vw_-_40px))] p-[11px_14px] rounded-[12px] border text-[13px] leading-[1.45] [box-shadow:var(--shadow-md)] [animation:noticeIn_.25s_ease_both] ${toast.type === 'success' ? 'border-[rgba(69,_217,_145,_.45)] text-[#45d991] [background:#0f1f19]' : 'border-[rgba(255,_107,_107,_.45)] text-[#ff9ca3] [background:#22151a]'}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
        >
          {toast.text}
        </div>
      )}

      {adjustItem && (
        <AdjustQuantityModal
          item={adjustItem}
          onClose={() => setAdjustItem(null)}
          onSaved={async () => {
            setAdjustItem(null);
            setActionError('');
            setSuccess('Quantity adjusted.');
            await reload();
          }}
        />
      )}

      {thresholdItem && (
        <ThresholdModal
          item={thresholdItem}
          onClose={() => setThresholdItem(null)}
          onSaved={async () => {
            setThresholdItem(null);
            setActionError('');
            setSuccess(`Thresholds updated for “${thresholdItem.name || 'item'}”.`);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function AddProductModal({ role, brands, defaultBrandId, onClose, onSaved }) {
  const [form, setForm] = useState({ ...EMPTY_PRODUCT, brand_id: defaultBrandId || '' });
  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newUnit, setNewUnit] = useState('');
  const [showNewUnit, setShowNewUnit] = useState(false);
  const [deletingCategoryId, setDeletingCategoryId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const showOpening = role === 'logistics';
  const canDeleteCategory = role === 'admin';

  const loadCategories = async (brandId) => {
    try {
      const response = await api.get('/product-categories', brandId ? { brand_id: brandId } : {});
      setCategories(response.data || []);
    } catch {
      setCategories([]);
    }
  };

  useEffect(() => {
    api.get('/units')
      .then((response) => setUnits(response.data || []))
      .catch(() => setUnits([]));
  }, []);

  useEffect(() => {
    if (form.brand_id) void loadCategories(form.brand_id);
  }, [form.brand_id]);

  const brandCategories = categories.filter((category) => String(category.brand_id) === String(form.brand_id));

  const addCategory = async () => {
    setError('');
    try {
      const response = await api.post('/product-categories', {
        brand_id: Number(form.brand_id),
        name: newCategory,
      });
      setCategories((rows) => [...rows, response.data]);
      setForm((current) => ({ ...current, category_id: String(response.data.id) }));
      setNewCategory('');
      setShowNewCategory(false);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  const addUnit = async () => {
    setError('');
    try {
      const response = await api.post('/units', { name: newUnit });
      setUnits((rows) => [...rows, response.data]);
      setForm((current) => ({ ...current, unit: response.data.name }));
      setNewUnit('');
      setShowNewUnit(false);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  // Delete is allowed only while the category has no products (the API blocks it otherwise).
  const deleteCategory = async (category) => {
    setError('');
    setDeletingCategoryId(category.id);
    try {
      await api.delete(`/product-categories/${category.id}`);
      setCategories((rows) => rows.filter((row) => row.id !== category.id));
      setForm((current) => (String(current.category_id) === String(category.id) ? { ...current, category_id: '' } : current));
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setDeletingCategoryId(null);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const name = form.name.trim();
      await api.post('/inventories/items', {
        name,
        brand_id: Number(form.brand_id),
        category_id: Number(form.category_id),
        unit: form.unit,
        opening_quantity: showOpening ? Number(form.opening_quantity || 0) : 0,
        reorder_level: Number(form.reorder_level || 0),
        critical_level: Number(form.critical_level || 0),
      });
      await onSaved(name);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add a warehouse product"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="add-product-form" disabled={saving}>
            {saving ? 'Adding…' : 'Add product'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="add-product-form" className="wh-product-form form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        <Field label="Product name" required>
          <input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Caramel Syrup" />
        </Field>
        <Field label="Brand" required>
          <select required value={form.brand_id} onChange={(e) => setForm({ ...form, brand_id: e.target.value, category_id: '' })}>
            <option value="">Select a brand</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </Field>
        <Field label="Unit" required>
          <select required value={form.unit} onChange={(e) => {
            if (e.target.value === '__add') { setShowNewUnit(true); return; }
            setForm({ ...form, unit: e.target.value });
          }}>
            <option value="">Select a unit</option>
            {units.map((unit) => <option key={unit.id} value={unit.name}>{unit.name}</option>)}
            <option value="__add">+ Add Unit</option>
          </select>
        </Field>
        <Field label="Category" required hint={form.brand_id ? 'Categories belong to the selected brand.' : 'Choose a brand first.'}>
          <select
            required
            disabled={!form.brand_id}
            value={form.category_id}
            onChange={(e) => {
              if (e.target.value === '__add') { setShowNewCategory(true); return; }
              setForm({ ...form, category_id: e.target.value });
            }}
          >
            <option value="">{form.brand_id ? 'Select a category' : 'Choose a brand first'}</option>
            {brandCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            <option value="__add">+ Add Category</option>
          </select>
        </Field>
        {showNewCategory && (
          <Field label="New category" hint="Letters, spaces, / and - only.">
            <div className="flex gap-2 items-center later-2:[&_input]:flex-[1_1_auto] [&_input]:min-w-0">
              <input value={newCategory} maxLength={50} onChange={(e) => setNewCategory(e.target.value)} placeholder="e.g. Syrup / Flavoring" />
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => void addCategory()} disabled={!newCategory.trim()}>Save category</button>
            </div>
          </Field>
        )}
        {showNewUnit && (
          <Field label="New unit" hint="Letters only.">
            <div className="flex gap-2 items-center later-2:[&_input]:flex-[1_1_auto] [&_input]:min-w-0">
              <input value={newUnit} maxLength={20} onChange={(e) => setNewUnit(e.target.value)} placeholder="e.g. bottle" />
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => void addUnit()} disabled={!newUnit.trim()}>Save unit</button>
            </div>
          </Field>
        )}
        {showOpening && (
          <Field label="Opening quantity" hint="Logistics only. The product starts at this quantity.">
            <input type="number" min="0" step="any" value={form.opening_quantity} onChange={(e) => setForm({ ...form, opening_quantity: e.target.value })} />
          </Field>
        )}
        <Field label="Re-Order Level">
          <input type="number" min="0" step="any" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: e.target.value })} />
        </Field>
        <Field label="Critical">
          <input type="number" min="0" step="any" value={form.critical_level} onChange={(e) => setForm({ ...form, critical_level: e.target.value })} />
        </Field>
        {form.brand_id && brandCategories.length > 0 && (
          <details className="inventory-categories col-span-full border border-line rounded-[12px] [background:var(--surface-subtle)] [&>summary]:flex [&>summary]:items-center [&>summary]:gap-2 [&>summary]:p-[11px_14px] [&>summary]:rounded-[12px] [&>summary]:text-text [&>summary]:text-[13px] [&>summary]:font-[700] [&>summary]:[list-style:none] [&>summary]:cursor-pointer [&>summary::-webkit-details-marker]:hidden [&>summary:hover]:[background:var(--hover)] [&>summary:focus-visible]:[outline:2px_solid_var(--accent)] [&>summary:focus-visible]:[outline-offset:2px] [&>summary_small]:min-w-[22px] [&>summary_small]:p-[1px_7px] [&>summary_small]:border [&>summary_small]:border-line [&>summary_small]:rounded-[999px] [&>summary_small]:text-muted later-4:[&>summary_small]:text-[12px] [&>summary_small]:text-center">
            <summary>
              <span>Brand categories</span>
              <small>{brandCategories.length}</small>
              <FaChevronDown className="ml-auto text-muted text-[12px] [transition:transform_.16s_ease] [.inventory-categories[open]_&]:[transform:rotate(180deg)]" aria-hidden="true" />
            </summary>
            <ul className="grid gap-[6px] m-0 p-0 [list-style:none] [&_li]:flex [&_li]:items-center [&_li]:gap-2 [&_li]:min-h-[34px] [&_li]:p-[0_4px_0_10px] [&_li]:border [&_li]:border-line [&_li]:rounded-[8px] [&_li]:[background:var(--surface-subtle)] [&_li]:text-[11px] [&_li>span]:flex-[1_1_auto] [&_li>span]:min-w-0 [&_li>span]:overflow-hidden [&_li>span]:text-ellipsis [&_li>span]:whitespace-nowrap [&_li>span]:text-text [&_li>small]:flex-[0_0_auto] [&_li>small]:text-muted later:[&_li>small]:text-[10px] [.inventory-categories_&]:max-h-[220px] [.inventory-categories_&]:overflow-y-auto [.inventory-categories_&]:p-[0_14px] [.inventory-categories_&_li]:min-h-[40px] [.inventory-categories_&_li]:p-[4px_6px_4px_12px] [.inventory-categories_&_li]:text-[13px] [.inventory-categories_&_li>small]:text-[12px]">
              {brandCategories.map((category) => {
                const used = Number(category.products_count || 0);
                return (
                  <li key={category.id}>
                    <span>{category.name}</span>
                    {used > 0 && <small>{used} product{used === 1 ? '' : 's'}</small>}
                    {canDeleteCategory && (
                      <button
                        type="button"
                        className="min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] rounded-[10px] text-[13px] font-[650] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] [&.small]:min-h-[32px] [&.small]:p-[0_10px] [&.small]:text-[12px] border later:border-[color:color-mix(in_srgb,_var(--danger)_38%,_transparent)] later:text-danger-text later:[background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] [&:hover:not(:disabled)]:border-[color:color-mix(in_srgb,_var(--danger)_65%,_transparent)] [&:hover:not(:disabled)]:[background:color-mix(in_srgb,_var(--danger)_18%,_transparent)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]"
                        onClick={() => void deleteCategory(category)}
                        disabled={used > 0 || deletingCategoryId === category.id}
                        title={used > 0 ? 'In use: a category can be deleted only while no product uses it.' : 'Delete category'}
                      >
                        <FaTrashCan aria-hidden="true" /> {deletingCategoryId === category.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <small className="block p-[10px_14px_12px] text-muted text-[12px]">
              {canDeleteCategory ? 'A category can be deleted only while no product uses it.' : 'Only Admin may delete a category.'}
            </small>
          </details>
        )}
      </form>
    </Modal>
  );
}

// Adjust Inventory: large type, two big direction cards, a stepper with quick chips and a
// live before/after summary. The API call and props are unchanged.
const ADJUST_STEPPER_CLASS = 'grid h-[46px] w-[46px] flex-none place-items-center rounded-[12px] border-2 border-line-strong [background:var(--input-bg)] text-[19px] font-[700] leading-none text-text cursor-pointer [transition:border-color_.16s_ease,_background_.16s_ease,_transform_.16s_ease] hover:border-accent hover:[background:var(--hover)] active:[transform:scale(.97)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]';
const ADJUST_CHIP_CLASS = 'min-h-[32px] rounded-full border border-line-strong [background:transparent] p-[0_12px] text-[12px] font-[650] text-text-secondary cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text hover:border-accent hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.45] disabled:cursor-not-allowed';

function AdjustQuantityModal({ item, onClose, onSaved }) {
  const [direction, setDirection] = useState('increase');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const unit = item.unit || '';
  const current = Number(item.quantity) || 0;
  const numeric = Number(quantity);
  const validQuantity = Number.isFinite(numeric) && numeric > 0;
  const overStock = direction === 'decrease' && validQuantity && numeric - current > 1e-9;
  const invalid = (quantity !== '' && !validQuantity) || overStock;
  const delta = validQuantity ? (direction === 'increase' ? numeric : -numeric) : 0;
  const resulting = current + delta;
  const ready = validQuantity && resulting >= 0 && !saving;
  const toneClass = delta > 0 ? 'text-[color:var(--success-text)]' : delta < 0 ? 'text-[color:var(--danger-text)]' : 'text-text';
  const message = overStock
    ? `You only have ${formatNumber(current, 2)} ${unit}. Stock can't go below zero.`
    : quantity !== '' && !validQuantity
      ? 'Must be greater than zero.'
      : validQuantity ? 'Looks good.' : '';

  const step = (amount) => {
    const next = Math.max(0, Math.round(((validQuantity ? numeric : 0) + amount) * 1000) / 1000);
    setQuantity(next > 0 ? String(next) : '');
  };
  const useAll = () => {
    setDirection('decrease');
    setQuantity(current > 0 ? String(current) : '');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/inventories/${item.id}/quantity`, {
        direction,
        quantity: numeric,
        note: note.trim() || null,
      });
      await onSaved();
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const options = [
    {
      value: 'increase', label: 'Add stock', hint: 'New delivery or recount', icon: '+',
      selectedClass: 'border-[color:var(--success)]! [background:color-mix(in_srgb,_var(--success)_15%,_transparent)]!',
      iconClass: '[background:var(--success)]! border-[color:var(--success)]! text-[#04160f]!',
    },
    {
      value: 'decrease', label: 'Remove stock', hint: 'Used, spilled or expired', icon: '−',
      selectedClass: 'border-[color:var(--danger)]! [background:color-mix(in_srgb,_var(--danger)_15%,_transparent)]!',
      iconClass: '[background:var(--danger)]! border-[color:var(--danger)]! text-[#1d0509]!',
    },
  ];

  return (
    <Modal
      title={<span className="block text-[20px] font-[750] leading-[1.25] tracking-[-.01em] text-text">Adjust {item.name || 'quantity'}</span>}
      onClose={onClose}
      size="small"
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[42px]! inline-flex items-center justify-center gap-2 rounded-[12px]! border-2! border-line-strong! [background:transparent]! p-[0_16px]! text-[14px]! font-[700]! text-text-secondary! cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text! hover:border-accent! hover:[background:var(--hover)]! focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[520px]:flex-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="adjust-quantity-form"
            disabled={!ready}
            className={`min-h-[42px]! inline-flex items-center justify-center gap-2 rounded-[12px]! border-2! border-transparent! p-[0_16px]! text-[14px]! font-[700]! cursor-pointer [transition:filter_.16s_ease,_opacity_.16s_ease] enabled:hover:[filter:brightness(1.06)] disabled:opacity-[.55]! disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[520px]:flex-1 ${direction === 'increase' ? '[background:var(--success)]! text-[#04160f]!' : '[background:var(--danger)]! text-[#1d0509]!'}`}
          >
            {saving ? 'Saving…' : direction === 'increase' ? 'Add stock' : 'Remove stock'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>

      <div
        aria-live="polite"
        aria-atomic="true"
        className="mb-[16px] rounded-[14px] border border-line [background:var(--surface-subtle)] p-[14px_16px] max-[520px]:p-[13px_14px]"
      >
        <div className="flex items-stretch gap-3 max-[520px]:flex-col max-[520px]:gap-2">
          <div className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-[600] text-muted">Current stock</span>
            <strong className="mt-1 block text-[26px] font-[800] leading-none tabular-nums text-text">
              {formatNumber(current, 2)} {unit}
            </strong>
          </div>
          <span aria-hidden="true" className="self-center flex-none text-[16px] leading-none text-muted max-[520px]:hidden">→</span>
          <div className="min-w-0 flex-1 text-right max-[520px]:text-left">
            <span className="block text-[12.5px] font-[600] text-muted">New stock</span>
            <strong className={`mt-1 block text-[26px] font-[800] leading-none tabular-nums ${toneClass}`}>
              {formatNumber(resulting, 2)} {unit}
            </strong>
            <span className={`mt-1 block text-[12px] font-[600] ${toneClass}`}>
              {delta === 0 ? 'No change yet' : `${delta > 0 ? '+' : ''}${formatNumber(delta, 2)} ${unit} from today`}
            </span>
          </div>
        </div>
      </div>

      <form id="adjust-quantity-form" onSubmit={submit} className="grid gap-0">
        <fieldset className="mb-[16px] min-w-0 border-0! p-0">
          <legend className="mb-2 p-0 text-[14px] font-[700] leading-[1.3] text-text">
            What do you want to do? <span aria-hidden="true" className="text-[color:var(--danger-text)]">*</span>
          </legend>
          <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
            {options.map((option) => {
              const selected = direction === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex min-h-[62px] cursor-pointer items-center gap-[10px] rounded-[12px] border-2 p-[10px_12px] [transition:border-color_.16s_ease,_background_.16s_ease] focus-within:[outline:2px_solid_var(--accent)] focus-within:[outline-offset:2px] ${selected ? option.selectedClass : 'border-line [background:var(--input-bg)] hover:border-line-strong'}`}
                >
                  <input
                    type="radio"
                    name="adjust-direction"
                    value={option.value}
                    checked={selected}
                    onChange={() => setDirection(option.value)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={`grid h-[34px] w-[34px] flex-none place-items-center rounded-full border-2 text-[17px] font-[800] leading-none ${selected ? option.iconClass : 'border-line text-muted'}`}
                  >
                    {option.icon}
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-[14px] font-[700] leading-[1.2] text-text">{option.label}</strong>
                    <span className="mt-[2px] block text-[11.5px] leading-[1.3] text-muted">{option.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mb-[16px]">
          <label htmlFor="adjust-quantity" className="mb-2 block text-[14px] font-[700] leading-[1.3] text-text">
            Quantity <span className="text-[12px] font-[600] text-muted">({unit})</span> <span aria-hidden="true" className="text-[color:var(--danger-text)]">*</span>
          </label>
          <div className="flex items-stretch gap-2">
            <button type="button" className={ADJUST_STEPPER_CLASS} onClick={() => step(-1)} aria-label="Decrease quantity by 1">−</button>
            <input
              id="adjust-quantity"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="0"
              aria-invalid={invalid || undefined}
              className={`min-h-[46px] w-full min-w-0 flex-1 rounded-[12px] border-2 [background:var(--input-bg)] p-[0_12px] text-center text-[20px] font-[800] leading-none tabular-nums text-text [appearance:textfield] [outline:none] [transition:border-color_.16s_ease,_box-shadow_.16s_ease] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none placeholder:text-placeholder focus:border-[color:var(--accent)] focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_18%,_transparent)] ${invalid ? 'border-[color:var(--danger)]' : 'border-input-line'}`}
            />
            <button type="button" className={ADJUST_STEPPER_CLASS} onClick={() => step(1)} aria-label="Increase quantity by 1">+</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-[6px]">
            {[1, 5, 10].map((amount) => (
              <button key={amount} type="button" className={ADJUST_CHIP_CLASS} onClick={() => setQuantity(String(amount))}>
                +{amount}
              </button>
            ))}
            <button type="button" className={ADJUST_CHIP_CLASS} onClick={useAll} disabled={current <= 0}>
              All {formatNumber(current, 2)} {unit}
            </button>
          </div>
          {message && (
            <p
              role={invalid ? 'alert' : undefined}
              className={`mt-2 text-[12px] font-[600] leading-[1.45] ${invalid ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--success-text)]'}`}
            >
              {message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="adjust-note" className="mb-2 block text-[14px] font-[700] leading-[1.3] text-text">
            Note <span className="text-[12px] font-[600] text-muted">(optional)</span>
          </label>
          <textarea
            id="adjust-note"
            maxLength={255}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is the quantity changing?"
            className="min-h-[76px] w-full rounded-[12px] border-2 border-input-line [background:var(--input-bg)] p-[10px_12px] text-[13px] leading-[1.5] text-text [outline:none] [transition:border-color_.16s_ease,_box-shadow_.16s_ease] placeholder:text-placeholder focus:border-[color:var(--accent)] focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_18%,_transparent)]"
          />
          <div className="mt-1 text-right text-[11.5px] text-muted">{note.length} / 255</div>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Adjust thresholds (Admin only): the Low and Critical levels that decide a warehouse row's
 * status — Low at or below the reorder level, Critical at or below the critical level.
 * Saves through PATCH /inventories/:id/thresholds.
 */
function ThresholdModal({ item, onClose, onSaved }) {
  const [low, setLow] = useState(String(Number(item.reorder_level ?? 0)));
  const [critical, setCritical] = useState(String(Number(item.critical_level ?? 0)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const unit = item.unit || '';
  const onHand = Number(item.quantity) || 0;
  const lowValue = low.trim() === '' ? NaN : Number(low);
  const criticalValue = critical.trim() === '' ? NaN : Number(critical);
  const validLow = Number.isFinite(lowValue) && lowValue >= 0;
  const validCritical = Number.isFinite(criticalValue) && criticalValue >= 0;
  const ordered = validLow && validCritical && criticalValue <= lowValue;
  const ready = ordered && !saving;
  const preview = ordered ? (onHand <= criticalValue ? 'critical' : onHand <= lowValue ? 'low' : 'normal') : null;
  const message = !validLow || !validCritical
    ? 'Both levels must be zero or more.'
    : !ordered
      ? `Critical (${formatNumber(criticalValue, 2)}) cannot be above Low (${formatNumber(lowValue, 2)}).`
      : null;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError('');
    try {
      await api.patch(`/inventories/${item.id}/thresholds`, { reorder_level: lowValue, critical_level: criticalValue });
      await onSaved();
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = 'grid gap-[6px] rounded-[14px] border border-line [background:var(--surface-subtle)] p-[12px_14px]';
  const inputClass = 'min-h-[46px] w-full min-w-0 rounded-[12px] border-2 border-input-line [background:var(--input-bg)] p-[0_12px] text-[18px] font-[800] leading-none tabular-nums text-text [appearance:textfield] [outline:none] [transition:border-color_.16s_ease,_box-shadow_.16s_ease] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:border-[color:var(--accent)] focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_18%,_transparent)]';

  return (
    <Modal
      title={<span className="block text-[20px] font-[750] leading-[1.25] tracking-[-.01em] text-text">Adjust thresholds · {item.name || 'item'}</span>}
      onClose={onClose}
      size="small"
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="min-h-[42px]! inline-flex items-center justify-center gap-2 rounded-[12px]! border-2! border-line-strong! [background:transparent]! p-[0_16px]! text-[14px]! font-[700]! text-text-secondary! cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text! hover:border-accent! hover:[background:var(--hover)]! focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[520px]:flex-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="threshold-form"
            disabled={!ready}
            className="min-h-[42px]! inline-flex items-center justify-center gap-2 rounded-[12px]! border-2! border-transparent! p-[0_16px]! text-[14px]! font-[700]! text-[#fff]! cursor-pointer [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]! [transition:filter_.16s_ease,_opacity_.16s_ease] enabled:hover:[filter:brightness(1.06)] disabled:opacity-[.55]! disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[520px]:flex-1"
          >
            {saving ? 'Saving…' : 'Save thresholds'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <p className="m-0 mb-[12px] text-[12.5px] leading-[1.5] text-muted">
        Only Admin can set warehouse thresholds. A row reads{' '}
        <strong className="text-[color:var(--warning-text)]">Low</strong> at or below the low level, and{' '}
        <strong className="text-[color:var(--danger-text)]">Critical</strong> at or below the critical level.
      </p>

      <div className="mb-[14px] flex items-center justify-between gap-3 rounded-[14px] border border-line [background:var(--surface-subtle)] p-[12px_16px]" aria-live="polite" aria-atomic="true">
        <div className="min-w-0">
          <span className="block text-[12.5px] font-[600] text-muted">On hand</span>
          <strong className="mt-1 block text-[22px] font-[800] leading-none tabular-nums text-text">{formatNumber(onHand, 2)} {unit}</strong>
        </div>
        <div className="min-w-0 text-right">
          <span className="block text-[12.5px] font-[600] text-muted">Status with these levels</span>
          <span className="mt-1 inline-flex">
            {preview ? <StatusBadge value={preview} /> : <span className="text-[13px] text-muted">—</span>}
          </span>
        </div>
      </div>

      <form id="threshold-form" onSubmit={submit} className="grid gap-[12px]">
        <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
          <label htmlFor="threshold-low" className={fieldClass}>
            <span className="flex items-center gap-[7px] text-[14px] font-[700] leading-[1.3] text-text">
              <span aria-hidden="true" className="h-[8px] w-[8px] flex-none rounded-full [background:var(--warning)]" />
              Low
            </span>
            <span className="text-[11.5px] leading-[1.4] text-muted">At or below this, the item shows Low.</span>
            <input
              id="threshold-low"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={low}
              onChange={(event) => setLow(event.target.value)}
              aria-invalid={!validLow && low.trim() !== '' ? true : undefined}
              className={inputClass}
            />
          </label>
          <label htmlFor="threshold-critical" className={fieldClass}>
            <span className="flex items-center gap-[7px] text-[14px] font-[700] leading-[1.3] text-text">
              <span aria-hidden="true" className="h-[8px] w-[8px] flex-none rounded-full [background:var(--danger)]" />
              Critical
            </span>
            <span className="text-[11.5px] leading-[1.4] text-muted">At or below this, the item shows Critical.</span>
            <input
              id="threshold-critical"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={critical}
              onChange={(event) => setCritical(event.target.value)}
              aria-invalid={!validCritical && critical.trim() !== '' ? true : undefined}
              className={inputClass}
            />
          </label>
        </div>
        {message && (
          <p role="alert" className="m-0 text-[12px] font-[600] leading-[1.45] text-[color:var(--danger-text)]">{message}</p>
        )}
      </form>
    </Modal>
  );
}

const IMPORT_STATUS_LABELS = { valid: 'Valid', error: 'Error', duplicate: 'Duplicate', skipped: 'Skipped' };
const IMPORT_MODES = {
  set: { label: 'Set quantity', help: 'Replaces the current quantity with the value in the file.' },
  add: { label: 'Add to quantity', help: 'Adds the value in the file to the current quantity.' },
};

/**
 * Update-only warehouse import for one brand. The file is read again at every
 * Preview (so an edited or re-chosen file is never stale); changing the file or
 * the mode clears the preview, and Apply stays off until a clean preview:
 * no errors, no duplicates, at least one row with a quantity.
 */
function ImportCsvModal({ brand, onClose, onImported }) {
  const [mode, setMode] = useState('set');
  const [file, setFile] = useState(null);
  const [previewed, setPreviewed] = useState(null); // { csv, data }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const preview = previewed?.data || null;

  const resetPreview = () => {
    setPreviewed(null);
    setError('');
  };

  const chooseFile = (event) => {
    resetPreview();
    setNotice('');
    const picked = event.target.files?.[0] || null;
    if (picked && picked.size > 2097152) {
      setFile(null);
      setError('CSV must be 2 MiB or smaller.');
      return;
    }
    setFile(picked);
  };

  const runPreview = async (event) => {
    event.preventDefault();
    if (!file || !brand?.id) return;
    setBusy(true);
    setError('');
    try {
      // Read the file now, not when it was chosen: edits saved since are included.
      let csv;
      try {
        csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        setError('Could not read this file as UTF-8 CSV. In Excel use "CSV UTF-8 (Comma delimited)".');
        return;
      }
      const response = await api.post('/warehouse/import/preview', { brand_id: brand.id, mode, csv });
      setPreviewed({ csv, data: response.data });
    } catch (caught) {
      setPreviewed(null);
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview?.can_apply) return;
    setBusy(true);
    setError('');
    try {
      // The server repeats every check, then applies all rows or none.
      const response = await api.post('/warehouse/import/apply', { brand_id: brand.id, mode, csv: previewed.csv });
      await onImported(response.data || {});
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    setError('');
    setNotice('');
    try {
      // Same mode as the preview, so the template's quantity column matches it:
      // current stock in "set" mode, blank in "add" mode (there the value is a delta).
      const result = await downloadFile('/warehouse/import-template', { brand_id: brand.id, mode }, 'warehouse_import_template.csv');
      const rows = Number(result?.headers?.get('X-Template-Rows'));
      if (rows === 0) {
        setNotice(`${brand.name} has no active products yet, so the template has headers only. Add products first; the import never creates them.`);
      }
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  const quantityCell = (value, unit) => (value == null ? '—' : `${formatNumber(value, 2)} ${unit || ''}`.trim());

  return (
    <Modal
      title={`Import warehouse CSV · ${brand?.name || 'brand'}`}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <button type="button" onClick={() => void downloadTemplate()}>Download CSV Template</button>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
            onClick={() => void apply()}
            disabled={!preview?.can_apply || busy}
            title={preview && !preview.can_apply ? 'Fix the errors and duplicates, then preview again.' : undefined}
          >
            {busy ? 'Working…' : 'Apply import'}
          </button>
        </>
      )}
    >
      <div className="grid gap-3 [&_.inventory-import-errors]:text-[12px]">
        <Notice type="error">{error}</Notice>
        <Notice type="info">{notice}</Notice>
        <p className="muted-note text-muted text-[8px] leading-[1.6]">
          Update-only: each row must match one existing {brand?.name || 'brand'} product by SKU (or by product name when only one product has it).
          The import never creates products or categories. Rows with a blank quantity are skipped.
          The template lists each product's current warehouse quantity in set mode (blank in add mode); edit the values you want to change.
        </p>
        <form className="grid gap-3" onSubmit={runPreview}>
          <fieldset className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-2 m-0 p-0 border-0 [&_legend]:mb-[6px] [&_legend]:p-0 [&_legend]:text-text-secondary [&_legend]:text-[12px] [&_legend]:font-[600] [&_label]:flex [&_label]:items-start [&_label]:gap-[10px] [&_label]:p-[10px_12px] [&_label]:border [&_label]:border-line [&_label]:rounded-[10px] [&_label]:[background:var(--surface-subtle,_transparent)] [&_label]:cursor-pointer [&_label.is-selected]:border-[color:var(--accent,_#6687ff)] [&_label.is-selected]:[background:color-mix(in_srgb,_var(--accent,_#6687ff)_10%,_transparent)] [&_input[type='radio']]:flex-[0_0_auto] [&_input[type='radio']]:w-[16px] [&_input[type='radio']]:h-[16px] [&_input[type='radio']]:min-h-0 [&_input[type='radio']]:m-[2px_0_0] [&_input[type='radio']]:p-0 [&_input[type='radio']]:[accent-color:var(--accent,_#6687ff)] [&_label_span]:grid [&_label_span]:gap-[2px] [&_label_span]:min-w-0 [&_strong]:text-text later-2:[&_strong]:text-[12.5px] later:[&_small]:text-muted later:[&_small]:text-[11.5px] [&_small]:leading-[1.35] max-[561px]:later:grid-cols-[minmax(0,_1fr)]">
            <legend>Import mode</legend>
            {Object.entries(IMPORT_MODES).map(([key, option]) => (
              <label key={key} className={mode === key ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="csv-mode"
                  value={key}
                  checked={mode === key}
                  onChange={() => { setMode(key); resetPreview(); }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.help}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-[6px]">
            <span className="text-text-secondary text-[12px] font-[600]">CSV file</span>
            <div className="flex items-center gap-[10px] min-w-0 p-[6px] border border-[color:var(--input-border,_var(--border))] rounded-[10px] [background:var(--input-bg,_var(--surface-subtle,_transparent))] [&_.ghost-button]:inline-flex [&_.ghost-button]:items-center [&_.ghost-button]:gap-[6px] [&_.ghost-button]:flex-[0_0_auto]">
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => fileRef.current?.click()}>
                <FaFileCsv aria-hidden="true" /> Choose file
              </button>
              <span className="min-w-0 overflow-hidden text-text text-[12px] text-ellipsis whitespace-nowrap">{file?.name || 'No file chosen'}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onClick={(event) => { event.currentTarget.value = ''; }}
                onChange={chooseFile}
              />
            </div>
            <small className="muted-note text-muted text-[8px] leading-[1.6]">Columns: brand, sku, product_name, category, unit, quantity. Excel/WPS CSVs (comma or semicolon) are fine.</small>
          </div>

          <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [justify-self:start]" disabled={!file || busy}>
            {busy ? 'Checking…' : 'Preview import'}
          </button>
        </form>

        {preview && (
          <div className="grid gap-[10px] mt-[14px] [&>p]:m-0 [&>p]:text-text-secondary [&>p]:text-[11px]">
            <p className="m-0 text-text-secondary text-[12px] [&_.is-bad]:text-[color:var(--danger-text,_#f56d7d)]">
              <strong>{preview.total_rows}</strong> row(s): <strong>{preview.valid_count}</strong> valid ·{' '}
              <strong>{preview.unchanged_count || 0}</strong> unchanged ·{' '}
              <strong className={preview.error_count ? 'is-bad' : ''}>{preview.error_count}</strong> error(s) ·{' '}
              <strong className={preview.duplicate_count ? 'is-bad' : ''}>{preview.duplicate_count}</strong> duplicate(s) ·{' '}
              <strong>{preview.skipped_count}</strong> skipped
            </p>
            {preview.ignored_columns?.length > 0 && (
              <p className="muted-note text-muted text-[8px] leading-[1.6]">Ignored columns: {preview.ignored_columns.join(', ')}. The import does not change these values.</p>
            )}
            {preview.duplicates?.length > 0 && (
              <ul className="inventory-import-errors m-0 p-[10px_14px_10px_28px] border border-[color:color-mix(in_srgb,_var(--danger,_#f56d7d)_34%,_var(--border))] rounded-[10px] text-[color:var(--danger-text,_#f56d7d)] [background:color-mix(in_srgb,_var(--danger,_#f56d7d)_8%,_transparent)] text-[10px]">
                {preview.duplicates.map((duplicate) => <li key={duplicate.key}>{duplicate.message}</li>)}
              </ul>
            )}
            {preview.errors?.length > 0 && (
              <ul className="inventory-import-errors m-0 p-[10px_14px_10px_28px] border border-[color:color-mix(in_srgb,_var(--danger,_#f56d7d)_34%,_var(--border))] rounded-[10px] text-[color:var(--danger-text,_#f56d7d)] [background:color-mix(in_srgb,_var(--danger,_#f56d7d)_8%,_transparent)] text-[10px]">
                {preview.errors.map((row) => <li key={`${row.line}-${row.message}`}>Line {row.line}: {row.message}</li>)}
              </ul>
            )}
            {!preview.can_apply && (
              <p className="m-0 text-[color:var(--warning-text,_#f0b35a)] text-[12px]">
                {preview.error_count || preview.duplicate_count
                  ? 'Apply is off: fix the rows above in the file, then preview again.'
                  : 'Apply is off: no row has a quantity. Fill in at least one quantity, then preview again.'}
              </p>
            )}
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer max-h-[320px] later:overflow-auto [&_td]:text-[12px] [&_td]:[vertical-align:top] [&_td_small]:block [&_td_small]:mt-[2px] [&_td_small]:text-muted later-3:[&_td_small]:text-[11px] [&_tr.is-error_td]:[background:color-mix(in_srgb,_var(--danger,_#f56d7d)_6%,_transparent)] [&_tr.is-duplicate_td]:[background:color-mix(in_srgb,_var(--danger,_#f56d7d)_6%,_transparent)] [&_tr.is-skipped_td]:text-muted">
              <table>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Current quantity</th>
                    <th>New quantity</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.line} className={`is-${row.status}`}>
                      <td>{row.line}</td>
                      <td>{row.product_sku || row.sku || '—'}</td>
                      <td>{row.product_name || row.product || '—'}</td>
                      <td>{quantityCell(row.current_quantity, row.unit)}</td>
                      <td>
                        {quantityCell(row.new_quantity, row.unit)}
                        {row.new_quantity != null && mode === 'add' && <small>{formatNumber(row.current_quantity, 2)} + {formatNumber(row.quantity, 2)}</small>}
                      </td>
                      <td>
                        <span className={`font-[600] whitespace-nowrap [&.is-valid]:text-[color:var(--success-text,_#75e2bd)] later:[&.is-error]:text-[color:var(--danger-text,_#f56d7d)] later:[&.is-duplicate]:text-[color:var(--danger-text,_#f56d7d)] later-2:[&.is-skipped]:text-muted is-${row.status}`}>{IMPORT_STATUS_LABELS[row.status] || row.status}</span>
                        {row.unchanged && <small>Already at this quantity: no change.</small>}
                        {row.message && row.status !== 'valid' && <small>{row.message}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function BranchInventory({ role }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(null);
  const [quantity, setQuantity] = useState('');
  const [mode, setMode] = useState('delta');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const remote = useRemote(async () => api.get('/inventories', { page, per_page: 50, stock_status: status }), [page, status]);
  const { reload } = remote;
  const canAdjust = role === 'franchisee';

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload({ silent: true });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [reload]);

  const adjust = async (event) => {
    event.preventDefault();
    const numericQuantity = Number(quantity);
    if (!Number.isInteger(numericQuantity) || (mode === 'set' && numericQuantity < 0) || (mode === 'delta' && numericQuantity === 0)) {
      setActionError(mode === 'set' ? 'Enter a whole-number stock balance of zero or more.' : 'Enter a non-zero whole number to add or subtract.');
      return;
    }
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/inventories/${selected.id}/adjust`, { mode, quantity: numericQuantity, remarks: remarks.trim() || null });
      setSelected(null);
      setQuantity('');
      setRemarks('');
      setSuccess('Inventory balance updated successfully.');
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]">
      <PageHeader
        title="My inventory"
        actions={<span className="inline-flex items-center gap-[.45rem] rounded-[999px] p-[.55rem_.8rem] [background:rgba(23,_137,_83,_.1)] text-[#147a4a] text-[.8rem] font-[800] whitespace-nowrap [&::before]:[content:''] [&::before]:w-[.48rem] [&::before]:h-[.48rem] [&::before]:rounded-[50%] [&::before]:[background:currentColor] [&::before]:[box-shadow:0_0_0_.22rem_rgba(23,_137,_83,_.12)]">Live sync · 3 seconds</span>}
      />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>
      <div className="toolbar flex items-center flex-wrap gap-[9px] mb-[14px] p-[10px] border border-line rounded-[15px] [background:color-mix(in_srgb,_var(--panel)_92%,_transparent)] [box-shadow:var(--shadow-sm)] [&_input]:flex-[1_1_270px] [&_select]:flex-[0_1_210px] [&_input]:min-h-[40px] [&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:min-h-[40px] [&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong [&_select:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[681px]:later:items-stretch max-[681px]:flex-col max-[681px]:[&_input]:w-full max-[681px]:later:[&_input]:flex-[auto] max-[681px]:[&_select]:w-full max-[681px]:later:[&_select]:flex-[auto]"><select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} aria-label="Filter stock level"><option value="">All stock levels</option>{['normal', 'low', 'critical'].map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select></div>
      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        {remote.loading && !remote.data ? <LoadingState /> : !remote.data?.data.length ? (
          <EmptyState label="No inventory records match this filter." detail="Choose another stock level or verify inventory has been initialized." />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer"><table><thead><tr><th>Product</th><th>Location</th><th>Stock</th><th>Reorder</th><th>Critical</th><th>Status</th><th>Action</th></tr></thead><tbody>
            {remote.data.data.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.product?.name || '—'}</strong><small>{item.product?.sku || item.product?.brand?.name || ''}</small></td>
                <td>{item.location?.name || '—'}<small>{titleCase(item.location?.type || '')}</small></td>
                <td><strong>{formatNumber(item.current_stock)} {item.product?.unit || ''}</strong></td>
                <td>{formatNumber(item.reorder_level)}</td>
                <td>{formatNumber(item.critical_level)}</td>
                <td><StatusBadge value={item.stock_status} /></td>
                <td>{canAdjust ? <button onClick={() => { setActionError(''); setSelected(item); setQuantity(''); setMode('delta'); }}>Adjust</button> : '—'}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={remote.data?.meta} onPage={setPage} />
      </section>

      {selected && (
        <Modal title={`Adjust ${selected.product?.name || 'inventory'}`} onClose={() => setSelected(null)} size="small" footer={<><button onClick={() => setSelected(null)}>Cancel</button><button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="adjust-form" disabled={saving}>{saving ? 'Saving…' : 'Apply adjustment'}</button></>}>
          <Notice type="error">{actionError}</Notice>
          <div className="grid grid-cols-[minmax(0,_1fr)_auto] gap-[5px_15px] mb-4 p-[13px_14px] border border-line rounded-[13px] [background:var(--surface-subtle)] [&_span]:text-muted later:[&_span]:text-[8px] [&_strong]:row-[span_2] [&_strong]:self-center [&_strong]:text-text later:[&_strong]:text-[16px] later:[&_strong]:tracking-[-.03em] [&_small]:text-text-secondary [&_small]:text-[9px]"><span>Current balance</span><strong>{formatNumber(selected.current_stock)} {selected.product?.unit || ''}</strong><small>{selected.location?.name || 'Unknown location'}</small></div>
          <form id="adjust-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={adjust}>
            <Field label="Adjustment mode" required><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="delta">Add or subtract</option><option value="set">Set exact balance</option></select></Field>
            <Field label={mode === 'delta' ? 'Quantity change' : 'New balance'} required hint={mode === 'delta' ? 'Use −1 to deduct one unit or +1 to add one unit. Whole numbers only.' : 'Enter the exact whole-number balance.'}>
              <div className="grid grid-cols-[auto_minmax(90px,_1fr)_auto] overflow-hidden border border-line-strong rounded-[11px] [background:var(--panel)] [&_button]:min-w-[50px] later-2:[&_button]:border-0 [&_button]:rounded-[0] [&_button]:text-accent-text later-2:[&_button]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] later-2:[&_button]:font-[850] later:[&_button:hover]:[background:color-mix(in_srgb,_var(--accent)_14%,_transparent)] [&_input]:min-w-0 later:[&_input]:border-0 later:[&_input]:border-r later:[&_input]:border-r-line later:[&_input]:border-l later:[&_input]:border-l-line later:[&_input]:rounded-[0] [&_input]:text-center [&_input]:font-[800] focus-within:border-accent focus-within:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] later:[&_input:focus]:[box-shadow:none] max-[681px]:later:grid-cols-[58px_minmax(70px,_1fr)_58px]">
                {mode === 'delta' && <button type="button" onClick={() => setQuantity(String((Number(quantity) || 0) - 1))} aria-label="Subtract one unit">−1</button>}
                <input required type="number" inputMode="numeric" min={mode === 'set' ? '0' : undefined} step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                <button type="button" onClick={() => setQuantity(String(Math.max(mode === 'set' ? 0 : -999999999, (Number(quantity) || 0) + 1)))} aria-label="Add one unit">+1</button>
              </div>
            </Field>
            <Field label="Remarks" full><textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Reason, reference, or reconciliation note" /></Field>
          </form>
        </Modal>
      )}
    </div>
  );
}
