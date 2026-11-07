import React, { useEffect, useRef, useState } from 'react';
import {
  FaArrowTrendUp,
  FaBoxesStacked,
  FaChartPie,
  FaCircleCheck,
  FaClipboardCheck,
  FaHandshake,
  FaLightbulb,
  FaTriangleExclamation,
  FaTruckFast,
  FaUserGroup,
} from 'react-icons/fa6';
import { api } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, formatNumber, localDateInputValue, titleCase } from '../lib/format';
import { kpiConversionRate } from '../lib/conversion';
import RecordCode from '../components/RecordCode';
import { downloadCsv, downloadPdf } from '../lib/export';
import { EmptyState, LoadingState, Notice, PageHeader, StatusBadge } from '../components/ApiUi';
import { useAuth } from '../context/AuthContext';
import { can, panelsFor } from '../lib/roleAccess';
import {
  AcquisitionBars,
  ApplicantFunnel,
  FulfillmentTrend,
  InventoryDonut,
  ProductionTrendCombo,
  SourceDonut,
  StageBarChart,
  SupplyStageTracker,
  TopBranchesBars,
} from '../components/dashboard/Charts';

/* ------------------------------------------------------------------ */
/* Shared building blocks                                              */
/* ------------------------------------------------------------------ */

function Metric({ label, value, suffix = '', Icon = FaChartPie, tone = '', caption }) {
  return (
    <article className={`metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px] ${tone ? ` metric-tone-${tone}` : ''}`}>
      <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span>{label}</span><span className="metric-icon w-[36px] h-[36px] later:grid place-items-center rounded-[12px] text-accent-text [background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] [.metric-tone-success_&]:text-success-text [.metric-tone-success_&]:[background:color-mix(in_srgb,_var(--success)_10%,_transparent)] later:[.metric-tone-warning_&]:text-[color:var(--warning-text)] later:[.metric-tone-warning_&]:[background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] later-2:[.metric-tone-danger_&]:text-danger-text later-2:[.metric-tone-danger_&]:[background:color-mix(in_srgb,_var(--danger)_10%,_transparent)] later-3:[.metric-tone-purple_&]:text-[#b7a4ff] later-3:[.metric-tone-purple_&]:[background:rgba(139,109,255,.11)] [.dashboard-page_&]:w-[28px] [.dashboard-page_&]:h-[28px] [.dashboard-page_&]:rounded-[9px] later:[.dashboard-page_&]:text-[12px]"><Icon /></span></div>
      <div><strong>{value}{suffix}</strong>{caption && <div className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{caption}</div>}</div>
    </article>
  );
}

