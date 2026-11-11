import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaAngleLeft,
  FaAngleRight,
  FaBoxesStacked,
  FaCircleExclamation,
  FaClipboardList,
  FaExpand,
  FaRotate,
  FaStore,
  FaTriangleExclamation,
  FaXmark,
} from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useRemote from '../lib/useRemote';
import useCosting from '../lib/useCosting';
import { EmptyState, Field, LoadingState, Modal, Notice, StatusBadge } from '../components/ApiUi';
import { defaultLevelsFor, formatQuantity, STOCK_STATUS_LABELS } from '../lib/quantity';
import { formatDate, formatNumber } from '../lib/format';
import { supplyStatusLabel } from '../lib/supplyActions';

import dailyDashLogo from '../assets/dailydash_new.png';
import goDoLogo from '../assets/godo_new.png';
import kkopiLogo from '../assets/kkopi_new.png';
import laPastaLogo from '../assets/lapasta_new.png';

const metrics = [
  ['active_branches', 'Active branches', FaStore, (summary) => `With portal account: ${formatNumber(summary?.with_portal_account || 0)}${Number(summary?.demo_with_portal_account) ? ` · ${formatNumber(summary.demo_with_portal_account)} demo` : ''}`],
  ['materials_tracked', 'Materials tracked', FaBoxesStacked, 'Inventory items across active branches'],
  ['low_stock_items', 'Low-stock items', FaTriangleExclamation, "At or below each material's low level"],
  ['critical_stock_items', 'Critical items', FaCircleExclamation, 'At or below the critical level, or no stock'],
  ['open_requests', 'Open requests', FaClipboardList, 'Awaiting completion'],
];

// Keys are normalized brand codes/names (lowercase, letters only).
const BRANDS = {
  dailydash: { label: 'Daily Dash', color: '#0565D6', logo: dailyDashLogo },
  kkopi: { label: 'Kkopi', color: '#F97D1B', logo: kkopiLogo },
  lapasta: { label: 'La Pasta', color: '#AF2525', logo: laPastaLogo },
  godo: { label: 'Godo', color: '#769D32', logo: goDoLogo },
};
const FALLBACK_BRAND = { label: '', color: '#5b6478', logo: null };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z]/g, '');

