import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FaArrowDownWideShort,
  FaArrowTrendUp,
  FaArrowUpWideShort,
  FaBoxesStacked,
  FaCalendarDays,
  FaCalendarXmark,
  FaChartLine,
  FaCircleInfo,
  FaClockRotateLeft,
  FaGear,
  FaPlus,
  FaRotateLeft,
  FaTriangleExclamation,
  FaXmark,
} from 'react-icons/fa6';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import useForecastLiveRefresh from '../lib/useForecastLiveRefresh';
import { formatNumber } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, Pagination } from '../components/ApiUi';
import BranchCombobox from '../components/BranchCombobox';

// Estimated Requirement, daily model. Descriptive = what happened; Predictive = what to order. Estimates are
// statistical and rule-based (WMA / SES / Croston on past usage), never AI, and never create an order.

const NOTE = 'Estimates are based on past usage to support decisions. They are not guarantees.';
const ALL_BRANCHES = '__all';
const HORIZONS = [{ value: 7, label: '1 week' }, { value: 14, label: '2 weeks' }, { value: 30, label: '1 month' }];

const STATUS_LABEL = { low_cover: 'Low cover', normal: 'Normal', overstocked: 'Overstocked', no_estimate: 'No estimate' };
const STATUS_CLASS = { low_cover: 'er-runs_out_soon', normal: 'er-ok', overstocked: 'er-watch', no_estimate: '' };
const STATUS_ORDER = { low_cover: 0, normal: 1, overstocked: 2, no_estimate: 3 };
const PATTERN_LABEL = { smooth: 'Smooth', erratic: 'Erratic', intermittent: 'Intermittent', lumpy: 'Lumpy' };
const DAY_LABEL = {
  open: 'Counted', closed: 'Branch closed', excluded: 'Week excluded', no_records: 'No records that day', not_yet_open: 'Before opening', not_yet_stocked: 'Not yet stocked',
};

const TABLE_WRAP = 'table-wrap overflow-x-auto';
const TABLE_PAGE_SIZE = 7;
const TABLE = 'er-table w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_.er-th-right]:text-right [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_strong]:text-[length:inherit] [&_td_strong]:leading-[inherit] [&_td_b]:text-[length:inherit] [&_td_b]:leading-[inherit]';
const TAG = 'er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px]';
const METHOD_TAG = 'inline-flex items-center p-[2px_9px] rounded-[999px] text-[11px] font-[700] border border-[color:color-mix(in_srgb,_var(--accent)_45%,_transparent)] [background:color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent-text whitespace-nowrap';
const CARD = 'relative isolate overflow-hidden flex flex-col gap-[2px] p-[10px_14px] [background:var(--panel)] border border-line rounded-[12px] [&_strong]:text-[18px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11px] before:content-[""] before:absolute before:top-[-34px] before:right-[-34px] before:w-[84px] before:h-[84px] before:rounded-full before:[background:radial-gradient(circle_at_30%_30%,_color-mix(in_srgb,_var(--accent)_38%,_transparent),_color-mix(in_srgb,_var(--accent-2)_12%,_transparent)_70%)] before:-z-10 before:[transition:transform_.35s_cubic-bezier(.2,_.8,_.2,_1)] hover:before:[transform:translate(-6px,_6px)_scale(1.12)]';
const CARD_HEAD = 'flex items-center gap-2 text-accent-text [&_svg]:text-[15px] [&_svg]:flex-none';
const CARD_LABEL = 'text-text-secondary font-[700] text-[11.5px] tracking-[.03em] uppercase';
const GHOST = 'ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]';
const PRIMARY = 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] disabled:opacity-60';
const SECTION = 'mt-[18px] [&_h3]:m-[0_0_8px] [&_h3]:text-[13px] [&_h3]:text-text';

const precisionOf = (item) => Math.max(0, Math.min(3, Number(item?.unit_precision ?? 2)));
function quantity(value, item) {
  if (value === null || value === undefined) return '—';
  return `${formatNumber(value, precisionOf(item))} ${item?.unit || ''}`.trim();
}
const plainNumber = (value, item) => (value === null || value === undefined ? '—' : formatNumber(value, precisionOf(item)));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : '—');
function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
/** The current Monday–Sunday week and the 11 before it (oldest first), for the exclusions panel. */
function recentWeeks(today) {
  const current = mondayOf(today || new Date().toISOString().slice(0, 10));
  return Array.from({ length: 12 }, (_, i) => {
    const start = addDays(current, -7 * (11 - i));
    return { week_start: start, week_end: addDays(start, 6) };
  });
}
function shortWeek(week) {
  const start = week?.week_start || '';
  const end = week?.week_end || '';
  if (!start) return '—';
  return end ? `${start.slice(5)} – ${end.slice(5)}` : start.slice(5);
}

function SortHeader({ label, sortKey, sort, onSort, align = 'left', sub }) {
  const active = sort.key === sortKey;
  const Icon = active && sort.dir === 'desc' ? FaArrowDownWideShort : FaArrowUpWideShort;
  return (
    <th className={align === 'right' ? 'er-th-right' : undefined}>
      <button
        type="button"
        className={`inline-flex items-center gap-[5px] [background:none] border-0 p-0 text-[color:inherit] later:[font-family:inherit] text-[13px] font-[700] [line-height:inherit] cursor-pointer [&_svg]:opacity-[.35] [&_svg]:text-[11px] [&.is-active]:text-text-secondary [&.is-active_svg]:opacity-[1] [&.is-active_svg]:text-accent-text later:hover:text-text ${active ? ' is-active' : ''}`}
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon aria-hidden="true" />
      </button>
      {sub && <small className="block text-muted text-[11px] font-[600] uppercase">{sub}</small>}
    </th>
  );
}

function TrendText({ trend }) {
  if (!trend || trend.direction === 'insufficient') return <span className="text-muted text-[11.5px]">Not enough history</span>;
  if (trend.direction === 'flat') return <span>Flat</span>;
  const pct = formatNumber(Math.abs(trend.change_percent ?? 0), 0);
  return <span className={trend.direction === 'up' ? 'er-trend-rising font-[600]' : 'er-trend-falling font-[600]'}>{trend.direction === 'up' ? `Up ${pct}%` : `Down ${pct}%`}</span>;
}

