import React, { useState } from 'react';
import { api } from '../lib/api';
import useRemote from '../lib/useRemote';
import { titleCase } from '../lib/format';
import { EmptyState, LoadingState, Notice } from '../components/ApiUi';
import { brandColor } from '../lib/brandColors';

// Server stores times in Asia/Manila (APP_TIMEZONE) and returns ISO 8601 UTC ("...Z").
// Format with the Manila zone explicitly so the display does not depend on the viewer's machine.
const formatManila = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
};

const PER_PAGE = 15;
const SECTIONS = [
  { key: 'input', label: 'Input Leads History' },
  { key: 'endorsed', label: 'Endorse History' },
  { key: 'archive', label: 'Archive' },
];

function BrandCell({ name }) {
  if (!name) return '—';
  return <span className="[.data-panel_.table-wrap_table_tbody_tr.inquiry-row_td:nth-child(3)_&]:text-[0.725rem]! [.data-panel_.table-wrap_table_tbody_tr.inquiry-row_td:nth-child(3)_&]:font-[350]! font-[600]" style={{ color: brandColor(name) }}>{name}</span>;
}

const leadName = (row) => [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.lead_name || '—';

export default function InquiryHistory() {
  const [section, setSection] = useState('input');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [endorsedPage, setEndorsedPage] = useState(1);

  // Input leads: filtered on the server to leads this user entered, with real pagination.
  const inputs = useRemote(async () => {
    const result = await api.get('/inquiries', { page, per_page: PER_PAGE, search, encoded_by_me: 1 });
    return { rows: result.data || [], meta: result.meta };
  }, [page, search]);

  // Endorsed history: one row per endorsement, Marketing users only (server-side).
  const endorsed = useRemote(async () => {
    const result = await api.get('/inquiries/endorsement-history', { page: endorsedPage, per_page: PER_PAGE, search });
    return { rows: result.data || [], meta: result.meta };
  }, [endorsedPage, search]);
  const endorsedLast = Number(endorsed.data?.meta?.last_page || 1);

  // Archive: the same server-filtered visibility as the pipeline (scopeVisibleTo applies).
  const [archivePage, setArchivePage] = useState(1);
  const archive = useRemote(async () => {
    if (section !== 'archive') return { rows: [] };
    const result = await api.get('/inquiries', { page: archivePage, per_page: PER_PAGE, archived: 1, search });
    return { rows: result.data || [], meta: result.meta };
  }, [section, search, archivePage]);
  const archiveLast = Number(archive.data?.meta?.last_page || 1);

  const inputMeta = inputs.data?.meta;
  const lastPage = Number(inputMeta?.last_page || 1);

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] inquiries-page later-2:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! [&_.eyebrow]:hidden! later-3:[&>:empty]:hidden! [&_.toolbar]:m-0! [&_.toolbar]:p-[10px_12px] [&_.toolbar]:items-center [&_.data-panel]:m-0! [&.page-container_.toolbar]:[--toolbar-control-h:48px] [&.page-container_.toolbar]:flex! [&.page-container_.toolbar]:items-center! [&.page-container_.toolbar]:gap-[10px] [&.page-container_.toolbar>input]:min-w-0 [&.page-container_.toolbar>input]:flex-[1_1_auto] [&.page-container_.toolbar>input]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar>input]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar>input]:[box-sizing:border-box] [&.page-container_.toolbar_select]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_select]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_select]:[box-sizing:border-box] [&.page-container_.toolbar_button.tab]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_button.tab]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_button.tab]:[box-sizing:border-box] [&.page-container_.toolbar_button.tab]:inline-flex! [&.page-container_.toolbar_button.tab]:items-center [&.page-container_.toolbar_button.tab]:justify-center [&.page-container_.toolbar_button.tab]:gap-2 [&.page-container_.toolbar_button.tab]:flex-none [&.page-container_.toolbar_button.tab]:p-[0_20px]! [&.page-container_.toolbar_button.tab]:border! [&.page-container_.toolbar_button.tab]:border-[#1f2842]! [&.page-container_.toolbar_button.tab]:rounded-[12px]! [&.page-container_.toolbar_button.tab]:[background-color:#161d30]! [&.page-container_.toolbar_button.tab]:text-[#fff]! [&.page-container_.toolbar_button.tab]:text-[1rem]! [&.page-container_.toolbar_button.tab]:font-[600]! [&.page-container_.toolbar_button.tab]:whitespace-nowrap [&.page-container_.toolbar_button.tab]:cursor-pointer [&.page-container_.toolbar_button.tab]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&.page-container_.toolbar_button.tab_svg]:m-0 [&.page-container_.toolbar_button.tab_svg]:text-[1rem] [&.page-container_.toolbar_button.tab:hover]:[background-color:rgba(123,_136,_255,_0.14)]! [&.page-container_.toolbar_button.tab:hover]:border-[rgba(123,_136,_255,_0.5)]! later:[&.page-container_.toolbar_button.tab.active]:[background-color:rgba(123,_136,_255,_0.22)]! later:[&.page-container_.toolbar_button.tab.active]:border-[#7b88ff]! [&.page-container_.toolbar_button.tab:focus-visible]:[outline:2px_solid_#7b88ff] [&.page-container_.toolbar_button.tab:focus-visible]:[outline-offset:2px] max-[721px]:[&.page-container_.toolbar]:flex-wrap max-[721px]:later:[&.page-container_.toolbar>input]:flex-[1_1_100%] max-[721px]:later:[&.page-container_.toolbar_button.tab]:flex-[1_1_100%] inquiry-history-page [&>.dashboard-tabpanel]:-mt-[1px] dashboard-page [--dash-radius-cell:6px] [--dash-accent:var(--accent,_#7b88ff)] [&_.dashboard-greeting]:m-[0_0_14px] [&_.dashboard-greeting]:text-[clamp(22px,_2.1vw,_28px)] [&_.dashboard-greeting]:font-[800] [&_.dashboard-greeting]:tracking-[-0.03em] [&_.dashboard-greeting]:leading-[1.15] [&_.dashboard-greeting]:text-text [&_.metric-card]:min-h-0 [&_.metric-card]:h-auto [&_.metric-card]:p-[10px_14px] [&_.metric-card]:gap-[6px] [&_.metric-card]:rounded-[16px] [&_.metric-top]:gap-2 [&_.metric-top]:text-[10px] [&_.metric-card_strong]:block later:[&_.metric-card_strong]:text-[clamp(20px,_1.9vw,_26px)] [&_.metric-card_strong]:leading-[1.05] [&_.metric-card_strong]:tracking-[-0.04em] [&_.metric-caption]:mt-[3px] [&_.metric-caption]:text-[9px] [&_.metric-caption]:leading-[1.3] [&_.row-actions]:flex [&_.row-actions]:items-center [&_.row-actions]:justify-between later:[&_.row-actions]:gap-4 [&_.row-actions]:flex-nowrap [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[36px] [&_.icon-button]:h-[36px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-transparent [&_.icon-button]:rounded-[var(--dash-radius-cell)] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_box-shadow_0.2s_ease,_color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:focus-visible]:[outline:2px_solid_var(--dash-accent)] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:cursor-not-allowed [&_.icon-button:disabled]:opacity-[0.5] [&_.archive-button]:[background:rgba(59,_130,_246,_0.16)] [&_.archive-button]:border-[rgba(59,_130,_246,_0.4)] [&_.archive-button]:text-[#60a5fa] [&_.archive-button:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.3)] [&_.archive-button:hover:not(:disabled)]:border-[rgba(96,_165,_250,_0.7)] [&_.archive-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(59,_130,_246,_0.4)] [&_.archive-button:hover:not(:disabled)]:text-[#93c5fd] [&_.restore-button]:[background:rgba(16,_185,_129,_0.16)] [&_.restore-button]:border-[rgba(16,_185,_129,_0.4)] [&_.restore-button]:text-[#34d399] [&_.restore-button:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.3)] [&_.restore-button:hover:not(:disabled)]:border-[rgba(52,_211,_153,_0.7)] [&_.restore-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(16,_185,_129,_0.4)] [&_.restore-button:hover:not(:disabled)]:text-[#6ee7b7] [&_.delete-button]:[background:rgba(239,_68,_68,_0.16)] [&_.delete-button]:border-[rgba(239,_68,_68,_0.4)] [&_.delete-button]:text-[#f87171] [&_.delete-button:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.3)] [&_.delete-button:hover:not(:disabled)]:border-[rgba(248,_113,_113,_0.7)] [&_.delete-button:hover:not(:disabled)]:[box-shadow:0_0_12px_rgba(239,_68,_68,_0.45)] [&_.delete-button:hover:not(:disabled)]:text-[#fca5a5] [&_.delete-button:disabled]:opacity-[0.35] [&_.delete-button:disabled]:cursor-not-allowed [&_.delete-button:disabled]:pointer-events-none [&_.delete-button.is-disabled]:opacity-[0.35] [&_.delete-button.is-disabled]:cursor-not-allowed [&_.delete-button.is-disabled]:pointer-events-none [&_.action-btn]:inline-flex [&_.action-btn]:items-center [&_.action-btn]:gap-[6px] [&_.action-btn]:p-[6px_12px] [&_.action-btn]:text-[12.5px] [&_.action-btn]:font-[650] [&_.action-btn]:border [&_.action-btn]:border-transparent [&_.action-btn]:rounded-[var(--dash-radius-cell)] [&_.action-btn]:cursor-pointer [&_.action-btn]:[transition:background-color_0.15s_ease,_color_0.15s_ease] [&_.action-btn.is-archive]:[background:rgba(59,_130,_246,_0.14)] [&_.action-btn.is-archive]:border-[rgba(59,_130,_246,_0.4)] [&_.action-btn.is-archive]:text-[#60a5fa] [&_.action-btn.is-archive:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.action-btn.is-archive:hover:not(:disabled)]:text-[#93c5fd] [&_.action-btn.is-restore]:[background:rgba(16,_185,_129,_0.12)] [&_.action-btn.is-restore]:border-[rgba(16,_185,_129,_0.35)] [&_.action-btn.is-restore]:text-[#34d399] [&_.action-btn.is-restore:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.22)] [&_.action-btn.is-restore:hover:not(:disabled)]:text-[#6ee7b7] [&_.action-btn.is-delete]:[background:rgba(239,_68,_68,_0.12)] [&_.action-btn.is-delete]:border-[rgba(239,_68,_68,_0.35)] [&_.action-btn.is-delete]:text-[#f87171] [&_.action-btn.is-delete:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.22)] [&_.action-btn.is-delete:hover:not(:disabled)]:text-[#fca5a5] motion-reduce:[&_*]:[transition:none]! [&_.panel-title]:flex-wrap [&_.chart-surface]:p-[14px_12px_2px] [&_.chart-caption]:m-0 [&_.chart-caption]:p-[4px_14px_15px] [&_.chart-caption]:text-[8.5px] [&_.chart-caption]:leading-[1.5] [&_.chart-legend-item]:inline-flex [&_.chart-legend-item]:items-center [&_.chart-legend-item]:gap-[7px] [&_.chart-legend-item]:text-muted [&_.chart-legend-item]:text-[8.5px] [&_.chart-legend-item]:font-[680] later:[&_.legend-swatch]:inline-block [&_.legend-swatch]:w-[15px] [&_.legend-swatch]:h-[8px] [&_.legend-swatch]:rounded-[4px] later:[&_.legend-line]:h-[3px] later:[&_.legend-line]:rounded-[999px] [&_.legend-line]:[background:#32c997] [&_.dashboard-tab-indicator]:absolute [&_.dashboard-tab-indicator]:top-0 [&_.dashboard-tab-indicator]:-bottom-[1px] [&_.dashboard-tab-indicator]:left-0 [&_.dashboard-tab-indicator]:z-0 [&_.dashboard-tab-indicator]:[box-sizing:border-box] [&_.dashboard-tab-indicator]:[background:var(--panel)] [&_.dashboard-tab-indicator]:border [&_.dashboard-tab-indicator]:border-[color:var(--border-strong,_var(--border))] [&_.dashboard-tab-indicator]:border-b-0 [&_.dashboard-tab-indicator]:rounded-[10px_14px_0_0] [&_.dashboard-tab-indicator]:pointer-events-none [&_.dashboard-tab-indicator]:[will-change:transform,_width] [&_.dashboard-tab-indicator.is-ready]:[transition:transform_340ms_cubic-bezier(0.22,_0.8,_0.3,_1),_width_340ms_cubic-bezier(0.22,_0.8,_0.3,_1)] [&_.dashboard-tab-indicator::before]:[content:''] [&_.dashboard-tab-indicator::before]:absolute [&_.dashboard-tab-indicator::before]:bottom-0 [&_.dashboard-tab-indicator::before]:w-[12px] [&_.dashboard-tab-indicator::before]:h-[12px] [&_.dashboard-tab-indicator::before]:pointer-events-none [&_.dashboard-tab-indicator::after]:[content:''] [&_.dashboard-tab-indicator::after]:absolute [&_.dashboard-tab-indicator::after]:bottom-0 [&_.dashboard-tab-indicator::after]:w-[12px] [&_.dashboard-tab-indicator::after]:h-[12px] [&_.dashboard-tab-indicator::after]:pointer-events-none [&_.dashboard-tab-indicator::before]:-left-[12px] [&_.dashboard-tab-indicator::before]:[background:radial-gradient(_circle_at_0_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] [&_.dashboard-tab-indicator::after]:-right-[12px] [&_.dashboard-tab-indicator::after]:[background:radial-gradient(_circle_at_100%_0,_transparent_11px,_var(--border-strong,_var(--border))_11px,_var(--border-strong,_var(--border))_12px,_var(--panel)_12px_)] motion-reduce:[&_.dashboard-tab-indicator.is-ready]:[transition:none]!">
      <div className="[.inquiries-page_&]:flex! [.inquiries-page_&]:flex-row! [.inquiries-page_&]:items-center! [.inquiries-page_&]:justify-between! [.inquiries-page_&]:gap-4 [.inquiries-page_&]:m-0! [.inquiries-page_&]:p-0! [.inquiries-page_&]:min-h-0! [.inquiries-page_&_h1]:m-0! [.inquiries-page_&_h1]:p-0! [.inquiries-page_&_h1]:text-[2rem] [.inquiries-page_&_h1]:font-[800] [.inquiries-page_&_h1]:leading-[1.15] [.inquiries-page_&_h1]:tracking-[-.045em] [.inquiries-page_&_.primary-button]:flex-none [.inquiries-page_&_.primary-button]:w-auto! [.inquiries-page_&_.primary-button]:m-0!">
        <h1>History</h1>
      </div>

      {/* Header row: search and the Archive toggle. */}
      <div className="toolbar flex items-center flex-wrap gap-[9px] mb-[14px] p-[10px] border border-line rounded-[15px] [background:color-mix(in_srgb,_var(--panel)_92%,_transparent)] [box-shadow:var(--shadow-sm)] [&_input]:flex-[1_1_270px] [&_select]:flex-[0_1_210px] [&_input]:min-h-[40px] [&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:min-h-[40px] [&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong [&_select:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[681px]:later:items-stretch max-[681px]:flex-col max-[681px]:[&_input]:w-full max-[681px]:later:[&_input]:flex-[auto] max-[681px]:[&_select]:w-full max-[681px]:later:[&_select]:flex-[auto] history-toolbar">
        <input
          value={search}
          onChange={(event) => { setPage(1); setEndorsedPage(1); setArchivePage(1); setSearch(event.target.value); }}
          placeholder="Search name, lead ID, source, concept, or encoder"
          aria-label="Search history"
        />
      </div>

        <div className="dashboard-tabs [.dashboard-page_&]:relative [.dashboard-page_&]:z-2 [.dashboard-page_&]:flex [.dashboard-page_&]:items-end [.dashboard-page_&]:flex-nowrap [.dashboard-page_&]:gap-3 [.dashboard-page_&]:p-0 [.dashboard-page_&]:min-w-0 [.dashboard-page_&]:max-w-full [.dashboard-page_&]:[clip-path:inset(-24px_-24px_-2px_0)] max-[681px]:later:[.dashboard-page_&]:gap-[10px] [.inquiry-history-page>&.dashboard-tabs]:mb-0! [.inquiry-history-page>&.dashboard-tabs]:self-start" role="tablist" aria-label="History sections">
          {SECTIONS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={section === tab.key}
              className={`[.dashboard-page_&]:relative [.dashboard-page_&]:z-1 [.dashboard-page_&]:[box-sizing:border-box] [.dashboard-page_&]:min-h-[46px] [.dashboard-page_&]:p-[0_20px] [.dashboard-page_&]:border [.dashboard-page_&]:border-transparent [.dashboard-page_&]:border-b-0 [.dashboard-page_&]:rounded-[12px_12px_0_0] [.dashboard-page_&]:text-muted [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_55%,_transparent)] [.dashboard-page_&]:text-[10px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.08em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap [.dashboard-page_&]:cursor-pointer [.dashboard-page_&]:opacity-[0.85] [.dashboard-page_&]:[transition:color_0.2s_ease,_opacity_0.2s_ease] [.dashboard-page_&:hover:not(.is-active)]:text-text [.dashboard-page_&:hover:not(.is-active)]:opacity-[1] [.dashboard-page_&:focus-visible]:[outline:2px_solid_var(--accent)] [.dashboard-page_&:focus-visible]:[outline-offset:-3px] [.dashboard-page_&.is-active]:text-text [.dashboard-page_&.is-active]:opacity-[1] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:[background:var(--panel)] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:border-[color:var(--border-strong,_var(--border))] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:-mb-[1px] [.dashboard-page_.dashboard-tabs:not(:has(.dashboard-tab-indicator))_&.is-active]:min-h-[47px] later:[.dashboard-page_.dashboard-tabs:has(.dashboard-tab-indicator)_&.is-active]:[background:transparent] later:[.dashboard-page_.dashboard-tabs:has(.dashboard-tab-indicator)_&.is-active]:border-transparent max-[681px]:later:[.dashboard-page_&]:p-[0_12px] max-[681px]:later:[.dashboard-page_&]:text-[9px] ${section === tab.key ? ' is-active' : ''}`}
              onClick={() => { setPage(1); setEndorsedPage(1); setSection(tab.key); }}
            >
              {tab.label}
            </button>
          ))}
        </div>

      <div className="dashboard-tabpanel [.dashboard-page_&]:relative [.dashboard-page_&]:z-1 [.dashboard-page_&]:-mt-[1px] [.dashboard-page_&]:p-[18px] [.dashboard-page_&]:border [.dashboard-page_&]:border-[color:var(--border-strong,_var(--border))] [.dashboard-page_&]:rounded-[0_14px_14px_14px] [.dashboard-page_&]:[background:var(--panel)] [.dashboard-page_&]:min-w-0" role="tabpanel">
      {section === 'archive' ? (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
            <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
              <h2>Archive</h2>
              <span>Archived leads.</span>
            </div>
          </div>
          {archive.loading ? <LoadingState /> : archive.error ? <Notice type="error">{archive.error}</Notice> : !archive.data?.rows.length ? (
            <EmptyState label="No archived inquiries." detail="Archived leads appear here." />
          ) : (
            <>
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer archive-mode">
                <table>
                  <thead><tr><th>Name</th><th>Source</th><th>Concept</th><th>Date and time archived</th></tr></thead>
                  <tbody>
                    {archive.data.rows.map((row) => (
                      <tr key={row.id}>
                        <td><strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{leadName(row)}</strong></td>
                        <td>{titleCase(row.source)}</td>
                        <td><BrandCell name={row.preferred_brand?.name} /></td>
                        <td>{formatManila(row.archived_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(
                <nav className="inquiry-pagination flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Archive pagination">
                  <span className="page-count">Page {archivePage} of {archiveLast} · {Number(archive.data?.meta?.total || 0)} records</span>
                  <div className="page-nav">
                    <button type="button" className="page-step" onClick={() => setArchivePage(archivePage - 1)} disabled={archivePage <= 1}>Previous</button>
                    <button type="button" className="page-step" onClick={() => setArchivePage(archivePage + 1)} disabled={archivePage >= archiveLast}>Next</button>
                  </div>
                </nav>
              )}
            </>
          )}
        </section>
      ) : section === 'input' ? (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          {inputs.loading ? <LoadingState /> : inputs.error ? <Notice type="error">{inputs.error}</Notice> : !inputs.data?.rows.length ? (
            <EmptyState label="No input leads yet." detail="Leads you record will appear here." />
          ) : (
            <>
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table>
                  <thead><tr><th>Name</th><th>Encoded by</th><th>Source</th><th>Concept</th><th>Date and time entered</th></tr></thead>
                  <tbody>
                    {inputs.data.rows.map((row) => (
                      <tr key={row.id}>
                        <td><strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{leadName(row)}</strong></td>
                        <td className="[&_strong]:text-[13px] later:[&_small]:text-[12px] [&_small]:whitespace-nowrap">
                          {/* No signed-in user created it: the system did. */}
                          <strong>{row.encoded_by?.full_name || 'System'}</strong>
                          {row.encoded_by?.user_code && <small>{row.encoded_by.user_code}</small>}
                        </td>
                        <td>{titleCase(row.source)}</td>
                        <td><BrandCell name={row.preferred_brand?.name} /></td>
                        <td>{formatManila(row.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(
                <nav className="inquiry-pagination flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Input leads pagination">
                  <span className="page-count">Page {page} of {lastPage} · {Number(inputMeta?.total || 0)} records</span>
                  <div className="page-nav">
                    <button type="button" className="page-step" onClick={() => setPage(page - 1)} disabled={page <= 1}>Previous</button>
                    <button type="button" className="page-step" onClick={() => setPage(page + 1)} disabled={page >= lastPage}>Next</button>
                  </div>
                </nav>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          {endorsed.loading ? <LoadingState /> : endorsed.error ? <Notice type="error">{endorsed.error}</Notice> : !endorsed.data?.rows.length ? (
            <EmptyState label="No endorsements yet." detail="Each time you endorse a lead to Admin, it is logged here." />
          ) : (
            <>
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table>
                <thead><tr><th>Name</th><th>Concept</th><th>Date and time endorsed</th></tr></thead>
                <tbody>
                  {endorsed.data.rows.map((row) => (
                    <tr key={row.id}>
                      <td><strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{row.lead_name || '—'}</strong></td>
                      <td><BrandCell name={row.concept} /></td>
                      <td>{formatManila(row.endorsed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="inquiry-pagination flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Endorsed history pagination">
              <span className="page-count">
                Page {endorsedPage} of {endorsedLast} · {Number(endorsed.data.meta?.total || 0)} records
              </span>
              <div className="page-nav">
                <button type="button" className="page-step" onClick={() => setEndorsedPage(endorsedPage - 1)} disabled={endorsedPage <= 1}>Previous</button>
                <button type="button" className="page-step" onClick={() => setEndorsedPage(endorsedPage + 1)} disabled={endorsedPage >= endorsedLast}>Next</button>
              </div>
            </nav>
            </>
          )}
        </section>
      )}
      </div>
    </div>
  );
}