function getBrand(branch) {
  return BRANDS[normalize(branch?.brand?.code)]
    || BRANDS[normalize(branch?.brand?.name)]
    || BRANDS[normalize(branch?.preferred_branch_type)]
    || FALLBACK_BRAND;
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
function BranchCard({ branch, active, onOpen, role, onEditLocation }) {
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
      className={`bp-card relative gap-2 overflow-hidden [border:1px_solid_var(--bp-border)] rounded-[20px_20px_20px_36px] [background:var(--bp-surface)] cursor-pointer [transition:border-color_.22s_ease,_transform_.22s_ease,_box-shadow_.22s_ease,_background_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:inset-[auto_-30%_-70%_35%] [&::after]:h-[150px] [&::after]:rounded-[50%] [&::after]:[background:radial-gradient(circle,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_16%,_transparent),_transparent_66%)] [&::after]:opacity-[.65] [&::after]:pointer-events-none hover:[transform:translateY(-2px)] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] focus-visible:[outline:2px_solid_color-mix(in_srgb,_var(--brand-color,_var(--accent))_60%,_transparent)] focus-visible:[outline-offset:2px] later:[&.is-active]:border-[color:color-mix(in_srgb,_var(--brand-color,_var(--accent))_55%,_var(--border))] max-[761px]:later:min-h-[164px] motion-reduce:later:[transition:none] later:grid-cols-[minmax(0,_1fr)] later-2:min-h-0 later:flex flex-col later:p-[18px] [&::after]:hidden ${active ? ' is-active' : ''}`}
      style={{ '--brand-color': brand.color }}
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
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-danger-text [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Status</small>
            <b className={`bp-card-state is-${state}`}>{STOCK_STATUS_LABELS[state] || STOCK_STATUS_LABELS.none}</b>
          </span>
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-danger-text [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Materials</small>
            <b>{materialsSummary(branch)}</b>
          </span>
          <span className="last:border-b-0 [&_small]:text-muted [&_small]:font-[720] [&_small]:tracking-[.06em] [&_small]:uppercase [&_b]:text-text-secondary [&_b]:font-[720] [&_b.is-normal]:text-success-text [&_b.is-low]:text-[color:var(--warning-text)] [&_b.is-critical]:text-danger-text [&_b.is-ok]:text-success-text [&_b.is-out]:text-danger-text [&_b.is-none]:text-muted flex items-baseline justify-between gap-3 later:p-[9px_0] border-b later:border-b-line [&_small]:flex-none later-7:[&_small]:text-[11px] later-2:[&_b]:text-[13.5px] [&_b]:text-right">
            <small>Request</small>
            <b>{formatNumber(branch.open_request_count)}</b>
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
function Section({ title, meta, className = '', children }) {
  return (
    <section className={`data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] later:m-0 later:hover:[box-shadow:none] [&_.panel-title]:min-h-[46px] [&_.panel-title]:p-[11px_15px] [&_.panel-title_span]:text-right [&_.panel-state]:min-h-[150px] later-2:[&_.panel-title_h2]:text-[14.5px] later-2:[&_.panel-title_span]:text-[12px] [&_.panel-title:last-child]:border-b-0 ${className}`}>
      <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {children ? <div className="p-0 later:[.bp-full-grid_.bp-sec-deliveries_&]:max-h-[none] later:[.bp-full-grid_.bp-sec-deliveries_&]:overflow-visible">{children}</div> : null}
    </section>
  );
}

function BranchSections({ ops, loading, error, role, onOpenRequests, onEditLevels, onBranchAction }) {
  const costing = useCosting();
  if (loading && !ops) {
    return <Section title="Branch Inventory"><LoadingState label="Loading branch data…" /></Section>;
  }
  if (error && !ops) {
    return <Section title="Branch Inventory"><Notice type="error">{error}</Notice></Section>;
  }
  if (!ops) return null;

  const inventory = ops.inventory || [];
  const summary = ops.inventory_summary || {};
  const activeRequests = ops.active_requests || [];
  const attention = ops.needs_attention || [];
  const deliveries = ops.deliveries || [];
  const branch = ops.branch || {};
  const brand = getBrand(branch);
  const thresholds = ops.thresholds || {};

  return (
    <>
      <Section
        title="Branch Inventory"
        className="bp-sec-inventory [grid-area:inventory]"
        meta={inventory.length
          ? `${formatNumber(summary.materials ?? summary.items)} material${Number(summary.materials ?? summary.items) === 1 ? '' : 's'}`
          : 'No inventory yet'}
      >
        {inventory.length > 0 && (
          <div className="table-wrap [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer later:overflow-auto later:max-h-[none] later-2:overflow-x-auto later-2:[overflow-y:visible] later:[.bp-full-grid_.bp-sec-inventory_&]:max-h-[none] [.bp-full-grid_.bp-sec-inventory_&]:overflow-x-auto [.bp-full-grid_.bp-sec-inventory_&]:[overflow-y:visible]">
            <table className="[&_th]:top-0 [&_td_small]:text-muted later:[&_tr.is-low_td]:[background:color-mix(in_srgb,_var(--warning)_5%,_transparent)] later-2:[&_tr.is-out_td]:[background:color-mix(in_srgb,_var(--danger)_6%,_transparent)] later:min-w-[620px] later:text-[13.5px] later:[&_th]:static later:[&_th]:p-[11px_14px] later:[&_th]:text-[11.5px] [&_th]:whitespace-nowrap later:[&_td]:p-[11px_14px] [&_td]:[vertical-align:top] later:[&_td_strong]:text-[13.5px] [&_td_small]:block later:[&_td_small]:text-[11.5px] [.bp-drawer-scroll_&]:min-w-0 [.bp-drawer-scroll_&_th]:p-[10px_12px] [.bp-drawer-scroll_&_td]:p-[10px_12px]">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="bp-col-source">Source</th>
                  <th>On hand</th>
                  <th>Low / Critical</th>
                  <th>Status</th>
                  {costing && <th>Unit cost</th>}
                  {costing && <th>Stock value</th>}
                  {role === 'logistics' && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {inventory.map((row) => (
                  <tr key={row.id} className={row.status === 'out' ? 'is-out' : row.status === 'ok' ? '' : 'is-low'}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.variant && <small>{row.variant}</small>}
                      <small className="hidden [.bp-drawer-scroll_&]:block">{row.source || '—'}</small>
                    </td>
                    <td className="bp-col-source">{row.source || '—'}</td>
                    <td><strong>{row.on_hand_display || formatQuantity(row.on_hand, row.unit)}</strong></td>
                    <td>{row.low_level_display || '—'} / {row.critical_level_display || '—'}</td>
                    <td><b className={`font-[600] whitespace-nowrap later-5:[&.is-ok]:text-success-text later-6:[&.is-low]:text-[color:var(--warning-text)] later-7:[&.is-critical]:text-danger-text later-7:[&.is-out]:text-danger-text is-${row.status}`}>{STOCK_STATUS_LABELS[row.status] || '—'}</b></td>
                    {costing && <td>{row.unit_cost == null ? '—' : `₱${formatNumber(row.unit_cost, 2)}`}</td>}
                    {costing && <td>{row.stock_value == null ? '—' : `₱${formatNumber(row.stock_value, 2)}`}</td>}
                    {role === 'logistics' && (
                      <td>
                        <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onEditLevels?.(row)}>Edit levels</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Supply requests"
        className="[.bp-drawer-scroll_&]:[order:-1] [grid-area:requests]"
        meta={activeRequests.length ? `${activeRequests.length} open` : 'No open requests'}
      >
        {activeRequests.length > 0 && (
          <ul className="m-0 p-0 [list-style:none] flex flex-col">
            {activeRequests.map((request) => (
              <li className="flex items-start justify-between gap-[10px] p-[11px_15px] border-b border-b-line last:border-b-0" key={request.id}>
                <div className="min-w-0">
                  <strong className="block text-text text-[12.5px] font-[760] [font-family:ui-monospace,monospace]">{request.request_number}</strong>
                  <small className="block mt-[2px] text-muted text-[10px] leading-[1.5]">
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
        <div className="flex justify-end p-[10px_15px] border-t border-t-line">
          <button type="button" className="ghost-button min-h-[34px] inline-flex items-center justify-center gap-[7px] p-[0_12px] border border-line-strong rounded-[10px] text-text-secondary [background:transparent] text-[11px] font-[650] cursor-pointer hover:text-text hover:border-accent" onClick={onOpenRequests}>
            Open in Supply Requests
          </button>
        </div>
      </Section>

      <Section
        title="Needs Attention"
        className="[grid-area:attention] [@container_bp-full_(min-width:860px)]:[.bp-full-grid_&]:self-stretch"
        meta={attention.length
          ? (thresholds.description || "Based on each material's low and critical levels")
          : 'Nothing needs attention'}
      >
        {attention.length > 0 && (
          <ul className="m-0 p-0 [list-style:none] flex flex-col [&_li]:p-[11px_15px] [&_li]:border-b [&_li]:border-b-line [&_li:last-child]:border-b-0 [&_small]:block later:[&_small]:mt-1 [&_small]:text-muted later-4:[&_small]:text-[9px] [&_small]:leading-[1.5] [&_li.is-critical_.bp-attention-tag]:text-[color:var(--warning-text)] [&_li.is-low_.bp-attention-tag]:text-accent-text [&_li.is-out_.bp-attention-tag]:text-danger-text">
            {attention.map((item, index) => (
              <li key={`${item.material_id || index}`} className={`is-${item.status || 'low'}`}>
                <div className="flex items-center justify-between gap-[10px] [&_strong]:text-text later:[&_strong]:text-[11px] later:[&_strong]:font-[740]">
                  <strong>{item.label}</strong>
                  <StatusBadge
                    value={item.status === 'out' || item.status === 'critical' ? 'critical' : 'low'}
                    label={item.alert}
                  />
                </div>
                <small>{item.detail}</small>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Delivery Fulfillment"
        className="bp-sec-deliveries [grid-area:deliveries] [@container_bp-full_(min-width:860px)]:[.bp-full-grid_&]:self-stretch"
        meta={deliveries.length ? `${deliveries.length} delivered` : 'No deliveries yet'}
      >
        {deliveries.length > 0 && (
          <div className="flex flex-col">
            {deliveries.map((delivery) => (
              <article className="p-[12px_15px] border-b border-b-line last:border-b-0" key={delivery.id}>
                <header className="flex items-start justify-between gap-[10px] [&_strong]:block [&_strong]:text-text later:[&_strong]:text-[11px] later-2:[&_strong]:font-[760] [&_small]:block later-2:[&_small]:mt-[3px] [&_small]:text-muted later-4:[&_small]:text-[9px]">
                  <div>
                    <strong>{delivery.request_number}</strong>
                    <small>{formatDate(delivery.delivered_at, true)}</small>
                  </div>
                  <span className="flex-none text-text-secondary text-[9px] font-[740]">{formatNumber(delivery.item_count ?? (delivery.items || []).length)} item{Number(delivery.item_count ?? (delivery.items || []).length) === 1 ? '' : 's'}</span>
                </header>
                <ul className="m-[10px_0_0] p-0 [list-style:none] flex flex-col gap-1 [&_li]:flex [&_li]:items-baseline [&_li]:justify-between [&_li]:gap-3 [&_li]:text-text-secondary [&_li]:text-[10px] [&_li_span:last-child]:text-text [&_li_span:last-child]:font-[720] [&_li_span:last-child]:whitespace-nowrap">
                  {(delivery.items || []).map((item, index) => (
                    <li key={`${delivery.id}-${index}`}>
                      <span>{item.name}</span>
                      <span>{formatQuantity(item.quantity, item.unit)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Branch Detail"
        className="[grid-area:detail]"
        meta={branch.archived_at ? 'Archived branch' : branch.is_active ? 'Active branch' : 'Inactive branch'}
      >
        <dl className="m-0 p-[6px_15px_12px] grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[0_22px] [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&>div]:p-[8px_0] [&>div]:border-b [&>div]:border-b-[color:color-mix(in_srgb,_var(--border)_60%,_transparent)] [&_dt]:text-muted [&_dt]:text-[9px] [&_dt]:tracking-[.02em] [&_dd]:m-0 [&_dd]:text-text-secondary [&_dd]:text-[10px] [&_dd]:font-[700] [&_dd]:text-right [&_dd]:[overflow-wrap:anywhere] [.bp-full-grid_&]:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[1181px]:later:[.bp-full-grid_&]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[761px]:later:grid-cols-[minmax(0,_1fr)] max-[761px]:later-2:[.bp-full-grid_&]:grid-cols-[minmax(0,_1fr)]">
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
          <div className="flex flex-wrap gap-2 mt-3 [&_.danger]:text-danger-text">
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
function MaterialLevelsModal({ branchId, material, onClose, onSaved }) {
  const [low, setLow] = useState(String(material.low_level ?? ''));
  const [critical, setCritical] = useState(String(material.critical_level ?? ''));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const unit = material.unit || '';

  const submit = async (event) => {
    event.preventDefault();
    const lowValue = Number(low);
    const criticalValue = Number(critical);
    if (low === '' || critical === '' || !(lowValue >= 0) || !(criticalValue >= 0)) {
      setError('Enter both levels as zero or more (no negative values).');
      return;
    }
    if (!(criticalValue < lowValue)) {
      setError('The critical level must be lower than the low level.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.patch(`/branches/${branchId}/materials/${material.id}/levels`, { low_level: lowValue, critical_level: criticalValue });
      await onSaved(`Stock levels for ${material.name} saved.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  /** Logistics: put back the auto-calculated default for this unit (logged). */
  const resetToDefault = async () => {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/branches/${branchId}/materials/${material.id}/levels`, { reset: true });
      await onSaved(`Stock levels for ${material.name} reset to the default.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const defaults = defaultLevelsFor(unit);
  const reference = Math.max(Number(low) || 0, Number(critical) || 0);
  return (
    <Modal
      title={`Stock levels · ${material.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]"
            disabled={saving}
            title={`Default for ${unit || 'this unit'}: low ${formatQuantity(defaults.low, unit)}, critical ${formatQuantity(defaults.critical, unit)}`}
            onClick={() => void resetToDefault()}
          >
            Reset to default
          </button>
          <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="material-levels-form" disabled={saving}>{saving ? 'Saving…' : 'Save levels'}</button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="material-levels-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        <Field label={`Low level (${unit})`} required hint={low !== '' ? `= ${formatQuantity(low, unit, reference)}` : 'Reorder at or below this amount.'}>
          <input required type="number" min="0" step="0.001" value={low} onChange={(event) => setLow(event.target.value)} />
        </Field>
        <Field label={`Critical level (${unit})`} required hint={critical !== '' ? `= ${formatQuantity(critical, unit, reference)}` : 'Critical at or below this amount.'}>
          <input required type="number" min="0" step="0.001" value={critical} onChange={(event) => setCritical(event.target.value)} />
        </Field>
      </form>
      <p className="muted-note text-muted text-[8px] leading-[1.6]">On hand now: {material.on_hand_display || formatQuantity(material.on_hand, unit)}. Status order: No stock → Critical → Low → Normal.</p>
      <p className="muted-note text-muted text-[8px] leading-[1.6]">Default for this unit: low {formatQuantity(defaults.low, unit)} · critical {formatQuantity(defaults.critical, unit)}. Every change is logged (who, when, old and new values).</p>
    </Modal>
  );
}

export default function Branches() {
  const { role } = useAuth();
  const navigate = useNavigate();
  // 'default' (list) | 'half' (list + panel) | 'full' (five sections only)
  const [view, setView] = useState('default');
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
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
  const ops = operations.data?.data ?? null;
  const opsMatch = ops && Number(ops.branch?.id) === Number(selectedId);
  const opsForBranch = opsMatch ? ops : null;

  const selected = branches.find((branch) => Number(branch.id) === Number(selectedId)) || null;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const visible = showDemo ? branches : branches.filter((branch) => !branch.is_demo);
    if (!term) return visible;
    return visible.filter((branch) => [
      branch.name,
      branch.location_label,
      branch.branch_code,
      branch.city,
      branch.province,
      branch.address,
      branch.brand?.name,
      branch.preferred_branch_type,
    ].filter(Boolean).join(' ').toLowerCase().includes(term));
  }, [branches, search, showDemo]);

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
  const syncSeconds = Math.max(10, Number(payload?.live_sync_seconds) || 30);
  const syncing = useRef(false);
  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      await Promise.all([
        reloadOverview({ silent: true }),
        selectedId ? reloadOperations({ silent: true }) : null,
      ]);
    } finally {
      syncing.current = false;
    }
  }, [reloadOverview, reloadOperations, selectedId]);
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
    setView('half');
    setNotice('');
    setActionError('');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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

  const [levelsTarget, setLevelsTarget] = useState(null);
  const [branchAction, setBranchAction] = useState(null);

  const sections = (
    <BranchSections
      ops={opsForBranch}
      loading={operations.loading}
      error={operations.error}
      role={role}
      onOpenRequests={() => navigate(`/supply-requests?tab=all&location_id=${selectedId}`)}
      onEditLevels={setLevelsTarget}
      onBranchAction={(kind, branch) => setBranchAction({ kind, branch })}
    />
  );

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] branches-page [--bp-surface:color-mix(in_srgb,_var(--panel)_92%,_transparent)] [--bp-surface-soft:color-mix(in_srgb,_var(--panel-2)_70%,_transparent)] [--bp-border:color-mix(in_srgb,_var(--border)_78%,_transparent)] [--bp-brand:var(--accent)] [--bp-radius:18px] [--bp-ease:cubic-bezier(.22,_.8,_.24,_1)] min-w-0 [overflow-x:clip]">
      {/* Same compact header as the Inquiries page: title only, no eyebrow gap. */}
      <div className="[.branches-page_&]:flex [.branches-page_&]:items-center [.branches-page_&]:justify-between [.branches-page_&]:gap-4 [.branches-page_&]:m-[0_0_16px] [.branches-page_&_h1]:m-0 [.branches-page_&_h1]:text-text [.branches-page_&_h1]:text-[2rem] [.branches-page_&_h1]:font-[800] [.branches-page_&_h1]:leading-[1.15] [.branches-page_&_h1]:tracking-[-.045em] max-[761px]:later:[.branches-page_&]:items-start max-[761px]:[.branches-page_&]:flex-col max-[761px]:later:[.branches-page_&]:gap-2 max-[761px]:later:[.branches-page_&_h1]:text-[1.7rem]">
        <h1>Branches</h1>
        <div className="flex items-center gap-[10px]">
          <span className="inline-flex items-center gap-[.45rem] rounded-[999px] p-[.55rem_.8rem] [background:rgba(23,_137,_83,_.1)] text-[#147a4a] text-[.8rem] font-[800] whitespace-nowrap [&::before]:[content:''] [&::before]:w-[.48rem] [&::before]:h-[.48rem] [&::before]:rounded-[50%] [&::before]:[background:currentColor] [&::before]:[box-shadow:0_0_0_.22rem_rgba(23,_137,_83,_.12)]">Live sync · {syncSeconds} seconds</span>
          <button
            type="button"
            className="w-[34px] h-[34px] inline-grid place-items-center p-0 border border-transparent rounded-[10px] text-muted [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:[transform:translateY(-1px)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
            onClick={() => { void syncNow(); }}
            aria-label="Refresh branch data"
            title="Refresh"
          >
            <FaRotate aria-hidden="true" />
          </button>
        </div>
      </div>

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
            <section className="metric-grid grid gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] later-4:grid-cols-[repeat(5,_minmax(0,_1fr))] max-[1281px]:later-5:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-6:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-7:grid-cols-[1fr] [.branches-page_&]:gap-3 [.branches-page_&]:mb-4 [.branches-page_&_.metric-card]:min-h-0! [.branches-page_&_.metric-card]:p-[12px_16px]! [.branches-page_&_.metric-card]:gap-[2px]! [.branches-page_&_.metric-card]:[box-shadow:none] [.branches-page_&_.metric-card]:[background:var(--bp-surface)] [.branches-page_&_.metric-card:hover]:[box-shadow:var(--shadow-sm)] [.branches-page_&_.metric-top]:mb-0! [.branches-page_&_.metric-icon]:w-[26px]! [.branches-page_&_.metric-icon]:h-[26px]! [.branches-page_&_.metric-icon]:text-[.72rem]! [.branches-page_&_.metric-icon]:text-muted [.branches-page_&_.metric-icon]:[background:transparent] [.branches-page_&_.metric-icon]:border-0 [.branches-page_&_.metric-card>strong]:text-[1.5rem]! [.branches-page_&_.metric-card>strong]:leading-[1.1]! [.branches-page_&_.metric-card>strong]:m-[2px_0_0]! [.branches-page_&_.metric-caption]:text-[.68rem]! [.branches-page_&_.metric-caption]:m-0!" aria-label="Branch network summary">
              {metrics.map(([key, label, Icon, caption]) => (
                <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]" key={key}>
                  <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span>{label}</span><span className="metric-icon w-[36px] h-[36px] later:grid place-items-center rounded-[12px] text-accent-text [background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] [.metric-tone-success_&]:text-success-text [.metric-tone-success_&]:[background:color-mix(in_srgb,_var(--success)_10%,_transparent)] later:[.metric-tone-warning_&]:text-[color:var(--warning-text)] later:[.metric-tone-warning_&]:[background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] later-2:[.metric-tone-danger_&]:text-danger-text later-2:[.metric-tone-danger_&]:[background:color-mix(in_srgb,_var(--danger)_10%,_transparent)] later-3:[.metric-tone-purple_&]:text-[#b7a4ff] later-3:[.metric-tone-purple_&]:[background:rgba(139,109,255,.11)] [.dashboard-page_&]:w-[28px] [.dashboard-page_&]:h-[28px] [.dashboard-page_&]:rounded-[9px] later:[.dashboard-page_&]:text-[12px]"><Icon aria-hidden="true" /></span></div>
                  <strong>{formatNumber(payload?.summary?.[key])}</strong>
                  <small className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{typeof caption === 'function' ? caption(payload?.summary) : caption}</small>
                </article>
              ))}
            </section>
          )}

          {view === 'full' ? (
            <section className="[animation:bpFadeUp_.3s_var(--bp-ease)_both] motion-reduce:later:[animation:none] [container-type:inline-size] [container-name:bp-full] min-w-0" aria-label="Branch overview">
              <header className="relative flex items-center justify-between gap-4 mb-4 p-[8px_12px_8px_8px] overflow-hidden border-0 rounded-[16px] [background:var(--bp-surface)] [&::after]:[content:''] [&::after]:absolute [&::after]:inset-[0_0_0_auto] [&::after]:w-[46%] [&::after]:[background:linear-gradient(270deg,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_34%,_transparent),_transparent_88%)] [&::after]:pointer-events-none max-[761px]:flex-wrap max-[761px]:later:gap-2 max-[761px]:later:[&::after]:w-[60%] max-[761px]:[&::after]:opacity-[.7]" style={{ '--brand-color': getBrand(selected).color }}>
                <div className="relative z-1 flex items-center gap-1 min-w-0">
                  <button
                    type="button"
                    className="w-[32px] h-[32px] inline-grid place-items-center flex-none p-0 border-0 rounded-[9px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    onClick={() => selectAdjacent(-1)}
                    disabled={selectedIndex <= 0}
                    aria-label="Previous branch"
                    title="Previous branch"
                  >
                    <FaAngleLeft aria-hidden="true" />
                  </button>
                  <span className="min-w-0 overflow-hidden text-text text-[15px] font-[780] tracking-[-.02em] text-ellipsis whitespace-nowrap [animation:bpTitleIn_.22s_var(--bp-ease)_both] motion-reduce:later:[animation:none]" key={selectedId}>{selected?.name || 'Branch'}</span>
                  <button
                    type="button"
                    className="w-[32px] h-[32px] inline-grid place-items-center flex-none p-0 border-0 rounded-[9px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    onClick={() => selectAdjacent(1)}
                    disabled={selectedIndex < 0 || selectedIndex >= branches.length - 1}
                    aria-label="Next branch"
                    title="Next branch"
                  >
                    <FaAngleRight aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="w-[32px] h-[32px] inline-grid place-items-center flex-none p-0 border-0 rounded-[9px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ml-[2px]"
                    onClick={backToList}
                    aria-label="Close full view"
                    title="Close"
                  >
                    <FaXmark aria-hidden="true" />
                  </button>
                </div>
                <div className="relative z-1 flex-none pr-[6px] later-2:[&_span]:text-[color:color-mix(in_srgb,_var(--brand-color,_var(--accent))_82%,_white)] later-3:[&_span]:text-[11px] later-2:[&_span]:font-[820] later:[&_span]:tracking-[.12em] [&_span]:uppercase">
                  <span>{brandLabelOf(selected)}</span>
                </div>
              </header>

              <div className="bp-full-grid grid [align-items:start] gap-[14px] [animation:bpFadeUp_.26s_var(--bp-ease)_both] max-[1181px]:later:grid-cols-[minmax(0,_1fr)] motion-reduce:later:[animation:none] later:grid-cols-[minmax(0,_1fr)] later-2:[grid-template-areas:'inventory'_'requests'_'attention'_'deliveries'_'detail'] [@container_bp-full_(min-width:860px)]:later-2:grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] [@container_bp-full_(min-width:860px)]:later-3:[grid-template-areas:'inventory_inventory'_'requests_requests'_'attention_deliveries'_'detail_detail'] max-[1181px]:later-4:[grid-template-areas:'inventory'_'requests'_'attention'_'deliveries'_'detail'] [@container_bp-full_(min-width:860px)_and_(max-width:99999px)]:later-5:[grid-template-areas:'inventory_inventory'_'requests_requests'_'attention_deliveries'_'detail_detail']" key={selectedId}>
                {sections}
              </div>
            </section>
          ) : (
            <div className={`bp-body grid grid-cols-[minmax(0,_1fr)_0px] [align-items:start] gap-0 [transition:grid-template-columns_.32s_var(--bp-ease),_gap_.32s_var(--bp-ease)] [&.is-open]:grid-cols-[minmax(0,_1fr)_minmax(340px,_440px)] [&.is-open]:gap-4 max-[1181px]:later:grid-cols-[minmax(0,_1fr)] max-[1181px]:later:gap-[14px] max-[1181px]:later:[&.is-open]:grid-cols-[minmax(0,_1fr)] max-[1181px]:later:[&.is-open]:gap-[14px] motion-reduce:later:[transition:none] min-[1181px]:later-2:[&.is-open]:grid-cols-[minmax(0,_1fr)_minmax(400px,_38%)] ${view === 'half' ? ' is-open' : ''}${panelClosing ? ' is-closing' : ''}`}>
              <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] min-w-0 [container-type:inline-size] [container-name:bp-list] p-0 later:hover:[box-shadow:none]" aria-labelledby="bp-list-title">
                <div className="bp-list-head flex flex-wrap items-center justify-between gap-[12px_20px] p-[14px_18px] border-b border-b-line later-2:[&_h2]:m-0 [&_h2]:text-text later-2:[&_h2]:text-[20px] later:[&_h2]:font-[760] later-2:[&_h2]:tracking-[-.015em]">
                  <h2 id="bp-list-title">Branches</h2>
                  <div className="flex items-center gap-3 mb-[14px] [&_input]:flex-[1_1_auto] [&_input]:min-w-0 [&_input]:min-h-[40px] [&_input]:p-[9px_13px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[12px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] [&_small]:flex-none [&_small]:text-muted later:[&_small]:text-[10px] [&_small]:whitespace-nowrap max-[761px]:flex-wrap max-[761px]:[&_small]:w-full [.bp-list-head_&]:flex-[1_1_260px] [.bp-list-head_&]:max-w-[520px] [.bp-list-head_&]:m-0">
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search branches, locations or brands"
                      aria-label="Search branches"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-[8px_16px] p-[12px_18px_0] [&_small]:text-muted later-6:[&_small]:text-[12px] [&_small]:whitespace-nowrap">
                  <small>{filtered.length} of {branches.length} branches</small>
                  <div className="flex flex-wrap gap-[6px_14px] text-text-secondary text-[12px] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-[5px] [&_label]:cursor-pointer">
                    <label><input type="checkbox" checked={showDemo} onChange={(event) => setShowDemo(event.target.checked)} /> Show demo data</label>
                    {role === 'admin' && (
                      <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
                    )}
                  </div>
                </div>

                {!filtered.length ? (
                  <EmptyState
                    label="No branches match your search."
                    detail="Try a different branch name, location or brand."
                  />
                ) : (
                  <div className="grid gap-[14px] max-[1381px]:later:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[761px]:later-2:grid-cols-[minmax(0,_1fr)] later-4:grid-cols-[repeat(auto-fill,_minmax(280px,_1fr))] p-[14px_18px_18px]" aria-label="Branches">
                    {filtered.map((branch) => (
                      <BranchCard
                        key={branch.id}
                        branch={branch}
                        active={view === 'half' && Number(branch.id) === Number(selectedId)}
                        onOpen={openBranch}
                        role={role}
                        onEditLocation={(branch) => setBranchAction({ kind: 'location', branch })}
                      />
                    ))}
                  </div>
                )}
              </section>

              <aside
                className="min-w-0 max-h-[calc(100dvh_-_150px)] overflow-hidden opacity-[0] [transform:translateX(18px)] [transition:opacity_.26s_var(--bp-ease),_transform_.32s_var(--bp-ease)] pointer-events-none [.bp-body.is-open_&]:opacity-[1] [.bp-body.is-open_&]:[transform:translateX(0)] [.bp-body.is-open_&]:pointer-events-auto later:[.bp-body.is-closing_&]:opacity-[0] later:[.bp-body.is-closing_&]:[transform:translateX(22px)] max-[1181px]:later:max-h-[none] max-[1181px]:later:[transform:translateY(12px)] max-[1181px]:later-2:[.bp-body.is-open_&]:[transform:translateY(0)] max-[1181px]:later-3:[.bp-body.is-closing_&]:[transform:translateY(10px)] motion-reduce:later:[transition:none]"
                aria-label="Selected branch"
                aria-hidden={view !== 'half'}
              >
                {selected && (
                  <div className="h-full max-h-[inherit] flex flex-col overflow-hidden [border:1px_solid_var(--bp-border)] rounded-[var(--bp-radius)] [background:var(--bp-surface)]">
                    <header className="flex-none flex items-start justify-between gap-3 p-[16px_16px_14px] border-b border-b-line [background:linear-gradient(120deg,_color-mix(in_srgb,_var(--brand-color,_var(--accent))_12%,_transparent),_transparent_62%)]" style={{ '--brand-color': getBrand(selected).color }}>
                      <div className="min-w-0 later:[&_h2]:m-[4px_0_2px] [&_h2]:text-text later:[&_h2]:text-[16px] [&_h2]:font-[780] later:[&_h2]:tracking-[-.02em] [&_small]:text-muted later-3:[&_small]:text-[10px]">
                        <span className="text-[color:var(--brand-color,_var(--accent))] text-[9px] font-[780] tracking-[.1em] uppercase">{brandLabelOf(selected)}</span>
                        <h2>{locationOf(selected)}</h2>
                        <small>{selected.name}</small>
                      </div>
                      <div className="flex items-center gap-[2px] flex-none">
                        <button
                          type="button"
                          className="w-[34px] h-[34px] inline-grid place-items-center p-0 border border-transparent rounded-[10px] text-muted [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:[transform:translateY(-1px)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
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
