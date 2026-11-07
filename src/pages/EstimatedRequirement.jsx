import React, { useEffect, useMemo, useState } from 'react';
import {
  FaArrowDownWideShort,
  FaArrowUpWideShort,
  FaChartLine,
  FaCircleInfo,
  FaPlus,
  FaRotateLeft,
  FaTriangleExclamation,
  FaXmark,
} from 'react-icons/fa6';
import { Link, useNavigate } from 'react-router-dom';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import useDebouncedValue from '../lib/useDebouncedValue';
import useForecastLiveRefresh from '../lib/useForecastLiveRefresh';
import { formatNumber } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader } from '../components/ApiUi';
import ForecastingSections from '../components/analytics/ForecastingSections';

const NOTE = 'Estimates are based on past usage to support decisions. They are not guarantees.';

const RISK_LABEL = {
  runs_out_soon: 'Run out soon',
  watch: 'Watch',
  ok: 'OK',
};

const WEEK_STATUS_LABEL = {
  included: 'Included',
  partly_closed: 'Partly closed',
  closed: 'Closed',
  no_records: 'No records',
  excluded: 'Manually excluded',
  not_yet_open: 'Not yet open',
  not_yet_stocked: 'Not yet stocked',
  incomplete: 'Current week',
};

const RISK_ORDER = { runs_out_soon: 0, watch: 1, ok: 2 };
const ALL_BRANCHES = '__all';
const TREND_ORDER ={ rising: 0, stable: 1, falling: 2, insufficient: 3 };

const precisionOf = (item) => Math.max(0, Math.min(3, Number(item?.unit_precision ?? 2)));

function quantity(value, item) {
  if (value === null || value === undefined) return '—';
  return `${formatNumber(value, precisionOf(item))} ${item?.unit || ''}`.trim();
}

function shortWeek(week) {
  const start = week?.week_start || '';
  const end = week?.week_end || '';
  if (!start) return '—';
  return end ? `${start.slice(5)} – ${end.slice(5)}` : start.slice(5);
}

function SortHeader({ label, sortKey, sort, onSort, align = 'left' }) {
  const active = sort.key === sortKey;
  const Icon = active && sort.dir === 'desc' ? FaArrowDownWideShort : FaArrowUpWideShort;
  return (
    <th className={align === 'right' ? 'er-th-right' : undefined}>
      <button
        type="button"
        className={`inline-flex items-center gap-[5px] [background:none] border-0 p-0 text-[color:inherit] later:[font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] [line-height:inherit] cursor-pointer [&_svg]:opacity-[.35] [&_svg]:text-[10px] [&.is-active]:text-text-secondary [&.is-active_svg]:opacity-[1] [&.is-active_svg]:text-accent-text later:hover:text-text ${active ? ' is-active' : ''}`}
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon aria-hidden="true" />
      </button>
    </th>
  );
}