function DescriptiveCards({ summary }) {
  if (!summary) return null;
  const left = summary.days_excluded || {};
  const split = [left.closed ? `${left.closed} closed` : null, left.excluded ? `${left.excluded} excluded` : null, left.no_records ? `${left.no_records} no records` : null].filter(Boolean).join(' · ');
  return (
    <div className="grid grid-cols-[repeat(auto-fit,_minmax(170px,_1fr))] gap-2 mb-3">
      <article className={CARD}><span className={CARD_HEAD}><FaBoxesStacked aria-hidden="true" /><strong>{formatNumber(summary.items_tracked)}</strong></span><span className={CARD_LABEL}>Items tracked</span><small>raw materials</small></article>
      <article className={CARD}><span className={CARD_HEAD}><FaClockRotateLeft aria-hidden="true" /><strong>{formatNumber(summary.stale_counts)}</strong></span><span className={CARD_LABEL}>Stale counts</span><small>counted {formatNumber(summary.stale_count_days)}+ days ago, or never</small></article>
      <article className={CARD}><span className={CARD_HEAD}><FaCalendarDays aria-hidden="true" /><strong>{summary.avg_zero_days_percent === null ? '—' : `${formatNumber(summary.avg_zero_days_percent, 0)}%`}</strong></span><span className={CARD_LABEL}>Avg zero-usage days</span><small>across items</small></article>
      <article className={CARD}><span className={CARD_HEAD}><FaCalendarXmark aria-hidden="true" /><strong>{formatNumber(left.total ?? 0)}</strong></span><span className={CARD_LABEL}>Days excluded</span><small>{split || 'none in the window'}</small></article>
    </div>
  );
}

function PredictiveCards({ summary }) {
  if (!summary) return null;
  const mix = summary.method_mix || {};
  return (
    <div className="grid grid-cols-[repeat(auto-fit,_minmax(150px,_1fr))] gap-2 mb-3">
      <article className={CARD}><span className={CARD_HEAD}><FaBoxesStacked aria-hidden="true" /><strong>{formatNumber(summary.items_tracked)}</strong></span><span className={CARD_LABEL}>Items tracked</span><small>raw materials</small></article>
      <article className={`${CARD} later:[&_strong]:text-danger-text`}><span className={CARD_HEAD}><FaTriangleExclamation aria-hidden="true" /><strong>{formatNumber(summary.low_cover)}</strong></span><span className={CARD_LABEL}>Low cover</span><small>under {formatNumber(summary.low_cover_days)} days</small></article>
      <article className={`${CARD} later-2:[&_strong]:text-[color:var(--warning-text)]`}><span className={CARD_HEAD}><FaBoxesStacked aria-hidden="true" /><strong>{formatNumber(summary.overstocked)}</strong></span><span className={CARD_LABEL}>Overstocked</span><small>over {formatNumber(summary.overstock_days)} days</small></article>
      <article className={`${CARD} later-3:[&_strong]:text-success-text`}><span className={CARD_HEAD}><FaArrowTrendUp aria-hidden="true" /><strong>{formatNumber(summary.reorders_suggested)}</strong></span><span className={CARD_LABEL}>Reorders suggested</span><small>covers {formatNumber(summary.cover_days)} days</small></article>
      <article className={CARD}><span className={CARD_HEAD}><FaChartLine aria-hidden="true" /><strong>{`${mix.wma ?? 0} / ${mix.ses ?? 0} / ${mix.croston ?? 0}`}</strong></span><span className={CARD_LABEL}>Method mix</span><small>WMA / SES / Croston</small></article>
    </div>
  );
}

function MethodCell({ item }) {
  if (!item.ready) return <span className="text-muted text-[11.5px]">{item.not_ready_reason || 'No estimate'}</span>;
  return (
    <span className="inline-flex flex-col items-end gap-[3px]">
      <span className={METHOD_TAG}>{item.method_label}</span>
      <small className="text-muted text-[11px]">{PATTERN_LABEL[item.pattern]}{item.low_confidence && <b className={`${TAG} er-watch ml-[4px] text-[10px]! p-[0_6px]!`}>Low confidence</b>}</small>
    </span>
  );
}

// ---- Chart ----
function chartRows(detail, predictive) {
  const item = detail?.item;
  if (!item) return [];
  const rows = (item.days || []).map((d) => ({
    offset: d.offset,
    date: d.date,
    status: d.status,
    usage: d.status === 'open' ? d.usage : null,
    gap: d.status !== 'open' && d.status !== 'not_yet_open' && d.status !== 'not_yet_stocked' ? 1 : null,
    avg7: d.avg7,
    reason: d.reason,
  }));
  if (predictive && item.ready) {
    for (const point of detail.forecast || []) rows.push({ offset: point.offset, forecast: point.rate, date: addDays(detail.today, point.offset), status: 'forecast' });
  } else rows.push({ offset: 0, date: detail.today, status: 'today' });
  return rows;
}

function DayTooltip({ active, payload, item }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="p-[8px_10px] border border-line-strong rounded-[10px] [background:var(--panel)] text-[12px] text-text-secondary [box-shadow:var(--shadow-md)]">
      <strong className="block text-text">{shortDate(row.date)} ({row.offset > 0 ? `+${row.offset}` : row.offset})</strong>
      {row.status === 'forecast' ? <span>Forecast {quantity(row.forecast, item)} per day</span>
        : row.status === 'open' ? <span>Used {quantity(row.usage, item)}{row.avg7 !== null && row.avg7 !== undefined ? ` · 7-day avg ${quantity(row.avg7, item)}` : ''}</span>
          : row.status === 'today' ? <span>Today (left out: still running)</span>
            : <span>{DAY_LABEL[row.status] || row.status}{row.reason ? `: ${row.reason}` : ''}</span>}
    </div>
  );
}

// Pill shown at the top of the "Today" reference line.
function TodayTag({ viewBox, text }) {
  const x = viewBox?.x ?? 0;
  const y = viewBox?.y ?? 0;
  const width = text.length * 6.5 + 18;
  return (
    <g>
      <rect x={x - width / 2} y={y - 12} width={width} height={20} rx={4} style={{ fill: 'color-mix(in srgb, var(--accent) 16%, transparent)', stroke: 'var(--accent)', strokeOpacity: 0.7 }} />
      <text x={x} y={y + 2} textAnchor="middle" style={{ fill: 'var(--accent-text)', fontSize: 11, fontWeight: 700 }}>{text}</text>
    </g>
  );
}

