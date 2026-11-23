import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FaAngleLeft,
  FaAngleRight,
  FaBoxesStacked,
  FaCheck,
  FaCircleExclamation,
  FaClipboardList,
  FaClockRotateLeft,
  FaExpand,
  FaStore,
  FaTriangleExclamation,
  FaXmark,
} from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useRemote from '../lib/useRemote';
import useCosting from '../lib/useCosting';
import { EmptyState, Field, LoadingState, Modal, Notice, Pagination, StatusBadge } from '../components/ApiUi';
import { defaultLevelsFor, formatQuantity, STOCK_STATUS_LABELS } from '../lib/quantity';
import { formatDate, formatNumber } from '../lib/format';
import { supplyStatusLabel } from '../lib/supplyActions';
import { changedAgo, lastCountLabel, sortWorstFirst, STOCK_ORDER } from '../lib/stockView';

import dailyDashLogo from '../assets/dailydash_new.png';
import goDoLogo from '../assets/godo_new.png';
import kkopiLogo from '../assets/kkopi_new.png';
import laPastaLogo from '../assets/lapasta_new.png';

const metrics = [
  ['active_branches', 'Active branches', FaStore, (summary) => activeBreakdown(summary)],
  ['materials_tracked', 'Materials tracked', FaBoxesStacked, 'Inventory items across active branches'],
  ['open_requests', 'Open requests', FaClipboardList, 'Awaiting completion'],
  ['low_stock_items', 'Low-stock items', FaTriangleExclamation, "At or below each material's low level"],
  ['critical_stock_items', 'Critical items', FaCircleExclamation, 'At or below the critical level, or no stock'],
  ['stale_branches', 'Stale data', FaClockRotateLeft, (summary) => `Branches with no count in ${summary?.stale_count_days ?? 3}+ days`],
];
/** Cards that open an alert list (one open at a time). */
const ALERT_CARDS = { low_stock_items: 'low', critical_stock_items: 'critical', stale_branches: 'stale' };

/** "2 live · 8 demo · 1 without portal account": the parts always add up to Active branches. */
function activeBreakdown(summary) {
  if (!summary) return '';
  const parts = [`${formatNumber(summary.live_branches ?? summary.with_portal_account ?? 0)} live`];
  if (Number(summary.demo_branches)) parts.push(`${formatNumber(summary.demo_branches)} demo`);
  if (Number(summary.without_portal_account)) parts.push(`${formatNumber(summary.without_portal_account)} without portal account`);
  return parts.join(' · ');
}

// Keys are normalized brand codes/names (lowercase, letters only).
const BRANDS = {
  dailydash: { label: 'Daily Dash', color: '#0565D6', logo: dailyDashLogo },
  kkopi: { label: 'Kkopi', color: '#F97D1B', logo: kkopiLogo },
  lapasta: { label: 'La Pasta', color: '#AF2525', logo: laPastaLogo },
  godo: { label: 'Godo', color: '#769D32', logo: goDoLogo },
};
const FALLBACK_BRAND = { label: '', color: '#5b6478', logo: null };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z]/g, '');

// Categories are matched by name: branch rows and the dropdown both carry the category name.
const categoryKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

function brandKeyOf(branch) {
  const key = [branch?.brand?.code, branch?.brand?.name, branch?.preferred_branch_type]
    .map(normalize)
    .find((candidate) => BRANDS[candidate]);
  return key || '';
}

function getBrand(branch) {
  return BRANDS[brandKeyOf(branch)] || FALLBACK_BRAND;
}

const brandLabelOf = (branch) => getBrand(branch).label
  || branch?.preferred_branch_type
  || branch?.brand?.name
  || 'Brand';

const LOCATION_NOT_SET = 'Location not set';
/** The branch's place (server decides; a person's name is never a location). */
const locationOf = (branch) => branch?.location_label || LOCATION_NOT_SET;
const hasLocation = (branch) => Boolean(branch?.location_label);

/**
 * Branch stock status from the server (worst material; one rule with the detail):
 * ok · low · critical · out (nothing on hand) · none (no inventory yet).
 */
function stockState(branch) {
  return branch?.stock_status || 'none';
}

/**
 * The name part of the card title, without what the card already shows: the
 * [DEMO] prefix (DEMO badge) and the trailing "· location" of "Brand · Location".
 */
function branchBaseName(branch) {
  const raw = String(branch?.name || '').replace(/^\s*\[demo\]\s*/i, '').trim();
  const parts = raw.split(' · ');
  return parts.length > 1 ? parts.slice(0, -1).join(' · ') : raw;
}