function EstimateCards({ summary, settings }) {
  if (!summary) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,_minmax(190px,_1fr))] gap-3 mb-4">
      <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11.5px]">
        <span className="text-muted text-[11.5px] tracking-[.03em] uppercase">Items tracked</span>
        <strong>{formatNumber(summary.items_tracked)}</strong>
        <small>Raw materials with production history</small>
      </article>
      <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_small]:text-muted [&_small]:text-[11.5px] later:[&_strong]:text-danger-text">
        <span className="text-muted text-[11.5px] tracking-[.03em] uppercase">Run out within {formatNumber(settings?.runs_out_days ?? 5)} days</span>
        <strong>{formatNumber(summary.runs_out_soon)}</strong>
        <small>Based on current on-hand stock</small>
      </article>
      <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_small]:text-muted [&_small]:text-[11.5px] later-2:[&_strong]:text-[color:var(--warning-text)]">
        <span className="text-muted text-[11.5px] tracking-[.03em] uppercase">Watch</span>
        <strong>{formatNumber(summary.watch)}</strong>
        <small>Under {formatNumber(settings?.watch_days ?? 10)} days of stock</small>
      </article>
      <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_small]:text-muted [&_small]:text-[11.5px] later-3:[&_strong]:text-success-text">
        <span className="text-muted text-[11.5px] tracking-[.03em] uppercase">Reorders suggested</span>
        <strong>{formatNumber(summary.reorders_suggested)}</strong>
        <small>Read-only hint — nothing is ordered</small>
      </article>
      <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11.5px]">
        <span className="text-muted text-[11.5px] tracking-[.03em] uppercase">Weeks excluded</span>
        <strong>{formatNumber(summary.weeks_excluded)}</strong>
        <ul className="[list-style:none] m-[2px_0_0] p-0 grid gap-[2px] [&_li]:flex [&_li]:justify-between [&_li]:gap-2 [&_li]:text-muted [&_li]:text-[11.5px] [&_b]:text-text-secondary [&_b]:font-[600]">
          {(summary.excluded_breakdown || []).map((row) => (
            <li key={row.status}>
              <span>{row.label}</span>
              <b>{formatNumber(row.weeks)}</b>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}

const GAP_SHORT = {
  closed: 'Closed',
  no_records: 'No records',
  excluded: 'Excluded',
  not_yet_open: 'Not open',
  not_yet_stocked: 'Not stocked',
  incomplete: 'This week',
};

const TREND_TEXT = {
  rising: { arrow: '↑', label: 'Up' },
  falling: { arrow: '↓', label: 'Down' },
  stable: { arrow: '→', label: 'Stable' },
  insufficient: { arrow: '', label: 'Not enough history for trend' },
};

const REORDER_STATUS_LABEL = { normal: 'Normal', low: 'Low', critical: 'Critical' };

function TrendCell({ trend }) {
  const text = TREND_TEXT[trend?.direction] || TREND_TEXT.insufficient;
  if (trend?.direction === 'insufficient' || !trend) {
    return <span className="inline-flex items-center gap-1 [&_b]:text-[13px] text-muted later:font-[400] text-[11.5px] later:whitespace-normal">{text.label}</span>;
  }
  const pct = trend.change_percent === null || trend.change_percent === undefined
    ? ''
    : ` ${trend.change_percent > 0 ? '+' : ''}${formatNumber(trend.change_percent, 0)}%`;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-[600] [&_b]:text-[13px] er-trend-${trend.direction}`}>
      <b aria-hidden="true">{text.arrow}</b> {text.label}{pct}
    </span>
  );
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * Rows for the 12-week chart plus four weeks ahead. Weeks left out of the
 * estimate have no "actual" value (a gap, never a zero) and carry a grey
 * labelled bar instead.
 */
function buildChartRows(item) {
  const weeks = item?.weeks || [];
  const range = item?.normal_range;
  const band = range ? [range.low, range.high] : null;
  const average = item?.weighted_average;
  const peak = Math.max(
    1,
    ...weeks.map((week) => Number(week.usage) || 0),
    range?.high ?? 0,
    average ?? 0,
  );
  const top = peak * 1.15;

  const rows = weeks.map((week) => ({
    key: week.week_start,
    label: week.week_start.slice(5),
    week,
    actual: week.is_included ? week.usage : null,
    gap: week.is_included ? null : top,
    gapLabel: week.is_included ? '' : (GAP_SHORT[week.status] || week.status),
    band,
    projection: null,
  }));

  if (average !== null && average !== undefined && rows.length > 0) {
    const last = rows[rows.length - 1];
    // The dashed estimate starts at the current (incomplete) week and runs four weeks ahead.
    if (last.week.status === 'incomplete') last.projection = average;
    for (let i = 1; i <= 4; i += 1) {
      const start = addDays(last.key, 7 * i);
      rows.push({
        key: start,
        label: start.slice(5),
        week: null,
        future: true,
        actual: null,
        gap: null,
        gapLabel: '',
        band,
        projection: average,
      });
    }
  }

  return { rows, top };
}

function UsageDot({ cx, cy, payload }) {
  if (cx === undefined || cy === undefined || payload?.actual === null || payload?.actual === undefined) return null;
  const flag = payload.week?.flagged;
  const key = `dot-${payload.key}`;
  if (flag === 'spike') {
    return (
      <g key={key}>
        <path d={`M${cx},${cy - 7} L${cx + 6},${cy + 4} L${cx - 6},${cy + 4} Z`} fill="var(--danger)" stroke="var(--panel)" strokeWidth={1.5} />
        <text x={cx} y={cy - 11} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--danger-text)">Spike</text>
      </g>
    );
  }
  if (flag === 'dip') {
    return (
      <g key={key}>
        <path d={`M${cx},${cy + 7} L${cx + 6},${cy - 4} L${cx - 6},${cy - 4} Z`} fill="var(--warning)" stroke="var(--panel)" strokeWidth={1.5} />
        <text x={cx} y={cy + 19} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--warning-text)">Dip</text>
      </g>
    );
  }
  if (payload.week?.status === 'partly_closed') {
    return <circle key={key} cx={cx} cy={cy} r={4} fill="var(--panel)" stroke="var(--warning)" strokeWidth={2} />;
  }
  return <circle key={key} cx={cx} cy={cy} r={3} fill="var(--accent)" stroke="var(--panel)" strokeWidth={1.5} />;
}

function WeekTooltip({ active, payload, item }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (row.future) {
    return (
      <div className="grid gap-[2px] p-[10px_12px] [background:var(--panel-3)] border border-line-strong rounded-[10px] text-[11.5px] text-text-secondary [box-shadow:var(--shadow-md)] later-4:[&_strong]:text-text later-2:[&_strong]:text-[12px]">
        <strong>Week of {row.key.slice(5)}</strong>
        <span>Estimated weekly use: {quantity(item?.weighted_average, item)}</span>
        {item?.normal_range && <span>Normal range: {quantity(item.normal_range.low, item)} – {quantity(item.normal_range.high, item)}</span>}
        <span>An estimate, not a guarantee.</span>
      </div>
    );
  }
  const week = row.week;
  return (
    <div className="grid gap-[2px] p-[10px_12px] [background:var(--panel-3)] border border-line-strong rounded-[10px] text-[11.5px] text-text-secondary [box-shadow:var(--shadow-md)] later-4:[&_strong]:text-text later-2:[&_strong]:text-[12px]">
      <strong>{shortWeek(week)}</strong>
      <span>Status: {WEEK_STATUS_LABEL[week.status] || week.status}</span>
      <span>Recorded usage: {quantity(week.usage, item)}</span>
      {week.is_included && week.adjusted_usage !== week.usage && <span>Used in estimate: {quantity(week.adjusted_usage, item)}</span>}
      {week.note && <span>{week.note}</span>}
      {week.closed_days > 0 && <span>Closed days: {week.closed_days} of 7</span>}
      {week.reason && <span>{week.reason}</span>}
    </div>
  );
}

function ChartLegend({ hasBand, hasAverage }) {
  return (
    <ul className="flex flex-wrap gap-[6px_16px] [list-style:none] m-[4px_0_0] p-0 text-text-secondary text-[11.5px] later:[&_li]:inline-flex [&_li]:items-center later-2:[&_li]:gap-[6px]" aria-hidden="true">
      <li><i className="inline-block flex-none w-[18px] h-0 border-t-[2.5px] border-t-accent" /> Recorded usage</li>
      <li><i className="inline-block flex-none w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[10px] border-b-danger" /> Spike</li>
      <li><i className="inline-block flex-none w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[10px] border-t-warning" /> Dip</li>
      <li><i className="inline-block flex-none w-[9px] h-[9px] rounded-[50%] border-[2px] border-warning" /> Partly closed</li>
      {hasBand && <li><i className="inline-block flex-none w-[16px] h-[10px] rounded-[3px] later:[background:color-mix(in_srgb,_var(--accent)_28%,_transparent)] border border-[color:color-mix(in_srgb,_var(--accent)_45%,_transparent)]" /> Normal range</li>}
      {hasAverage && <li><i className="inline-block flex-none w-[18px] h-0 [border-top:2.5px_dashed_var(--accent-2)]" /> Estimated average (next 4 weeks)</li>}
      <li><i className="inline-block flex-none w-[10px] h-[12px] rounded-[2px] [background:var(--panel-3)] border border-line-strong" /> Left out of the estimate</li>
    </ul>
  );
}

/**
 * Keeps a drawing problem inside the chart box: the rest of the detail view
 * (facts, tables, the chart-as-table) still renders instead of a blank modal.
 */
class ChartBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Estimated requirement chart error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Notice type="error">
        The chart could not be drawn ({String(this.state.error?.message || this.state.error)}). The same weeks are listed in “Show the chart as a table” below.
      </Notice>
    );
  }
}

function UsageChart({ item }) {
  const { rows, top } = useMemo(() => buildChartRows(item), [item]);
  if (rows.length === 0) return <EmptyState label="No weeks to chart yet." detail="Production history will appear here." />;

  return (
    <figure className="m-[6px_0_0]">
      <ChartBoundary>
      <div className="m-[14px_0_6px]" role="img" aria-label={`Weekly usage of ${item?.name} for the last 12 weeks with the estimate for the next 4 weeks. A table version follows.`}>
        {/* initialDimension: draw at a sane size on the first frame, even while
            the modal is still animating in and has not been measured yet. */}
        <ResponsiveContainer width="100%" height={280} minWidth={0} initialDimension={{ width: 900, height: 280 }}>
          <ComposedChart data={rows} margin={{ top: 18, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis domain={[0, top]} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={52} tickFormatter={(value) => formatNumber(value, 0)} />
            <Tooltip content={<WeekTooltip item={item} />} cursor={{ fill: 'var(--hover)' }} />
            <Bar dataKey="gap" fill="var(--panel-3)" fillOpacity={0.7} isAnimationActive={false} barSize={18}>
              <LabelList dataKey="gapLabel" position="insideTop" angle={-90} offset={28} style={{ fill: 'var(--muted)', fontSize: 10, fontWeight: 600 }} />
            </Bar>
            {item?.normal_range && (
              <Area dataKey="band" type="linear" stroke="var(--accent)" strokeOpacity={0.35} strokeWidth={1} fill="var(--accent)" fillOpacity={0.2} isAnimationActive={false} activeDot={false} />
            )}
            <Line dataKey="actual" type="linear" stroke="var(--accent)" strokeWidth={2.25} dot={<UsageDot />} activeDot={false} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="projection" type="linear" stroke="var(--accent-2)" strokeWidth={2} strokeDasharray="6 5" dot={false} activeDot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      </ChartBoundary>
      <ChartLegend hasBand={Boolean(item?.normal_range)} hasAverage={item?.weighted_average !== null && item?.weighted_average !== undefined} />

      <details className="p-[12px_14px] [background:var(--surface-subtle)] border border-line rounded-[10px] [&_summary]:cursor-pointer [&_summary]:text-text [&_summary]:text-[12.5px] [&_summary]:font-[600] [&_ul]:m-[10px_0_0] [&_ul]:pl-[18px] [&_ul]:text-text-secondary [&_ul]:text-[11.5px] [&_ul]:grid [&_ul]:gap-[5px] later:mt-[10px] [&_.table-wrap]:mt-[10px] [&_.table-wrap]:max-h-[320px] [&_.table-wrap]:overflow-auto">
        <summary>Show the chart as a table</summary>
        <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
          <table className="er-table w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_.er-th-right]:text-right [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_strong]:text-[length:inherit] [&_td_strong]:leading-[inherit] [&_td_b]:text-[length:inherit] [&_td_b]:leading-[inherit]">
            <thead>
              <tr><th>Week</th><th>Status</th><th className="er-th-right">Recorded</th><th className="er-th-right">Used in estimate</th><th>Note</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.future ? `Week of ${row.key.slice(5)}` : shortWeek(row.week)}</td>
                  <td>{row.future ? 'Estimate' : (WEEK_STATUS_LABEL[row.week.status] || row.week.status)}</td>
                  <td className="text-right">{row.future ? '—' : quantity(row.week.usage, item)}</td>
                  <td className="text-right">
                    {row.future ? quantity(row.projection, item) : row.week.is_included ? quantity(row.week.adjusted_usage, item) : 'Left out'}
                  </td>
                  <td>{row.future ? 'Average repeated, not a guarantee' : (row.week.note || row.week.reason || '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function OneOffExclude({ locationId, item, week, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(`One-off event (${week.note || week.flagged})`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!open) {
    return (
      <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => setOpen(true)}>
        Exclude (one-off event)
      </button>
    );
  }

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/estimated-requirement/exclusions', {
        location_id: locationId,
        material_id: item.material_id,
        week_start: week.week_start,
        reason: reason.trim(),
      });
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
      <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy}>Exclude</button>
      <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      {error && <small className="block mt-[6px] text-danger-text">{error}</small>}
    </form>
  );
}

function EstimateDetail({ locationId, materialId, horizon, dips, canExclude, onClose, onChanged }) {
  const remote = useRemote(
    () => api.get('/estimated-requirement/detail', {
      location_id: locationId || undefined,
      material_id: materialId,
      horizon,
      dips,
    }),
    [locationId, materialId, horizon, dips],
  );

  const detail = remote.data?.data;
  const item = detail?.item;
  const resolvedLocation = detail?.location?.id ?? locationId;

  const afterExclude = () => {
    void remote.reload({ silent: true });
    onChanged?.();
  };

  return (
    <Modal
      title={item ? `${item.name}${item.variant ? ` · ${item.variant}` : ''}` : 'Estimated requirement'}
      onClose={onClose}
      size="wide"
    >
      {remote.loading ? <LoadingState label="Loading the 12-week history…" /> : remote.error ? (
        <Notice type="error">{remote.error}</Notice>
      ) : (
        <>
          <p className="er-note-inline flex items-center gap-2 m-[0_0_14px] text-muted text-[12.5px] [&_svg]:text-accent-text [&_svg]:flex-none"><FaCircleInfo aria-hidden="true" /> {detail?.note || NOTE}</p>

          <div className="grid grid-cols-[repeat(auto-fit,_minmax(150px,_1fr))] gap-[10px] m-[14px_0] [&>div]:p-[10px_12px] [&>div]:[background:var(--surface-subtle)] [&>div]:border [&>div]:border-line [&>div]:rounded-[10px] [&_span]:block [&_span]:text-muted [&_span]:text-[11px] later-4:[&_strong]:text-text later-3:[&_strong]:text-[13.5px]">
            <div><span>Average weekly usage</span><strong>{quantity(item?.weighted_average, item)}</strong></div>
            <div><span>Normal range</span><strong>{item?.normal_range ? `${quantity(item.normal_range.low, item)} – ${quantity(item.normal_range.high, item)}` : '—'}</strong></div>
            <div><span>Trend</span><strong><TrendCell trend={item?.trend} /></strong></div>
            <div><span>Included weeks</span><strong>{formatNumber(item?.included_weeks)}</strong></div>
            <div><span>Days left</span><strong>{item?.days_left === null || item?.days_left === undefined ? (item?.ready ? 'No recent usage' : '—') : formatNumber(item.days_left, 1)}</strong></div>
            <div><span>Estimated need ({horizon} wk)</span><strong>{quantity(item?.estimated_need, item)}</strong></div>
            <div><span>Suggested reorder</span><strong>{quantity(item?.suggested_reorder, item)}</strong></div>
            <div><span>On hand / on order</span><strong>{quantity(item?.on_hand, item)} / {quantity(item?.on_order, item)}</strong></div>
          </div>

          {item?.on_order_note && <Notice type="info">{item.on_order_note}.{item?.warehouse_product?.note ? ` ${item.warehouse_product.note}` : ''}</Notice>}

          {item?.ready ? <UsageChart item={item} /> : (
            <div className="m-[14px_0_4px] p-[6px] border border-dashed border-line-strong rounded-[12px]">
              <EmptyState
                label="Not enough data yet"
                detail={`This item has ${formatNumber(item?.included_weeks ?? 0)} included week${item?.included_weeks === 1 ? '' : 's'} so far. The chart and estimate appear after ${formatNumber(item?.needed_weeks ?? 0)} more week${item?.needed_weeks === 1 ? '' : 's'} of recorded usage — nothing is guessed until then.`}
              />
            </div>
          )}

          <section className="mt-[18px] [&_h3]:m-[0_0_8px] [&_h3]:text-[13px] [&_h3]:text-text">
            <h3>Dips and spikes</h3>
            {item?.outliers?.status === 'insufficient_history' && <p className="text-muted text-[12px] m-[10px_0_0]">Dips and spikes are checked once there are {formatNumber(detail?.settings?.detection_weeks ?? 8)} included weeks.</p>}
            {item?.outliers?.status === 'skipped_sparse' && <p className="text-muted text-[12px] m-[10px_0_0]">Not checked: more than half of the included weeks had no usage of this item.</p>}
            {(detail?.dips_and_spikes || []).length === 0 ? (
              item?.outliers?.status === 'ok' && <p className="text-muted text-[12px] m-[10px_0_0]">No week was flagged in this window.</p>
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="er-table w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_.er-th-right]:text-right [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_strong]:text-[length:inherit] [&_td_strong]:leading-[inherit] [&_td_b]:text-[length:inherit] [&_td_b]:leading-[inherit]">
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th className="er-th-right">Actual</th>
                      <th className="er-th-right">Typical</th>
                      <th className="er-th-right">Difference</th>
                      <th>Note</th>
                      {canExclude && <th><span className="absolute w-[1px] h-[1px] p-0 -m-[1px] overflow-hidden [clip:rect(0_0_0_0)] whitespace-nowrap border-0">Action</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(detail?.dips_and_spikes || []).map((week) => (
                      <tr key={week.week_start}>
                        <td>{shortWeek(week)}</td>
                        <td className="text-right">{quantity(week.usage, item)}</td>
                        <td className="text-right">{quantity(week.typical, item)}</td>
                        <td className="text-right">{week.difference > 0 ? '+' : ''}{quantity(week.difference, item)}</td>
                        <td>
                          <b className={`er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px] er-tag-${week.flagged}`}>{week.note || (week.flagged === 'spike' ? 'Spike' : 'Dip')}</b>
                          <small className="block text-muted text-[11px]">
                            {item?.outliers?.capped
                              ? `Counted as ${quantity(week.adjusted_usage, item)} (capped)`
                              : 'Counted as recorded'}
                          </small>
                        </td>
                        {canExclude && (
                          <td><OneOffExclude locationId={resolvedLocation} item={item} week={week} onDone={afterExclude} /></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="mt-[18px] [&_h3]:m-[0_0_8px] [&_h3]:text-[13px] [&_h3]:text-text">
            <h3>Weeks left out of the estimate</h3>
            {(detail?.excluded_weeks || []).length === 0 ? (
              <p className="text-muted text-[12px] m-[10px_0_0]">Every week in this window is counted.</p>
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="er-table w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_.er-th-right]:text-right [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_strong]:text-[length:inherit] [&_td_strong]:leading-[inherit] [&_td_b]:text-[length:inherit] [&_td_b]:leading-[inherit]">
                  <thead><tr><th>Week</th><th>Why</th><th>Detail</th></tr></thead>
                  <tbody>
                    {(detail?.excluded_weeks || []).map((week) => (
                      <tr key={week.week_start}>
                        <td>{shortWeek(week)}</td>
                        <td><b className={`er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px] er-tag-${week.status}`}>{WEEK_STATUS_LABEL[week.status] || week.status}</b></td>
                        <td>{week.reason || (week.status === 'no_records' ? 'Open, but nothing was recorded this week' : '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <details className="mt-4 p-[12px_14px] [background:var(--surface-subtle)] border border-line rounded-[10px] [&_summary]:cursor-pointer [&_summary]:text-text [&_summary]:text-[12.5px] [&_summary]:font-[600] [&_ul]:m-[10px_0_0] [&_ul]:pl-[18px] [&_ul]:text-text-secondary [&_ul]:text-[11.5px] [&_ul]:grid [&_ul]:gap-[5px]">
            <summary>How this is calculated</summary>
            <ul>
              <li>Weekly usage = raw materials used by production (voided production is left out, so refunded materials never count){detail?.settings?.include_manual_deductions === false ? '.' : ', plus manual deductions (spoilage, damage, corrections).'} Deliveries and stock increases are never usage. Weeks run Monday–Sunday in {detail?.timezone || 'Asia/Manila'}.</li>
              <li>Weeks are left out (never counted as zero) when the branch was not yet open, the item was not yet stocked (before its first delivery or first use at this branch{item?.first_stocked_on ? `, ${item.first_stocked_on}` : ''}), the branch was closed for {formatNumber(detail?.settings?.closed_days_threshold ?? 4)}+ days, recorded nothing at all, a week was manually excluded, or it is the current week. After the item is first stocked, a week where the branch was open but used none of it is a real zero.</li>
              <li>Average weekly usage weights the last 4 included weeks 1, 2, 3, 4 (oldest to newest).</li>
              <li>Normal range = average ± one standard deviation of the last 8 included weeks (never below 0).</li>
              <li>Trend compares the simple average of the last 4 included weeks with the 4 before: more than +{formatNumber(detail?.settings?.trend_threshold_percent ?? 10)}% is Up, more than −{formatNumber(detail?.settings?.trend_threshold_percent ?? 10)}% is Down.</li>
              <li>Dips and spikes are weeks outside Q1 − 1.5×IQR / Q3 + 1.5×IQR (needs 8 included weeks, at most half of them zero). {detail?.dips_mode === 'raw' ? 'They are currently used as recorded.' : 'They are currently capped to the nearest bound for the maths only — the recorded figure is never changed.'}</li>
              <li>Days left = on hand ÷ (average ÷ 7). Estimated need = average × {horizon} week{horizon === 1 ? '' : 's'}.</li>
              <li>Suggested reorder = need + safety stock (1 standard deviation) − on hand − on order, rounded up to {item?.pack_size ? `packs of ${formatNumber(item.pack_size, 3)} ${item.unit}` : 'whole units'}. It is a hint only; nothing is ordered automatically.</li>
              <li>Fewer than {formatNumber(detail?.settings?.minimum_included_weeks ?? 4)} included weeks: no estimate is shown.</li>
            </ul>
            <p className="text-muted text-[12px] m-[10px_0_0]">{NOTE}</p>
          </details>
        </>
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

  const [locationId, setLocationId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [horizon, setHorizon] = useState(1);
  const [dips, setDips] = useState('cap');
  const [search, setSearch] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
  const [sort, setSort] = useState({ key: 'risk', dir: 'asc' });
  const [detailId, setDetailId] = useState(null);
  const [openingDraft, setOpeningDraft] = useState('');
  const [openingBusy, setOpeningBusy] = useState(false);
  const [openingError, setOpeningError] = useState('');

  const debouncedSearch = useDebouncedValue(search, 300);

  const remote = useRemote(
    () => api.get('/estimated-requirement', {
      location_id: locationId || undefined,
      brand_id: brandId || undefined,
      horizon,
      dips,
      search: debouncedSearch || undefined,
    }),
    [locationId, brandId, horizon, dips, debouncedSearch],
  );

  const payload = remote.data?.data;
  const branches = useMemo(() => payload?.locations || [], [payload]);
  const location = payload?.location;

  const visibleBranches = useMemo(() => {
    const needle = branchQuery.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((branch) => `${branch.name} ${branch.franchisee?.business_name || ''}`.toLowerCase().includes(needle));
  }, [branches, branchQuery]);

  useEffect(() => {
    if (isFranchisee || locationId || branches.length === 0) return;
    setLocationId(String(branches[0].id));
  }, [branches, isFranchisee, locationId]);

  const closuresRemote = useRemote(
    () => (location?.id && canCreateClosure
      ? api.get('/estimated-requirement/closures', {
        location_id: location.id,
        include_undone: 1,
      })
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

  const sortedItems = useMemo(() => {
    const value = (item) => {
      switch (sort.key) {
        case 'name': return item.name?.toLowerCase() || '';
        case 'risk': return item.ready ? (RISK_ORDER[item.status] ?? 9) : 8;
        case 'onhand': return item.on_hand ?? -1;
        case 'trend': return item.ready ? (TREND_ORDER[item.trend?.direction] ?? 9) : 9;
        case 'weeks': return item.included_weeks;
        case 'average': return item.weighted_average ?? -1;
        case 'days': return item.days_left ?? Number.MAX_SAFE_INTEGER;
        case 'need': return item.estimated_need ?? -1;
        case 'reorder': return item.suggested_reorder ?? -1;
        default: return 0;
      }
    };
    const direction = sort.dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return String(a.name).localeCompare(String(b.name));
      return left > right ? direction : -direction;
    });
  }, [items, sort]);

  const toggleSort = (key) => {
    setSort((current) => (current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'risk' || key === 'days' ? 'asc' : 'desc' }));
  };

  const saveOpeningDate = async (event) => {
    event.preventDefault();
    setOpeningBusy(true);
    setOpeningError('');
    try {
      await api.patch('/estimated-requirement/opening-date', {
        location_id: location?.id,
        opening_date: openingDraft || null,
      });
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

  // New usage, voids, closures or exclusions elsewhere: re-read in place.
  useForecastLiveRefresh(() => {
    reloadSide();
    void remote.reload({ silent: true });
  });

  const body = (
    <>
      {!embedded && (
        <PageHeader
          title="Analytics and Forecasting"
          subtitle="Usage-based demand and supply estimates"
          eyebrow="Analytics and Forecasting"
        />
      )}

      <p className="er-note-inline flex items-center gap-2 m-[0_0_14px] text-muted text-[12.5px] [&_svg]:text-accent-text [&_svg]:flex-none"><FaCircleInfo aria-hidden="true" /> {payload?.note || NOTE}</p>

      {canExclude && !embedded && (
        <p className="m-[-4px_0_14px] [&_a]:inline-flex [&_a]:items-center [&_a]:gap-[6px] [&_a]:p-[7px_12px] [&_a]:border [&_a]:border-line-strong [&_a]:rounded-[10px] [&_a]:text-accent-text [&_a]:text-[12.5px] [&_a]:font-[600] [&_a]:[text-decoration:none] [&_a:hover]:[background:var(--hover)]">
          <Link to="/estimated-requirement/network">Open network view: all branches vs warehouse stock →</Link>
        </p>
      )}

      {remote.error && <Notice type="error">{remote.error}</Notice>}

      <div className="er-filters grid grid-cols-[repeat(auto-fit,_minmax(190px,_1fr))] gap-3 p-[14px] mb-4 [background:var(--panel)] border border-line rounded-[14px]">
        {!isFranchisee && (
          <>
            <Field label="Search branch / franchisee">
              <input
                type="search"
                value={branchQuery}
                placeholder="Type a branch name…"
                onChange={(event) => setBranchQuery(event.target.value)}
              />
            </Field>
            <Field label="Branch">
              <select
                value={locationId}
                onChange={(event) => {
                  if (event.target.value === ALL_BRANCHES) {
                    navigate('/estimated-requirement/network');
                    return;
                  }
                  setLocationId(event.target.value);
                }}
              >
                {canExclude && <option value={ALL_BRANCHES}>All branches — network view</option>}
                {visibleBranches.length === 0 && <option value="">No branch matches</option>}
                {visibleBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}{branch.franchisee?.business_name ? ` · ${branch.franchisee.business_name}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Brand">
              <select value={brandId} onChange={(event) => setBrandId(event.target.value)}>
                <option value="">All brands</option>
                {(payload?.brands || []).map((brand) => (
                  <option key={brand.id} value={brand.id}>{brand.name}</option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="Horizon">
          <select value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
            <option value={1}>1 week</option>
            <option value={2}>2 weeks</option>
            <option value={4}>4 weeks</option>
          </select>
        </Field>
        <Field label="Dips and spikes in calculations" hint="Your recorded usage is never changed.">
          <select value={dips} onChange={(event) => setDips(event.target.value)}>
            <option value="cap">Cap them (default)</option>
            <option value="raw">Use raw values</option>
          </select>
        </Field>
        <Field label="Find an item">
          <input
            type="search"
            value={search}
            placeholder="Material or variant…"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </div>

      {location?.opening_date_needed && (
        <div className="flex gap-3 items-start p-[14px_16px] mb-4 border border-[color:color-mix(in_srgb,_var(--warning)_35%,_transparent)] [background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] rounded-[14px] later:[&>svg]:text-[color:var(--warning-text)] [&>svg]:mt-[2px] [&>svg]:flex-none [&_strong]:block later-4:[&_strong]:text-text later:[&_strong]:text-[13.5px] [&_p]:m-[4px_0_0] [&_p]:text-text-secondary [&_p]:text-[12.5px] [&_p]:max-w-[70ch]">
          <FaTriangleExclamation aria-hidden="true" />
          <div>
            <strong>Opening date needed</strong>
            <p>
              This branch has not recorded any activity yet, so its past weeks are not counted as zero usage.
              {isAdmin ? ' Set the date it started operating, or wait for its first production record.' : ' An administrator can set the opening date.'}
            </p>
            {isAdmin && (
              <form className="flex gap-2 mt-[10px] flex-wrap" onSubmit={saveOpeningDate}>
                <input type="date" value={openingDraft} required onChange={(event) => setOpeningDraft(event.target.value)} />
                <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={openingBusy}>Save opening date</button>
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
          <EstimateCards summary={payload?.summary} settings={payload?.settings} />

          <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px] later:[&_.table-wrap]:overflow-x-auto">
            <header className="flex justify-between gap-3 items-start">
              <div>
                <h2>{location.name}</h2>
                <p>
                  Weekly usage is Monday–Sunday in {payload?.timezone || 'Asia/Manila'}.
                  {location.effective_opening_date ? ` Counting from ${location.effective_opening_date}${location.opening_date_source === 'first_activity' ? ' (first recorded activity)' : ''}.` : ''}
                </p>
              </div>
            </header>

            {sortedItems.length > 0 && (
              <p className="flex items-center gap-[10px] later:m-[0_0_12px] p-[10px_14px] border border-[color:color-mix(in_srgb,_var(--accent)_40%,_transparent)] border-l-[4px] border-l-accent rounded-[10px] [background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] later:text-text later:text-[13px] later-2:[&_svg]:text-accent-text [&_svg]:flex-none later:[&_b]:text-accent-text" role="note">
                <FaChartLine aria-hidden="true" />
                <span>Click <b>View chart</b> to see the 12-week usage history and how the estimate was worked out.</span>
              </p>
            )}

            {sortedItems.length === 0 ? (
              <EmptyState label="No tracked raw material yet." detail="Add materials and record production for this branch." />
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="er-table w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_.er-th-right]:text-right [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_strong]:text-[length:inherit] [&_td_strong]:leading-[inherit] [&_td_b]:text-[length:inherit] [&_td_b]:leading-[inherit]">
                  <thead>
                    <tr>
                      <SortHeader label="Raw material" sortKey="name" sort={sort} onSort={toggleSort} />
                      <SortHeader label="On hand" sortKey="onhand" sort={sort} onSort={toggleSort} align="right" />
                      <SortHeader label="Avg weekly usage" sortKey="average" sort={sort} onSort={toggleSort} align="right" />
                      <SortHeader label="Trend" sortKey="trend" sort={sort} onSort={toggleSort} />
                      <SortHeader label="Days left" sortKey="days" sort={sort} onSort={toggleSort} align="right" />
                      <SortHeader label="Status" sortKey="risk" sort={sort} onSort={toggleSort} />
                      <SortHeader label={`Est. need (${horizon} wk)`} sortKey="need" sort={sort} onSort={toggleSort} align="right" />
                      <SortHeader label="Suggested reorder" sortKey="reorder" sort={sort} onSort={toggleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((item) => (
                      <tr
                        key={item.material_id}
                        onClick={() => setDetailId(item.material_id)}
                        onKeyDown={(event) => {
                          // Keys pressed on the View chart button are handled by the button itself.
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDetailId(item.material_id); }
                        }}
                        tabIndex={0}
                        className="cursor-pointer [&:hover_td]:[background:var(--hover)] [&:focus-visible_td]:[background:var(--hover)] [&:focus-visible_td]:[outline:none] [&:focus-visible_td:first-child]:[box-shadow:inset_3px_0_0_var(--accent)]"
                      >
                        <td>
                          <strong>{item.name}</strong>
                          <small className="block text-muted text-[11px]">
                            {[item.variant, item.brand_name].filter(Boolean).join(' · ')}
                          </small>
                        </td>
                        <td className="text-right">{quantity(item.on_hand, item)}</td>
                        <td className="text-right">
                          {item.ready ? (
                            <>
                              {quantity(item.weighted_average, item)}
                              {item.normal_range && (
                                <small className="block text-muted text-[11px]">{formatNumber(item.normal_range.low, precisionOf(item))}–{formatNumber(item.normal_range.high, precisionOf(item))}</small>
                              )}
                            </>
                          ) : (
                            <span className="text-muted text-[11.5px]">
                              Not enough data yet
                              <small className="block text-muted text-[11px]">{formatNumber(item.needed_weeks)} more week{item.needed_weeks === 1 ? '' : 's'} needed</small>
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-[6px_10px]">
                            {item.ready ? <TrendCell trend={item.trend} /> : <span className="text-muted text-[11.5px]">—</span>}
                            <button
                              type="button"
                              className="inline-flex items-center gap-[6px] min-h-[28px] p-[0_10px] border border-[color:color-mix(in_srgb,_var(--accent)_45%,_transparent)] rounded-[999px] [background:color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent-text text-[11.5px] font-[650] whitespace-nowrap [transition:background_.15s_ease,_border-color_.15s_ease] later:[&_svg]:text-[11px] hover:[background:color-mix(in_srgb,_var(--accent)_22%,_transparent)] hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                              aria-label={`View 12-week chart for ${item.name}`}
                              onClick={(event) => {
                                event.stopPropagation(); // the row would open it too
                                setDetailId(item.material_id);
                              }}
                            >
                              <FaChartLine aria-hidden="true" /> View chart
                            </button>
                          </div>
                        </td>
                        <td className="text-right">
                          {!item.ready ? '—' : item.days_left === null || item.days_left === undefined ? <span className="text-muted text-[11.5px]">No recent usage</span> : formatNumber(item.days_left, 1)}
                        </td>
                        <td>
                          {item.ready
                            ? <span className={`er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px] er-${item.status}`}>{RISK_LABEL[item.status] || item.status}</span>
                            : <span className="er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px] later:text-muted">No estimate</span>}
                          {item.reorder_status && (
                            <span className={`er-tag inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap [.er-tag+&]:ml-[6px] er-stock-${item.reorder_status}`} title="Existing reorder status of the branch inventory">
                              {REORDER_STATUS_LABEL[item.reorder_status]}
                            </span>
                          )}
                        </td>
                        <td className="text-right">{quantity(item.estimated_need, item)}</td>
                        <td className="text-right">
                          {item.suggested_reorder ? <strong className="text-accent-text [.er-table_td_&]:font-[700]">{quantity(item.suggested_reorder, item)}</strong> : (item.ready ? '0' : '—')}
                          {item.on_order !== null && item.on_order !== undefined && item.on_order > 0 && (
                            <small className="block text-muted text-[11px]">on order {quantity(item.on_order, item)}</small>
                          )}
                          {item.on_order_note && <small className="block mt-[2px] text-[color:var(--warning-text)] text-[10.5px] whitespace-nowrap">{item.on_order_note}</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-muted text-[12px] m-[10px_0_0]">You can also click anywhere on a row to open the same chart.</p>
          </section>

          {canCreateClosure && (
            <ClosuresPanel
              locationId={location.id}
              canCreate={canCreateClosure}
              canUndo={canCreateClosure}
              closures={closuresRemote.data?.data?.closures || []}
              onChanged={() => {
                reloadSide();
                void remote.reload({ silent: true });
              }}
            />
          )}

          {canExclude && (
            <ExclusionsPanel
              locationId={location.id}
              weeks={payload?.weeks || []}
              exclusions={exclusionsRemote.data?.data?.exclusions || []}
              onChanged={() => {
                reloadSide();
                void remote.reload({ silent: true });
              }}
            />
          )}
        </>
      )}

      {detailId !== null && (
        <EstimateDetail
          locationId={locationId || location?.id}
          materialId={detailId}
          horizon={horizon}
          dips={dips}
          canExclude={canExclude}
          onClose={() => setDetailId(null)}
          onChanged={() => {
            reloadSide();
            void remote.reload({ silent: true });
          }}
        />
      )}
    </>
  );

  // The franchisee's Branch Portal tab uses the embedded form: it gets no
  // header and no Admin/Logistics sections, so that view is unchanged.
  return embedded
    ? <div className="block [&_.er-note-inline]:mt-0">{body}</div>
    : <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]">{body}<ForecastingSections role={role} /></div>;
}