function UsageChart({ detail, predictive }) {
  const item = detail.item;
  const rows = chartRows(detail, predictive);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.usage ?? 0, r.avg7 ?? 0, r.forecast ?? 0)));
  const data = rows.map((r) => ({ ...r, gap: r.gap ? max : null }));
  const methodLabel = item.method_label ? `Forecast (${item.method_label})` : 'Forecast';
  const minOffset = Math.min(0, ...rows.map((r) => r.offset));
  const ticks = [];
  for (let v = Math.floor(minOffset / 7) * 7; v <= 0; v += 7) ticks.push(v);
  const todayText = predictive && item.ready ? 'Today | Forecast' : 'Today';
  return (
    <div className="h-[300px] m-[10px_0_4px]" role="img" aria-label={`Daily usage of ${item.name}${predictive && item.ready ? ' with the forecast' : ''}`}>
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <pattern id="usage-gap-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="7" height="7" style={{ fill: 'var(--surface-strong)', fillOpacity: 0.45 }} />
            <line x1="0" y1="0" x2="0" y2="7" strokeWidth="2.5" style={{ stroke: 'var(--muted)', strokeOpacity: 0.55 }} />
          </pattern>
          <linearGradient id="usage-bar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--muted)', stopOpacity: 0.95 }} />
            <stop offset="1" style={{ stopColor: 'var(--muted)', stopOpacity: 0.35 }} />
          </linearGradient>
        </defs>
      </svg>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 22, right: 22, bottom: 18, left: 0 }} barCategoryGap="6%">
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="offset" type="number" domain={['dataMin', 'dataMax']} ticks={ticks} tickFormatter={(v) => (v > 0 ? `+${v}` : String(v))} tick={{ fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false}
            label={{ value: 'Days from today', position: 'insideBottom', offset: -10, fill: 'var(--muted)', fontSize: 12 }} allowDecimals={false} />
          <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }} width={44} domain={[0, 'auto']} axisLine={false} tickLine={false} />
          <Tooltip content={<DayTooltip item={item} />} />
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }} />
          <Bar dataKey="gap" name="Left out (closed, excluded, no records)" fill="url(#usage-gap-hatch)" isAnimationActive={false} legendType="square" />
          <Bar dataKey="usage" name="Actual daily usage" fill="url(#usage-bar-grad)" isAnimationActive={false} />
          <Line dataKey="avg7" name="7-day average" stroke="var(--accent)" strokeWidth={8} strokeOpacity={0.18} dot={false} legendType="none" connectNulls isAnimationActive={false} />
          <Line dataKey="avg7" name="7-day average" stroke="var(--accent)" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
          {predictive && item.ready && <Line dataKey="forecast" name={methodLabel} stroke="var(--warning-text)" strokeWidth={2.5} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
          <ReferenceLine x={0} stroke="var(--accent)" strokeOpacity={0.6} strokeDasharray="2 3" label={<TodayTag text={todayText} />} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function OneOffExclude({ locationId, item, day, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(`One-off event (${day.flag === 'spike' ? 'spike' : 'dip'} on ${shortDate(day.date)})`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!open) return <button type="button" className={GHOST} onClick={() => setOpen(true)}>Exclude its week</button>;
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/estimated-requirement/exclusions', { location_id: locationId, material_id: item.material_id, week_start: mondayOf(day.date), reason: reason.trim() });
      setOpen(false);
      onDone();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-wrap gap-[6px] items-center min-w-[240px] [&_input]:flex-[1_1_160px] [&_input]:min-w-0" onSubmit={submit}>
      <input type="text" value={reason} required minLength={3} maxLength={500} aria-label="Reason for excluding this week" onChange={(event) => setReason(event.target.value)} />
      <button type="submit" className={PRIMARY} disabled={busy}>Exclude</button>
      <button type="button" className={GHOST} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      {error && <small className="block mt-[6px] text-danger-text">{error}</small>}
    </form>
  );
}

const PATTERN_TEXT = { smooth: 'smooth', erratic: 'erratic', intermittent: 'intermittent', lumpy: 'lumpy' };

/**
 * The selected item's detail, directly under the table (no modal). It keeps showing the last content while
 * a new horizon or dips mode loads, and re-reads quietly when the page's live refresh fires.
 */
function ItemDetailPanel({ locationId, materialId, horizon, dips, view, canExclude, liveTick, panelRef, onClose, onChanged }) {
  const remote = useRemote(
    () => api.get('/estimated-requirement/detail', { location_id: locationId || undefined, material_id: materialId, horizon, dips }),
    [locationId, materialId, horizon, dips],
  );
  useEffect(() => {
    if (liveTick) void remote.reload({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);
  const detail = remote.data?.data;
  const item = detail?.item;
  const predictive = view === 'predictive';
  const resolvedLocation = detail?.location?.id ?? locationId;
  const afterExclude = () => { void remote.reload({ silent: true }); onChanged?.(); };
  const title = item ? `${item.name}${item.variant ? ` · ${item.variant}` : ''}` : 'Loading…';

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label={item ? `Detail for ${title}` : 'Item detail'}
      className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [scroll-margin-top:90px] focus:[outline:none]"
    >
      <header className="flex items-start justify-between gap-3 mb-[6px]">
        <div className="flex flex-wrap items-center gap-[10px] min-w-0">
          <h2 className="m-0 text-[17px] font-[700] text-text">{title}</h2>
          {predictive && item?.ready && <span className={METHOD_TAG}>{item.method_label}</span>}
          {item && <span className="text-[13px] text-text-secondary">On hand {quantity(item.on_hand, item)} · On order {quantity(item.on_order, item)}</span>}
        </div>
        <button type="button" className="inline-grid place-items-center w-[34px] h-[34px] flex-none border border-transparent rounded-[10px] [background:transparent] text-text-secondary cursor-pointer hover:text-text hover:[background:var(--hover)] hover:border-line focus-visible:[outline:2px_solid_var(--accent)]" aria-label="Close the item detail" onClick={onClose}>
          <FaXmark aria-hidden="true" />
        </button>
      </header>
      {remote.loading && !detail ? <LoadingState label="Loading the daily history…" /> : remote.error && !detail ? <Notice type="error" inline>{remote.error}</Notice> : (
        <>
          <p className="m-[0_0_8px] text-muted text-[12px]">{detail?.freshness}</p>
          {predictive && item?.ready && item.days_of_cover !== null && (
            <p className="m-[0_0_8px] text-[13px] text-text-secondary">Days of cover {formatNumber(item.days_of_cover, 1)} (incl. on order) · {formatNumber(item.days_on_hand, 1)} on hand only (on order may not have arrived yet).</p>
          )}
          {item?.on_order_note && <Notice type="info" inline>{item.on_order_note}.{item?.warehouse_product?.note ? ` ${item.warehouse_product.note}` : ''}</Notice>}

          <UsageChart detail={detail} predictive={predictive} />
          {predictive && item?.pending_pattern && (
            <p className="m-[6px_0_0] p-[8px_12px] border border-line rounded-[10px] [background:var(--surface-subtle)] text-[12.5px] text-text-secondary" role="note">
              Pattern looks {PATTERN_TEXT[item.pending_pattern.pattern]} for {item.pending_pattern.days} of {item.pending_pattern.needed} days; method stays {item.method_label} for now.
            </p>
          )}

          {!predictive ? (
            <section className={SECTION}>
              <h3>How usage was summarized</h3>
              <p className="m-0 text-text-secondary text-[13px] leading-[1.6]">{detail?.explanation?.descriptive}</p>
            </section>
          ) : (
            <section className={SECTION}>
              <h3>How this was worked out</h3>
              {!item?.ready ? (
                <p className="m-0 text-text-secondary text-[13px]">{item?.not_ready_reason}. No numbers are estimated until then; nothing is guessed.</p>
              ) : (
                <ol className="m-0 pl-[20px] grid gap-[6px] text-text-secondary text-[13px] leading-[1.55] [&_b]:text-text">
                  {(detail?.explanation?.steps || []).map((step) => <li key={step.title}><b>{step.title}.</b> {step.text}</li>)}
                </ol>
              )}
              {item?.ready && <p className="m-[8px_0_0] text-muted text-[12px]">Forecast error (one-step-ahead RMSE over {formatNumber(item.error_points)} days): {plainNumber(item.forecast_error, item)} {item.unit}.</p>}
            </section>
          )}

          <section className={SECTION}>
            <h3>Dips and spikes</h3>
            {item?.outliers?.status === 'insufficient_history' && <p className="text-muted text-[12px] m-0">Checked once there are {formatNumber(detail?.settings?.minimum_open_days ?? 14)} open days.</p>}
            {item?.outliers?.status === 'skipped_sparse' && <p className="text-muted text-[12px] m-0">Not checked: more than half of the open days had no usage of this item.</p>}
            {(detail?.dips_and_spikes || []).length === 0 ? (item?.outliers?.status === 'ok' && <p className="text-muted text-[12px] m-0">No day was flagged in this window.</p>) : (
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead><tr><th>Day</th><th className="er-th-right">Recorded</th><th>Note</th>{canExclude && <th><span className="sr-only">Action</span></th>}</tr></thead>
                  <tbody>
                    {detail.dips_and_spikes.map((day) => (
                      <tr key={day.date}>
                        <td>{shortDate(day.date)}</td>
                        <td className="text-right">{quantity(day.usage, item)}</td>
                        <td>
                          <b className={`${TAG} er-tag-${day.flag}`}>{day.flag === 'spike' ? 'Spike' : 'Dip'}</b>
                          <small className="block text-muted text-[11px]">{item?.outliers?.capped ? `Counted as ${quantity(day.adjusted_usage, item)} (capped)` : 'Counted as recorded'}</small>
                        </td>
                        {canExclude && <td><OneOffExclude locationId={resolvedLocation} item={item} day={day} onDone={afterExclude} /></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={SECTION}>
            <h3>Days left out of the estimate</h3>
            {(detail?.left_out || []).length === 0 ? <p className="text-muted text-[12px] m-0">Every day in this window is counted.</p> : (
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead><tr><th>Days</th><th>Why</th><th>Detail</th></tr></thead>
                  <tbody>
                    {detail.left_out.map((range) => (
                      <tr key={`${range.status}-${range.from}`}>
                        <td className="whitespace-nowrap">{range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)} – ${shortDate(range.to)}`} <small className="text-muted">({range.days} day{range.days === 1 ? '' : 's'})</small></td>
                        <td><b className={`${TAG} er-tag-${range.status}`}>{range.label}</b></td>
                        <td>{range.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="text-muted text-[12px] m-[14px_0_0]">Statistical, rule-based estimate from recorded usage (no AI). {NOTE}</p>
        </>
      )}
    </section>
  );
}

const SETTING_FIELDS = [
  { key: 'lookback_open_days', label: 'History window (open days)', min: 14, max: 90, step: 1 },
  { key: 'minimum_open_days', label: 'Minimum open days for an estimate', min: 7, max: 60, step: 1 },
  { key: 'low_cover_days', label: 'Low cover under (days)', min: 0, max: 60, step: 0.5 },
  { key: 'overstock_days', label: 'Overstocked over (days)', min: 1, max: 365, step: 0.5 },
  { key: 'stale_count_days', label: 'Stale count after (days)', min: 1, max: 30, step: 1 },
  { key: 'lead_time_days', label: 'Lead time (days)', min: 0, max: 365, step: 1 },
  { key: 'z_score', label: 'Safety factor (z)', min: 0, max: 3.5, step: 0.05 },
  { key: 'adi_cutoff', label: 'ADI cutoff', min: 1, max: 3, step: 0.01 },
  { key: 'cv2_cutoff', label: 'CV² cutoff', min: 0.1, max: 2, step: 0.01 },
  { key: 'ses_alpha', label: 'SES alpha', min: 0.05, max: 0.9, step: 0.05 },
  { key: 'croston_alpha', label: 'Croston alpha', min: 0.05, max: 0.9, step: 0.05 },
  { key: 'method_switch_days', label: 'Method switch after (days)', min: 1, max: 14, step: 1 },
  { key: 'trend_threshold_percent', label: 'Trend threshold (%)', min: 0, max: 100, step: 1 },
];

/** Admin edits the forecast settings; Logistics sees them read-only. */
function SettingsDialog({ editable, onClose, onSaved }) {
  const remote = useRemote(() => api.get('/estimated-requirement/settings'), []);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = remote.data?.data?.settings;
  const form = draft ?? settings;
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, Number(form[f.key])]));
      await api.patch('/estimated-requirement/settings', { ...body, include_manual_deductions: Boolean(form.include_manual_deductions), cap_spikes_and_dips: Boolean(form.cap_spikes_and_dips) });
      onSaved();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
      setBusy(false);
    }
  };
  return (
    <Modal title="Forecast settings" onClose={onClose} size="wide" footer={editable ? (
      <>
        <button type="button" className={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="forecast-settings-form" className={PRIMARY} disabled={busy || !form}>{busy ? 'Saving…' : 'Save settings'}</button>
      </>
    ) : <button type="button" className={GHOST} onClick={onClose}>Close</button>}>
      {!form ? <LoadingState label="Loading settings…" /> : (
        <form id="forecast-settings-form" onSubmit={save} className="grid gap-3">
          {!editable && <Notice type="info" inline>Only an administrator can change these settings.</Notice>}
          <div className="grid grid-cols-[repeat(auto-fit,_minmax(220px,_1fr))] gap-3">
            {SETTING_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <input type="number" min={f.min} max={f.max} step={f.step} value={form[f.key]} disabled={!editable} required onChange={(event) => setDraft({ ...form, [f.key]: event.target.value })} />
              </Field>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary"><input type="checkbox" checked={Boolean(form.include_manual_deductions)} disabled={!editable} onChange={(event) => setDraft({ ...form, include_manual_deductions: event.target.checked })} /> Count negative physical-count corrections (spoilage, damage) as usage</label>
          <label className="flex items-center gap-2 text-[13px] text-text-secondary"><input type="checkbox" checked={Boolean(form.cap_spikes_and_dips)} disabled={!editable} onChange={(event) => setDraft({ ...form, cap_spikes_and_dips: event.target.checked })} /> Cap dips and spikes by default</label>
          {error && <Notice type="error" inline>{error}</Notice>}
        </form>
      )}
    </Modal>
  );
}

function ClosuresPanel({ locationId, canCreate, canUndo, closures, onChanged }) {
  const [form, setForm] = useState({ starts_on: '', ends_on: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/estimated-requirement/closures', {
        location_id: locationId,
        starts_on: form.starts_on,
        ends_on: form.ends_on || form.starts_on,
        reason: form.reason.trim(),
      });
      setForm({ starts_on: '', ends_on: '', reason: '' });
      onChanged();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (id) => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/estimated-requirement/closures/${id}`);
      onChanged();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (id) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/estimated-requirement/closures/${id}/restore`);
      onChanged();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px] later:[&_.table-wrap]:overflow-x-auto">
      <header>
        <h2>Closed periods</h2>
        <p>A closure needs a reason. Closed days leave the estimate and are never counted as zero usage.</p>
      </header>
      <Notice type="error">{error}</Notice>

      {canCreate && (
        <form className="er-inline-form grid grid-cols-[repeat(auto-fit,_minmax(170px,_1fr))] gap-[10px] [align-items:end] mb-3" onSubmit={submit}>
          <Field label="First closed day">
            <input type="date" value={form.starts_on} required onChange={(event) => setForm({ ...form, starts_on: event.target.value })} />
          </Field>
          <Field label="Last closed day">
            <input type="date" value={form.ends_on} onChange={(event) => setForm({ ...form, ends_on: event.target.value })} />
          </Field>
          <Field label="Reason" full>
            <input
              type="text"
              value={form.reason}
              required
              minLength={3}
              maxLength={500}
              placeholder="e.g. Scheduled maintenance"
              onChange={(event) => setForm({ ...form, reason: event.target.value })}
            />
          </Field>
          <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy}>
            <FaPlus /> Record closure
          </button>
        </form>
      )}

      {(closures || []).length === 0 ? (
        <p className="text-muted text-[12px] m-[10px_0_0]">No closure recorded for this branch.</p>
      ) : (
        <ul className="[list-style:none] m-0 p-0 grid gap-2 [&_li]:flex [&_li]:justify-between [&_li]:items-center later:[&_li]:gap-3 [&_li]:p-[10px_12px] [&_li]:[background:var(--surface-subtle)] [&_li]:border [&_li]:border-line [&_li]:rounded-[10px] [&_li.is-undone]:opacity-[.65] [&_strong]:block later-4:[&_strong]:text-text later-4:[&_strong]:text-[12.5px] [&_small]:block [&_small]:text-muted [&_small]:text-[11.5px] [&_small]:mt-[2px]">
          {(closures || []).map((closure) => (
            <li key={closure.id} className={closure.undone ? 'is-undone' : undefined}>
              <div>
                <strong>{closure.starts_on} → {closure.ends_on}</strong>
                <small>{formatNumber(closure.days)} day{closure.days === 1 ? '' : 's'} · {closure.reason}</small>
                {closure.created_by && <small>Recorded by {closure.created_by}</small>}
                {closure.undone && <small className="text-danger-text!">Undone{closure.undone_by ? ` by ${closure.undone_by}` : ''}</small>}
              </div>
              {canUndo && (closure.undone ? (
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => restore(closure.id)}>
                  <FaRotateLeft /> Restore
                </button>
              ) : (
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] danger [&.ap-btn]:text-[#fca5a5] [&.ap-btn]:border-[rgba(248,_113,_113,_0.35)]" disabled={busy} onClick={() => undo(closure.id)}>
                  <FaXmark /> Undo
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExclusionsPanel({ locationId, weeks, exclusions, onChanged }) {
  const [form, setForm] = useState({ week_start: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/estimated-requirement/exclusions', {
        location_id: locationId,
        week_start: form.week_start,
        reason: form.reason.trim(),
      });
      setForm({ week_start: '', reason: '' });
      onChanged();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (id) => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/estimated-requirement/exclusions/${id}`);
      onChanged();
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px] later:[&_.table-wrap]:overflow-x-auto">
      <header>
        <h2>Manually excluded weeks</h2>
        <p>Use this when a week's records cannot be trusted. The week leaves the estimate with a stated reason.</p>
      </header>
      <Notice type="error">{error}</Notice>

      <form className="er-inline-form grid grid-cols-[repeat(auto-fit,_minmax(170px,_1fr))] gap-[10px] [align-items:end] mb-3" onSubmit={submit}>
        <Field label="Week">
          <select value={form.week_start} required onChange={(event) => setForm({ ...form, week_start: event.target.value })}>
            <option value="">Choose a week…</option>
            {(weeks || []).slice(0, -1).map((week) => (
              <option key={week.week_start} value={week.week_start}>{shortWeek(week)}</option>
            ))}
          </select>
        </Field>
        <Field label="Reason" full>
          <input
            type="text"
            value={form.reason}
            required
            minLength={3}
            maxLength={500}
            placeholder="e.g. Stock take — records unusable"
            onChange={(event) => setForm({ ...form, reason: event.target.value })}
          />
        </Field>
        <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy}>
          <FaPlus /> Exclude week
        </button>
      </form>

      {(exclusions || []).length === 0 ? (
        <p className="text-muted text-[12px] m-[10px_0_0]">No week is excluded for this branch.</p>
      ) : (
        <ul className="[list-style:none] m-0 p-0 grid gap-2 [&_li]:flex [&_li]:justify-between [&_li]:items-center later:[&_li]:gap-3 [&_li]:p-[10px_12px] [&_li]:[background:var(--surface-subtle)] [&_li]:border [&_li]:border-line [&_li]:rounded-[10px] [&_li.is-undone]:opacity-[.65] [&_strong]:block later-4:[&_strong]:text-text later-4:[&_strong]:text-[12.5px] [&_small]:block [&_small]:text-muted [&_small]:text-[11.5px] [&_small]:mt-[2px]">
          {(exclusions || []).map((exclusion) => (
            <li key={exclusion.id}>
              <div>
                <strong>{exclusion.week_start} · {exclusion.scope === 'branch' ? 'whole branch' : exclusion.material?.name}</strong>
                <small>{exclusion.reason}</small>
              </div>
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] danger [&.ap-btn]:text-[#fca5a5] [&.ap-btn]:border-[rgba(248,_113,_113,_0.35)]" disabled={busy} onClick={() => undo(exclusion.id)}>
                <FaXmark /> Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function EstimatedRequirement({ embedded = false }) {
  const { role } = useAuth();
  const isFranchisee = role === 'franchisee';
  const isAdmin = role === 'admin';
  const canExclude = role === 'admin' || role === 'logistics';
  // Closure periods are managed by Admin/Logistics only; the branch portal never shows them.
  const canCreateClosure = isAdmin || role === 'logistics';
  const navigate = useNavigate();

  const [view, setView] = useState('descriptive');
  const [locationId, setLocationId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [horizon, setHorizon] = useState(7);
  const [dips, setDips] = useState('cap');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  // The selected item (its detail panel sits under the table).
  const [selectedId, setSelectedId] = useState(null);
  const [liveTick, setLiveTick] = useState(0);
  const panelRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openingDraft, setOpeningDraft] = useState('');
  const [openingBusy, setOpeningBusy] = useState(false);
  const [openingError, setOpeningError] = useState('');

  const remote = useRemote(
    () => api.get('/estimated-requirement', {
      location_id: locationId || undefined,
      brand_id: brandId || undefined,
      horizon,
      dips,
    }),
    [locationId, brandId, horizon, dips],
  );

  const payload = remote.data?.data;
  const branches = useMemo(() => payload?.locations || [], [payload]);
  const location = payload?.location;


  useEffect(() => {
    if (isFranchisee || locationId || branches.length === 0) return;
    setLocationId(String(branches[0].id));
  }, [branches, isFranchisee, locationId]);

  const closuresRemote = useRemote(
    () => (location?.id && canCreateClosure
      ? api.get('/estimated-requirement/closures', { location_id: location.id, include_undone: 1 })
      : Promise.resolve({ data: { closures: [] } })),
    [location?.id, canCreateClosure],
  );

  const exclusionsRemote = useRemote(
    () => (location?.id && canExclude
      ? api.get('/estimated-requirement/exclusions', { location_id: location.id })
      : Promise.resolve({ data: { exclusions: [] } })),
    [location?.id, canExclude],
  );

  const items = useMemo(() => payload?.items || [], [payload]);
  const predictive = view === 'predictive';

  const sortedItems = useMemo(() => {
    const value = (item) => {
      switch (sort.key) {
        case 'name': return item.name?.toLowerCase() || '';
        case 'onhand': return item.on_hand ?? -1;
        case 'avg': return item.avg_daily_use ?? -1;
        case 'last7': return item.last_7_days ?? -1;
        case 'zero': return item.zero_days_percent ?? -1;
        case 'trend': return item.trend?.change_percent ?? Number.NEGATIVE_INFINITY;
        case 'counted': return item.days_since_count ?? Number.MAX_SAFE_INTEGER;
        case 'status': return STATUS_ORDER[item.status] ?? 9;
        case 'cover': return item.days_of_cover ?? Number.MAX_SAFE_INTEGER;
        case 'method': return item.method_label || 'zz';
        case 'need': return item.estimated_need ?? -1;
        case 'reorder': return item.suggested_reorder ?? -1;
        default: return 0;
      }
    };
    const direction = sort.dir === 'asc' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    const matches = needle
      ? items.filter((item) => `${item.name} ${item.variant ?? ''} ${item.brand_name ?? ''}`.toLowerCase().includes(needle))
      : items;
    return [...matches].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return String(a.name).localeCompare(String(b.name));
      return left > right ? direction : -direction;
    });
  }, [items, sort, search]);

  // Table pages of 7 rows; back to page 1 whenever the list itself changes.
  const [page, setPage] = useState(1);
  const [pageDir, setPageDir] = useState(1);
  useEffect(() => { setPage(1); }, [view, sort, search, locationId, horizon, dips]);
  const changePage = (next) => {
    setPageDir(next >= currentPage ? 1 : -1);
    setPage(next);
  };
  const pageCount = Math.max(1, Math.ceil(sortedItems.length / TABLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedItems = sortedItems.slice((currentPage - 1) * TABLE_PAGE_SIZE, currentPage * TABLE_PAGE_SIZE);
  const tableMeta = { current_page: currentPage, per_page: TABLE_PAGE_SIZE, total: sortedItems.length, last_page: pageCount };

  const switchView = (next) => {
    setView(next);
    // Descriptive: by name; Predictive: worst status first (Low cover, Normal, Overstocked, No estimate).
    setSort(next === 'predictive' ? { key: 'status', dir: 'asc' } : { key: 'name', dir: 'asc' });
  };
  const toggleSort = (key) => {
    setSort((current) => (current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: ['name', 'status', 'cover', 'counted', 'method'].includes(key) ? 'asc' : 'desc' }));
  };

  const saveOpeningDate = async (event) => {
    event.preventDefault();
    setOpeningBusy(true);
    setOpeningError('');
    try {
      await api.patch('/estimated-requirement/opening-date', { location_id: location?.id, opening_date: openingDraft || null });
      setOpeningDraft('');
      await remote.reload({ silent: true });
    } catch (requestError) {
      setOpeningError(firstValidationMessage(requestError));
    } finally {
      setOpeningBusy(false);
    }
  };

  const reloadSide = () => {
    void closuresRemote.reload({ silent: true });
    void exclusionsRemote.reload({ silent: true });
  };

  // New usage, voids, closures, exclusions, settings or classes elsewhere: re-read in place.
  useForecastLiveRefresh(() => {
    reloadSide();
    void remote.reload({ silent: true });
    setLiveTick((n) => n + 1);
  });

  const summary = payload?.summary;
  // The selection survives view, horizon and dips changes; it is cleared when the item is no longer listed
  // (another branch, a search that hides it).
  const selected = selectedId !== null && items.some((i) => i.material_id === selectedId) ? selectedId : null;
  const toggleRow = (item) => setSelectedId((current) => (current === item.material_id ? null : item.material_id));
  useEffect(() => {
    if (selected === null || !panelRef.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    panelRef.current.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, [selected]);
  const rowProps = (item) => ({
    key: item.material_id,
    onClick: () => toggleRow(item),
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRow(item); }
    },
    tabIndex: 0,
    'aria-selected': selected === item.material_id,
    'aria-expanded': selected === item.material_id,
    className: `cursor-pointer [&:hover_td]:[background:var(--hover)] [&:focus-visible_td]:[background:var(--hover)] [&:focus-visible_td]:[outline:none] [&:focus-visible_td:first-child]:[box-shadow:inset_3px_0_0_var(--accent)] ${selected === item.material_id ? '[&_td]:[background:color-mix(in_srgb,_var(--accent)_10%,_transparent)]! [&_td:first-child]:[box-shadow:inset_3px_0_0_var(--accent)]' : ''}`,
  });
  const nameCell = (item) => (
    <td>
      <strong>{item.name}</strong>
      <small className="block text-muted text-[11px]">{[item.variant, item.brand_name].filter(Boolean).join(' · ')}</small>
    </td>
  );

  const body = (
    <>
      {!embedded && <PageHeader title="Analytics and Forecasting" subtitle="Usage-based demand and supply estimates" />}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <p className="er-note-inline flex items-center gap-2 m-0 text-muted text-[12.5px] [&_svg]:text-accent-text [&_svg]:flex-none"><FaCircleInfo aria-hidden="true" /> {payload?.note || NOTE}</p>

      {canExclude && !embedded && (
        <div className="flex flex-wrap items-center gap-2 [&_a]:inline-flex [&_a]:items-center [&_a]:gap-[6px] [&_a]:min-h-[38px] [&_a]:p-[0_14px] [&_a]:border [&_a]:border-line-strong [&_a]:rounded-[10px] [&_a]:text-accent-text [&_a]:text-[13px] [&_a]:font-[650] [&_a]:[text-decoration:none] [&_a:hover]:[background:var(--hover)]">
          <Link to="/estimated-requirement/network">Network view →</Link>
          <button type="button" className={GHOST} onClick={() => setSettingsOpen(true)}><FaGear aria-hidden="true" /> Forecast settings</button>
        </div>
      )}
      </div>

      {remote.error && <Notice type="error">{remote.error}</Notice>}

      <div className="er-filters grid grid-cols-[repeat(auto-fit,_minmax(170px,_1fr))] gap-3 p-[12px] mb-3 [background:var(--panel)] border border-line rounded-[14px]">
        {!isFranchisee && (
          <>
            <Field label="Branch">
              <BranchCombobox
                branches={branches}
                value={locationId}
                extra={canExclude ? [{ value: ALL_BRANCHES, label: 'All branches — network view' }] : []}
                onChange={(next) => {
                  if (next === ALL_BRANCHES) { navigate('/estimated-requirement/network'); return; }
                  setSelectedId(null);
                  setLocationId(next);
                }}
              />
            </Field>
            <Field label="Brand">
              <select value={brandId} onChange={(event) => setBrandId(event.target.value)}>
                <option value="">All brands</option>
                {(payload?.brands || []).map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
            </Field>
          </>
        )}
        <Field label="Horizon">
          <select value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
            {HORIZONS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
          </select>
        </Field>
        <Field label="Dips and spikes">
          <select value={dips} onChange={(event) => setDips(event.target.value)}>
            <option value="cap">Cap them (default)</option>
            <option value="raw">Include them</option>
          </select>
        </Field>
      </div>

      {location?.opening_date_needed && (
        <div className="flex gap-3 items-start p-[14px_16px] mb-4 border border-[color:color-mix(in_srgb,_var(--warning)_35%,_transparent)] [background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] rounded-[14px] later:[&>svg]:text-[color:var(--warning-text)] [&>svg]:mt-[2px] [&>svg]:flex-none [&_strong]:block later-4:[&_strong]:text-text later:[&_strong]:text-[13.5px] [&_p]:m-[4px_0_0] [&_p]:text-text-secondary [&_p]:text-[12.5px] [&_p]:max-w-[70ch]">
          <FaTriangleExclamation aria-hidden="true" />
          <div>
            <strong>Opening date needed</strong>
            <p>
              This branch has not recorded any activity yet, so its past days are not counted as zero usage.
              {isAdmin ? ' Set the date it started operating, or wait for its first production record.' : ' An administrator can set the opening date.'}
            </p>
            {isAdmin && (
              <form className="flex gap-2 mt-[10px] flex-wrap" onSubmit={saveOpeningDate}>
                <input type="date" value={openingDraft} required onChange={(event) => setOpeningDraft(event.target.value)} />
                <button type="submit" className={PRIMARY} disabled={openingBusy}>Save opening date</button>
              </form>
            )}
            {openingError && <small className="block mt-[6px] text-danger-text">{openingError}</small>}
          </div>
        </div>
      )}

      {remote.loading ? <LoadingState label="Working out the estimate…" /> : !location ? (
        <EmptyState label="Choose a branch to see its estimated requirement." detail="Franchise accounts are pinned to their own branch." />
      ) : (
        <>
          {predictive ? <PredictiveCards summary={summary} /> : <DescriptiveCards summary={summary} />}

          <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px]">
            <header className="flex flex-wrap justify-between gap-3 items-center">
              <div>
                <h2>{location.name}</h2>
                <p>
                  Daily usage in {payload?.timezone || 'Asia/Manila'}, last {formatNumber(payload?.settings?.lookback_open_days ?? 28)} open days.
                  {location.effective_opening_date ? ` Counting from ${location.effective_opening_date}${location.opening_date_source === 'first_activity' ? ' (first recorded activity)' : ''}.` : ''}
                  {' '}<b className="text-text-secondary font-[600]">{summary?.freshness}</b>
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex gap-1" role="tablist" aria-label="View">
                  {[['descriptive', 'Descriptive'], ['predictive', 'Predictive']].map(([key, label]) => (
                    <button key={key} type="button" role="tab" aria-selected={view === key} className={`${GHOST} min-h-[34px] ${view === key ? 'later:border-accent! later:text-text! later:[background:var(--hover)]!' : ''}`} onClick={() => switchView(key)}>{label}</button>
                  ))}
                </div>
                <input type="search" aria-label="Find an item" className="w-[220px] max-w-full shrink-0 h-[34px] p-[0_12px] text-[13px] rounded-[9px] border border-line-strong [background:var(--bg-elevated)] text-text placeholder:text-placeholder outline-none hover:border-accent focus:border-accent" value={search} placeholder="Find an item…" onChange={(event) => setSearch(event.target.value)} />
              </div>
            </header>

            {sortedItems.length === 0 ? (
              <EmptyState label="No tracked raw material yet." detail="Add materials and record production for this branch." />
            ) : (
              <div key={`page-${currentPage}-${view}`} className={`overflow-hidden ${pageDir < 0 ? 'animate-cal-slide-from-left' : 'animate-cal-slide-from-right'}`}>
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    {predictive ? (
                      <tr>
                        <SortHeader label="Raw material" sortKey="name" sort={sort} onSort={toggleSort} />
                        <SortHeader label="On hand / on order" sortKey="onhand" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Days of cover" sub="incl. on order" sortKey="cover" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                        <SortHeader label="Method" sortKey="method" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label={`Est. need (${horizon} d)`} sortKey="need" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Suggested reorder" sub={`covers ${formatNumber(summary?.cover_days ?? horizon)} days`} sortKey="reorder" sort={sort} onSort={toggleSort} align="right" />
                      </tr>
                    ) : (
                      <tr>
                        <SortHeader label="Raw material" sortKey="name" sort={sort} onSort={toggleSort} />
                        <SortHeader label="On hand" sortKey="onhand" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Avg daily use" sortKey="avg" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Last 7 days" sortKey="last7" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Zero days" sortKey="zero" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Trend" sortKey="trend" sort={sort} onSort={toggleSort} align="right" />
                        <SortHeader label="Last counted" sortKey="counted" sort={sort} onSort={toggleSort} align="right" />
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {pagedItems.map((item) => (predictive ? (
                      <tr {...rowProps(item)}>
                        {nameCell(item)}
                        <td className="text-right whitespace-nowrap">
                          {plainNumber(item.on_hand, item)} / {item.on_order === null ? '—' : plainNumber(item.on_order, item)} {item.unit}
                          {item.on_order_note && <small className="block mt-[2px] text-[color:var(--warning-text)] text-[10.5px]">{item.on_order_note}</small>}
                        </td>
                        <td className="text-right">{item.days_of_cover === null ? '—' : `${formatNumber(item.days_of_cover, 1)} d`}</td>
                        <td><span className={`${TAG} ${STATUS_CLASS[item.status] || 'later:text-muted'}`}>{STATUS_LABEL[item.status] || item.status}</span></td>
                        <td className="text-right"><MethodCell item={item} /></td>
                        <td className="text-right">{item.ready ? quantity(item.estimated_need, item) : '—'}</td>
                        <td className="text-right">
                          {!item.ready ? '—' : item.suggested_reorder ? <strong className="text-accent-text [.er-table_td_&]:font-[700]">{quantity(item.suggested_reorder, item)}</strong> : quantity(0, item)}
                          {item.ready && item.cover_capped && <small className="block text-muted text-[10.5px]">Capped at {formatNumber(item.cover_days)} days</small>}
                        </td>
                      </tr>
                    ) : (
                      <tr {...rowProps(item)}>
                        {nameCell(item)}
                        <td className="text-right">{quantity(item.on_hand, item)}</td>
                        <td className="text-right">{item.open_days ? plainNumber(item.avg_daily_use, item) : <span className="text-muted text-[11.5px]">{item.not_ready_reason}</span>}</td>
                        <td className="text-right">{plainNumber(item.last_7_days, item)}</td>
                        <td className="text-right">{item.zero_days_percent === null ? '—' : `${formatNumber(item.zero_days_percent, 0)}%`}</td>
                        <td className="text-right"><TrendText trend={item.trend} /></td>
                        <td className={`text-right whitespace-nowrap ${item.count_stale ? 'text-[color:var(--warning-text)]!' : ''}`}>{item.days_since_count === null ? 'Never' : `${item.days_since_count} d ago`}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
              </div>
            )}
            {sortedItems.length > 0 && <div className="[&_nav]:min-h-[52px] [&_nav]:text-[12px] [&_nav_span]:text-[12px] [&_nav_button]:text-[12px] [&_nav_button]:min-h-[38px] [&_nav_button]:px-[14px]"><Pagination meta={tableMeta} onPage={changePage} /></div>}
            {selected === null && sortedItems.length > 0 && (
              <p className="text-muted text-[12px] m-[10px_0_0]"><FaChartLine aria-hidden="true" className="inline mr-1 text-accent-text" />Select an item in the table to see its chart.</p>
            )}
          </section>

          {selected !== null && (
            <ItemDetailPanel
              locationId={locationId || location?.id}
              materialId={selected}
              horizon={horizon}
              dips={dips}
              view={view}
              canExclude={canExclude}
              liveTick={liveTick}
              panelRef={panelRef}
              onClose={() => setSelectedId(null)}
              onChanged={() => { reloadSide(); void remote.reload({ silent: true }); }}
            />
          )}

          <div className="flex flex-wrap items-stretch gap-4 [&>section]:flex-1 [&>section]:basis-0 [&>section]:min-w-[300px] [&>section]:mb-0 [&>section]:h-auto">
          {canCreateClosure && (
            <ClosuresPanel
              locationId={location.id}
              canCreate={canCreateClosure}
              canUndo={canCreateClosure}
              closures={closuresRemote.data?.data?.closures || []}
              onChanged={() => { reloadSide(); void remote.reload({ silent: true }); }}
            />
          )}

          {canExclude && (
            <ExclusionsPanel
              locationId={location.id}
              weeks={recentWeeks(payload?.today)}
              exclusions={exclusionsRemote.data?.data?.exclusions || []}
              onChanged={() => { reloadSide(); void remote.reload({ silent: true }); }}
            />
          )}
          </div>
        </>
      )}

      {settingsOpen && (
        <SettingsDialog
          editable={isAdmin}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); void remote.reload({ silent: true }); }}
        />
      )}
    </>
  );

  return embedded
    ? <div className="block [&_.er-note-inline]:mt-0">{body}</div>
    : <div className="page-container w-full m-[0_auto] p-[clamp(10px,_1.2vw,_16px)] max-[861px]:later:p-[22px_17px_30px]">{body}</div>;
}