function PanelShell({ title, subtitle, actions, children }) {
  return (
    <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
      <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
        <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
          <h2>{title}</h2>
          {subtitle && <span>{subtitle}</span>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Panel body: loading and error always win, then `empty` — but only when the
 * caller actually passes one (pass `null` once real rows exist). This used to
 * render the empty state unconditionally, which is why every panel looked blank.
 */
function PanelBody({ loading, error, empty, children }) {
  if (loading) return <LoadingState label="Loading panel…" />;
  if (error) return <Notice type="error">{error}</Notice>;
  if (empty) return empty;
  return children;
}

/* ------------------------------------------------------------------ */
/* Global / chart date filter                                          */
/* ------------------------------------------------------------------ */

const RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'this_month', label: 'This month' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: '12m', label: '12 months' },
];

function presetRange(key) {
  const to = new Date();
  const from = new Date();
  if (key === 'today') {
    // from and to are both today.
  } else if (key === 'this_month') from.setDate(1);
  else if (key === '7d') from.setDate(from.getDate() - 6);
  else if (key === '30d') from.setDate(from.getDate() - 29);
  else if (key === '90d') from.setDate(from.getDate() - 89);
  else if (key === 'custom') return null;
  else from.setMonth(from.getMonth() - 12);
  return { from: localDateInputValue(from), to: localDateInputValue(to), preset: key };
}

function DateRangeFilter({ value, onChange, compact = false, variant = 'chips' }) {
  // Dropdown variant only: an invalid custom range (start after end) is held here
  // and reported inline, so the last valid range keeps driving the data.
  const [pending, setPending] = useState(null);
  const customFrom = pending?.from ?? value.from;
  const customTo = pending?.to ?? value.to;
  const rangeInvalid = variant === 'dropdown' && Boolean(pending) && customFrom > customTo;

  const applyPreset = (key) => {
    setPending(null);
    const next = presetRange(key);
    onChange(next || { ...value, preset: 'custom' });
  };

  const changeCustom = (from, to) => {
    if (variant !== 'dropdown') {
      onChange({ ...value, preset: 'custom', from, to });
      return;
    }
    if (from > to) {
      setPending({ from, to });
      return;
    }
    setPending(null);
    onChange({ ...value, preset: 'custom', from, to });
  };

  if (variant === 'dropdown') {
    return (
      <div className={`date-filter-bar [.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:mb-[18px] [.dashboard-page_&]:p-[10px_14px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[14px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_94%,_transparent)] [.dashboard-page_&]:[box-shadow:var(--shadow-sm)] [.dashboard-page_&.is-compact]:mb-0 [.dashboard-page_&.is-compact]:p-0 [.dashboard-page_&.is-compact]:border-0 [.dashboard-page_&.is-compact]:[background:transparent] [.dashboard-page_&.is-compact]:[box-shadow:none] max-[681px]:later:[.dashboard-page_&]:items-start max-[681px]:[.dashboard-page_&]:flex-col ${compact ? ' is-compact' : ''}`}>
        <span className="[.dashboard-page_&]:text-accent-text [.dashboard-page_&]:text-[8px] [.dashboard-page_&]:font-[850] [.dashboard-page_&]:tracking-[0.13em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap">Date filter</span>
        <select
          className="[.dashboard-page_&]:min-h-[30px] [.dashboard-page_&]:p-[0_28px_0_12px] [.dashboard-page_&]:border [.dashboard-page_&]:border-input-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:var(--input-bg)] [.dashboard-page_&]:text-accent-text [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.08em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:cursor-pointer"
          aria-label="Date range"
          value={value.preset}
          onChange={(event) => applyPreset(event.target.value)}
        >
          {RANGE_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>{preset.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
        {value.preset === 'custom' && (
          <>
            <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[7px] [.dashboard-page_&_input]:min-h-[30px] [.dashboard-page_&_input]:p-[4px_9px] [.dashboard-page_&_input]:border later-2:[.dashboard-page_&_input]:border-input-line [.dashboard-page_&_input]:rounded-[9px] [.dashboard-page_&_input]:text-text later:[.dashboard-page_&_input]:[background:var(--input-bg)] [.dashboard-page_&_input]:text-[9px] [.dashboard-page_&_span]:text-muted later-3:[.dashboard-page_&_span]:text-[10px]">
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => changeCustom(event.target.value, customTo)}
              />
              <span>→</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => changeCustom(customFrom, event.target.value)}
              />
            </div>
            {rangeInvalid && <span className="[.dashboard-page_&]:text-danger-text [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:font-[700]" role="alert">Start date must be before end date</span>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`date-filter-bar [.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:mb-[18px] [.dashboard-page_&]:p-[10px_14px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[14px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_94%,_transparent)] [.dashboard-page_&]:[box-shadow:var(--shadow-sm)] [.dashboard-page_&.is-compact]:mb-0 [.dashboard-page_&.is-compact]:p-0 [.dashboard-page_&.is-compact]:border-0 [.dashboard-page_&.is-compact]:[background:transparent] [.dashboard-page_&.is-compact]:[box-shadow:none] max-[681px]:later:[.dashboard-page_&]:items-start max-[681px]:[.dashboard-page_&]:flex-col ${compact ? ' is-compact' : ''}`}>
      <span className="[.dashboard-page_&]:text-accent-text [.dashboard-page_&]:text-[8px] [.dashboard-page_&]:font-[850] [.dashboard-page_&]:tracking-[0.13em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap">Date filter</span>
      <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[6px]">
        {RANGE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.key}
            className={`[.dashboard-page_&]:min-h-[28px] [.dashboard-page_&]:p-[0_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:text-muted [.dashboard-page_&]:[background:var(--surface-subtle)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[720] [.dashboard-page_&]:[transition:color_0.16s_ease,_border-color_0.16s_ease,_background_0.16s_ease,_box-shadow_0.16s_ease] [.dashboard-page_&:hover]:text-text [.dashboard-page_&:hover]:border-line-strong [.dashboard-page_&:hover]:[background:var(--hover)] later:[.dashboard-page_&.active]:text-[#fff] later:[.dashboard-page_&.active]:border-transparent later:[.dashboard-page_&.active]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [.dashboard-page_&.active]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] ${value.preset === preset.key ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
            onClick={() => applyPreset(preset.key)}
          >
            {preset.label}
          </button>
        ))}  <button
        type="button"
        className={`[.dashboard-page_&]:min-h-[28px] [.dashboard-page_&]:p-[0_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:text-muted [.dashboard-page_&]:[background:var(--surface-subtle)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[720] [.dashboard-page_&]:[transition:color_0.16s_ease,_border-color_0.16s_ease,_background_0.16s_ease,_box-shadow_0.16s_ease] [.dashboard-page_&:hover]:text-text [.dashboard-page_&:hover]:border-line-strong [.dashboard-page_&:hover]:[background:var(--hover)] later:[.dashboard-page_&.active]:text-[#fff] later:[.dashboard-page_&.active]:border-transparent later:[.dashboard-page_&.active]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [.dashboard-page_&.active]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] ${value.preset === 'custom' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
        onClick={() => applyPreset('custom')}
      >
        Custom
      </button>
      </div>
      {value.preset === 'custom' && (
        <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[7px] [.dashboard-page_&_input]:min-h-[30px] [.dashboard-page_&_input]:p-[4px_9px] [.dashboard-page_&_input]:border later-2:[.dashboard-page_&_input]:border-input-line [.dashboard-page_&_input]:rounded-[9px] [.dashboard-page_&_input]:text-text later:[.dashboard-page_&_input]:[background:var(--input-bg)] [.dashboard-page_&_input]:text-[9px] [.dashboard-page_&_span]:text-muted later-3:[.dashboard-page_&_span]:text-[10px]">
          <input
            type="date"
            value={value.from}
            max={value.to}
            onChange={(event) => onChange({ ...value, preset: 'custom', from: event.target.value })}
          />
          <span>→</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            onChange={(event) => onChange({ ...value, preset: 'custom', to: event.target.value })}
          />
        </div>
      )}
      <span className="[.dashboard-page_&]:ml-auto [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:whitespace-nowrap [.dashboard-page_.date-filter-bar.is-compact_&]:ml-[6px] max-[681px]:later:[.dashboard-page_&]:ml-0">{formatDate(value.from)} — {formatDate(value.to)}</span>
    </div>
  );
}

/**
 * Active / All switch: one shared state drives every inquiry- and applicant-based
 * panel (KPIs, funnel, acquisition, recent applications, exports) through the
 * single `include_archived` API parameter. Inventory and supply panels have no
 * archive concept and ignore it.
 */
function ArchiveToggle({ value, onChange }) {
  return (
    <div className={`[.dashboard-page_.dashboard-control-row_&]:flex-[0_1_auto] [.dashboard-page_.dashboard-control-row_&]:min-h-[46px] [.dashboard-page_.dashboard-control-row_&]:[box-sizing:border-box] [.dashboard-page_.dashboard-control-row_&]:mb-0 [.dashboard-page_.dashboard-control-row_&]:pt-0 [.dashboard-page_.dashboard-control-row_&]:pb-0 [.dashboard-page_.dashboard-control-row_&]:items-center [.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:p-[10px_14px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[14px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_94%,_transparent)] [.dashboard-page_&]:[box-shadow:var(--shadow-sm)] [.dashboard-page_&.is-all]:border-[color:color-mix(in_srgb,_var(--accent)_34%,_var(--border))] ${value ? ' is-all' : ''}`} role="group" aria-label="Archived records">
      <span className="[.dashboard-page_&]:text-accent-text [.dashboard-page_&]:text-[8px] [.dashboard-page_&]:font-[850] [.dashboard-page_&]:tracking-[0.13em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap">Records</span>
      <div className="[.dashboard-page_&]:inline-flex [.dashboard-page_&]:gap-1 [.dashboard-page_&]:p-[3px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--bg)_62%,_transparent)]">
        <button
          type="button"
          className={`[.dashboard-page_&]:border-0 [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:p-[5px_14px] [.dashboard-page_&]:[background:transparent] [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[9.5px] [.dashboard-page_&]:font-[750] [.dashboard-page_&]:cursor-pointer [.dashboard-page_&]:[transition:color_0.15s_ease,_background_0.15s_ease,_box-shadow_0.15s_ease] [.dashboard-page_&:hover:not(.active)]:text-[color:var(--text,_#e7ecf7)] [.dashboard-page_&.active]:[background:color-mix(in_srgb,_var(--accent)_80%,_#10121c)] [.dashboard-page_&.active]:text-[#fff] [.dashboard-page_&.active]:[box-shadow:0_0_12px_color-mix(in_srgb,_var(--accent)_42%,_transparent)] ${!value ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
          aria-pressed={!value}
          onClick={() => onChange(false)}
        >
          Active
        </button>
        <button
          type="button"
          className={`[.dashboard-page_&]:border-0 [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:p-[5px_14px] [.dashboard-page_&]:[background:transparent] [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[9.5px] [.dashboard-page_&]:font-[750] [.dashboard-page_&]:cursor-pointer [.dashboard-page_&]:[transition:color_0.15s_ease,_background_0.15s_ease,_box-shadow_0.15s_ease] [.dashboard-page_&:hover:not(.active)]:text-[color:var(--text,_#e7ecf7)] [.dashboard-page_&.active]:[background:color-mix(in_srgb,_var(--accent)_80%,_#10121c)] [.dashboard-page_&.active]:text-[#fff] [.dashboard-page_&.active]:[box-shadow:0_0_12px_color-mix(in_srgb,_var(--accent)_42%,_transparent)] ${value ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
          aria-pressed={value}
          onClick={() => onChange(true)}
        >
          All
        </button>
      </div>
      {value && <span className="[.dashboard-page_&]:p-[4px_9px] [.dashboard-page_&]:border [.dashboard-page_&]:border-dashed [.dashboard-page_&]:border-[color:color-mix(in_srgb,_var(--accent)_45%,_transparent)] [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [.dashboard-page_&]:text-accent-text [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:font-[750] [.dashboard-page_&]:whitespace-nowrap">Including archived</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Role-specific KPI sets                                               */
/* ------------------------------------------------------------------ */

const KPI_SETS = {
  admin: [
    { key: 'total_inquiries', label: 'Total inquiries', Icon: FaHandshake, caption: 'Franchise leads in this range' },
    { key: 'active_applicants', label: 'Active applicants', Icon: FaUserGroup, tone: 'purple', caption: 'Candidates currently progressing' },
    { key: 'conversion_rate_percent', label: 'Conversion rate', Icon: FaArrowTrendUp, tone: 'success', suffix: '%', decimals: 2, caption: 'Inquiry-to-applicant performance' },
    { key: 'supply_requests', label: 'Supply requests', Icon: FaClipboardCheck, caption: 'Orders across the network' },
    { key: 'fulfillment_rate_percent', label: 'Fulfillment rate', Icon: FaTruckFast, suffix: '%', decimals: 2, tone: 'dynamic', caption: 'Completed supply workflow' },
    { key: 'critical_inventory_items', label: 'Critical stock', Icon: FaTriangleExclamation, tone: 'dynamic', caption: 'Items requiring attention' },
  ],
  sales: [
    { key: 'total_inquiries', label: 'Total inquiries', Icon: FaHandshake, caption: 'Franchise leads in this range' },
    { key: 'endorsed_inquiries', label: 'Endorsed inquiries', Icon: FaArrowTrendUp, tone: 'purple', caption: 'Qualified into the sales pipeline' },
    { key: 'active_applicants', label: 'Active applicants', Icon: FaUserGroup, caption: 'Candidates currently progressing' },
    { key: 'conversion_rate_percent', label: 'Conversion rate', Icon: FaCircleCheck, tone: 'success', suffix: '%', decimals: 2, caption: 'Inquiry-to-applicant performance' },
  ],
  marketing: [
    { key: 'total_inquiries', label: 'Total inquiries', Icon: FaHandshake, caption: 'Leads acquired in this range' },
    { key: 'endorsed_inquiries', label: 'Endorsed inquiries', Icon: FaArrowTrendUp, tone: 'purple', caption: 'Endorsed into the sales pipeline' },
    { key: 'converted_inquiries', label: 'Converted leads', Icon: FaLightbulb, tone: 'success', caption: 'Became franchise applicants' },
    { key: 'conversion_rate_percent', label: 'Conversion rate', Icon: FaCircleCheck, tone: 'success', suffix: '%', decimals: 2, caption: 'Inquiry-to-applicant performance' },
  ],
};

function kpiTone(descriptor, value) {
  if (descriptor.key === 'fulfillment_rate_percent') return Number(value) >= 80 ? 'success' : 'warning';
  if (descriptor.key === 'critical_inventory_items') return Number(value) > 0 ? 'danger' : 'success';
  return descriptor.tone === 'dynamic' ? '' : (descriptor.tone || '');
}

function KpiGrid({ role, kpi, loading, error }) {
  const descriptors = KPI_SETS[role] || KPI_SETS.admin;
  const data = kpi || {};

  return (
    <PanelBody
      loading={loading}
      error={error}
      empty={kpi ? null : <EmptyState label="No KPI data for this range." detail="Widen the date filter to see more activity." />}
    >
      <div className={`metric-grid grid grid-cols-[repeat(6,_minmax(0,_1fr))] gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-2:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-3:grid-cols-[1fr] ${descriptors.length <= 4 ? ' [.dashboard-page_&.metric-grid]:grid-cols-[repeat(4,_minmax(0,_1fr))] max-[1381px]:later:[.dashboard-page_&.metric-grid]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[481px]:later-2:[.dashboard-page_&.metric-grid]:grid-cols-[1fr]' : ''}`}>
        {descriptors.map((descriptor) => {
          // Conversion goes through the shared helper (0–100 guard, same formula on every dashboard).
          const value = descriptor.key === 'conversion_rate_percent' ? kpiConversionRate(data) : (data[descriptor.key] ?? 0);
          return (
            <Metric
              key={descriptor.key}
              label={descriptor.label}
              value={formatNumber(value, descriptor.decimals ?? 0)}
              suffix={descriptor.suffix || ''}
              Icon={descriptor.Icon}
              tone={kpiTone(descriptor, value)}
              caption={descriptor.caption}
            />
          );
        })}
      </div>
    </PanelBody>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                               */
/* ------------------------------------------------------------------ */

function AcquisitionBody({ rows, loading, error }) {
  // Chart panels never swap themselves for an empty box: the chart draws its own
  // frame with the "No data in this range" note (never a blank rectangle).
  return (
    <PanelBody loading={loading} error={error}>
      <AcquisitionBars rows={rows} />
    </PanelBody>
  );
}

/** Admin/Sales/Marketing build: rows come from the shared, date-filtered overview. */
function AcquisitionPanel({ rows, loading, error, range }) {
  return (
    <PanelShell
      title="Inquiry acquisition"
      subtitle="Leads per channel from Admin and Marketing entries — hover for conversion"
      actions={<span className="[.dashboard-page_&]:p-[5px_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-[color:color-mix(in_srgb,_var(--accent)_26%,_var(--border))] [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:text-accent-text [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--accent)_7%,_transparent)] [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:whitespace-nowrap">{formatDate(range.from)} — {formatDate(range.to)}</span>}
    >
      <AcquisitionBody rows={rows} loading={loading} error={error} />
    </PanelShell>
  );
}

// Brand colors for the "By Branch" view (fixed by the spec).
const BRAND_CATEGORIES = ['Kkopi', 'Daily Dash', 'La Pasta', 'GoDo'];
const BRAND_COLORS = ['#F97D1B', '#0565D6', '#AF2525', '#769D32'];

const VIEW_OPTIONS = [
  { value: 'source', label: 'By Source' },
  { value: 'branch', label: 'By Branch' },
];

/** Themed dropdown for the Inquiry by source chart (replaces the native select). */
function ViewDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = VIEW_OPTIONS.find((option) => option.value === value) || VIEW_OPTIONS[0];

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="[.dashboard-page_&]:relative [.dashboard-page_&]:inline-block" ref={rootRef}>
      <button
        type="button"
        className="view-dropdown-button [.dashboard-page_&]:inline-flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:min-h-[30px] [.dashboard-page_&]:p-[0_12px] [.dashboard-page_&]:border [.dashboard-page_&]:border-input-line [.dashboard-page_&]:rounded-[10px] [.dashboard-page_&]:[background:var(--input-bg)] [.dashboard-page_&]:text-text [.dashboard-page_&]:text-[10px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.04em] [.dashboard-page_&]:cursor-pointer [.dashboard-page_&]:[transition:border-color_0.16s_ease,_box-shadow_0.16s_ease,_background_0.16s_ease] [.dashboard-page_&:hover]:border-line-strong [.dashboard-page_&:focus-visible]:[outline:none] later:[.dashboard-page_&:focus-visible]:border-accent [.dashboard-page_&:focus-visible]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [.dashboard-page_&[aria-expanded='true']]:[outline:none] later:[.dashboard-page_&[aria-expanded='true']]:border-accent [.dashboard-page_&[aria-expanded='true']]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)]"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Inquiry chart view"
        onClick={() => setOpen((prev) => !prev)}
      >
        {current.label}
        <svg className="[.dashboard-page_&]:flex-none [.dashboard-page_&]:text-muted [.dashboard-page_&]:[transition:transform_0.16s_ease] [.dashboard-page_.view-dropdown-button[aria-expanded='true']_&]:[transform:rotate(180deg)]" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="[.dashboard-page_&]:absolute [.dashboard-page_&]:top-[calc(100%_+_6px)] [.dashboard-page_&]:right-0 [.dashboard-page_&]:z-20 [.dashboard-page_&]:min-w-full [.dashboard-page_&]:m-0 [.dashboard-page_&]:p-1 [.dashboard-page_&]:[list-style:none] [.dashboard-page_&]:border [.dashboard-page_&]:border-line-strong [.dashboard-page_&]:rounded-[10px] [.dashboard-page_&]:[background:var(--panel-2)] [.dashboard-page_&]:[box-shadow:var(--shadow-md)]" role="listbox" aria-label="Inquiry chart view">
          {VIEW_OPTIONS.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`[.dashboard-page_&]:p-[7px_10px] [.dashboard-page_&]:rounded-[7px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:text-[10px] [.dashboard-page_&]:font-[650] [.dashboard-page_&]:whitespace-nowrap [.dashboard-page_&]:cursor-pointer [.dashboard-page_&:hover]:[background:var(--hover)] [.dashboard-page_&:hover]:text-text later:[.dashboard-page_&.is-selected]:[background:color-mix(in_srgb,_var(--accent)_16%,_transparent)] later:[.dashboard-page_&.is-selected]:text-accent-text ${option.value === value ? ' is-selected' : ''}`}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InquirySourcePanel({ sources, branches, loading, error }) {
  const [view, setView] = useState('source');
  const entries = Object.entries(sources || {}).map(([name, value]) => ({ name, value }));
  // Branch counts are keyed by preferred_brand_id; map them to the four brand names.
  // Backend keys are normalized (lowercase, letters and digits only); look them up the same way.
  const normalizeBrand = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const branchEntries = BRAND_CATEGORIES.map((name) => ({ name, value: Number(branches?.[normalizeBrand(name)] || 0) }));
  const isBranch = view === 'branch';
  return (
    <PanelShell
      title="Inquiry by source"
      subtitle={isBranch ? 'Lead share per branch' : 'Lead share per acquisition channel'}
      actions={<ViewDropdown value={view} onChange={setView} />}
    >
      <PanelBody loading={loading} error={error}>
        {isBranch ? (
          <SourceDonut entries={branchEntries} categories={BRAND_CATEGORIES} colors={BRAND_COLORS} />
        ) : (
          <SourceDonut entries={entries} />
        )}
      </PanelBody>
    </PanelShell>
  );
}

function ApplicantFunnelPanel({ funnel, loading, error }) {
  return (
    <PanelShell title="Applicant funnel" subtitle="Drop-off between pipeline stages">
      <PanelBody loading={loading} error={error}>
        <ApplicantFunnel funnel={funnel} />
      </PanelBody>
    </PanelShell>
  );
}

function InventoryHealthPanel({ status, loading, error, title, subtitle }) {
  return (
    <PanelShell title={title} subtitle={subtitle}>
      <PanelBody loading={loading} error={error}>
        <InventoryDonut status={status} />
      </PanelBody>
    </PanelShell>
  );
}

function ProductionTrendPanel({ rows, period, onPeriodChange, loading, error }) {
  return (
    <PanelShell
      title="Production trend"
      subtitle="All branches · units produced (bars) vs production transactions (line)"
      actions={(
        <div className="flex flex-wrap gap-[6px] mb-[14px]" style={{ margin: 0 }}>
          {['month', 'year'].map((option) => (
            <button
              key={option}
              type="button"
              className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${period === option ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
              onClick={() => onPeriodChange(option)}
            >
              {option === 'month' ? 'By month' : 'By year'}
            </button>
          ))}
        </div>
      )}
    >
      <PanelBody loading={loading} error={error}>
        <ProductionTrendCombo rows={rows} />
      </PanelBody>
    </PanelShell>
  );
}

function TopBranchesPanel({ rows, loading, error }) {
  const [metric, setMetric] = useState('quantity');
  return (
    <PanelShell
      title="Top performing branches"
      subtitle={metric === 'quantity' ? 'Ranked by quantity sold' : 'Ranked by number of sales'}
      actions={(
        <div className="flex flex-wrap gap-[6px] mb-[14px]" style={{ margin: 0 }}>
          <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${metric === 'quantity' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMetric('quantity')}>
            By volume (quantity)
          </button>
          <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${metric === 'sales' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMetric('sales')}>
            By sales count
          </button>
        </div>
      )}
    >
      <PanelBody loading={loading} error={error}>
        <TopBranchesBars rows={rows} metric={metric} />
      </PanelBody>
    </PanelShell>
  );
}

function ExportButtons({ rows, label, onCsv, onPdf }) {
  return (
    <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:gap-[7px]">
      <button type="button" className="[.dashboard-page_&]:min-h-[30px] [.dashboard-page_&]:p-[0_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[9px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:[background:var(--surface-subtle)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[730] [.dashboard-page_&]:[transition:color_0.16s_ease,_border-color_0.16s_ease,_background_0.16s_ease,_transform_0.16s_ease] [.dashboard-page_&:hover:not(:disabled)]:text-accent-text [.dashboard-page_&:hover:not(:disabled)]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_var(--border))] [.dashboard-page_&:hover:not(:disabled)]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)] [.dashboard-page_&:hover:not(:disabled)]:[transform:translateY(-1px)] [.dashboard-page_&:disabled]:opacity-[0.4]" onClick={onCsv} disabled={!rows.length} title={`Export ${label} as CSV`}>
        Export CSV
      </button>
      <button type="button" className="[.dashboard-page_&]:min-h-[30px] [.dashboard-page_&]:p-[0_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[9px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:[background:var(--surface-subtle)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[730] [.dashboard-page_&]:[transition:color_0.16s_ease,_border-color_0.16s_ease,_background_0.16s_ease,_transform_0.16s_ease] [.dashboard-page_&:hover:not(:disabled)]:text-accent-text [.dashboard-page_&:hover:not(:disabled)]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_var(--border))] [.dashboard-page_&:hover:not(:disabled)]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)] [.dashboard-page_&:hover:not(:disabled)]:[transform:translateY(-1px)] [.dashboard-page_&:disabled]:opacity-[0.4]" onClick={onPdf} disabled={!rows.length} title={`Export ${label} as PDF`}>
        Export PDF
      </button>
    </div>
  );
}

function RecentApplicationsPanel({ applications, loading, error }) {
  const rows = applications || [];
  const headers = ['Candidate', 'Brand', 'Status', 'Application date'];
  const exportRows = rows.map((applicant) => [
    applicant.full_name,
    applicant.brand || 'No brand',
    titleCase(String(applicant.status || '').replaceAll('_', ' ')),
    applicant.application_date,
  ]);

  return (
    <PanelShell
      title="Recent franchise applications"
      subtitle="Newest candidates in the pipeline"
      actions={(
        <ExportButtons
          rows={rows}
          label="applications"
          onCsv={() => downloadCsv('recent-franchise-applications', headers, exportRows)}
          onPdf={() => downloadPdf('recent-franchise-applications', headers, exportRows, 'Recent franchise applications', `Range ${formatDate(exportRows[0]?.[3])} — today`)}
        />
      )}
    >
      <PanelBody
        loading={loading}
        error={error}
        empty={rows.length ? null : <EmptyState label="No franchise applications yet." detail="Applications appear here as soon as a candidate is added." />}
      >
        <div className="p-[5px_18px_15px] [&>div]:min-h-[42px] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:border-b [&>div]:border-b-line [&>div]:text-text-secondary [&>div]:text-[9px] [&>div:last-child]:border-b-0 [&_strong]:text-text">
          {rows.map((applicant) => (
            <div key={applicant.id}>
              <span>
                {applicant.full_name}
                {applicant.applicant_code && <> · <RecordCode code={applicant.applicant_code} label="Applicant ID" /></>}
                <small className="muted-note text-muted text-[8px] leading-[1.6]"> · {applicant.brand || 'No brand'} · {formatDate(applicant.application_date)}</small>
              </span>
              <StatusBadge value={applicant.status} />
            </div>
          ))}
        </div>
      </PanelBody>
    </PanelShell>
  );
}

// Transaction legend: the same transaction types the PDF asked to see.
const transactionTypeLabels = {
  opening: 'Receipt · opening stock',
  adjustment_in: 'Adjustment · stock in',
  adjustment_out: 'Adjustment · stock out',
  consumption: 'Branch deduction',
  fulfillment: 'Issue / dispatched to branch',
  replenishment: 'Delivery confirmation · branch received',
};

function TransactionBadge({ type }) {
  return <StatusBadge value={transactionTypeLabels[type] || type} />;
}

function TransactionsPanel({ from, to }) {
  // /inventory-transactions is a paginated endpoint: the payload itself is
  // { data: [...], meta }, so the whole payload must be kept — unwrapping it
  // here (payload.data) left `data.data` undefined and the table always empty.
  const { data, loading, error } = useRemote(
    async () => (await api.get('/inventory-transactions', {
      per_page: 15,
      ...(from ? { from, to } : {}),
    })),
    [from, to],
  );

  const rows = data?.data || [];
  const headers = ['When', 'Type', 'Product', 'Location', 'Change', 'Balance after', 'Recorded by'];
  const exportRows = rows.map((row) => {
    const change = Number(row.quantity || 0);
    return [
      formatDate(row.transaction_date, true),
      transactionTypeLabels[row.type] || row.type,
      row.inventory?.product?.name || '—',
      row.inventory?.location?.name || '—',
      change,
      row.balance_after,
      row.recorded_by?.full_name || '—',
    ];
  });

  return (
    <PanelShell
      title="Transaction records"
      subtitle="Receipts, dispatches, delivery confirmations, branch deductions, and adjustments"
      actions={(
        <ExportButtons
          rows={rows}
          label="transactions"
          onCsv={() => downloadCsv('transaction-records', headers, exportRows)}
          onPdf={() => downloadPdf('transaction-records', headers, exportRows, 'Transaction records', from ? `Range ${formatDate(from)} — ${formatDate(to)}` : 'Latest records')}
        />
      )}
    >
      <PanelBody
        loading={loading}
        error={error}
        empty={rows.length ? null : <EmptyState label="No transactions recorded yet." detail="Stock movements appear here as they happen." />}
      >
        <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Product</th><th>Location</th><th>Change</th><th>Balance after</th><th>Recorded by</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const change = Number(row.quantity || 0);
                return (
                  <tr key={row.id}>
                    <td>{formatDate(row.transaction_date, true)}</td>
                    <td><TransactionBadge type={row.type} /></td>
                    <td><strong>{row.inventory?.product?.name || '—'}</strong></td>
                    <td>{row.inventory?.location?.name || '—'}</td>
                    <td style={{ color: change >= 0 ? 'var(--success-text, #16a34a)' : 'var(--danger-text, #dc2626)', fontWeight: 700 }}>
                      {change >= 0 ? `+${formatNumber(change)}` : `−${formatNumber(Math.abs(change))}`}
                    </td>
                    <td>{formatNumber(row.balance_after)}</td>
                    <td>{row.recorded_by?.full_name || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PanelBody>
    </PanelShell>
  );
}

function FranchisingInsights({ data, loading, error }) {
  const insights = data?.insights || [];
  const alerts = data?.alerts || [];
  return (
    <PanelShell title="Insights" subtitle="What the network is telling you right now">
      <PanelBody loading={loading} error={error}>
        <div className="grid gap-[9px] p-[15px_18px]">
          {!insights.length ? (
            <span className="muted-note text-muted text-[8px] leading-[1.6]">No insights available yet.</span>
          ) : insights.map((insight) => (
            <div className="flex items-start gap-[9px] text-text-secondary text-[9px] leading-[1.6]" key={`${insight.type}-${insight.message}`}>
              <FaLightbulb aria-hidden="true" />
              <span>{insight.message}</span>
            </div>
          ))}
        </div>
        <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px] [&.panel-title]:mt-[7px] [&.panel-title]:border-t [&.panel-title]:border-t-line">
          <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
            <h2>Alerts &amp; warnings</h2>
            <span>Items that need attention</span>
          </div>
        </div>
        <div className="grid gap-2 p-[15px_18px]">
          {!alerts.length ? (
            <div className="flex items-start gap-[9px] p-[10px_12px] border border-line rounded-[12px] text-[9px] leading-[1.55] [&.severity-danger]:text-danger-text [&.severity-danger]:border-[color:color-mix(in_srgb,_var(--danger)_26%,_transparent)] [&.severity-danger]:[background:color-mix(in_srgb,_var(--danger)_7%,_transparent)] later:[&.severity-warning]:text-[color:var(--warning-text)] later:[&.severity-warning]:border-[color:color-mix(in_srgb,_var(--warning)_26%,_transparent)] later:[&.severity-warning]:[background:color-mix(in_srgb,_var(--warning)_7%,_transparent)] later-2:[&.severity-clear]:text-success-text later-2:[&.severity-clear]:border-[color:color-mix(in_srgb,_var(--success)_26%,_transparent)] later-2:[&.severity-clear]:[background:color-mix(in_srgb,_var(--success)_7%,_transparent)] severity-clear">
              <FaCircleCheck aria-hidden="true" />
              <span>No warnings. Every branch, applicant, and supply request is on track.</span>
            </div>
          ) : alerts.map((alert) => (
            <div className={`flex items-start gap-[9px] p-[10px_12px] border border-line rounded-[12px] text-[9px] leading-[1.55] [&.severity-danger]:text-danger-text [&.severity-danger]:border-[color:color-mix(in_srgb,_var(--danger)_26%,_transparent)] [&.severity-danger]:[background:color-mix(in_srgb,_var(--danger)_7%,_transparent)] later:[&.severity-warning]:text-[color:var(--warning-text)] later:[&.severity-warning]:border-[color:color-mix(in_srgb,_var(--warning)_26%,_transparent)] later:[&.severity-warning]:[background:color-mix(in_srgb,_var(--warning)_7%,_transparent)] later-2:[&.severity-clear]:text-success-text later-2:[&.severity-clear]:border-[color:color-mix(in_srgb,_var(--success)_26%,_transparent)] later-2:[&.severity-clear]:[background:color-mix(in_srgb,_var(--success)_7%,_transparent)] severity-${alert.severity}`} key={alert.message}>
              <FaTriangleExclamation aria-hidden="true" />
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      </PanelBody>
    </PanelShell>
  );
}

function StageBreakdownPanel({ stages, loading, error }) {
  return (
    <PanelShell title="Requests per stage" subtitle="Volume sitting in each workflow stage">
      <PanelBody loading={loading} error={error}>
        <StageBarChart stages={stages} />
      </PanelBody>
    </PanelShell>
  );
}

function FulfillmentTrendPanel({ rows, loading, error }) {
  return (
    <PanelShell title="Fulfillment trend" subtitle="Submitted vs completed supply requests per month">
      <PanelBody loading={loading} error={error}>
        <FulfillmentTrend rows={rows} />
      </PanelBody>
    </PanelShell>
  );
}

/* ------------------------------------------------------------------ */
/* Role dashboards driven by the central panel config                   */
/* ------------------------------------------------------------------ */

const OVERVIEW_PANELS = ['kpi', 'inquirySource', 'applicantFunnel', 'inventoryHealth', 'fulfillmentTrend'];
const FRANCHISE_PANELS = ['salesTrend', 'topBranches', 'insights', 'recentApplications'];

/**
 * Renders panels in config order. Inquiry acquisition and Inquiry by source are
 * wrapped in one side-by-side row when they are adjacent (Marketing); every
 * other layout is rendered exactly as before.
 */
function renderPanelList(panels, renderPanel) {
  return panels.flatMap((panel, index) => {
    if (panel === 'inquirySource' && panels[index - 1] === 'inquiryAcquisition') return [];
    if (panel === 'inquiryAcquisition' && panels[index + 1] === 'inquirySource') {
      return [(
        <div key="chart-row-2" className="chart-row-2 [.dashboard-page_&]:grid [.dashboard-page_&]:grid-cols-[repeat(2,_minmax(0,_1fr))] [.dashboard-page_&]:gap-[18px] [.dashboard-page_&]:items-stretch [.dashboard-page_&]:mb-[18px] [.dashboard-page_&>.data-panel]:min-w-0 [.dashboard-page_&>.data-panel]:h-full [.dashboard-page_&>.data-panel]:m-0 max-[1121px]:later:[.dashboard-page_&]:grid-cols-[1fr]">
          {renderPanel(panel)}
          {renderPanel('inquirySource')}
        </div>
      )];
    }
    return [renderPanel(panel)];
  }).filter(Boolean);
}

/**
 * Admin panels grouped into three named sections (Inquiries, Operation, Supply).
 * Rendered one after another for now; the groups are the future tab contents.
 */
const ADMIN_PANEL_GROUPS = {
  inquiries: ['inquiryAcquisition', 'inquirySource', 'applicantFunnel', 'recentApplications'],
  operation: ['salesTrend', 'topBranches', 'insights'],
  supply: ['inventoryHealth', 'transactions'],
};

const ADMIN_TABS = [
  { key: 'inquiries', label: 'Inquiries' },
  { key: 'operation', label: 'Operation' },
  { key: 'supply', label: 'Supply / Inventory' },
];

function DashboardBody({ role, panels }) {
  const usesGlobalRange = panels.includes('dateFilter');
  const [range, setRange] = useState(() => presetRange('12m'));
  const [period, setPeriod] = useState('month');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [tabState, setTabState] = useState({ active: 'inquiries', direction: 'slide-from-right' });
  const activeTab = tabState.active;
  const slideClass = tabState.direction;
  const tabRefs = useRef({});
  const setActiveTab = (next) => setTabState((current) => ({
    active: next,
    direction: ADMIN_TABS.findIndex((tab) => tab.key === next) >= ADMIN_TABS.findIndex((tab) => tab.key === current.active)
      ? 'slide-from-right' : 'slide-from-left',
  }));

  // Arrow keys, Home and End move between the admin tabs and move focus with them.
  const onTabKeyDown = (event) => {
    const count = ADMIN_TABS.length;
    const index = ADMIN_TABS.findIndex((tab) => tab.key === activeTab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % count;
    else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    const key = ADMIN_TABS[next].key;
    setActiveTab(key);
    tabRefs.current[key]?.focus();
  };
  const activeRange = usesGlobalRange ? range : null;
  // ONE source of truth for every panel: the date range plus the Active/All
  // archive switch. Both are appended to the query each endpoint receives.
  const rangeQuery = {
    ...(activeRange ? { from: activeRange.from, to: activeRange.to } : {}),
    include_archived: includeArchived ? 1 : 0,
  };

  const needsOverview = panels.some((panel) => OVERVIEW_PANELS.includes(panel));
  const overview = useRemote(
    async () => (needsOverview ? (await api.get('/analytics/overview', rangeQuery)).data : null),
    [needsOverview, rangeQuery.from, rangeQuery.to, rangeQuery.include_archived],
  );

  const needsFranchise = panels.some((panel) => FRANCHISE_PANELS.includes(panel));
  const franchising = useRemote(
    async () => (needsFranchise
      ? (await api.get('/analytics/franchising-dashboard', { period, ...rangeQuery })).data
      : null),
    [needsFranchise, period, rangeQuery.from, rangeQuery.to, rangeQuery.include_archived],
  );

  const needsPipeline = panels.includes('stageTracker') || panels.includes('stageBreakdown');
  const pipeline = useRemote(
    async () => (needsPipeline
      ? (await api.get('/supply-requests/pipeline', { from: rangeQuery.from, to: rangeQuery.to })).data
      : null),
    [needsPipeline, rangeQuery.from, rangeQuery.to],
  );

  const needsWarehouse = panels.includes('inventoryHealth') && role === 'logistics';
  const warehouse = useRemote(
    async () => (needsWarehouse
      ? (await api.get('/inventories', { per_page: 200, location_type: 'warehouse' })).data
      : null),
    [needsWarehouse],
  );

  const warehouseStatus = needsWarehouse
    ? (warehouse.data || []).reduce(
      (acc, item) => ({ ...acc, [item.stock_status]: (acc[item.stock_status] || 0) + 1 }),
      { normal: 0, low: 0, critical: 0 },
    )
    : null;

  const renderPanel = (panel) => {
    switch (panel) {
      case 'dateFilter':
        return (
          <div key="dateFilter" className="[.dashboard-page_.dashboard-control-row>&]:mb-[14px] [.dashboard-page_.dashboard-control-row>&]:flex-[0_1_auto] [.dashboard-page_.dashboard-control-row>&]:justify-end [.dashboard-page_.dashboard-control-row>&]:min-w-0 [.dashboard-page_.dashboard-control-row>&]:max-w-full [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:flex-[0_1_auto] [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:min-h-[46px] [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:[box-sizing:border-box] [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:mb-0 [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:pt-0 [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:pb-0 [.dashboard-page_.dashboard-control-row_&_.date-filter-bar]:items-center max-[681px]:later:[.dashboard-page_.dashboard-control-row>&]:mt-[10px] [.dashboard-page_&]:flex [.dashboard-page_&]:items-stretch [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:mb-[18px] [.dashboard-page_&_.date-filter-bar]:flex-[1_1_auto] [.dashboard-page_&_.date-filter-bar]:min-w-0 [.dashboard-page_&_.date-filter-bar]:max-w-full [.dashboard-page_&_.date-filter-bar]:mb-0">
            <DateRangeFilter value={range} onChange={setRange} variant="dropdown" />
            {/* Sales has no archive: the Active/All switch is hidden and the API
                ignores include_archived for roles outside the permission. */}
            {can(role, 'analytics.include_archived') && (
              <ArchiveToggle value={includeArchived} onChange={setIncludeArchived} />
            )}
          </div>
        );
      case 'kpi':
        return <KpiGrid key="kpi" role={role} kpi={overview.data?.kpis} loading={overview.loading} error={overview.error} />;
      case 'inquiryAcquisition':
        return (
          <AcquisitionPanel
            key="acquisition"
            rows={overview.data?.inquiries_by_source_conversion}
            loading={overview.loading}
            error={overview.error}
            range={range}
          />
        );
      case 'inquirySource':
        return (
          <InquirySourcePanel
            key="source"
            sources={overview.data?.inquiries_by_source}
            branches={overview.data?.inquiries_by_branch}
            loading={overview.loading}
            error={overview.error}
          />
        );
      case 'applicantFunnel':
        return (
          <ApplicantFunnelPanel
            key="funnel"
            funnel={overview.data?.applicant_funnel}
            loading={overview.loading}
            error={overview.error}
          />
        );
      case 'inventoryHealth':
        if (role === 'logistics') {
          return (
            <InventoryHealthPanel
              key="inventory"
              title="Warehouse inventory health"
              subtitle="Threshold distribution for central stock"
              status={warehouseStatus}
              loading={warehouse.loading}
              error={warehouse.error}
            />
          );
        }
        return (
          <InventoryHealthPanel
            key="inventory"
            title="Inventory health"
            subtitle="Current threshold distribution — center shows total SKUs"
            status={overview.data?.inventory_status}
            loading={overview.loading}
            error={overview.error}
          />
        );
      case 'salesTrend':
        return (
          <ProductionTrendPanel
            key="trend"
            rows={franchising.data?.production_trend}
            period={period}
            onPeriodChange={setPeriod}
            loading={franchising.loading}
            error={franchising.error}
          />
        );
      case 'topBranches':
        return (
          <TopBranchesPanel
            key="branches"
            rows={franchising.data?.top_branches}
            loading={franchising.loading}
            error={franchising.error}
          />
        );
      case 'insights':
        return <FranchisingInsights key="insights" data={franchising.data} loading={franchising.loading} error={franchising.error} />;
      case 'recentApplications':
        return (
          <RecentApplicationsPanel
            key="applications"
            applications={franchising.data?.recent_applications}
            loading={franchising.loading}
            error={franchising.error}
          />
        );
      case 'transactions':
        return <TransactionsPanel key="transactions" from={activeRange?.from} to={activeRange?.to} />;
      case 'stageTracker':
        return <SupplyStageTracker key="tracker" data={pipeline.data} loading={pipeline.loading} error={pipeline.error} />;
      case 'stageBreakdown':
        return <StageBreakdownPanel key="stages" stages={pipeline.data?.stages} loading={pipeline.loading} error={pipeline.error} />;
      case 'fulfillmentTrend':
        return (
          <FulfillmentTrendPanel
            key="fulfillment"
            rows={overview.data?.supply_request_trend}
            loading={overview.loading}
            error={overview.error}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {role === 'admin' ? (
        <>
          {renderPanelList(panels.filter((panel) => !Object.values(ADMIN_PANEL_GROUPS).flat().includes(panel) && panel !== 'dateFilter'), renderPanel)}
          <div className="dashboard-control-row [.dashboard-page_&]:flex [.dashboard-page_&]:items-end [.dashboard-page_&]:justify-between [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-3 [.dashboard-page_&]:mt-[14px] [.dashboard-page_&]:mb-0">
          <div className="dashboard-tabs [.dashboard-page_&]:relative [.dashboard-page_&]:z-2 [.dashboard-page_&]:flex [.dashboard-page_&]:items-end [.dashboard-page_&]:flex-nowrap [.dashboard-page_&]:gap-3 [.dashboard-page_&]:p-0 [.dashboard-page_&]:min-w-0 [.dashboard-page_&]:max-w-full [.dashboard-page_&]:[clip-path:inset(-24px_-24px_-2px_0)] max-[681px]:later:[.dashboard-page_&]:gap-[10px]" role="tablist" aria-label="Executive sections">
            {ADMIN_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`dash-tab-${tab.key}`}
                ref={(el) => { tabRefs.current[tab.key] = el; }}
                onKeyDown={onTabKeyDown}
                aria-selected={activeTab === tab.key}
                aria-controls="dash-tabpanel"
                tabIndex={activeTab === tab.key ? 0 : -1}
                className={`[.dashboard-page_&]:relative [.dashboard-page_&]:z-1 [.dashboard-page_&]:[box-sizing:border-box] [.dashboard-page_&]:min-h-[46px] [.dashboard-page_&]:p-[0_20px] [.dashboard-page_&]:border [.dashboard-page_&]:border-transparent [.dashboard-page_&]:border-b-0 [.dashboard-page_&]:rounded-[12px_12px_0_0] [.dashboard-page_&]:text-muted [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_55%,_transparent)] [.dashboard-page_&]:text-[10px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.08em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap [.dashboard-page_&]:cursor-pointer [.dashboard-page_&]:opacity-[0.85] [.dashboard-page_&]:[transition:color_0.2s_ease,_opacity_0.2s_ease] [.dashboard-page_&:hover:not(.is-active)]:text-text [.dashboard-page_&:hover:not(.is-active)]:opacity-[1] [.dashboard-page_&:focus-visible]:[outline:2px_solid_var(--accent)] [.dashboard-page_&:focus-visible]:[outline-offset:-3px] [.dashboard-page_&.is-active]:text-text [.dashboard-page_&.is-active]:opacity-[1] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:[background:var(--panel)] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:border-[color:var(--border-strong,_var(--border))] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:-mb-[1px] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:min-h-[47px] later:[.dashboard-page_.dashboard-tabs:has(.dashboard-tab-indicator)_&.is-active]:[background:transparent] later:[.dashboard-page_.dashboard-tabs:has(.dashboard-tab-indicator)_&.is-active]:border-transparent max-[681px]:later:[.dashboard-page_&]:p-[0_12px] max-[681px]:later:[.dashboard-page_&]:text-[9px] ${activeTab === tab.key ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {panels.includes('dateFilter') && renderPanel('dateFilter')}
          </div>
          <div className="dashboard-tabpanel [.dashboard-page_&]:relative [.dashboard-page_&]:z-1 [.dashboard-page_&]:-mt-[1px] [.dashboard-page_&]:p-[18px] [.dashboard-page_&]:border [.dashboard-page_&]:border-[color:var(--border-strong,_var(--border))] [.dashboard-page_&]:rounded-[0_14px_14px_14px] [.dashboard-page_&]:[background:var(--panel)] [.dashboard-page_&]:min-w-0" role="tabpanel" id="dash-tabpanel" aria-labelledby={`dash-tab-${activeTab}`}>
            <div key={activeTab} className={`dashboard-tab-content ${slideClass}`}>
              {renderPanelList(ADMIN_PANEL_GROUPS[activeTab].filter((panel) => panels.includes(panel)), renderPanel)}
            </div>
          </div>
        </>
      ) : (
        renderPanelList(panels, renderPanel)
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Franchisee dashboard (unchanged behaviour)                           */
/* ------------------------------------------------------------------ */

function FranchiseeDashboard() {
  const { data, loading, error } = useRemote(async () => {
    const [applicants, inventories, requests] = await Promise.all([
      api.get('/applicants', { per_page: 10 }),
      api.get('/inventories', { per_page: 100 }),
      api.get('/supply-requests', { view: 'active', per_page: 20 }),
    ]);
    return { applicants: applicants.data, inventories: inventories.data, requests: requests.data };
  }, []);
  if (loading) return <LoadingState label="Loading franchise overview…" />;
  if (error) return <Notice type="error">{error}</Notice>;
  const critical = data.inventories.filter((item) => item.stock_status === 'critical').length;
  const openRequests = data.requests.filter((item) => !['completed', 'cancelled', 'rejected'].includes(item.status)).length;

  return (
    <>
      <div className="metric-grid grid gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] later-4:grid-cols-[repeat(4,_minmax(0,_1fr))] max-[681px]:later-5:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-6:grid-cols-[1fr]">
        <Metric label="Application status" value={titleCase(data.applicants[0]?.status || 'Not available')} Icon={FaUserGroup} tone="purple" caption="Current franchise journey stage" />
        <Metric label="Inventory items" value={data.inventories.length} Icon={FaBoxesStacked} caption="Products currently monitored" />
        <Metric label="Critical stock" value={critical} Icon={FaTriangleExclamation} tone={critical ? 'danger' : 'success'} caption="Items needing replenishment" />
        <Metric label="Open requests" value={openRequests} Icon={FaTruckFast} tone={openRequests ? 'warning' : 'success'} caption="Supply orders still in progress" />
      </div>
      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]"><div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]"><h2>Latest supply requests</h2><span>Your most recent fulfillment activity</span></div></div>
        {data.requests.length === 0 ? <EmptyState /> : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer"><table><thead><tr><th>Request</th><th>Location</th><th>Status</th><th>Delivery date</th></tr></thead><tbody>
            {data.requests.slice(0, 8).map((request) => <tr key={request.id}><td><strong>{request.request_number}</strong></td><td>{request.location?.name || '—'}</td><td><StatusBadge value={request.status} /></td><td>{request.target_delivery_date || '—'}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                                 */
/* ------------------------------------------------------------------ */

const DASH_META = {
  admin: {
    eyebrow: 'Operational command center',
    subtitle: 'Executive overview of inquiries, applicants, inventory and fulfillment.',
  },
  sales: {
    eyebrow: 'Sales command center',
    subtitle: 'Leads, endorsements and applicant conversion — the sales pipeline only.',
  },
  marketing: {
    eyebrow: 'Growth command center',
    subtitle: 'Acquisition channels, lead sources and conversion performance.',
  },
  logistics: {
    eyebrow: 'Logistics command center',
    subtitle: 'Live supply records, warehouse stock status, and fulfillment analytics.',
  },
  franchisee: {
    eyebrow: 'Operational command center',
    subtitle: 'Your application, inventory and supply activity in one view.',
  },
};

export default function Dashboard() {
  const { user, role } = useAuth();
  const firstName = user?.full_name?.split(' ')[0] || 'there';
  const panels = panelsFor(role);
  const meta = DASH_META[role] || DASH_META.admin;

  if (role === 'franchisee') {
    return (
      <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] dashboard-page [--dash-radius-cell:6px] [--dash-accent:var(--accent,_#7b88ff)] [&.page-container]:pt-[10px] [&_.dashboard-greeting]:m-[0_0_14px] [&_.dashboard-greeting]:text-[clamp(22px,_2.1vw,_28px)] [&_.dashboard-greeting]:font-[800] [&_.dashboard-greeting]:tracking-[-0.03em] [&_.dashboard-greeting]:leading-[1.15] [&_.dashboard-greeting]:text-text [&_.metric-card]:min-h-0 [&_.metric-card]:h-auto [&_.metric-card]:p-[10px_14px] [&_.metric-card]:gap-[6px] [&_.metric-card]:rounded-[16px] [&_.metric-top]:gap-2 [&_.metric-top]:text-[10px] [&_.metric-card_strong]:block later:[&_.metric-card_strong]:text-[clamp(20px,_1.9vw,_26px)] [&_.metric-card_strong]:leading-[1.05] [&_.metric-card_strong]:tracking-[-0.04em] [&_.metric-caption]:mt-[3px] [&_.metric-caption]:text-[9px] [&_.metric-caption]:leading-[1.3] [&_.row-actions]:flex [&_.row-actions]:items-center [&_.row-actions]:justify-between later:[&_.row-actions]:gap-4 [&_.row-actions]:flex-nowrap [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[36px] [&_.icon-button]:h-[36px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-transparent [&_.icon-button]:rounded-[var(--dash-radius-cell)] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_box-shadow_0.2s_ease,_color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:focus-visible]:[outline:2px_solid_var(--dash-accent)] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:cursor-not-allowed [&_.icon-button:disabled]:opacity-[0.5] [&_.archive-button]:[background:rgba(59,_130,_246,_0.16)] [&_.archive-button]:border-[rgba(59,_130,_246,_0.4)] [&_.archive-button]:text-[#60a5fa] [&_.archive-button:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.3)] [&_.archive-button:hover:not(:disabled)]:border-[rgba(96,_165,_250,_0.7)] [&_.archive-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(59,_130,_246,_0.4)] [&_.archive-button:hover:not(:disabled)]:text-[#93c5fd] [&_.restore-button]:[background:rgba(16,_185,_129,_0.16)] [&_.restore-button]:border-[rgba(16,_185,_129,_0.4)] [&_.restore-button]:text-[#34d399] [&_.restore-button:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.3)] [&_.restore-button:hover:not(:disabled)]:border-[rgba(52,_211,_153,_0.7)] [&_.restore-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(16,_185,_129,_0.4)] [&_.restore-button:hover:not(:disabled)]:text-[#6ee7b7] [&_.delete-button]:[background:rgba(239,_68,_68,_0.16)] [&_.delete-button]:border-[rgba(239,_68,_68,_0.4)] [&_.delete-button]:text-[#f87171] [&_.delete-button:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.3)] [&_.delete-button:hover:not(:disabled)]:border-[rgba(248,_113,_113,_0.7)] [&_.delete-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(239,_68,_68,_0.45)] [&_.delete-button:hover:not(:disabled)]:text-[#fca5a5] [&_.delete-button:disabled]:opacity-[0.35] [&_.delete-button:disabled]:cursor-not-allowed [&_.delete-button:disabled]:pointer-events-none [&_.delete-button.is-disabled]:opacity-[0.35] [&_.delete-button.is-disabled]:cursor-not-allowed [&_.delete-button.is-disabled]:pointer-events-none [&_.action-btn]:inline-flex [&_.action-btn]:items-center [&_.action-btn]:gap-[6px] [&_.action-btn]:p-[6px_12px] [&_.action-btn]:text-[12.5px] [&_.action-btn]:font-[650] [&_.action-btn]:border [&_.action-btn]:border-transparent [&_.action-btn]:rounded-[var(--dash-radius-cell)] [&_.action-btn]:cursor-pointer [&_.action-btn]:[transition:background-color_0.15s_ease,_color_0.15s_ease] [&_.action-btn.is-archive]:[background:rgba(59,_130,_246,_0.14)] [&_.action-btn.is-archive]:border-[rgba(59,_130,_246,_0.4)] [&_.action-btn.is-archive]:text-[#60a5fa] [&_.action-btn.is-archive:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.action-btn.is-archive:hover:not(:disabled)]:text-[#93c5fd] [&_.action-btn.is-restore]:[background:rgba(16,_185,_129,_0.12)] [&_.action-btn.is-restore]:border-[rgba(16,_185,_129,_0.35)] [&_.action-btn.is-restore]:text-[#34d399] [&_.action-btn.is-restore:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.22)] [&_.action-btn.is-restore:hover:not(:disabled)]:text-[#6ee7b7] [&_.action-btn.is-delete]:[background:rgba(239,_68,_68,_0.12)] [&_.action-btn.is-delete]:border-[rgba(239,_68,_68,_0.35)] [&_.action-btn.is-delete]:text-[#f87171] [&_.action-btn.is-delete:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.22)] [&_.action-btn.is-delete:hover:not(:disabled)]:text-[#fca5a5] motion-reduce:[&_*]:[transition:none]! [&_.panel-title]:flex-wrap [&_.chart-surface]:p-[14px_12px_2px] [&_.chart-caption]:m-0 [&_.chart-caption]:p-[4px_14px_15px] [&_.chart-caption]:text-[8.5px] [&_.chart-caption]:leading-[1.5] [&_.chart-legend-item]:inline-flex [&_.chart-legend-item]:items-center [&_.chart-legend-item]:gap-[7px] [&_.chart-legend-item]:text-muted [&_.chart-legend-item]:text-[8.5px] [&_.chart-legend-item]:font-[680] later:[&_.legend-swatch]:inline-block [&_.legend-swatch]:w-[15px] [&_.legend-swatch]:h-[8px] [&_.legend-swatch]:rounded-[4px] later:[&_.legend-line]:h-[3px] later:[&_.legend-line]:rounded-[999px] [&_.legend-line]:[background:#32c997] [&_.dashboard-tab-indicator]:absolute [&_.dashboard-tab-indicator]:top-0 [&_.dashboard-tab-indicator]:-bottom-[1px] [&_.dashboard-tab-indicator]:left-0 [&_.dashboard-tab-indicator]:z-0 [&_.dashboard-tab-indicator]:[box-sizing:border-box] [&_.dashboard-tab-indicator]:[background:var(--panel)] [&_.dashboard-tab-indicator]:border [&_.dashboard-tab-indicator]:border-[color:var(--border-strong,_var(--border))] [&_.dashboard-tab-indicator]:border-b-0 [&_.dashboard-tab-indicator]:rounded-[10px_14px_0_0] [&_.dashboard-tab-indicator]:pointer-events-none [&_.dashboard-tab-indicator]:[will-change:transform,_width] [&_.dashboard-tab-indicator.is-ready]:[transition:transform_340ms_cubic-bezier(0.22,_0.8,_0.3,_1),_width_340ms_cubic-bezier(0.22,_0.8,_0.3,_1)] [&_.dashboard-tab-indicator::before]:[content:''] [&_.dashboard-tab-indicator::before]:absolute [&_.dashboard-tab-indicator::before]:bottom-0 [&_.dashboard-tab-indicator::before]:w-[12px] [&_.dashboard-tab-indicator::before]:h-[12px] [&_.dashboard-tab-indicator::before]:pointer-events-none [&_.dashboard-tab-indicator::after]:[content:''] [&_.dashboard-tab-indicator::after]:absolute [&_.dashboard-tab-indicator::after]:bottom-0 [&_.dashboard-tab-indicator::after]:w-[12px] [&_.dashboard-tab-indicator::after]:h-[12px] [&_.dashboard-tab-indicator::after]:pointer-events-none [&_.dashboard-tab-indicator::before]:-left-[12px] [&_.dashboard-tab-indicator::before]:[background:radial-gradient(_circle_at_0_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] [&_.dashboard-tab-indicator::after]:-right-[12px] [&_.dashboard-tab-indicator::after]:[background:radial-gradient(_circle_at_100%_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] motion-reduce:[&_.dashboard-tab-indicator.is-ready]:[transition:none]!">
        <PageHeader
          title={`Good to see you, ${firstName}.`}
          subtitle="Your application, inventory and supply activity in one view."
          eyebrow="Franchise portal"
        />
        <FranchiseeDashboard />
      </div>
    );
  }

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] dashboard-page [--dash-radius-cell:6px] [--dash-accent:var(--accent,_#7b88ff)] [&.page-container]:pt-[10px] [&_.dashboard-greeting]:m-[0_0_14px] [&_.dashboard-greeting]:text-[clamp(22px,_2.1vw,_28px)] [&_.dashboard-greeting]:font-[800] [&_.dashboard-greeting]:tracking-[-0.03em] [&_.dashboard-greeting]:leading-[1.15] [&_.dashboard-greeting]:text-text [&_.metric-card]:min-h-0 [&_.metric-card]:h-auto [&_.metric-card]:p-[10px_14px] [&_.metric-card]:gap-[6px] [&_.metric-card]:rounded-[16px] [&_.metric-top]:gap-2 [&_.metric-top]:text-[10px] [&_.metric-card_strong]:block later:[&_.metric-card_strong]:text-[clamp(20px,_1.9vw,_26px)] [&_.metric-card_strong]:leading-[1.05] [&_.metric-card_strong]:tracking-[-0.04em] [&_.metric-caption]:mt-[3px] [&_.metric-caption]:text-[9px] [&_.metric-caption]:leading-[1.3] [&_.row-actions]:flex [&_.row-actions]:items-center [&_.row-actions]:justify-between later:[&_.row-actions]:gap-4 [&_.row-actions]:flex-nowrap [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[36px] [&_.icon-button]:h-[36px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-transparent [&_.icon-button]:rounded-[var(--dash-radius-cell)] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_box-shadow_0.2s_ease,_color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:focus-visible]:[outline:2px_solid_var(--dash-accent)] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:cursor-not-allowed [&_.icon-button:disabled]:opacity-[0.5] [&_.archive-button]:[background:rgba(59,_130,_246,_0.16)] [&_.archive-button]:border-[rgba(59,_130,_246,_0.4)] [&_.archive-button]:text-[#60a5fa] [&_.archive-button:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.3)] [&_.archive-button:hover:not(:disabled)]:border-[rgba(96,_165,_250,_0.7)] [&_.archive-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(59,_130,_246,_0.4)] [&_.archive-button:hover:not(:disabled)]:text-[#93c5fd] [&_.restore-button]:[background:rgba(16,_185,_129,_0.16)] [&_.restore-button]:border-[rgba(16,_185,_129,_0.4)] [&_.restore-button]:text-[#34d399] [&_.restore-button:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.3)] [&_.restore-button:hover:not(:disabled)]:border-[rgba(52,_211,_153,_0.7)] [&_.restore-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(16,_185,_129,_0.4)] [&_.restore-button:hover:not(:disabled)]:text-[#6ee7b7] [&_.delete-button]:[background:rgba(239,_68,_68,_0.16)] [&_.delete-button]:border-[rgba(239,_68,_68,_0.4)] [&_.delete-button]:text-[#f87171] [&_.delete-button:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.3)] [&_.delete-button:hover:not(:disabled)]:border-[rgba(248,_113,_113,_0.7)] [&_.delete-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(239,_68,_68,_0.45)] [&_.delete-button:hover:not(:disabled)]:text-[#fca5a5] [&_.delete-button:disabled]:opacity-[0.35] [&_.delete-button:disabled]:cursor-not-allowed [&_.delete-button:disabled]:pointer-events-none [&_.delete-button.is-disabled]:opacity-[0.35] [&_.delete-button.is-disabled]:cursor-not-allowed [&_.delete-button.is-disabled]:pointer-events-none [&_.action-btn]:inline-flex [&_.action-btn]:items-center [&_.action-btn]:gap-[6px] [&_.action-btn]:p-[6px_12px] [&_.action-btn]:text-[12.5px] [&_.action-btn]:font-[650] [&_.action-btn]:border [&_.action-btn]:border-transparent [&_.action-btn]:rounded-[var(--dash-radius-cell)] [&_.action-btn]:cursor-pointer [&_.action-btn]:[transition:background-color_0.15s_ease,_color_0.15s_ease] [&_.action-btn.is-archive]:[background:rgba(59,_130,_246,_0.14)] [&_.action-btn.is-archive]:border-[rgba(59,_130,_246,_0.4)] [&_.action-btn.is-archive]:text-[#60a5fa] [&_.action-btn.is-archive:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.action-btn.is-archive:hover:not(:disabled)]:text-[#93c5fd] [&_.action-btn.is-restore]:[background:rgba(16,_185,_129,_0.12)] [&_.action-btn.is-restore]:border-[rgba(16,_185,_129,_0.35)] [&_.action-btn.is-restore]:text-[#34d399] [&_.action-btn.is-restore:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.22)] [&_.action-btn.is-restore:hover:not(:disabled)]:text-[#6ee7b7] [&_.action-btn.is-delete]:[background:rgba(239,_68,_68,_0.12)] [&_.action-btn.is-delete]:border-[rgba(239,_68,_68,_0.35)] [&_.action-btn.is-delete]:text-[#f87171] [&_.action-btn.is-delete:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.22)] [&_.action-btn.is-delete:hover:not(:disabled)]:text-[#fca5a5] motion-reduce:[&_*]:[transition:none]! [&_.panel-title]:flex-wrap [&_.chart-surface]:p-[14px_12px_2px] [&_.chart-caption]:m-0 [&_.chart-caption]:p-[4px_14px_15px] [&_.chart-caption]:text-[8.5px] [&_.chart-caption]:leading-[1.5] [&_.chart-legend-item]:inline-flex [&_.chart-legend-item]:items-center [&_.chart-legend-item]:gap-[7px] [&_.chart-legend-item]:text-muted [&_.chart-legend-item]:text-[8.5px] [&_.chart-legend-item]:font-[680] later:[&_.legend-swatch]:inline-block [&_.legend-swatch]:w-[15px] [&_.legend-swatch]:h-[8px] [&_.legend-swatch]:rounded-[4px] later:[&_.legend-line]:h-[3px] later:[&_.legend-line]:rounded-[999px] [&_.legend-line]:[background:#32c997] [&_.dashboard-tab-indicator]:absolute [&_.dashboard-tab-indicator]:top-0 [&_.dashboard-tab-indicator]:-bottom-[1px] [&_.dashboard-tab-indicator]:left-0 [&_.dashboard-tab-indicator]:z-0 [&_.dashboard-tab-indicator]:[box-sizing:border-box] [&_.dashboard-tab-indicator]:[background:var(--panel)] [&_.dashboard-tab-indicator]:border [&_.dashboard-tab-indicator]:border-[color:var(--border-strong,_var(--border))] [&_.dashboard-tab-indicator]:border-b-0 [&_.dashboard-tab-indicator]:rounded-[10px_14px_0_0] [&_.dashboard-tab-indicator]:pointer-events-none [&_.dashboard-tab-indicator]:[will-change:transform,_width] [&_.dashboard-tab-indicator.is-ready]:[transition:transform_340ms_cubic-bezier(0.22,_0.8,_0.3,_1),_width_340ms_cubic-bezier(0.22,_0.8,_0.3,_1)] [&_.dashboard-tab-indicator::before]:[content:''] [&_.dashboard-tab-indicator::before]:absolute [&_.dashboard-tab-indicator::before]:bottom-0 [&_.dashboard-tab-indicator::before]:w-[12px] [&_.dashboard-tab-indicator::before]:h-[12px] [&_.dashboard-tab-indicator::before]:pointer-events-none [&_.dashboard-tab-indicator::after]:[content:''] [&_.dashboard-tab-indicator::after]:absolute [&_.dashboard-tab-indicator::after]:bottom-0 [&_.dashboard-tab-indicator::after]:w-[12px] [&_.dashboard-tab-indicator::after]:h-[12px] [&_.dashboard-tab-indicator::after]:pointer-events-none [&_.dashboard-tab-indicator::before]:-left-[12px] [&_.dashboard-tab-indicator::before]:[background:radial-gradient(_circle_at_0_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] [&_.dashboard-tab-indicator::after]:-right-[12px] [&_.dashboard-tab-indicator::after]:[background:radial-gradient(_circle_at_100%_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] motion-reduce:[&_.dashboard-tab-indicator.is-ready]:[transition:none]!">
      <PageHeader
        title={`Good to see you, ${firstName}.`}
        subtitle={meta.subtitle}
        eyebrow={meta.eyebrow}
      />
      <DashboardBody role={role} panels={panels} />
    </div>
  );
}