/** Red dot: an open or new request, or a critical / out-of-stock material. */
function branchAlert(branch) {
  const requests = Number(branch?.open_request_count || 0) + Number(branch?.pending_review_count || 0);
  const critical = Number(branch?.critical_stock_count || 0) + Number(branch?.out_of_stock_count || 0);
  if (!requests && !critical) return '';
  return [
    requests ? `${formatNumber(requests)} open request${requests === 1 ? '' : 's'}` : '',
    critical ? `${formatNumber(critical)} critical item${critical === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
}

/** "4 materials · 1 low · 0 critical" */
function materialsSummary(branch) {
  const count = Number(branch?.materials_count || 0);
  const critical = Number(branch?.critical_stock_count || 0) + Number(branch?.out_of_stock_count || 0);
  return `${formatNumber(count)} material${count === 1 ? '' : 's'} · ${formatNumber(branch?.low_stock_count || 0)} low · ${formatNumber(critical)} critical`;
}

/* ------------------------------------------------------------------ *
 * Default view: one branch card. The card and the View label open the
 * same half view.
 * ------------------------------------------------------------------ */
function BranchCard({ branch, active, onOpen, role, onEditLocation, highlighted = false }) {
  const brand = getBrand(branch);
  const state = stockState(branch);
  const alert = branchAlert(branch);
  const baseName = branchBaseName(branch);
  const sameAsLocation = baseName.toLowerCase() === String(branch.location_label || '').toLowerCase();

  const open = () => onOpen(branch);
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };

  return (
    <div
      id={`branch-card-${branch.id}`}
      className={`bp-card relative scroll-mt-[96px] gap-2 overflow-hidden [border:1px_solid_color-mix(in_srgb,_var(--text)_13%,_transparent)] rounded-[14px_14px_14px_22px] [background:linear-gradient(148deg,_color-mix(in_srgb,_var(--panel)_80%,_transparent)_0%,_color-mix(in_srgb,_var(--panel)_52%,_transparent)_58%,_color-mix(in_srgb,_var(--panel)_68%,_transparent)_100%)] [backdrop-filter:blur(16px)_saturate(1.35)] [box-shadow:inset_0_1px_0_color-mix(in_srgb,_var(--text)_11%,_transparent),_0_12px_30px_-20px_rgba(0,0,0,.6)] cursor-pointer [transition:border-color_.22s_ease,_transform_.22s_ease,_box-shadow_.22s_ease,_background_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:inset-[0_0_auto_0] [&::after]:h-[62%] [&::after]:[background:linear-gradient(162deg,_color-mix(in_srgb,_var(--text)_9%,_transparent),_transparent_64%)] [&::after]:opacity-[.9] [&::after]:pointer-events-none hover:[transform:translateY(-2px)] hover:border-line-strong hover:[background:linear-gradient(148deg,_color-mix(in_srgb,_var(--panel)_90%,_transparent)_0%,_color-mix(in_srgb,_var(--panel)_64%,_transparent)_58%,_color-mix(in_srgb,_var(--panel)_78%,_transparent)_100%)] hover:[box-shadow:inset_0_1px_0_color-mix(in_srgb,_var(--text)_16%,_transparent),_0_18px_40px_-22px_rgba(0,0,0,.55),var(--shadow-md)] focus-visible:[outline:2px_solid_color-mix(in_srgb,_var(--brand-color,_var(--accent))_60%,_transparent)] focus-visible:[outline-offset:2px] later:[&.is-active]:border-[color:color-mix(in_srgb,_var(--brand-color,_var(--accent))_55%,_var(--border))] max-[761px]:later:min-h-[164px] motion-reduce:later:[transition:none] later:grid-cols-[minmax(0,_1fr)] later-2:min-h-0 later:flex flex-col later:p-[18px] ${active ? ' is-active' : ''}`}
      data-highlighted={highlighted || undefined}
      style={{ '--brand-color': brand.color, ...(highlighted ? { outline: '2px solid var(--accent)', outlineOffset: '3px', boxShadow: '0 0 0 6px color-mix(in srgb, var(--accent) 24%, transparent)' } : {}) }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${branch.name}`}
      title={branch.name}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      {alert && <span className="flex-none w-[8px] h-[8px] rounded-[50%] [background:var(--danger)] [box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--danger)_16%,_transparent)] absolute top-[12px] left-[12px] z-2" title={alert} aria-label={alert} />}

      {/* Brand logo on a curved corner in the brand color. */}
      <div className="grid place-items-center [&_img]:max-w-full [&_img]:max-h-full later:[&_span]:text-[#fff] later:[&_span]:font-[760] [&_span]:text-center [&_span]:tracking-[.02em] later:absolute top-0 right-0 z-1 later:w-[104px] later:h-[84px] later:p-[2px_2px_2px_12px] later:rounded-[0_0_0_64px] later:[background:var(--brand-color,_var(--accent))] later:opacity-[1] later:[&_img]:w-full later:[&_img]:h-full [&_img]:object-contain later-4:[&_span]:text-[12px] [&_span]:leading-[1.2] [&_span]:[overflow-wrap:anywhere]" title={brandLabelOf(branch)}>
        {brand.logo
          ? <img src={brand.logo} alt={brandLabelOf(branch)} draggable="false" />
          : <span>{brandLabelOf(branch)}</span>}
      </div>

      <div className="z-1 min-w-0 flex flex-col flex-[1_1_auto] later:static later:gap-0">
        {/* "Branch name - Preferred location"; the head keeps clear of the logo. */}
        <div className="min-h-[70px] pr-26">
          <strong className="overflow-hidden text-text font-[760] tracking-[-.015em] text-ellipsis later-5:[&.is-unset]:text-muted [&.is-unset]:italic block later-2:text-[15px] leading-[1.35] later:whitespace-normal later:[overflow-wrap:anywhere] [&_.is-unset]:text-muted [&_.is-unset]:italic">
            {baseName && !sameAsLocation && <>{baseName} - </>}
            <span className={hasLocation(branch) ? '' : 'is-unset'}>{locationOf(branch)}</span>
          </strong>
          {(branch.is_demo || branch.archived_at) && (
            <div className="flex flex-wrap items-center later:gap-2 later:mt-[6px]">
              {branch.is_demo && <span className="inline-flex items-center gap-1 p-[1px_7px] border border-line rounded-[999px] text-text-secondary text-[10.5px] font-[600] leading-[1.6] whitespace-nowrap [&_img]:w-[12px] [&_img]:h-[12px] [&_img]:object-contain later-5:[&.is-brand]:text-[color:var(--badge-color,_var(--text))] [&.is-brand]:border-[color:color-mix(in_srgb,_var(--badge-color,_var(--border))_45%,_transparent)] later-6:[&.is-portal]:text-success-text later:[&.is-portal]:border-[color:color-mix(in_srgb,_var(--success-text)_40%,_transparent)] later-7:[&.is-noportal]:text-muted later-8:[&.is-demo]:text-[color:var(--warning-text)] later-2:[&.is-demo]:border-[color:color-mix(in_srgb,_var(--warning-text)_40%,_transparent)] [&.is-demo]:tracking-[.04em] later-9:[&.is-archived]:text-danger-text later-3:[&.is-archived]:border-[color:color-mix(in_srgb,_var(--danger-text)_40%,_transparent)] is-demo" title="Sample / demo data">DEMO</span>}
              {branch.archived_at && <span className="text-muted text-[12px]">Archived</span>}
            </div>
          )}
        </div>
        {!hasLocation(branch) && role === 'admin' && (
          <button
            type="button"
            className="self-start mt-1 p-0 border-0 [background:none] text-accent-text text-[11.5px] font-[600] cursor-pointer hover:[text-decoration:underline] focus-visible:[text-decoration:underline]"
            onClick={(event) => { event.stopPropagation(); onEditLocation?.(branch); }}
          >
            Edit location
          </button>
        )}

        <div className="flex flex-col later:gap-0 later:mt-[6px]">
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-[#ff1f3d] [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Status</small>
            <b className={`bp-card-state is-${state}`}>{STOCK_STATUS_LABELS[state] || STOCK_STATUS_LABELS.none}</b>
          </span>
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-[#ff1f3d] [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Materials</small>
            <b>{materialsSummary(branch)}</b>
          </span>
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-[#ff1f3d] [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Request</small>
            <b>{formatNumber(branch.open_request_count)}</b>
          </span>
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-[#ff1f3d] [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Last count</small>
            <b className={branch.is_stale ? 'text-[color:var(--warning-text)]! font-[400]!' : ''} title={branch.is_stale ? 'No physical count in 3+ days: on-hand figures may be higher than actual' : undefined}>{lastCountLabel(branch.last_count_at)}{branch.is_stale && branch.materials_count ? ' · stale' : ''}</b>
          </span>
        </div>

        <div className="flex justify-end mt-auto pt-3">
          <button
            type="button"
            className="ghost-button justify-center later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px] right-[16px] bottom-[14px] z-2 inline-flex items-center later-2:gap-[5px] later-2:min-h-[30px] later-2:p-[0_12px] border later-2:border-line rounded-[10px] text-text-secondary later-2:[background:color-mix(in_srgb,_var(--panel)_72%,_transparent)] later-2:font-[760] later-2:[transition:color_.18s_ease,_border-color_.18s_ease,_background_.18s_ease] [.bp-card:hover_&]:text-text later-2:[.bp-card:hover_&]:border-line-strong [.bp-card:hover_&]:[background:var(--hover)] later-3:text-[12.5px] later:static"
            onClick={(event) => { event.stopPropagation(); open(); }}
          >
            Action
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Branch sections (half + full view). `inventory` is the branch's own
 * raw-material ledger: the same rows the branch portal reads.
 * ------------------------------------------------------------------ */
/* Full view: a click anywhere on a panel (not on one of its controls) centres it on screen. */
const PANEL_CLICK_IGNORE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable="true"]';
function centrePanel(event) {
  if (event.target.closest?.(PANEL_CLICK_IGNORE)) return;
  // Leave text selection alone: a drag that ends inside the panel is not a click-to-centre.
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return;
  const panel = event.currentTarget;
  if (!panel.closest('.bp-full-grid')) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const rect = panel.getBoundingClientRect();
  const top = window.scrollY + rect.top;
  const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 0;
  // Centre the panel, but a panel taller than the screen stops just below the sticky header
  // so its title and first row stay in view instead of being cut off.
  const centred = top + rect.height / 2 - window.innerHeight / 2;
  const belowHeader = top - header - 12;
  window.scrollTo({ top: Math.max(0, Math.min(centred, belowHeader)), behavior: reduced ? 'auto' : 'smooth' });
}

function Section({ title, meta, className = '', titleClassName = '', children }) {
  return (                    <section onClick={centrePanel} className={`data-panel overflow-hidden mb-[18px] border border-line rounded-[9px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] later:m-0 later:hover:[box-shadow:none] [&_.panel-title]:min-h-[46px] [&_.panel-title]:p-[11px_15px] [&_.panel-title_span]:text-right [&_.panel-state]:min-h-[150px] later-2:[&_.panel-title_h2]:text-[14.5px] later-2:[&_.panel-title_span]:text-[12px] [&_.panel-title:last-child]:border-b-0 ${className}`}>
      <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
        <h2 className={titleClassName}>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {children ? <div className="p-0 later:[.bp-full-grid_.bp-sec-deliveries_&]:max-h-[none] later:[.bp-full-grid_.bp-sec-deliveries_&]:overflow-visible">{children}</div> : null}
    </section>
  );
}

const INVENTORY_PER_PAGE = 8;

/* Delivery fulfillment: 10 rows at a time, with quick date presets. */
const DELIVERY_PAGE_SIZE = 10;

/* Needs attention: 10 rows at a time, grouped by how bad the stock is. */
const ATTENTION_PAGE_SIZE = 10;
const ATTENTION_STATUSES = ['out', 'critical', 'low'];
const ATTENTION_TONES = {
  out: { label: 'No stock', dot: '#9aa4b8', text: 'var(--text-secondary)', mix: '#9aa4b8' },
  critical: { label: 'Critical', dot: '#e5484d', text: 'var(--danger-text)', mix: '#e5484d' },
  low: { label: 'Low', dot: '#f0b429', text: 'var(--warning-text)', mix: '#f0b429' },
};
const DELIVERY_PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
];
const isoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayOfValue = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : isoDay(date);
};
const presetRange = (key) => {
  const today = new Date();
  const to = isoDay(today);
  if (key === '7d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 6);
    return { from: isoDay(from), to };
  }
  if (key === '30d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 29);
    return { from: isoDay(from), to };
  }
  if (key === 'month') return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  return { from: '', to: '' };
};

function BranchSections({ ops, loading, error, role, onOpenRequests, onEditLevels, onBranchAction, onRetry = null, focusMaterial = null, animateFilters = false }) {
  const costing = useCosting();
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventoryDirection, setInventoryDirection] = useState(1);
  const [highlightMaterial, setHighlightMaterial] = useState(null);
  useEffect(() => {
    if (!focusMaterial) return undefined;
    // Clear filters so the material is in the list, then go to its page.
    setCategoryFilter('');
    setStatusFilter('');
    setInventorySearch('');
    setHighlightMaterial(focusMaterial.id);
    const timer = window.setTimeout(() => setHighlightMaterial(null), 2500);
    return () => window.clearTimeout(timer);
  }, [focusMaterial]);
  const [attentionStatus, setAttentionStatus] = useState('all');
  const [attentionSearch, setAttentionSearch] = useState('');
  const [attentionVisible, setAttentionVisible] = useState(ATTENTION_PAGE_SIZE);
  const attentionListRef = useRef(null);
  const [deliveryOpenId, setDeliveryOpenId] = useState(null);
  const [deliveryPreset, setDeliveryPreset] = useState('');
  const [deliveryFrom, setDeliveryFrom] = useState('');
  const [deliveryTo, setDeliveryTo] = useState('');
  const [deliveryVisible, setDeliveryVisible] = useState(DELIVERY_PAGE_SIZE);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [inventorySearch, setInventorySearch] = useState('');
  const [brandCategories, setBrandCategories] = useState([]);
  const brandId = ops?.branch?.brand?.id ?? null;
  useEffect(() => {
    if (!brandId) return undefined;
    let active = true;
    api.get('/product-categories', { brand_id: brandId })
      .then((response) => { if (active) setBrandCategories(response.data || []); })
      .catch(() => { if (active) setBrandCategories([]); });
    return () => { active = false; };
  }, [brandId]);
  // A category chosen for one branch must not carry over to another brand's list.
  const activeCategoryFilter = brandCategories.some((c) => categoryKey(c.name) === categoryFilter) ? categoryFilter : '';
  // Jump to the page that holds the focused material (list is worst-first, unfiltered after the reset).
  useEffect(() => {
    if (!focusMaterial || !ops) return;
    const idx = sortWorstFirst(ops.inventory || []).findIndex((row) => Number(row.id) === focusMaterial.id);
    if (idx >= 0) setInventoryPage(Math.floor(idx / INVENTORY_PER_PAGE) + 1);
  }, [focusMaterial, ops]);
  useEffect(() => {
    if (highlightMaterial == null) return;
    document.querySelector('[data-inv-focus="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightMaterial, inventoryPage]);
  // Back to the top and the first page whenever the stock filter or the search changes.
  useEffect(() => {
    setAttentionVisible(ATTENTION_PAGE_SIZE);
    if (attentionListRef.current) attentionListRef.current.scrollTop = 0;
  }, [attentionStatus, attentionSearch]);
  // The newest delivery starts open; keep the open row while it is still listed.
  useEffect(() => {
    const rows = [...(ops?.deliveries || [])].sort((a, b) => new Date(b.delivered_at || 0) - new Date(a.delivered_at || 0));
    if (!rows.length) return;
    setDeliveryOpenId((current) => (current != null && rows.some((row) => row.id === current) ? current : rows[0].id));
  }, [ops]);
  if (loading && !ops) {
    return <Section title="Branch Inventory"><LoadingState label="Loading branch data…" /></Section>;
  }
  if (error && !ops) {
    return <Section title="Branch Inventory"><Notice type="error">{error}</Notice></Section>;
  }
  if (!ops) return null;

  const inventoryTerm = inventorySearch.trim().toLowerCase();
  // Worst status first (No stock, Critical, Low, Normal), then by name.
  const inventory = sortWorstFirst(ops.inventory || [])
    .filter((row) => !activeCategoryFilter || categoryKey(row.category) === activeCategoryFilter)
    .filter((row) => !statusFilter || row.status === statusFilter)
    .filter((row) => !inventoryTerm || String(row.name || '').toLowerCase().includes(inventoryTerm));
  const summary = ops.inventory_summary || {};
  const activeRequests = ops.active_requests || [];
  const attention = ops.needs_attention || [];
  const attentionTotal = attention.length;
  const attentionCounts = ATTENTION_STATUSES.reduce((acc, status) => ({ ...acc, [status]: attention.filter((item) => item.status === status).length }), {});
  const attentionChips = [
    { key: 'all', label: 'All', count: attentionTotal },
    ...ATTENTION_STATUSES.map((status) => ({ key: status, label: ATTENTION_TONES[status].label, count: attentionCounts[status] || 0 })),
  ].filter((chip) => chip.count > 0);
  const attentionTerm = attentionSearch.trim().toLowerCase();
  // Within each group the most urgent row (lowest on-hand vs critical level) comes first.
  const attentionFiltered = attention
    .filter((item) => attentionStatus === 'all' || item.status === attentionStatus)
    .filter((item) => !attentionTerm || String(item.label || '').toLowerCase().includes(attentionTerm))
    .sort((a, b) => {
      const ratio = (item) => (Number(item.on_hand) || 0) / Math.max(Number(item.critical_level) || 0, 1);
      return ratio(a) - ratio(b);
    });
  const attentionShown = attentionFiltered.slice(0, attentionVisible);
  const attentionGroupsView = ATTENTION_STATUSES
    .map((status) => ({ status, rows: attentionShown.filter((item) => item.status === status) }))
    .filter((group) => group.rows.length > 0);
  const attentionChipClass = (active) => `min-h-[29px] inline-flex items-center gap-[6px] p-[0_11px] border rounded-[999px] text-[12.5px] font-[650] cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ${active ? 'border-transparent text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]' : 'border-line-strong text-text-secondary [background:transparent] hover:text-text hover:[background:var(--hover)]'}`;
  const deliveries = ops.deliveries || [];
  const sortedDeliveries = [...deliveries].sort((a, b) => new Date(b.delivered_at || 0) - new Date(a.delivered_at || 0));
  const deliveryHasRange = Boolean(deliveryFrom || deliveryTo);
  const filteredDeliveries = sortedDeliveries.filter((row) => {
    const day = dayOfValue(row.delivered_at);
    if (!day) return !deliveryHasRange;
    if (deliveryFrom && day < deliveryFrom) return false;
    if (deliveryTo && day > deliveryTo) return false;
    return true;
  });
  const visibleDeliveries = filteredDeliveries.slice(0, deliveryVisible);
  const applyDeliveryPreset = (key) => {
    const range = presetRange(key);
    setDeliveryPreset(key);
    setDeliveryFrom(range.from);
    setDeliveryTo(range.to);
    setDeliveryVisible(DELIVERY_PAGE_SIZE);
  };
  const clearDeliveryFilter = () => {
    setDeliveryPreset('');
    setDeliveryFrom('');
    setDeliveryTo('');
    setDeliveryVisible(DELIVERY_PAGE_SIZE);
  };
  const editDeliveryDate = (setter) => (event) => {
    setter(event.target.value);
    setDeliveryPreset('');
    setDeliveryVisible(DELIVERY_PAGE_SIZE);
  };
  const deliveryChipClass = (active) => `min-h-[29px] inline-flex items-center p-[0_11px] border rounded-[999px] text-[12.5px] font-[650] cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ${active ? 'border-transparent text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]' : 'border-line-strong text-text-secondary [background:transparent] hover:text-text hover:border-line-strong hover:[background:var(--hover)]'}`;
  const deliveryInputClass = 'min-h-[32px] p-[3px_9px] border border-line-strong rounded-[9px] [background:var(--input-bg)] text-text text-[13px] font-[600] [outline:none] focus:border-accent focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_14%,_transparent)]';
  const branch = ops.branch || {};
  const brand = getBrand(branch);
  const thresholds = ops.thresholds || {};

  // Inventory pages of 8 rows; the Pagination meta mirrors the server shape.
  const filtered = Boolean(activeCategoryFilter || statusFilter || inventoryTerm);
  const invLastPage = Math.max(1, Math.ceil(inventory.length / INVENTORY_PER_PAGE));
  const invPage = Math.min(inventoryPage, invLastPage);
  const invRows = inventory.slice((invPage - 1) * INVENTORY_PER_PAGE, invPage * INVENTORY_PER_PAGE);

  const invMeta = { current_page: invPage, last_page: invLastPage, per_page: INVENTORY_PER_PAGE, total: inventory.length };
  const goToInventoryPage = (page) => {
    setInventoryDirection(page > invPage ? 1 : -1);
    setInventoryPage(page);
  };

  return (
    <>
      <Section
        title="Branch Inventory"
        titleClassName="uppercase tracking-[.06em]!"
        className="bp-sec-inventory [grid-area:inventory] [&_.panel-title]:[background:color-mix(in_srgb,_var(--bg)_94%,_transparent)]"
        meta={(
          <span className="inline-flex flex-wrap items-center gap-[12px]">
            {brandCategories.length > 0 && (
              <select
                aria-label="Filter by category"
                value={activeCategoryFilter}
                onChange={(e) => { setCategoryFilter(e.target.value); setInventoryPage(1); }}
                className="min-h-[40px] p-[0_12px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text text-[14px] font-[600] cursor-pointer"
              >
                <option value="">All categories</option>
                {brandCategories.map((category) => <option key={category.id} value={categoryKey(category.name)}>{category.name}</option>)}
              </select>
            )}
            <input
              type="search"
              value={inventorySearch}
              onChange={(event) => { setInventorySearch(event.target.value); setInventoryPage(1); }}
              placeholder="Search material"
              aria-label="Search material in this branch's inventory"
              className="w-[180px] min-h-[40px] p-[0_12px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text text-[14px] font-[600] [outline:none] placeholder:text-placeholder placeholder:font-[500] focus:border-accent focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_14%,_transparent)] max-[721px]:w-full"
            />
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setInventoryPage(1); }}
              className="min-h-[40px] p-[0_12px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text text-[14px] font-[600] cursor-pointer"
            >
              <option value="">All statuses</option>
              {Object.keys(STOCK_ORDER).map((key) => <option key={key} value={key}>{STOCK_STATUS_LABELS[key]}</option>)}
            </select>
            <span>
              {inventory.length
                ? `${formatNumber(filtered ? inventory.length : (summary.materials ?? summary.items))} material${Number(filtered ? inventory.length : (summary.materials ?? summary.items)) === 1 ? '' : 's'}`
                : (filtered ? 'No matches' : 'No inventory yet')}
            </span>
          </span>
        )}
      >
        {(inventory.length > 0 || filtered) && (
          <div key={`${invPage}-${animateFilters ? activeCategoryFilter : ''}-${animateFilters ? statusFilter : ''}-${animateFilters ? inventoryTerm : ''}`} style={animateFilters ? undefined : { animation: `${inventoryDirection > 0 ? 'bpInventoryFromRight' : 'bpInventoryFromLeft'} .24s ease-out both` }} className={`table-wrap ${animateFilters ? 'bp-inventory-filter-enter' : ''} [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer later:overflow-auto later:max-h-[none] later-2:overflow-x-auto later-2:[overflow-y:visible] later:[.bp-full-grid_.bp-sec-inventory_&]:max-h-[none] [.bp-full-grid_.bp-sec-inventory_&]:overflow-x-auto [.bp-full-grid_.bp-sec-inventory_&]:[overflow-y:visible]`}>
            <table className="[&_th]:top-0 [&_th]:[background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [&_td_small]:text-muted later:[&_tr.is-low_td]:[background:color-mix(in_srgb,_var(--warning)_5%,_transparent)] later-2:[&_tr.is-out_td]:[background:color-mix(in_srgb,_var(--danger)_6%,_transparent)] later:min-w-[620px] later:text-[13.5px] later:[&_th]:static later:[&_th]:p-[9px_14px] later:[&_th]:text-[11.5px] [&_th]:whitespace-nowrap later:[&_td]:p-[8px_14px] [&_td]:[vertical-align:top] later:[&_td_strong]:text-[13.5px] [&_td_small]:block later:[&_td_small]:text-[11.5px] [.bp-drawer-scroll_&]:min-w-0 [.bp-drawer-scroll_&_th]:p-[10px_12px] [.bp-drawer-scroll_&_td]:p-[10px_12px]">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="bp-col-source">Source</th>
                  <th>On hand</th>
                  <th>Low / Critical</th>
                  <th>Status</th>
                  <th>Last count</th>
                  {costing && <th>Unit cost</th>}
                  {costing && <th>Stock value</th>}
                  {role === 'logistics' && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {invRows.map((row) => (
                  <tr key={row.id} data-inv-focus={Number(row.id) === highlightMaterial ? 'true' : undefined} className={`${row.status === 'out' ? 'is-out' : row.status === 'ok' ? '' : 'is-low'}${Number(row.id) === highlightMaterial ? ' [background:color-mix(in_srgb,_var(--accent)_22%,_transparent)]' : ''}`}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.variant && <small>{row.variant}</small>}
                      <small className="hidden [.bp-drawer-scroll_&]:block">{row.source || '—'}</small>
                    </td>
                    <td className="bp-col-source">{row.source || '—'}</td>
                    <td><strong>{row.on_hand_display || formatQuantity(row.on_hand, row.unit)}</strong></td>
                    <td>
                      {row.low_level_display || '—'} / {row.critical_level_display || '—'}
                      {row.levels_source === 'default' && <span className="ml-[6px] inline-flex p-[1px_6px] border border-line rounded-[999px] text-muted text-[10px] font-[650] align-middle" title="Unit defaults: Logistics has not set levels for this material">Default</span>}
                    </td>
                    <td><b className={`font-[600] whitespace-nowrap later-5:[&.is-ok]:text-success-text later-6:[&.is-low]:text-[color:var(--warning-text)] later-7:[&.is-critical]:text-[#ff1f3d] later-7:[&.is-out]:text-danger-text is-${row.status}`}>{STOCK_STATUS_LABELS[row.status] || '—'}</b></td>
                    <td className={row.last_counted_at ? '' : 'text-muted'}>{lastCountLabel(row.last_counted_at)}</td>
                    {costing && <td>{row.unit_cost == null ? '—' : `₱${formatNumber(row.unit_cost, 2)}`}</td>}
                    {costing && <td>{row.stock_value == null ? '—' : `₱${formatNumber(row.stock_value, 2)}`}</td>}
                    {role === 'logistics' && (
                      <td>
                        <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onEditLevels?.(row)}>Edit levels</button>
                      </td>
                    )}
                  </tr>
                ))}
                {invRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6 + (costing ? 2 : 0) + (role === 'logistics' ? 1 : 0)}
                      style={{ height: 220, verticalAlign: 'middle', borderBottom: 0 }}
                      className="text-center"
                    >
                      <p className="m-0 text-text text-[15px] font-[740]">No materials found</p>
                      <p className="m-0 mt-[6px] text-text-secondary text-[13.5px] leading-[1.55]">
                        {inventoryTerm
                          ? <>Nothing in this branch matches “{inventorySearch.trim()}”. Check the spelling or try a shorter name.</>
                          : 'No materials match these filters. Try a different category or status.'}
                      </p>
                    </td>
                  </tr>
                )}
                {invRows.length > 0 && Array.from({ length: INVENTORY_PER_PAGE - invRows.length }, (_, index) => (
                  <tr key={`empty-inventory-slot-${index}`} aria-hidden="true">
                    <td colSpan={6 + (costing ? 2 : 0) + (role === 'logistics' ? 1 : 0)} style={{ height: 60, padding: 0, borderBottom: 0 }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {inventory.length > 0 && (
          <Pagination
            meta={invMeta}
            onPage={goToInventoryPage}
            className="[&_button]:min-h-[42px]! [&_button]:p-[0_16px]! [&_button]:text-[13px]! [&_.pagination-summary]:text-[13px]! [&>div>span]:text-[13px]! [&>div]:gap-[11px]! [&>div>span]:min-w-[118px]!"
          />
        )}
      </Section>

      <Section
        title="Supply requests"
        className="[.bp-drawer-scroll_&]:[order:-1] [grid-area:requests] [&_.panel-title]:[background:color-mix(in_srgb,_var(--bg)_94%,_transparent)] [&_.panel-title]:min-h-[58px] [&_.panel-title_h2]:text-[17.5px] [&_.panel-title_h2]:uppercase [&_.panel-title_h2]:tracking-[.05em] [&_.panel-title_span]:text-[14px]"
        meta={activeRequests.length ? `${activeRequests.length} open` : 'No open requests'}
      >
        {activeRequests.length > 0 && (
          <ul className="m-0 p-0 [list-style:none] flex flex-col">
            {activeRequests.map((request) => (
              <li className="flex items-center justify-between gap-[14px] p-[14px_18px] border-b border-b-line last:border-b-0 [&_.status-pill]:min-h-[30px]! [&_.status-pill]:p-[5px_13px]! [&_.status-pill]:text-[11.5px]!" key={request.id}>
                <div className="min-w-0">
                  <strong className="block text-text text-[16px] font-[760] [font-family:ui-monospace,monospace]">{request.request_number}</strong>
                  <small className="block mt-[4px] text-muted text-[13.5px] leading-[1.5]">
                    Target {formatDate(request.target_delivery_date) || '—'}
                    {' · '}
                    {(request.items || []).slice(0, 2).map((item) => item.name).join(', ')}{(request.items || []).length > 2 ? '…' : ''}
                  </small>
                </div>
                <StatusBadge value={request.status} label={request.status === 'returned' ? 'Returned – waiting for branch' : supplyStatusLabel(request.status)} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end p-[12px_18px] border-t border-t-line">
          <button type="button" className="primary-button min-h-[36px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_8px_22px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12.5px] font-[720] cursor-pointer [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-1px)] [&:hover:not(:disabled)]:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_28%,_transparent)]" onClick={onOpenRequests}>
            Open in Supply Requests
          </button>
        </div>
      </Section>

      <Section
        title="Needs attention"
        className="[grid-area:attention] [&_.panel-title]:[background:color-mix(in_srgb,_var(--bg)_94%,_transparent)] [@container_bp-full_(min-width:860px)]:[.bp-full-grid_&]:self-stretch [&_.panel-title_h2]:text-[16px] [&_.panel-title_span]:text-[14px]"
        meta={attentionTotal ? (thresholds.description || "Based on each material's low and critical levels") : 'Nothing needs attention'}
      >
        {error ? (
          <div className="flex flex-col items-center gap-[8px] p-[32px_22px] text-center" role="alert">
            <p className="m-0 text-text text-[15.5px] font-[740]">Couldn't load stock levels</p>
            <p className="m-0 text-text-secondary text-[14.5px] leading-[1.5]">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="ghost-button mt-[4px] min-h-[38px] inline-flex items-center justify-center p-[0_16px] border border-line-strong rounded-[9px] text-text-secondary [background:transparent] text-[14px] font-[650] cursor-pointer hover:text-text hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
              >
                Retry
              </button>
            )}
          </div>
        ) : loading && !attentionTotal ? (
          <div className="flex flex-col gap-[12px] p-[14px_16px]" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center justify-between gap-3 [animation:apDotPulse_1.2s_ease-in-out_infinite]">
                <span className="block h-[13px] w-[180px] rounded-[6px] [background:var(--surface-strong)]" />
                <span className="block h-[13px] w-[72px] rounded-[6px] [background:var(--surface-strong)]" />
              </div>
            ))}
          </div>
        ) : attentionTotal === 0 ? (
          <div className="flex flex-col items-center gap-[10px] p-[36px_22px] text-center">
            <span
              aria-hidden="true"
              className="grid place-items-center w-[46px] h-[46px] border rounded-[50%] text-[20px] [color:var(--success-text)] [border-color:color-mix(in_srgb,_var(--success)_58%,_transparent)] [background:color-mix(in_srgb,_var(--success)_10%,_transparent)]"
            >
              <FaCheck />
            </span>
            <p className="m-0 text-text text-[15px] font-[760]">All materials are above their low levels</p>
            <p className="m-0 max-w-[430px] text-text-secondary text-[13.5px] leading-[1.55]">
              Nothing needs your attention right now. Items will appear here when their stock reaches the low or critical level.
            </p>
          </div>
        ) : (
          <>
            <div className="flex-none flex flex-col gap-[8px] p-[8px_14px_10px] border-b border-b-line">
              <div className="flex flex-wrap items-center gap-[6px]" role="group" aria-label="Filter by stock status">
                {attentionChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    aria-pressed={attentionStatus === chip.key}
                    onClick={() => setAttentionStatus(chip.key)}
                    className={attentionChipClass(attentionStatus === chip.key)}
                  >
                    {chip.label}
                    <span className="opacity-80">{chip.count}</span>
                  </button>
                ))}
              </div>
              <input
                type="search"
                value={attentionSearch}
                onChange={(event) => setAttentionSearch(event.target.value)}
                placeholder="Search material"
                aria-label="Search material"
                className="min-h-[34px] w-full p-[6px_11px] border border-line-strong rounded-[9px] [background:var(--input-bg)] text-text text-[13.5px] [outline:none] placeholder:text-placeholder focus:border-accent focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_14%,_transparent)]"
              />
            </div>

            <div ref={attentionListRef} className="h-[480px] overflow-y-auto">
              {/* Switching status filters slides the new list in. */}
              <div key={attentionStatus} className="ap-list-slide">
              {loading && attentionTotal === 0 && (
                <div className="flex flex-col gap-[12px] p-[14px_16px]" aria-hidden="true">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="flex items-center justify-between gap-3 [animation:apDotPulse_1.2s_ease-in-out_infinite]">
                      <span className="block h-[13px] w-[180px] rounded-[6px] [background:var(--surface-strong)]" />
                      <span className="block h-[13px] w-[72px] rounded-[6px] [background:var(--surface-strong)]" />
                    </div>
                  ))}
                </div>
              )}
              {(!loading || attentionTotal > 0) && attentionFiltered.length === 0 && (
                <div className="p-[28px_18px] text-center">
                  <p className="m-0 text-text text-[14px] font-[720]">Nothing matches</p>
                  <p className="m-0 mt-[4px] text-text-secondary text-[13px]">Try another status or clear the search.</p>
                </div>
              )}
              {attentionGroupsView.map((group) => {
                const tone = ATTENTION_TONES[group.status];
                return (
                  <div key={group.status}>
                    <div className="sticky top-0 z-[2] flex items-center gap-[7px] px-[14px] py-[6px] border-b border-b-line [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [backdrop-filter:blur(8px)] text-text-secondary text-[12.5px] font-[720]">
                      <span aria-hidden="true" className="w-[7px] h-[7px] rounded-[50%]" style={{ background: tone.dot }} />
                      {tone.label} · {group.rows.length}
                    </div>
                    <ul className="m-0 p-0 [list-style:none]">
                      {group.rows.map((item) => {
                        const qty = formatQuantity(item.on_hand ?? 0, item.unit);
                        const lowLabel = formatQuantity(item.low_level ?? 0, item.unit);
                        const criticalLabel = formatQuantity(item.critical_level ?? 0, item.unit);
                        const barMax = Math.max((Number(item.low_level) || 0) * 1.5, Number(item.on_hand) || 0, 1);
                        const pct = (value) => Math.min(100, Math.max(0, ((Number(value) || 0) / barMax) * 100));
                        return (
                          <li
                            key={item.material_id ?? item.label}
                            className="flex items-start gap-[12px] px-[14px] py-[10px] border-b border-b-line last:border-b-0"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-[7px]">
                                <strong className="text-text text-[15.5px] font-[760] leading-[1.25]">{item.label}</strong>
                                <span
                                  className="inline-flex flex-none items-center gap-[5px] text-[12px] font-[720] whitespace-nowrap"
                                  style={{ color: tone.text }}
                                >
                                  <span aria-hidden="true" className="w-[6px] h-[6px] rounded-[50%]" style={{ background: tone.dot }} />
                                  {tone.label}
                                </span>
                              </div>
                              <p className="m-0 mt-[4px] text-text-secondary text-[13.5px] leading-[1.45]">
                                {group.status === 'out'
                                  ? <><strong className="text-text font-[750]">Out of stock</strong>{` · critical at ${criticalLabel}`}</>
                                  : <><strong className="text-text font-[750]">{qty}</strong>{` left · ${group.status === 'critical' ? 'critical' : 'low'} at ${group.status === 'critical' ? criticalLabel : lowLabel}`}</>}
                              </p>
                              <div className="relative mt-[7px] h-[5px] w-full max-w-[300px] rounded-[999px] [background:color-mix(in_srgb,_var(--border)_70%,_transparent)]">
                                <span className="absolute left-0 top-0 bottom-0 rounded-[999px]" style={{ width: `${pct(item.on_hand)}%`, background: tone.dot }} />
                                <span aria-hidden="true" className="absolute top-[-3px] bottom-[-3px] w-[2px] [background:color-mix(in_srgb,_var(--text)_45%,_transparent)]" style={{ left: `${pct(item.critical_level)}%` }} />
                                <span aria-hidden="true" className="absolute top-[-3px] bottom-[-3px] w-[2px] [background:color-mix(in_srgb,_var(--text)_45%,_transparent)]" style={{ left: `${pct(item.low_level)}%` }} />
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
              </div>
            </div>

            <div className="flex-none flex items-center justify-between gap-[12px] p-[8px_14px] border-t border-t-line">
              <span className="text-text-secondary text-[13px] font-[600]">
                Showing {attentionShown.length} of {attentionFiltered.length} items that need attention
              </span>
              {attentionFiltered.length > attentionVisible && (
                <button
                  type="button"
                  onClick={() => setAttentionVisible((count) => count + ATTENTION_PAGE_SIZE)}
                  className="ghost-button min-h-[32px] inline-flex items-center justify-center p-[0_12px] border border-line-strong rounded-[9px] text-text-secondary [background:transparent] text-[13px] font-[650] cursor-pointer hover:text-text hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                >
                  Load 10 more
                </button>
              )}
            </div>
          </>
        )}
        {!error && attentionTotal === 0 && !loading && (
          <div className="flex items-center justify-between gap-[12px] p-[10px_16px] border-t border-t-line">
            <span className="text-text-secondary text-[13px] font-[600]">All materials checked</span>
          </div>
        )}
      </Section>

      <Section
        title="Delivery fulfillment"
        className="bp-sec-deliveries [grid-area:deliveries] [&_.panel-title]:[background:color-mix(in_srgb,_var(--bg)_94%,_transparent)] [@container_bp-full_(min-width:860px)]:[.bp-full-grid_&]:self-stretch [&_.panel-title_h2]:text-[16px] [&_.panel-title_span]:text-[14px]"
        meta={loading && !deliveries.length ? 'Loading…' : `${filteredDeliveries.length} delivered`}
      >
        {/* Filters stay put while the list scrolls. */}
        <div className="flex-none flex flex-col gap-[8px] p-[8px_14px_10px] border-b border-b-line">
          <div className="flex flex-wrap items-center gap-[6px]" role="group" aria-label="Delivery date presets">
            <button type="button" aria-pressed={!deliveryHasRange} onClick={clearDeliveryFilter} className={deliveryChipClass(!deliveryHasRange)}>All</button>
            {DELIVERY_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={deliveryPreset === preset.key}
                onClick={() => applyDeliveryPreset(preset.key)}
                className={deliveryChipClass(deliveryPreset === preset.key)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-[10px]">
            <label className="inline-flex items-center gap-[6px] text-text-secondary text-[13px] font-[600]">
              From
              <input type="date" aria-label="Deliveries from date" value={deliveryFrom} onChange={editDeliveryDate(setDeliveryFrom)} className={deliveryInputClass} />
            </label>
            <label className="inline-flex items-center gap-[6px] text-text-secondary text-[13px] font-[600]">
              To
              <input type="date" aria-label="Deliveries to date" value={deliveryTo} onChange={editDeliveryDate(setDeliveryTo)} className={deliveryInputClass} />
            </label>
            {deliveryHasRange && (
              <button type="button" onClick={clearDeliveryFilter} className="text-accent-text text-[13px] font-[650] underline cursor-pointer [background:none] border-0 focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]">
                Clear filter
              </button>
            )}
          </div>
        </div>

        <div className="h-[480px] overflow-y-auto @container" aria-live="polite">
          {/* Switching presets or dates slides the new list in. */}
          <div key={`${deliveryPreset}|${deliveryFrom}|${deliveryTo}`} className="ap-list-slide">
          {loading && !deliveries.length && (
            <div className="flex flex-col gap-[12px] p-[14px_16px]" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center justify-between gap-3 [animation:apDotPulse_1.2s_ease-in-out_infinite]">
                  <span className="block h-[13px] w-[180px] rounded-[6px] [background:var(--surface-strong)]" />
                  <span className="block h-[13px] w-[64px] rounded-[6px] [background:var(--surface-strong)]" />
                </div>
              ))}
            </div>
          )}
          {(!loading || deliveries.length > 0) && filteredDeliveries.length === 0 && (
            <div className="p-[26px_18px] text-center">
              <p className="m-0 text-text text-[15px] font-[720]">No deliveries in this date range</p>
              <p className="m-0 mt-[4px] text-text-secondary text-[14px]">Widen the range or clear the filter to see earlier deliveries.</p>
            </div>
          )}
          {visibleDeliveries.map((delivery) => {
            const items = delivery.items || [];
            const itemCount = Number(delivery.item_count ?? items.length);
            const isOpen = deliveryOpenId === delivery.id;
            return (
              <article
                key={delivery.id}
                className={`border-b border-b-line last:border-b-0 [transition:background_.18s_ease] ${isOpen ? '[background:color-mix(in_srgb,_var(--bg)_68%,_var(--panel))]' : ''}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setDeliveryOpenId(isOpen ? null : delivery.id)}
                  className="w-full flex items-start justify-between gap-[12px] p-[12px_16px] border-0 [background:transparent] text-left cursor-pointer hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]"
                >
                  <span className="min-w-0">
                    <strong className="block text-text text-[15px] font-[760] [font-family:ui-monospace,monospace]">{delivery.request_number}</strong>
                    <span className="block mt-[3px] text-text-secondary text-[14px]">{formatDate(delivery.delivered_at, true)}</span>
                  </span>
                  <span className="flex-none flex items-center gap-[10px]">
                    <span className="min-h-[28px] inline-flex items-center p-[3px_11px] border border-line rounded-[999px] text-text-secondary text-[14px] font-[650] whitespace-nowrap">
                      {formatNumber(itemCount)} item{itemCount === 1 ? '' : 's'}
                    </span>
                    <FaAngleRight aria-hidden="true" className={`text-text-secondary text-[13px] [transition:transform_.2s_ease] motion-reduce:[transition:none] ${isOpen ? '-rotate-90' : 'rotate-90'}`} />
                  </span>
                </button>
                {/* Slide open/closed with a 0fr → 1fr grid row, so no measuring is needed. */}
                <div
                  className={`grid [transition:grid-template-rows_.28s_cubic-bezier(.22,_.8,_.24,_1)] motion-reduce:[transition:none] ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                  aria-hidden={!isOpen}
                >
                  <div className="overflow-hidden">
                  <div className="p-[2px_16px_12px]">
                    <ul className="m-0 w-full p-0 [list-style:none] grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-x-[24px] max-[640px]:grid-cols-[minmax(0,_1fr)] @max-[520px]:grid-cols-[minmax(0,_1fr)]">
                      {items.map((item, index) => (
                        <li
                          key={`${delivery.id}-${index}`}
                          className="flex min-w-0 items-baseline justify-between gap-[10px] py-[9px] text-text-secondary text-[14px] leading-[1.4] [border-bottom:1px_dashed_color-mix(in_srgb,_var(--border)_90%,_transparent)]"
                        >
                          <span className="min-w-0 flex-1 truncate">{item.name}</span>
                          <span className="flex-none text-text text-[14px] font-[700] [font-variant-numeric:tabular-nums] whitespace-nowrap">{formatQuantity(item.quantity, item.unit)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  </div>
                </div>
              </article>
            );
          })}
          </div>
        </div>

        <div className="flex-none flex items-center justify-between gap-[12px] p-[8px_14px] border-t border-t-line">
          <span className="text-text-secondary text-[13px] font-[600]">Showing {visibleDeliveries.length} of {filteredDeliveries.length}</span>
          {visibleDeliveries.length < filteredDeliveries.length && (
            <button
              type="button"
              onClick={() => setDeliveryVisible((count) => count + DELIVERY_PAGE_SIZE)}
              className="ghost-button min-h-[32px] inline-flex items-center justify-center p-[0_12px] border border-line-strong rounded-[9px] text-text-secondary [background:transparent] text-[13px] font-[650] cursor-pointer hover:text-text hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
            >
              Load 10 more
            </button>
          )}
        </div>
      </Section>

      <Section
        title="Branch Detail"
        className="[grid-area:detail] [&_.panel-title_h2]:text-[16px] [&_.panel-title_span]:text-[14px]"
        meta={branch.archived_at ? 'Archived branch' : branch.is_active ? 'Active branch' : 'Inactive branch'}
      >
        <dl className="m-0 p-[6px_15px_12px] grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[0_22px] [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&>div]:p-[10px_0] [&>div]:border-b [&>div]:border-b-[color:color-mix(in_srgb,_var(--border)_60%,_transparent)] [&_dt]:text-muted [&_dt]:text-[14px] [&_dt]:tracking-[.01em] [&_dd]:m-0 [&_dd]:text-text-secondary [&_dd]:text-[15px] [&_dd]:font-[700] [&_dd]:text-right [&_dd]:[overflow-wrap:anywhere] [.bp-full-grid_&]:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[1181px]:later:[.bp-full-grid_&]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[761px]:later:grid-cols-[minmax(0,_1fr)] max-[761px]:later-2:[.bp-full-grid_&]:grid-cols-[minmax(0,_1fr)]">
          <div><dt>Branch name</dt><dd>{branch.name || '—'}</dd></div>
          <div><dt>Branch code</dt><dd>{branch.branch_code || '—'}</dd></div>
          <div><dt>Brand</dt><dd style={{ color: brand.color }}>{brandLabelOf(branch)}</dd></div>
          <div><dt>Owner / operator</dt><dd>{branch.operator?.full_name || 'Not assigned'}</dd></div>
          <div><dt>Contact</dt><dd>{branch.contact_number || branch.operator?.phone || '—'}</dd></div>
          <div><dt>Location</dt><dd>{locationOf(branch)}</dd></div>
          <div><dt>Address</dt><dd>{branch.address || '—'}</dd></div>
          <div><dt>Portal account</dt><dd>{branch.portal_active ? 'Portal active' : branch.operator ? `No portal account (${branch.operator.account_status || 'inactive'})` : 'No portal account'}</dd></div>
          {branch.archived_at && (
            <div><dt>Archived</dt><dd>{formatDate(branch.archived_at, true)}{branch.archived_by?.full_name ? ` · ${branch.archived_by.full_name}` : ''}{branch.archive_reason ? ` · ${branch.archive_reason}` : ''}</dd></div>
          )}
          <div><dt>Last activity</dt><dd>{formatDate(branch.last_activity_at, true)}</dd></div>
        </dl>
        {role === 'admin' && (
          <div className="flex flex-wrap gap-[10px] mt-[14px] [&_.danger]:text-danger-text [&_button]:min-h-[42px] [&_button]:p-[0_16px] [&_button]:text-[14px] [&_button]:font-[650]">
            <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onBranchAction?.('location', branch)}>Edit location</button>
            {branch.archived_at
              ? <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onBranchAction?.('restore', branch)}>Restore branch</button>
              : <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px] danger [&.ap-btn]:text-[#fca5a5] [&.ap-btn]:border-[rgba(248,_113,_113,_0.35)]" onClick={() => onBranchAction?.('archive', branch)}>Archive branch</button>}
            {branch.operator && (branch.operator.account_status === 'active'
              ? <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px] danger [&.ap-btn]:text-[#fca5a5] [&.ap-btn]:border-[rgba(248,_113,_113,_0.35)]" onClick={() => onBranchAction?.('deactivate', branch)}>Deactivate franchisee account</button>
              : <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onBranchAction?.('reactivate', branch)}>Reactivate franchisee account</button>)}
          </div>
        )}
      </Section>
    </>
  );
}

const BRANCH_ACTIONS = {
  location: { title: 'Edit location', button: 'Save location' },
  archive: { title: 'Archive branch', button: 'Archive branch', reason: 'Why is this branch archived?', danger: true },
  restore: { title: 'Restore branch', button: 'Restore branch' },
  deactivate: { title: 'Deactivate franchisee account', button: 'Deactivate account', reason: 'Why is this account deactivated?', danger: true },
  reactivate: { title: 'Reactivate franchisee account', button: 'Reactivate account' },
};

/**
 * Admin branch actions. Nothing is ever deleted: archiving hides the branch and
 * closes its portal, deactivating stops the account from signing in; both need a
 * reason and are logged (who, when, why), and both can be undone.
 */
function BranchActionModal({ action, onClose, onDone }) {
  const { kind, branch } = action;
  const config = BRANCH_ACTIONS[kind];
  const [reason, setReason] = useState('');
  const [form, setForm] = useState(() => ({
    name: branch.name || '',
    city: branch.city || '',
    province: branch.province || '',
    address: branch.address && branch.address !== 'Location not set' ? branch.address : '',
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const brandLabel = brandLabelOf(branch);

  const submit = async (event) => {
    event.preventDefault();
    if (config.reason && reason.trim().length < 3) {
      setError('Enter a reason (at least 3 characters).');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (kind === 'location') {
        const city = form.city.trim();
        if (!city) {
          setError('Enter the city or area of this branch.');
          return;
        }
        await api.put(`/locations/${branch.id}`, {
          name: form.name.trim() || `${brandLabel} · ${city}`,
          city,
          province: form.province.trim() || null,
          address: form.address.trim() || city,
        });
        await onDone('Branch location saved.');
      } else if (kind === 'archive') {
        await api.post(`/branches/${branch.id}/archive`, { reason: reason.trim() });
        await onDone('Branch archived. Turn on "Show archived" to see or restore it.', { leaveBranch: true });
      } else if (kind === 'restore') {
        await api.post(`/branches/${branch.id}/restore`);
        await onDone('Branch restored.');
      } else if (kind === 'deactivate') {
        await api.post(`/branches/${branch.id}/deactivate-account`, { reason: reason.trim() });
        await onDone('Franchisee account deactivated. It can no longer sign in; the branch history is kept.');
      } else if (kind === 'reactivate') {
        await api.post(`/branches/${branch.id}/reactivate-account`);
        await onDone('Franchisee account reactivated.');
      }
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${config.title} · ${branch.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className={config.danger ? 'danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]' : 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]'} form="branch-action-form" disabled={saving}>
            {saving ? 'Saving…' : config.button}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="branch-action-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        {kind === 'location' && (
          <>
            <Field label="City / area" required hint="Shown as the branch card title.">
              <input required maxLength={100} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} placeholder="e.g. Muntinlupa City" />
            </Field>
            <Field label="Province (optional)">
              <input maxLength={100} value={form.province} onChange={(event) => setForm({ ...form, province: event.target.value })} />
            </Field>
            <Field label="Address" full>
              <input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Street, barangay, city" />
            </Field>
            <Field label="Branch name" full hint={`Suggested: ${brandLabel} · ${form.city.trim() || 'City'}`}>
              <input maxLength={255} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
          </>
        )}
        {config.reason && (
          <Field label="Reason" required full hint="Saved with your name and the time.">
            <textarea required rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={config.reason} />
          </Field>
        )}
      </form>
      {kind === 'archive' && <p className="muted-note text-muted text-[8px] leading-[1.6]">The branch leaves the list and its portal closes. Inventory, requests, deliveries and production are kept, and you can restore it.</p>}
      {kind === 'deactivate' && <p className="muted-note text-muted text-[8px] leading-[1.6]">The account can no longer sign in to the branch portal and open sessions end. All branch history is kept.</p>}
      {kind === 'restore' && <p className="muted-note text-muted text-[8px] leading-[1.6]">The branch returns to the list and its portal opens again.</p>}
    </Modal>
  );
}

/**
 * Admin: one material's Low (reorder) and Critical level, typed in the
 * material's own unit (g, ml, pcs …), with a readable preview (kg / L).
 */
/* The four stock readings and the colour each one uses in the badge / chips. */
const LEVEL_TONES = {
  out: { label: 'No stock', color: '#e5484d', text: 'var(--danger-text)' },
  critical: { label: 'Critical', color: '#f0526b', text: 'var(--danger-text)' },
  low: { label: 'Low stock', color: '#f0b429', text: 'var(--warning-text)' },
  ok: { label: 'Normal', color: '#30a46c', text: 'var(--success-text)' },
};

/** Same order the server uses: No stock → Critical → Low → Normal. */
function levelStatus(onHand, low, critical) {
  const qty = Number(onHand) || 0;
  if (qty <= 0) return 'out';
  if (qty <= (Number(critical) || 0)) return 'critical';
  if (qty <= (Number(low) || 0)) return 'low';
  return 'ok';
}

/**
 * Admin / logistics: one material's Low (reorder) and Critical level, typed in
 * the material's own unit (g, ml, pcs …), with a live preview of the reading.
 */
function MaterialLevelsModal({ branchId, material, onClose, onSaved }) {
  const initialLow = material.low_level === null || material.low_level === undefined ? '' : String(material.low_level);
  const initialCritical = material.critical_level === null || material.critical_level === undefined ? '' : String(material.critical_level);
  // Estimated Requirement: optional perishable cap on the cover period (1–60 days, empty = no cap).
  const initialCover = material.max_cover_days === null || material.max_cover_days === undefined ? '' : String(material.max_cover_days);

  const [low, setLow] = useState(initialLow);
  const [critical, setCritical] = useState(initialCritical);
  const [maxCover, setMaxCover] = useState(initialCover);
  const [touched, setTouched] = useState({ low: false, critical: false, cover: false });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const unit = material.unit || '';
  // pcs, packs, boxes, bottles…: the API requires whole numbers too.
  const wholeOnly = Boolean(material.count_unit);
  const defaults = defaultLevelsFor(unit);
  const onHand = Number(material.on_hand) || 0;
  const onHandLabel = material.on_hand_display || formatQuantity(material.on_hand ?? 0, unit);

  const lowValue = Number(low);
  const criticalValue = Number(critical);
  const coverValue = maxCover.trim() === '' ? null : Number(maxCover);

  const lowError = low.trim() === ''
    ? 'Enter the Low level.'
    : lowValue < 1
      ? `Low level must be at least 1 ${unit}.`.trim()
      : wholeOnly && !Number.isInteger(lowValue)
        ? 'Use whole numbers only.'
        : '';
  const criticalError = critical.trim() === ''
    ? 'Enter the Critical level.'
    : criticalValue < 0
      ? 'Critical level cannot be negative.'
      : wholeOnly && !Number.isInteger(criticalValue)
        ? 'Use whole numbers only.'
        : !lowError && !(criticalValue < lowValue)
          ? `Critical must be lower than Low (${formatQuantity(lowValue, unit)}).`
          : '';
  const coverError = coverValue === null
    ? ''
    : !Number.isInteger(coverValue) || coverValue < 1 || coverValue > 60
      ? 'Use a whole number from 1 to 60, or leave it empty.'
      : '';
  const invalid = Boolean(lowError || criticalError || coverError);
  const dirty = low !== initialLow || critical !== initialCritical || maxCover !== initialCover;

  const previewStatus = levelStatus(onHand, low || 0, critical || 0);
  const previewTone = LEVEL_TONES[previewStatus];

  // Bar scale: a little headroom past the biggest of on hand / Low.
  const barMax = Math.max(onHand, lowValue || 0, 1) * 1.1;
  const pctOf = (value) => Math.min(100, Math.max(0, ((Number(value) || 0) / barMax) * 100));
  const critPct = pctOf(criticalValue || 0);
  const lowPct = Math.max(critPct, pctOf(lowValue || 0));
  const onHandPct = pctOf(onHand);
  // Real (not washed-out) colours: red below Critical, amber to Low, green above.
  const track = [
    'linear-gradient(90deg',
    `#e5484d 0%`,
    `#e5484d ${critPct}%`,
    `#f0b429 ${critPct}%`,
    `#f0b429 ${lowPct}%`,
    `#30a46c ${lowPct}%`,
    `#30a46c 100%)`,
  ].join(', ');

  const chips = [
    { key: 'out', label: 'No stock', range: '0' },
    { key: 'critical', label: 'Critical', range: criticalValue > 0 ? `1–${formatQuantity(criticalValue, unit)}` : '—' },
    { key: 'low', label: 'Low', range: lowValue > criticalValue ? `${formatQuantity(criticalValue + 1, unit)}–${formatQuantity(lowValue, unit)}` : '—' },
    { key: 'ok', label: 'Normal', range: `${formatQuantity(Math.max(lowValue, 0) + 1, unit)}+` },
  ];

  const submit = async (event) => {
    event.preventDefault();
    setTouched({ low: true, critical: true, cover: true });
    if (invalid) return;
    setSaving(true);
    setError('');
    try {
      await api.patch(`/branches/${branchId}/materials/${material.id}/levels`, { low_level: lowValue, critical_level: criticalValue });
      if (maxCover.trim() !== initialCover) {
        await api.patch(`/branches/${branchId}/materials/${material.id}/levels`, { max_cover_days: coverValue });
      }
      await onSaved(`Stock levels for ${material.name} saved.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  /** Form-only: put back the auto-calculated default for this unit. Nothing is saved yet. */
  const resetToDefault = () => {
    setLow(String(defaults.low));
    setCritical(String(defaults.critical));
    setMaxCover('');
    setTouched({ low: true, critical: true, cover: true });
  };

  const inputClass = 'w-full h-[52px] pl-[14px] pr-[58px] border rounded-[12px] [background:var(--input-bg)] text-text text-[22px] font-[600] [outline:none] [transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] focus:border-accent focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_14%,_transparent)] focus:[background:var(--input-focus-bg)] [appearance:textfield] [&::-webkit-outer-spin-button]:[appearance:none] [&::-webkit-inner-spin-button]:[appearance:none]';
  const labelClass = 'flex items-center gap-[5px] text-text text-[14px] font-[650]';
  const suffixClass = 'absolute right-[14px] top-1/2 [transform:translateY(-50%)] text-text-secondary text-[14px] font-[600] pointer-events-none';

  return (
    <Modal
      title={(
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-text text-[17px] font-[780] leading-[1.2] tracking-[-.01em]">Edit stock levels</span>
          <span className="truncate text-text-secondary text-[14px] font-[500] leading-[1.35]">
            {material.name} · counted in {unit || 'units'}
          </span>
        </span>
      )}
      onClose={onClose}
      className="rounded-[14px]! max-[451px]:rounded-[12px]!"
      footer={(
        <div className="flex w-full flex-wrap items-center gap-[8px_10px]">
          <span className={`mr-auto whitespace-nowrap text-[14px] font-[650] [transition:color_.18s_ease] max-[541px]:hidden ${dirty ? 'text-[color:var(--warning-text)]' : 'text-text-secondary'}`}>
            {dirty ? 'Unsaved changes' : 'No changes yet'}
          </span>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-[8px]">
          <button type="button" onClick={onClose} className="ghost-button min-h-[42px]! inline-flex items-center justify-center p-[0_16px]! max-[451px]:p-[0_11px]! border border-line-strong rounded-[10px] text-text-secondary [background:transparent]! text-[14px]! max-[451px]:text-[13px]! font-[650]! whitespace-nowrap cursor-pointer hover:text-text hover:border-accent">Cancel</button>
          <button
            type="button"
            className="ghost-button min-h-[42px]! inline-flex items-center justify-center p-[0_16px]! max-[451px]:p-[0_11px]! border border-line-strong rounded-[10px] text-text-secondary [background:transparent]! text-[14px]! max-[451px]:text-[13px]! font-[650]! whitespace-nowrap cursor-pointer hover:text-text hover:border-accent disabled:opacity-50 disabled:cursor-default"
            disabled={saving}
            onClick={resetToDefault}
          >
            Reset to default
          </button>
          <button
            className="primary-button min-h-[42px]! inline-flex items-center justify-center gap-2 p-[0_18px]! max-[451px]:p-[0_12px]! border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[14px]! max-[451px]:text-[13px]! font-[720]! whitespace-nowrap tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:disabled]:text-muted [&:disabled]:[background:var(--surface-subtle)] [&:disabled]:cursor-not-allowed [&:disabled]:[box-shadow:none] [&:disabled]:opacity-100"
            form="material-levels-form"
            disabled={saving || invalid || !dirty}
          >
            {saving ? 'Saving…' : 'Save levels'}
          </button>
          </span>
        </div>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="material-levels-form" className="flex flex-col gap-[18px]" onSubmit={submit} noValidate>
        {/* 1. Summary: on hand + live reading */}
        <div className="flex flex-wrap items-start justify-between gap-[12px_18px]">
          <div className="min-w-0">
            <p className="m-0 text-text-secondary text-[14px] font-[600]">On hand now</p>
            <p className="m-0 mt-[2px] text-text text-[30px] font-[790] leading-[1.1]">{onHandLabel}</p>
          </div>
          <span className="inline-flex flex-none items-center gap-[8px] text-[16px] font-[730] whitespace-nowrap" style={{ color: previewTone.text }}>
            <span aria-hidden="true" className="w-[8px] h-[8px] rounded-[50%]" style={{ background: previewTone.color }} />
            {previewTone.label}
          </span>
        </div>

        {/* 2. Stock bar with the Critical / Low markers */}
        <div>
          <div className="relative h-[14px] rounded-[999px] overflow-hidden" style={{ background: track }} aria-hidden="true">
            <span className="absolute top-0 bottom-0 w-[2px] [background:rgba(255,255,255,.75)]" style={{ left: `${critPct}%` }} />
            <span className="absolute top-0 bottom-0 w-[2px] [background:rgba(255,255,255,.9)]" style={{ left: `${lowPct}%` }} />
            <span className="absolute top-0 bottom-0 w-[3px] rounded-[2px] [background:#fff] [box-shadow:0_0_8px_rgba(255,255,255,.75)]" style={{ left: `${onHandPct}%`, transform: 'translateX(-50%)' }} />
          </div>
          <div className="mt-[8px] flex flex-wrap items-center justify-between gap-[4px_14px] text-[14px] font-[650]">
            <span className="text-[color:var(--danger-text)]">Critical at {formatQuantity(criticalValue || 0, unit)}</span>
            <span className="text-[color:var(--warning-text)]">Low at {formatQuantity(lowValue || 0, unit)}</span>
          </div>
        </div>

        {/* 3. Low + Critical */}
        <div className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[541px]:grid-cols-[minmax(0,_1fr)]">
          <div>
            <label className={labelClass} htmlFor="material-levels-low">
              Low level <span className="text-[color:var(--danger-text)]" aria-hidden="true">*</span>
            </label>
            <div className="relative mt-[6px]">
              <input
                id="material-levels-low"
                type="number"
                inputMode="decimal"
                min="1"
                step={wholeOnly ? '1' : '0.001'}
                value={low}
                onChange={(event) => { setLow(event.target.value); setTouched((prev) => ({ ...prev, low: true })); }}
                onBlur={() => setTouched((prev) => ({ ...prev, low: true }))}
                aria-invalid={touched.low && Boolean(lowError)}
                aria-describedby={touched.low && lowError ? 'material-levels-low-help' : undefined}
                className={`${inputClass} ${touched.low && lowError ? 'border-[color:var(--danger)]' : 'border-line-strong'}`}
              />
              <span className={suffixClass}>{unit}</span>
            </div>
            {touched.low && lowError && <span id="material-levels-low-help" className="block mt-[6px] text-[14px] font-[600] text-[color:var(--danger-text)]">{lowError}</span>}
          </div>
          <div>
            <label className={labelClass} htmlFor="material-levels-critical">
              Critical level <span className="text-[color:var(--danger-text)]" aria-hidden="true">*</span>
            </label>
            <div className="relative mt-[6px]">
              <input
                id="material-levels-critical"
                type="number"
                inputMode="decimal"
                min="0"
                step={wholeOnly ? '1' : '0.001'}
                value={critical}
                onChange={(event) => { setCritical(event.target.value); setTouched((prev) => ({ ...prev, critical: true })); }}
                onBlur={() => setTouched((prev) => ({ ...prev, critical: true }))}
                aria-invalid={touched.critical && Boolean(criticalError)}
                aria-describedby={touched.critical && criticalError ? 'material-levels-critical-help' : undefined}
                className={`${inputClass} ${touched.critical && criticalError ? 'border-[color:var(--danger)]' : 'border-line-strong'}`}
              />
              <span className={suffixClass}>{unit}</span>
            </div>
            {touched.critical && criticalError && <span id="material-levels-critical-help" className="block mt-[6px] text-[14px] font-[600] text-[color:var(--danger-text)]">{criticalError}</span>}
          </div>
        </div>

        {/* 4. Max cover days */}
        <div>
          <label className={labelClass} htmlFor="material-levels-cover">
            Max cover days <span className="text-text-secondary text-[14px] font-[500]">(optional, for perishables)</span>
          </label>
          <div className="relative mt-[6px]">
            <input
              id="material-levels-cover"
              type="number"
              inputMode="numeric"
              min="1"
              max="60"
              step="1"
              value={maxCover}
              placeholder="No cap"
              onChange={(event) => { setMaxCover(event.target.value); setTouched((prev) => ({ ...prev, cover: true })); }}
              onBlur={() => setTouched((prev) => ({ ...prev, cover: true }))}
              aria-invalid={touched.cover && Boolean(coverError)}
              aria-describedby={touched.cover && coverError ? 'material-levels-cover-help' : undefined}
              className={`${inputClass} max-w-[240px] max-[541px]:max-w-none ${touched.cover && coverError ? 'border-[color:var(--danger)]' : 'border-line-strong'} [font-size:18px] placeholder:text-placeholder placeholder:font-[500]`}
            />
            <span className={suffixClass}>days</span>
          </div>
          {touched.cover && coverError && <span id="material-levels-cover-help" className="block mt-[6px] text-[14px] font-[600] text-[color:var(--danger-text)]">{coverError}</span>}
        </div>

        {/* 5. How the reading will behave */}
        <div className="pt-[16px] border-t border-t-line">
          <p className="m-0 mb-[8px] text-text text-[15px] font-[700]">How status will read</p>
          <div className="grid grid-cols-[repeat(4,_minmax(0,_1fr))] gap-[8px] max-[601px]:grid-cols-[repeat(2,_minmax(0,_1fr))]">
            {chips.map((chip) => {
              const active = previewStatus === chip.key;
              return (
                <div key={chip.key} className="min-w-0">
                  <span className={`flex items-center gap-[6px] text-[14px] [transition:color_.18s_ease] ${active ? 'text-text font-[750]' : 'text-text-secondary font-[600]'}`}>
                    <span aria-hidden="true" className="w-[7px] h-[7px] flex-none rounded-[50%]" style={{ background: LEVEL_TONES[chip.key].color }} />
                    <span className="truncate">{chip.label}</span>
                  </span>
                  <span className={`block mt-[2px] truncate text-[14px] [transition:color_.18s_ease] ${active ? 'text-text font-[600]' : 'text-text-secondary font-[500]'}`}>{chip.range}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 6. Reference notes */}
        <div>
          <ul className="m-0 p-0 [list-style:none] flex flex-col gap-[6px] text-text-secondary text-[14px] leading-[1.5] [&>li]:relative [&>li]:pl-[14px] [&>li::before]:[content:'•'] [&>li::before]:absolute [&>li::before]:left-0 [&>li::before]:text-muted">
            <li>
              Default for this unit: <strong className="text-text font-[700]">Low {formatQuantity(defaults.low, unit)}</strong>
              {' · '}
              <strong className="text-text font-[700]">Critical {formatQuantity(defaults.critical, unit)}</strong>
            </li>
            <li>{wholeOnly ? 'Use whole numbers only.' : 'Up to 3 decimals are allowed for this unit.'}</li>
            <li>Every change is logged with who, when, and the old and new values.</li>
          </ul>
        </div>
      </form>
    </Modal>
  );
}


/* ------------------------------------------------------------------ *
 * Alert list under the summary cards: Low-stock items, Critical items
 * (critical + no stock) or Stale data. Closed by default; one at a time.
 * Opening it never marks anything as seen — only "Mark as seen" does.
 * ------------------------------------------------------------------ */
const ALERT_TITLES = { low: 'Low-stock items', critical: 'Critical items', stale: 'Stale data' };
const CHIP = {
  low: 'text-[#1a1305] [background:#fbbf24]',
  critical: 'text-danger-text [background:color-mix(in_srgb,var(--danger)_16%,transparent)]',
  out: 'text-danger-text [background:color-mix(in_srgb,var(--danger)_16%,transparent)]',
};

// Searchable branch dropdown: fixed-height, scrollable list so long branch lists stay usable.
function BranchPicker({ branches, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };
  const selected = branches.find((branch) => String(branch.id) === String(value));
  const shown = branches.filter((branch) => branch.name.toLowerCase().includes(term.trim().toLowerCase()));
  const pick = (id) => { onChange(id); setOpen(false); setTerm(''); };
  return (
    <span className="relative inline-block">
      <button ref={btnRef} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={toggle} className="min-h-[36px] max-w-[220px] p-[0_12px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text text-[13px] font-[600] cursor-pointer truncate">
        {selected ? selected.name : 'All branches'} ▾
      </button>
      {open && createPortal(
        <div style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 1000 }} className="w-[260px] p-2 border border-line-strong rounded-[12px] [background:var(--panel)] [box-shadow:var(--shadow-sm)]">
          <input type="search" autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search branch…" aria-label="Search branch" className="w-full min-h-[34px] mb-2 p-[6px_10px] border border-line-strong rounded-[8px] [background:var(--input-bg)] text-text text-[13px]" />
          <ul role="listbox" className="m-0 p-0 [list-style:none] max-h-[220px] overflow-y-auto">
            <li><button type="button" onClick={() => pick('')} className="w-full text-left p-[6px_8px] border-0 rounded-[8px] [background:none] text-text text-[13px] cursor-pointer hover:[background:var(--hover)]">All branches</button></li>
            {shown.map((branch) => (
              <li key={branch.id}><button type="button" onClick={() => pick(String(branch.id))} className="w-full text-left p-[6px_8px] border-0 rounded-[8px] [background:none] text-text text-[13px] cursor-pointer hover:[background:var(--hover)]">{branch.name}</button></li>
            ))}
            {shown.length === 0 && <li className="p-[6px_8px] text-muted text-[13px]">No branch found</li>}
          </ul>
        </div>,
        document.body,
      )}
    </span>
  );
}

function AlertList({ kind, closing = false, items, branches, newCount, marking, onMarkSeen, onClose, onViewBranch, error = '', loaded = true, onRetry }) {
  // Low / Critical come from GET /branches/stock-alerts; Stale comes from the overview already on the page.
  const fromAlerts = kind !== 'stale';
  const [brandFilter, setBrandFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  // Click a row to highlight every row of the same branch; click again to clear.
  const [markedBranch, setMarkedBranch] = useState(null);
  const toggleMarked = (branchId) => setMarkedBranch((current) => (Number(current) === Number(branchId) ? null : branchId));
  // Brand of each branch id, so alert items (which only carry branch_id) can be filtered by brand.
  const brandByBranch = new Map(branches.map((branch) => [Number(branch.id), brandKeyOf(branch)]));
  const rowsAll = kind === 'stale'
    ? branches.filter((branch) => branch.is_stale).sort((a, b) => new Date(a.last_count_at || 0) - new Date(b.last_count_at || 0))
    : items.filter((item) => (kind === 'low' ? item.status === 'low' : item.status !== 'low'));
  const brandOfRow = (row) => (kind === 'stale' ? brandKeyOf(row) : brandByBranch.get(Number(row.branch_id)) || '');
  const rowBranch = (row) => (kind === 'stale' ? Number(row.id) : Number(row.branch_id));
  const byBrand = brandFilter ? rowsAll.filter((row) => brandOfRow(row) === brandFilter) : rowsAll;
  const filteredRows = branchFilter ? byBrand.filter((row) => String(rowBranch(row)) === branchFilter) : byBrand;
  // 10 rows per page; go back to page 1 whenever a filter changes.
  const [alertPage, setAlertPage] = useState(1);
  useEffect(() => { setAlertPage(1); }, [brandFilter, branchFilter, kind]);
  const alertLastPage = Math.max(1, Math.ceil(filteredRows.length / 10));
  const alertCurPage = Math.min(alertPage, alertLastPage);
  const rows = filteredRows.slice((alertCurPage - 1) * 10, alertCurPage * 10);
  const subtitle = kind === 'stale'
    ? 'No physical count in 3+ days · On-hand figures may be higher than actual'
    : `${newCount ? `${newCount} new since you last checked` : 'Nothing new since you last checked'} · newest first`;
  const rowClass = 'grid grid-cols-[110px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,.8fr)_auto] max-[981px]:grid-cols-[1fr_1fr] items-center gap-[10px_16px] p-[12px_18px] border-t border-t-line text-[13px]';
  return (
    <section id="branch-alert-list" className={`bp-alert-list-enter data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)]${closing ? ' is-closing' : ''}`} aria-labelledby="branch-alert-list-title">
      <div className="flex flex-wrap items-start justify-between gap-3 p-[14px_18px]">
        <div>
          <h2 id="branch-alert-list-title" className="m-0 text-text text-[16px] font-[780]">{ALERT_TITLES[kind]}</h2>
          <small className="text-muted text-[12px]">{subtitle}</small>
        </div>
        <span className="flex gap-2">
          <BranchPicker branches={branches} value={branchFilter} onChange={setBranchFilter} />
          <select
            aria-label="Filter by brand"
            value={brandFilter}
            onChange={(event) => setBrandFilter(event.target.value)}
            className="min-h-[36px] p-[0_12px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text text-[13px] font-[600] cursor-pointer"
          >
            <option value="">All brands</option>
            {Object.entries(BRANDS).map(([key, brand]) => <option key={key} value={key}>{brand.label}</option>)}
          </select>
          {kind !== 'stale' && (
            <button type="button" className="ghost-button min-h-[36px] p-[0_14px] border border-line-strong rounded-[10px] text-text-secondary text-[13px] font-[650] disabled:opacity-50" disabled={marking || !newCount} onClick={onMarkSeen}>
              {marking ? 'Saving…' : 'Mark as seen'}
            </button>
          )}
          <button type="button" className="bp-alert-close" aria-label="Close the list" onClick={onClose}>
            <FaXmark aria-hidden="true" />
          </button>
        </span>
      </div>
      {fromAlerts && error ? (
        <div className="p-[14px_18px] border-t border-t-line">
          <Notice type="error">{`The stock alerts could not be loaded: ${error}`}</Notice>
          <button type="button" className="ghost-button min-h-[36px] p-[0_14px] border border-line-strong rounded-[10px] text-text-secondary text-[13px] font-[650]" onClick={onRetry}>Retry</button>
        </div>
      ) : fromAlerts && !loaded ? (
        <div className="p-[14px_18px] border-t border-t-line"><LoadingState label="Loading stock alerts…" /></div>
      ) : rows.length === 0 ? (
        <p className="m-0 p-[14px_18px] border-t border-t-line text-muted text-[13px]">{kind === 'stale' ? 'Every branch with materials was counted in the last 3 days.' : 'No items in this list right now.'}</p>
      ) : kind === 'stale' ? (
        <ul className="bp-alert-rows m-0 p-0 [list-style:none]">
          {rows.map((branch) => (
            <li key={branch.id} onClick={() => toggleMarked(branch.id)} className={`grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] max-[981px]:grid-cols-[1fr_1fr] items-center gap-[10px_16px] p-[12px_18px] border-t border-t-line text-[13px] cursor-pointer ${Number(markedBranch) === Number(branch.id) ? '[background:color-mix(in_srgb,var(--accent)_8%,transparent)]' : ''}`}>
              <span><strong className="text-text">{branch.name}</strong>{branch.is_demo && <small className="ml-2 text-muted">Demo</small>}</span>
              <span><small className="block text-muted">Last count</small><b className="text-[color:var(--warning-text)] font-[650]">{lastCountLabel(branch.last_count_at)}</b></span>
              <span><small className="block text-muted">Last production or activity</small>{changedAgo(branch.last_production_at || branch.last_activity_at)}</span>
              <button type="button" className="p-0 border-0 [background:none] text-accent-text font-[700] cursor-pointer hover:underline" onClick={(event) => { event.stopPropagation(); onViewBranch(branch.id); }}>View branch →</button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="bp-alert-rows m-0 p-0 [list-style:none]">
          {rows.map((item) => (
            <li key={item.material_id} onClick={() => toggleMarked(item.branch_id)} className={`${rowClass} cursor-pointer ${Number(markedBranch) === Number(item.branch_id) ? '[background:color-mix(in_srgb,var(--accent)_8%,transparent)]' : item.is_new ? '[background:color-mix(in_srgb,var(--accent)_6%,transparent)]' : ''}`}>
              <span className={`justify-self-start p-[3px_10px] rounded-[999px] text-[11px] font-[800] ${CHIP[item.status] || ''}`}>{item.status_label}</span>
              <span className="min-w-0">
                <strong className="text-text">{item.material_name}</strong>
                {item.is_new && <span className="ml-2 p-[1px_7px] rounded-[999px] text-[10px] font-[800] text-accent-text [background:color-mix(in_srgb,var(--accent)_18%,transparent)]">NEW</span>}
                <small className="block text-muted">{item.branch_name}</small>
              </span>
              <span>
                <strong className="text-text">{item.on_hand_display}</strong>
                <small className="block text-muted">{item.status === 'out' ? `No stock (critical at ${item.critical_level_display})` : item.status === 'critical' ? `Critical at ${item.critical_level_display}` : `Low at ${item.low_level_display}`}</small>
              </span>
              <span>
                {item.open_request
                  ? <span className="text-text-secondary">{item.open_request.request_number} {supplyStatusLabel(item.open_request.status).toLowerCase()}</span>
                  : <span className="text-[color:var(--warning-text)] font-[650]">No open supply request</span>}
              </span>
              <span className="text-muted">{changedAgo(item.stock_status_changed_at || item.source_at)}{item.source ? ` · ${item.source}` : ''}</span>
              <button type="button" className="justify-self-end p-0 border-0 [background:none] text-accent-text font-[700] cursor-pointer hover:underline" onClick={(event) => { event.stopPropagation(); onViewBranch(item.branch_id, item.material_id); }}>View branch →</button>
            </li>
          ))}
        </ul>
      )}
      {rowsAll.length > 0 && filteredRows.length > 10 && (
        <div className="flex items-center justify-between gap-3 p-[12px_18px] border-t border-t-line text-[13px] text-text-secondary">
          <small className="text-muted">Page {alertCurPage} of {alertLastPage} · {filteredRows.length} items</small>
          <span className="flex gap-2">
            <button type="button" className="min-h-[36px] p-[0_14px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text font-[650] cursor-pointer disabled:opacity-40 disabled:cursor-default" disabled={alertCurPage <= 1} onClick={() => setAlertPage(alertCurPage - 1)}>← Back</button>
            <button type="button" className="min-h-[36px] p-[0_14px] border border-line-strong rounded-[10px] [background:var(--panel)] text-text font-[650] cursor-pointer disabled:opacity-40 disabled:cursor-default" disabled={alertCurPage >= alertLastPage} onClick={() => setAlertPage(alertCurPage + 1)}>Next →</button>
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * Branch lookup used in place of the free-text search: a searchable dropdown of the active branches.
 * Typing filters the options; picking one narrows the card grid to that branch.
 * An × inside the field clears the typed text (and the picked branch).
 */
function BranchLookup({ branches, value, onChange, placeholder = 'Search branches, locations or brands' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  const listId = 'bp-branch-lookup-list';
  const selected = branches.find((branch) => String(branch.id) === String(value));

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((branch) => [branch.name, branch.location_label, branch.brand?.name, branch.preferred_branch_type]
      .filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [branches, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => { listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' }); }, [active]);

  const pick = (option) => {
    setQuery('');
    setOpen(false);
    onChange(option ? String(option.id) : '');
  };
  const clear = () => { setQuery(''); setActive(0); onChange(''); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (open && options[active]) pick(options[active]); }
    else if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); setQuery(''); }
  };

  return (
    <span className="relative block flex-[1_1_auto] min-w-0" ref={wrapRef}>
      <input
        type="text"
        className="w-full"
        role="combobox"
        aria-label="Search branches"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={open ? query : (selected?.name || '')}
        placeholder={selected?.name || placeholder}
        style={{ paddingRight: 40 }}
        onFocus={() => { setOpen(true); setQuery(''); setActive(0); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
      />
      {(query || value) && (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-[8px] top-[50%] [transform:translateY(-50%)] z-2 inline-grid place-items-center w-[24px] h-[24px] p-0 border-0 rounded-[7px] [background:transparent] text-muted cursor-pointer [transition:color_.15s_ease,_background_.15s_ease] hover:text-text hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={clear}
        >
          <FaXmark aria-hidden="true" />
        </button>
      )}
      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Branches"
          className="absolute top-[calc(100%_+_4px)] left-0 right-0 z-30 m-0 p-1 [list-style:none] max-h-[280px] overflow-y-auto [background:var(--panel)] border border-line-strong rounded-[10px] [box-shadow:var(--shadow-md)]"
        >
          {options.length ? options.map((branch, index) => (
            <li
              key={branch.id}
              role="option"
              aria-selected={String(branch.id) === String(value)}
              className={`p-[8px_11px] rounded-[7px] cursor-pointer text-[13px] text-text hover:[background:var(--hover)] ${index === active ? '[background:var(--hover)]' : ''} ${String(branch.id) === String(value) ? 'font-[700]' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(branch)}
            >
              {branch.name}
              <small className="block text-muted text-[11.5px] font-[400]">
                {[branch.location_label, branch.brand?.name].filter(Boolean).join(' · ') || 'Branch'}
              </small>
            </li>
          )) : <li className="p-[8px_11px] text-[13px] text-muted" role="option" aria-disabled="true" aria-selected="false">No branch matches</li>}
        </ul>
      )}
    </span>
  );
}

export default function Branches() {
  const { role } = useAuth();
  const navigate = useNavigate();
  // 'default' (list) | 'half' (list + panel) | 'full' (five sections only)
  const [view, setView] = useState('default');
  const [selectedId, setSelectedId] = useState(null);
  const [branchPick, setBranchPick] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  // Half view: 6 cards per page; a card picked from a lower page is pinned to the first slot.
  const LIST_PER_PAGE = 6;
  const [pinnedId, setPinnedId] = useState(null);
  const [listPage, setListPage] = useState(1);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [panelClosing, setPanelClosing] = useState(false);
  const closeTimer = useRef(null);

  // Filters: demo data shown by default; archived branches only on request (Admin).
  const [showDemo, setShowDemo] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const overview = useRemote(
    () => api.get('/branches/overview', showArchived ? { include_archived: 1 } : {}),
    [showArchived],
  );
  const payload = overview.data?.data;
  const branches = useMemo(() => payload?.branches || [], [payload?.branches]);

  const operations = useRemote(
    () => (selectedId ? api.get(`/branches/${selectedId}/operations`) : Promise.resolve(null)),
    [selectedId],
  );
  // Stock alerts for the Low / Critical cards (refreshed with the page's live sync, no extra polling).
  const alerts = useRemote(() => api.get('/branches/stock-alerts', showArchived ? { include_archived: 1 } : {}), [showArchived]);
  const [alertList, setAlertList] = useState(null); // 'low' | 'critical' | 'stale' | null — closed by default
  const [alertClosing, setAlertClosing] = useState(false);
  const alertCloseTimer = useRef(null);
  useEffect(() => () => {
    if (alertCloseTimer.current) window.clearTimeout(alertCloseTimer.current);
  }, []);
  const [markingSeen, setMarkingSeen] = useState(false);
  const ops = operations.data?.data ?? null;
  const opsMatch = ops && Number(ops.branch?.id) === Number(selectedId);
  const opsForBranch = opsMatch ? ops : null;

  const selected = branches.find((branch) => Number(branch.id) === Number(selectedId)) || null;

  const visibleBranches = useMemo(() => (showDemo ? branches : branches.filter((branch) => !branch.is_demo))
    .filter((branch) => !brandFilter || brandKeyOf(branch) === brandFilter), [branches, showDemo, brandFilter]);

  // The branch lookup only offers active (non-archived) branches.
  const lookupBranches = useMemo(() => visibleBranches.filter((branch) => !branch.archived_at), [visibleBranches]);

  const filtered = useMemo(() => (branchPick
    ? visibleBranches.filter((branch) => String(branch.id) === String(branchPick))
    : visibleBranches), [visibleBranches, branchPick]);

  // Drop a picked branch that no longer exists after a reload.
  useEffect(() => {
    if (branchPick && !branches.some((branch) => String(branch.id) === String(branchPick))) setBranchPick('');
  }, [branches, branchPick]);

  const pinnedFirst = useMemo(() => {
    const pinned = filtered.find((branch) => Number(branch.id) === Number(pinnedId));
    return pinned ? [pinned, ...filtered.filter((branch) => branch !== pinned)] : filtered;
  }, [filtered, pinnedId]);
  const listLastPage = Math.max(1, Math.ceil(pinnedFirst.length / LIST_PER_PAGE));
  const listCurPage = Math.min(listPage, listLastPage);
  const listItems = view === 'half'
    ? pinnedFirst.slice((listCurPage - 1) * LIST_PER_PAGE, listCurPage * LIST_PER_PAGE)
    : pinnedFirst;

  const selectedIndex = branches.findIndex((branch) => Number(branch.id) === Number(selectedId));

  // Clear a running close timer when the page unmounts.
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  // Live sync (no broadcasting is set up, so this polls): every N seconds from the
  // server (default 30), paused while the tab is hidden, refreshed at once when it
  // comes back, and never a new request while one is still pending.
  const { reload: reloadOverview } = overview;
  const { reload: reloadOperations } = operations;
  const { reload: reloadAlerts } = alerts;
  const syncSeconds = Math.max(10, Number(payload?.live_sync_seconds) || 30);
  const syncing = useRef(false);
  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      await Promise.all([
        reloadOverview({ silent: true }),
        reloadAlerts({ silent: true }),
        selectedId ? reloadOperations({ silent: true }) : null,
      ]);
    } finally {
      syncing.current = false;
    }
  }, [reloadOverview, reloadOperations, reloadAlerts, selectedId]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncNow();
    }, syncSeconds * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void syncNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [syncNow, syncSeconds]);

  useEffect(() => {
    const refresh = () => { void reloadOverview({ silent: true }); };
    window.addEventListener('herald:branch-account-created', refresh);
    return () => window.removeEventListener('herald:branch-account-created', refresh);
  }, [reloadOverview]);

  const openBranch = (branch) => {
    if (!branch) return;
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setPanelClosing(false);
    setSelectedId(branch.id);
    // A card below the first row of the visible list is pinned to the top slot; a card in the first row goes back.
    const cardEl = document.getElementById(`branch-card-${branch.id}`);
    const firstEl = cardEl?.parentElement?.firstElementChild;
    const onPage1 = listCurPage === 1 && pinnedFirst.findIndex((item) => Number(item.id) === Number(branch.id)) < LIST_PER_PAGE;
    const isLower = !onPage1 || (cardEl && firstEl && cardEl.getBoundingClientRect().top > firstEl.getBoundingClientRect().top + 8);
    setPinnedId(isLower ? branch.id : null);
    setListPage(1);
    setView('half');
    setNotice('');
    setActionError('');
    // Only jump to the top when opening from the default view; clicking cards while half view is open must stay put.
    if (view !== 'half' && typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const backToList = () => {
    setNotice('');
    setActionError('');
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setView('default');
      setSelectedId(null);
      return;
    }
    setPanelClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPanelClosing(false);
      setView('default');
      setSelectedId(null);
      setPinnedId(null);
    }, 220);
  };

  const openFull = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setPanelClosing(false);
    setView('full');
  };

  const selectAdjacent = (offset) => {
    const next = branches[selectedIndex + offset];
    if (!next) return;
    setSelectedId(next.id);
    setNotice('');
    setActionError('');
  };

  const markSeen = async () => {
    setMarkingSeen(true);
    try {
      await api.post('/branches/stock-alerts/seen', {});
      await Promise.all([reloadAlerts({ silent: true }), reloadOverview({ silent: true })]);
      window.dispatchEvent(new Event('herald:stock-alerts-updated'));
    } catch (caught) {
      setActionError(firstValidationMessage(caught));
    } finally {
      setMarkingSeen(false);
    }
  };
  const closeAlertList = () => {
    if (!alertList || alertClosing) return;
    setAlertClosing(true);
    alertCloseTimer.current = window.setTimeout(() => {
      alertCloseTimer.current = null;
      setAlertList(null);
      setAlertClosing(false);
    }, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 240);
  };
  const toggleAlertList = (kind) => {
    if (alertList === kind) {
      closeAlertList();
      return;
    }
    if (alertCloseTimer.current) window.clearTimeout(alertCloseTimer.current);
    alertCloseTimer.current = null;
    setAlertClosing(false);
    setAlertList(kind);
  };
  const alertItems = (alerts.data?.data?.items || []).filter((item) => showDemo || !item.is_demo);
  const newCounts = {
    low: alertItems.filter((item) => item.is_new && item.status === 'low').length,
    critical: alertItems.filter((item) => item.is_new && item.status !== 'low').length,
  };

  // "View branch →" in the alert lists: scroll to the branch's card below and highlight it.
  const [highlightedId, setHighlightedId] = useState(null);
  const highlightTimer = useRef(null);
  useEffect(() => () => {
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, []);
  // Material row to highlight in Branch Inventory (set from a Low / Critical "View branch").
  const [focusMaterial, setFocusMaterial] = useState(null);
  const scrollToBranchCard = (id, materialId = null) => {
    const branch = branches.find((b) => Number(b.id) === Number(id));
    if (!branch) return;
    // Make sure the card is in the list: clear a search that hides it, show demo branches if needed.
    if (!filtered.some((b) => Number(b.id) === Number(id))) {
      if (branchPick) setBranchPick('');
      if (branch.is_demo && !showDemo) setShowDemo(true);
    }
    // Open the branch in half view, pinned to the first slot like a normal card click.
    openBranch(branch);
    setFocusMaterial(materialId == null ? null : { id: Number(materialId), key: Date.now() });
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let tries = 0;
    // Wait for the re-render (a few frames at most) before scrolling.
    const attempt = () => {
      const card = document.getElementById(`branch-card-${branch.id}`);
      if (!card) {
        tries += 1;
        if (tries < 20) window.requestAnimationFrame(attempt);
        return;
      }
      card.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      card.focus({ preventScroll: true });
      setHighlightedId(Number(branch.id));
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => {
        highlightTimer.current = null;
        setHighlightedId(null);
      }, 2500);
    };
    window.requestAnimationFrame(attempt);
  };

  const [levelsTarget, setLevelsTarget] = useState(null);
  const [branchAction, setBranchAction] = useState(null);

  const sections = (
    <BranchSections
      focusMaterial={focusMaterial}
      ops={opsForBranch}
      loading={operations.loading}
      error={operations.error}
      role={role}
      onOpenRequests={() => navigate(`/supply-requests?tab=all&location_id=${selectedId}`)}
      onEditLevels={setLevelsTarget}
      onRetry={() => operations.reload?.()}
      onBranchAction={(kind, branch) => setBranchAction({ kind, branch })}
      animateFilters={view === 'full'}
    />
  );

  return (
    <div className="page-container w-full m-[0_auto] p-[clamp(10px,_1.2vw,_16px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] branches-page [--bp-surface:color-mix(in_srgb,_var(--panel)_92%,_transparent)] [--bp-surface-soft:color-mix(in_srgb,_var(--panel-2)_70%,_transparent)] [--bp-border:color-mix(in_srgb,_var(--border)_78%,_transparent)] [--bp-brand:var(--accent)] [--bp-radius:18px] [--bp-ease:cubic-bezier(.22,_.8,_.24,_1)] min-w-0 [overflow-x:clip]">
      <Notice type="error">{overview.error || actionError}</Notice>
      <Notice type="success">{notice}</Notice>

      {overview.loading && !payload ? <LoadingState label="Loading branches…" /> : !branches.length ? (
        <EmptyState
          label={showArchived ? 'No branches were found.' : 'No active branches were found.'}
          detail="Configure active franchise locations with branch codes to display them here."
        />
      ) : (
        <>
          {view !== 'full' && (
            <section className="metric-grid grid gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] later-4:grid-cols-[repeat(6,_minmax(0,_1fr))] max-[1281px]:later-5:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-6:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-7:grid-cols-[1fr] [.branches-page_&]:gap-3 [.branches-page_&]:mb-4 [.branches-page_&_.metric-card]:min-h-0! [.branches-page_&_.metric-card]:p-[12px_16px]! [.branches-page_&_.metric-card]:gap-[2px]! [.branches-page_&_.metric-card]:[box-shadow:none] [.branches-page_&_.metric-card]:[background:var(--bp-surface)] [.branches-page_&_.metric-card:hover]:[box-shadow:var(--shadow-sm)] [.branches-page_&_.metric-top]:mb-0! [.branches-page_&_.metric-icon]:w-[26px]! [.branches-page_&_.metric-icon]:h-[26px]! [.branches-page_&_.metric-icon]:text-[.72rem]! [.branches-page_&_.metric-icon]:text-muted [.branches-page_&_.metric-icon]:[background:transparent] [.branches-page_&_.metric-icon]:border-0 [.branches-page_&_.metric-card>strong]:text-[1.5rem]! [.branches-page_&_.metric-card>strong]:leading-[1.1]! [.branches-page_&_.metric-card>strong]:m-[2px_0_0]! [.branches-page_&_.metric-caption]:text-[.68rem]! [.branches-page_&_.metric-caption]:m-0!" aria-label="Branch network summary">
              {metrics.map(([key, label, Icon, caption]) => {
                const kind = ALERT_CARDS[key];
                const value = payload?.summary?.[key];
                const fresh = kind === 'low' ? newCounts.low : kind === 'critical' ? newCounts.critical : 0;
                const body = (
                  <>
                    <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span className="inline-flex items-center gap-[6px]">{kind === 'critical' && fresh > 0 && <span className="w-[7px] h-[7px] rounded-[50%] [background:var(--danger)] motion-safe:animate-pulse" aria-hidden="true" />}{label}</span><span className="metric-icon w-[36px] h-[36px] later:grid place-items-center rounded-[12px] text-accent-text [background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] [.metric-tone-success_&]:text-success-text [.metric-tone-success_&]:[background:color-mix(in_srgb,_var(--success)_10%,_transparent)] later:[.metric-tone-warning_&]:text-[color:var(--warning-text)] later:[.metric-tone-warning_&]:[background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] later-2:[.metric-tone-danger_&]:text-danger-text later-2:[.metric-tone-danger_&]:[background:color-mix(in_srgb,_var(--danger)_10%,_transparent)] later-3:[.metric-tone-purple_&]:text-[#b7a4ff] later-3:[.metric-tone-purple_&]:[background:rgba(139,109,255,.11)] [.dashboard-page_&]:w-[28px] [.dashboard-page_&]:h-[28px] [.dashboard-page_&]:rounded-[9px] later:[.dashboard-page_&]:text-[12px]"><Icon aria-hidden="true" /></span></div>
                    {fresh > 0 && <span className={`absolute top-[14px] right-[56px] z-2 p-[2px_8px] rounded-[999px] text-[11px] font-[800] ${kind === 'critical' ? 'text-[#fff] [background:var(--danger)]' : 'text-[#1a1305] [background:#fbbf24]'}`}>+{fresh} new</span>}
                    <strong className={kind === 'stale' && Number(value) ? 'text-[color:var(--warning-text)]!' : ''}>{formatNumber(value)}</strong>
                    <small className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{typeof caption === 'function' ? caption(payload?.summary) : caption}{kind && <span className="metric-action-hint"> · Click to view</span>}</small>
                  </>
                );
                if (!kind) return <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]" key={key}>{body}</article>;
                const open = alertList === kind;
                const tint = fresh > 0 ? (kind === 'critical' ? 'border-[color:var(--danger)]! [background:color-mix(in_srgb,var(--danger)_8%,var(--panel))]!' : 'border-[#fbbf24]! [background:color-mix(in_srgb,#fbbf24_7%,var(--panel))]!') : '';
                return (
                  <button
                    type="button"
                    key={key}
                    className={`metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px] w-full text-left cursor-pointer focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ${kind ? 'metric-card-action' : ''} ${tint} ${open ? 'border-accent! [box-shadow:0_0_0_2px_color-mix(in_srgb,var(--accent)_35%,transparent)]!' : ''}`}
                    aria-pressed={open}
                    aria-expanded={open}
                    aria-controls="branch-alert-list"
                    aria-label={`${label}: ${formatNumber(value)}${fresh ? `, ${fresh} new` : ''}. ${open ? 'Hide' : 'Show'} the list.`}
                    onClick={() => toggleAlertList(kind)}
                  >
                    {body}
                  </button>
                );
              })}
            </section>
          )}

          {view !== 'full' && alertList && (
            <AlertList
              kind={alertList}
              closing={alertClosing}
              items={alertItems}
              branches={branches.filter((branch) => !branch.archived_at && (showDemo || !branch.is_demo))}
              newCount={alertList === 'low' ? newCounts.low : alertList === 'critical' ? newCounts.critical : 0}
              marking={markingSeen}
              onMarkSeen={() => void markSeen()}
              onClose={closeAlertList}
              onViewBranch={scrollToBranchCard}
              error={alerts.error ? String(alerts.error) : ''}
              loaded={Boolean(alerts.data)}
              onRetry={() => void reloadAlerts()}
            />
          )}

          {view === 'full' ? (
            <section className="mt-[-30px] [animation:bpFadeUp_.3s_var(--bp-ease)_both] motion-reduce:later:[animation:none] [container-type:inline-size] [container-name:bp-full] min-w-0" aria-label="Branch overview">
              <header className="relative flex items-center justify-between gap-4 mb-3 min-h-[76px] p-[10px_18px] overflow-hidden rounded-[14px] border-0 [background:linear-gradient(108deg,_color-mix(in_srgb,_var(--panel)_76%,_transparent)_0%,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_24%,_color-mix(in_srgb,_var(--panel)_70%,_transparent))_56%,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_54%,_color-mix(in_srgb,_var(--panel)_64%,_transparent))_100%)] [backdrop-filter:blur(18px)_saturate(1.45)] [box-shadow:inset_0_1px_0_color-mix(in_srgb,_var(--text)_15%,_transparent),_0_16px_38px_-26px_rgba(0,0,0,.65)] [&::after]:[content:''] [&::after]:absolute [&::after]:inset-[0_0_0_auto] [&::after]:w-[54%] [&::after]:[background:linear-gradient(270deg,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_76%,_transparent),_transparent_92%)] [&::after]:pointer-events-none max-[761px]:flex-wrap max-[761px]:later:gap-2 max-[761px]:later:[&::after]:w-[66%] max-[761px]:[&::after]:opacity-[.75]" style={{ '--brand-color': getBrand(selected).color }}>
                <div className="relative z-1 flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    className="w-[44px] h-[44px] text-[18px] inline-grid place-items-center flex-none p-0 border-0 rounded-[11px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ml-[2px]"
                    onClick={backToList}
                    aria-label="Close full view"
                    title="Close"
                  >
                    <FaXmark aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="w-[44px] h-[44px] text-[18px] inline-grid place-items-center flex-none p-0 border-0 rounded-[11px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    onClick={() => selectAdjacent(-1)}
                    disabled={selectedIndex <= 0}
                    aria-label="Previous branch"
                    title="Previous branch"
                  >
                    <FaAngleLeft aria-hidden="true" />
                  </button>
                  <span className="min-w-0 overflow-hidden text-text text-[22px] font-[780] tracking-[-.02em] text-ellipsis whitespace-nowrap [animation:bpTitleIn_.22s_var(--bp-ease)_both] motion-reduce:later:[animation:none]" key={selectedId}>{selected?.name || 'Branch'}</span>
                  <button
                    type="button"
                    className="w-[44px] h-[44px] text-[18px] inline-grid place-items-center flex-none p-0 border-0 rounded-[11px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    onClick={() => selectAdjacent(1)}
                    disabled={selectedIndex < 0 || selectedIndex >= branches.length - 1}
                    aria-label="Next branch"
                    title="Next branch"
                  >
                    <FaAngleRight aria-hidden="true" />
                  </button>
                </div>
                <div className="relative z-1 flex-none pr-[6px] flex items-center">
                  {getBrand(selected).logo
                    ? (
                      <img
                        src={getBrand(selected).logo}
                        alt={brandLabelOf(selected)}
                        title={brandLabelOf(selected)}
                        draggable="false"
                        className={`block w-auto object-contain [filter:drop-shadow(0_1px_3px_rgba(0,0,0,.3))] ${brandKeyOf(selected) === 'kkopi' ? 'h-[56px] max-w-[240px]' : 'h-[48px] max-w-[210px]'}`}
                      />
                    )
                    : (
                      <span className="text-[color:color-mix(in_srgb,_var(--brand-color,_var(--accent))_20%,_white)] text-[15px] font-[820] tracking-[.12em] uppercase">{brandLabelOf(selected)}</span>
                    )}
                </div>
              </header>

              <div className="bp-full-grid grid [align-items:start] gap-[14px] [animation:bpFadeUp_.26s_var(--bp-ease)_both] max-[1181px]:later:grid-cols-[minmax(0,_1fr)] motion-reduce:later:[animation:none] later:grid-cols-[minmax(0,_1fr)] later-2:[grid-template-areas:'inventory'_'requests'_'attention'_'deliveries'_'detail'] [@container_bp-full_(min-width:860px)]:later-2:grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] [@container_bp-full_(min-width:860px)]:later-3:[grid-template-areas:'inventory_inventory'_'requests_requests'_'attention_deliveries'_'detail_detail'] max-[1181px]:later-4:[grid-template-areas:'inventory'_'requests'_'attention'_'deliveries'_'detail'] [@container_bp-full_(min-width:860px)_and_(max-width:99999px)]:later-5:[grid-template-areas:'inventory_inventory'_'requests_requests'_'attention_deliveries'_'detail_detail']" key={selectedId}>
                {sections}
              </div>
            </section>
          ) : (
            <div className={`bp-body grid grid-cols-[minmax(0,_1fr)_0px] [align-items:start] gap-0 [transition:grid-template-columns_.32s_var(--bp-ease),_gap_.32s_var(--bp-ease)] [&.is-open]:grid-cols-[minmax(0,_1fr)_minmax(340px,_440px)] [&.is-open]:gap-4 max-[1181px]:later:grid-cols-[minmax(0,_1fr)] max-[1181px]:later:gap-[14px] max-[1181px]:later:[&.is-open]:grid-cols-[minmax(0,_1fr)] max-[1181px]:later:[&.is-open]:gap-[14px] motion-reduce:later:[transition:none] min-[1181px]:later-2:[&.is-open]:grid-cols-[minmax(0,_1fr)_minmax(400px,_38%)] ${view === 'half' ? ' is-open' : ''}${panelClosing ? ' is-closing' : ''}`}>
              <section className="data-panel overflow-hidden mb-[18px] min-[1182px]:mb-0 border rounded-[12px] [border-color:color-mix(in_srgb,_var(--muted)_20%,_var(--border-strong))] [background:#0A0E19] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:[border-color:color-mix(in_srgb,_var(--muted)_36%,_var(--border-strong))] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] min-w-0 [container-type:inline-size] [container-name:bp-list] p-0 later:hover:[box-shadow:none]" aria-labelledby="bp-list-title">
                <div className="bp-list-head flex flex-wrap items-center justify-between gap-[12px_20px] p-[14px_18px] border-b border-b-line later-2:[&_h2]:m-0 [&_h2]:text-text later-2:[&_h2]:text-[20px] later:[&_h2]:font-[760] later-2:[&_h2]:tracking-[.06em]">
                  <div className="min-w-0 flex flex-col">
                    <h2 id="bp-list-title" className="uppercase">Branches</h2>
                    <small className="text-muted text-[12px] [letter-spacing:0] normal-case">{filtered.length} of {branches.length} branches</small>
                  </div>
                  <div className="flex items-center gap-3 mb-[14px] [&_select]:min-h-[40px] [&_select]:p-[0_12px] [&_select]:border [&_select]:border-line-strong [&_select]:rounded-[12px] [&_select]:[background:var(--panel)] [&_select]:text-text [&_select]:text-[14px] [&_select]:font-[600] [&_select]:cursor-pointer [&_input]:flex-[1_1_auto] [&_input]:min-w-0 [&_input]:min-h-[40px] [&_input]:p-[9px_13px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[12px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] [&_small]:flex-none [&_small]:text-muted later:[&_small]:text-[10px] [&_small]:whitespace-nowrap max-[761px]:flex-wrap max-[761px]:[&_small]:w-full [.bp-list-head_&]:flex-[1_1_260px] [.bp-list-head_&]:max-w-[520px] [.bp-list-head_&]:m-0">
                    <select
                      aria-label="Sort by brand"
                      value={brandFilter}
                      onChange={(event) => setBrandFilter(event.target.value)}
                    >
                      <option value="">All brands</option>
                      {Object.entries(BRANDS).map(([key, brand]) => <option key={key} value={key}>{brand.label}</option>)}
                    </select>
                    <BranchLookup branches={lookupBranches} value={branchPick} onChange={setBranchPick} />
                  </div>
                </div>
                {(role === 'admin' || (view === 'half' && listLastPage > 1)) && (
                <div className="flex flex-wrap items-center justify-end gap-[8px_16px] p-[4px_18px_0]">
                  <div className="flex flex-wrap gap-[6px_14px] text-text-secondary text-[12px] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-[5px] [&_label]:cursor-pointer">
                    {role === 'admin' && (
                      <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
                    )}
                    {view === 'half' && listLastPage > 1 && (
                      <span className="inline-flex items-center gap-[8px] text-text-secondary text-[14px] font-[600]">
                        <button type="button" className="inline-grid place-items-center w-[42px] h-[42px] p-0 border-0 [background:transparent] text-[30px] text-text-secondary cursor-pointer disabled:opacity-[.35] disabled:cursor-default hover:text-text" disabled={listCurPage <= 1} onClick={() => setListPage(listCurPage - 1)} aria-label="Previous page">‹</button>
                        <span>{listCurPage} / {listLastPage}</span>
                        <button type="button" className="inline-grid place-items-center w-[42px] h-[42px] p-0 border-0 [background:transparent] text-[30px] text-text-secondary cursor-pointer disabled:opacity-[.35] disabled:cursor-default hover:text-text" disabled={listCurPage >= listLastPage} onClick={() => setListPage(listCurPage + 1)} aria-label="Next page">›</button>
                      </span>
                    )}
                  </div>
                </div>
                )}

                {!filtered.length ? (
                  <EmptyState
                    label="No branches match your search."
                    detail="Try a different branch name, location or brand."
                  />
                ) : (
                  <div className="grid gap-[14px] max-[1381px]:later:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[761px]:later-2:grid-cols-[minmax(0,_1fr)] later-4:grid-cols-[repeat(auto-fill,_minmax(280px,_1fr))] p-[10px_18px_18px]" aria-label="Branches">
                    {listItems.map((branch) => (
                      <BranchCard
                        key={branch.id}
                        branch={branch}
                        active={view === 'half' && Number(branch.id) === Number(selectedId)}
                        onOpen={openBranch}
                        role={role}
                        onEditLocation={(branch) => setBranchAction({ kind: 'location', branch })}
                        highlighted={Number(branch.id) === highlightedId}
                      />
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-end gap-[6px_14px] p-[10px_18px_16px] text-text-secondary text-[12px] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-[5px] [&_label]:cursor-pointer">
                  <label><input type="checkbox" checked={showDemo} onChange={(event) => setShowDemo(event.target.checked)} /> Show demo data</label>
                </div>
              </section>

              <aside
                className="relative min-w-0 self-stretch overflow-hidden min-[1182px]:[&>div]:absolute min-[1182px]:[&>div]:inset-0 opacity-[0] [transform:translateX(18px)] [transition:opacity_.26s_var(--bp-ease),_transform_.32s_var(--bp-ease)] pointer-events-none [.bp-body.is-open_&]:opacity-[1] [.bp-body.is-open_&]:[transform:translateX(0)] [.bp-body.is-open_&]:pointer-events-auto later:[.bp-body.is-closing_&]:opacity-[0] later:[.bp-body.is-closing_&]:[transform:translateX(22px)] max-[1181px]:later:max-h-[none] max-[1181px]:later:[transform:translateY(12px)] max-[1181px]:later-2:[.bp-body.is-open_&]:[transform:translateY(0)] max-[1181px]:later-3:[.bp-body.is-closing_&]:[transform:translateY(10px)] motion-reduce:later:[transition:none]"
                aria-label="Selected branch"
                aria-hidden={view !== 'half'}
              >
                {selected && (
                  <div className="h-full flex flex-col overflow-hidden rounded-[12px] [border:1px_solid_color-mix(in_srgb,_var(--muted)_20%,_var(--border-strong))] [box-shadow:0_14px_34px_-26px_rgba(0,0,0,.7)] [background:var(--bp-surface)]">
                    <header className="flex-none flex items-start justify-between gap-2 p-[10px_12px_9px] border-b border-b-line [background:linear-gradient(120deg,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_12%,_transparent),_transparent_62%)]" style={{ '--brand-color': getBrand(selected).color }}>
                      <div className="min-w-0 later:[&_h2]:m-[1px_0_1px] [&_h2]:text-text later:[&_h2]:text-[18px] [&_h2]:font-[780] later:[&_h2]:tracking-[-.02em] [&_small]:text-text-secondary [&_small]:font-[700] later-3:[&_small]:text-[10.5px]">
                        <span className="text-[color:var(--brand-color,_var(--accent))] text-[9px] font-[780] tracking-[.1em] uppercase">{brandLabelOf(selected)}</span>
                        <h2>{locationOf(selected)}</h2>
                        <small>{selected.name}</small>
                      </div>
                      <div className="flex items-center gap-[2px] flex-none">
                        <button
                          type="button"
                          className="w-[34px] h-[34px] inline-grid place-items-center p-0 border border-transparent rounded-[10px] text-[var(--accent-text)] [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] hover:text-text hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [&_svg]:[transform-origin:center] [&_svg]:[animation:bpFullIconGlow_2.6s_ease-in-out_infinite] motion-reduce:[&_svg]:[animation:none]"
                          onClick={openFull}
                          aria-label="Open full view"
                          title="Full view"
                          tabIndex={view === 'half' ? 0 : -1}
                        >
                          <FaExpand aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="w-[34px] h-[34px] inline-grid place-items-center p-0 border border-transparent rounded-[10px] text-muted [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:[transform:translateY(-1px)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                          onClick={backToList}
                          aria-label="Close branch details"
                          title="Close"
                          tabIndex={view === 'half' ? 0 : -1}
                        >
                          <FaXmark aria-hidden="true" />
                        </button>
                      </div>
                    </header>
                    <div className="bp-drawer-scroll flex-[1_1_auto] min-h-0 flex flex-col gap-3 p-[14px] overflow-y-auto [overscroll-behavior:contain] max-[1181px]:max-h-[70dvh] [&>*]:flex-none [&_.bp-col-source]:hidden">
                      {sections}
                    </div>
                  </div>
                )}
              </aside>
            </div>
          )}
        </>
      )}

      {branchAction && (
        <BranchActionModal
          action={branchAction}
          onClose={() => setBranchAction(null)}
          onDone={async (message, { leaveBranch } = {}) => {
            setBranchAction(null);
            setNotice(message);
            if (leaveBranch) backToList();
            await syncNow();
          }}
        />
      )}

      {levelsTarget && selectedId && (
        <MaterialLevelsModal
          branchId={selectedId}
          material={levelsTarget}
          onClose={() => setLevelsTarget(null)}
          onSaved={async (message) => {
            setLevelsTarget(null);
            setNotice(message);
            await Promise.all([operations.reload?.(), overview.reload?.()]);
          }}
        />
      )}

    </div>
  );
}
