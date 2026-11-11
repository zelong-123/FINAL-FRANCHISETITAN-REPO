import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  FaBoxesStacked,
  FaCalendarCheck,
  FaCircleCheck,
  FaClipboardCheck,
  FaClipboardList,
  FaHandshake,
  FaMagnifyingGlass,
  FaPause,
  FaRotateLeft,
  FaTriangleExclamation,
  FaTruckFast,
} from 'react-icons/fa6';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ApiUi';
import { formatNumber, titleCase } from '../../lib/format';
import { conversionRatePercent, formatPercent } from '../../lib/conversion';

/* Chart palette — mirrors the dark/neon theme tokens from index.css. */
const PALETTE = ['#6687ff', '#8b6dff', '#32c997', '#f4b84a', '#54a8ff', '#f56d7d', '#9db2ff', '#4dd4ac'];
const GRID = 'rgba(143, 154, 178, .16)';
const AXIS = '#8f9ab2';

// One entry per open supply status (the pipeline's stages); colours come from PALETTE.
const STAGE_COLORS = {
  submitted: '#54a8ff',
  under_review: '#6687ff',
  returned: '#9db2ff',
  waiting_logistics: '#8b6dff',
  scheduled: '#4dd4ac',
  on_hold: '#f56d7d',
  preparing: '#f4b84a',
  dispatched: '#9db2ff',
  delivered: '#32c997',
  discrepancy_review: '#f56d7d',
};

const STAGE_ICONS = {
  submitted: FaClipboardList,
  under_review: FaMagnifyingGlass,
  returned: FaRotateLeft,
  waiting_logistics: FaHandshake,
  scheduled: FaCalendarCheck,
  on_hold: FaPause,
  preparing: FaBoxesStacked,
  dispatched: FaTruckFast,
  delivered: FaCircleCheck,
  discrepancy_review: FaTriangleExclamation,
};

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:gap-1 [.dashboard-page_&]:p-[9px_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line-strong [.dashboard-page_&]:rounded-[11px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel-2)_96%,_transparent)] [.dashboard-page_&]:[box-shadow:var(--shadow-md)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:pointer-events-none [.dashboard-page_&_strong]:text-text later-2:[.dashboard-page_&_strong]:text-[9.5px]">
      {label !== undefined && label !== null && <strong>{label}</strong>}
      {payload.map((entry) => (
        <span key={String(entry.dataKey ?? entry.name)} style={{ color: entry.color || entry.fill || undefined }}>
          {entry.name}: {formatNumber(entry.value, 1)}
        </span>
      ))}
    </div>
  );
}

/** Numeric label drawn at the end of a horizontal bar. */
function countBarLabel({ x, y, width, height, value }) {
  const posX = Number(x) + Number(width) + 8;
  const posY = Number(y) + Number(height) / 2;
  if (!Number.isFinite(posX) || !Number.isFinite(posY) || value === undefined || value === null) return null;
  return (
    <text x={posX} y={posY} dominantBaseline="middle" className="[.branch-portal-page_&]:[fill:var(--text-secondary)] [.branch-portal-page_&]:text-[9px] [.branch-portal-page_&]:font-[750] [.dashboard-page_&]:[fill:var(--text-secondary)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[750]">
      {formatNumber(value, 1)}
    </text>
  );
}

/** Small note drawn inside a chart frame when the selected range holds no rows. */
function EmptyNote() {
  return <span className="chart-empty-note [.dashboard-page_&]:absolute [.dashboard-page_&]:top-[8px] [.dashboard-page_&]:right-[12px] [.dashboard-page_&]:z-3 [.dashboard-page_&]:p-[4px_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-dashed [.dashboard-page_&]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_var(--border))] [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_90%,_#000_10%)] [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.04em] [.dashboard-page_&]:pointer-events-none [.dashboard-page_&]:whitespace-nowrap">No data in this range</span>;
}

/**
 * Fixed-height chart frame. The box always renders — with its axes, grid and
 * legend — so a chart is never a blank rectangle; when the range holds nothing
 * the empty flag adds the "No data in this range" note inside the frame.
 */
function ChartFrame({ height, empty = false, children }) {
  return (
    <div className="[.branch-portal-page_&]:relative [.branch-portal-page_&]:w-full [.branch-portal-page_&]:min-w-0 [.dashboard-page_.chart-row-2_&]:h-[260px]! [.dashboard-page_&]:relative [.dashboard-page_&]:w-full [.dashboard-page_&]:min-w-0" style={{ height }}>
      {children}
      {empty && <EmptyNote />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sales trend — dual-axis combo: bars = units sold, line = sales count */
/* ------------------------------------------------------------------ */
export function SalesTrendCombo({ rows }) {
  const data = rows || [];
  const empty = !data.some((row) => Number(row.quantity || 0) > 0 || Number(row.sales || 0) > 0);

  return (
    <div className="chart-surface">
      <div className="chart-legend [.dashboard-page_&]:flex [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[15px] [.dashboard-page_&]:p-[12px_16px_0]">
        <span className="chart-legend-item"><i className="legend-swatch legend-bar [.dashboard-page_&]:[background:#6687ff]" /> Units sold (bars)</span>
        <span className="chart-legend-item"><i className="legend-swatch legend-line" /> Transactions (line)</span>
      </div>
      <ChartFrame height={280} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 9 }} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis yAxisId="qty" allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={44} />
            <YAxis yAxisId="sales" orientation="right" allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={34} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(102, 135, 255, .09)' }} />
            <Bar yAxisId="qty" dataKey="quantity" name="Units sold" fill="#6687ff" radius={[5, 5, 0, 0]} maxBarSize={30} />
            <Line yAxisId="sales" dataKey="sales" name="Transactions" type="monotone" stroke="#32c997" strokeWidth={2.2} dot={{ r: 2.4, fill: '#32c997', strokeWidth: 0 }} activeDot={{ r: 4.5 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No branch sales in this range — record a branch sale and the trend fills in.'
          : 'Units sold per period (bars, left axis) against the number of sales transactions (line, right axis).'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Production trend — units produced vs production transactions        */
/* ------------------------------------------------------------------ */
export function ProductionTrendCombo({ rows }) {
  const data = rows || [];
  const empty = !data.some((row) => Number(row.units || 0) > 0 || Number(row.transactions || 0) > 0);

  return (
    <div className="chart-surface">
      <div className="chart-legend [.dashboard-page_&]:flex [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[15px] [.dashboard-page_&]:p-[12px_16px_0]">
        <span className="chart-legend-item"><i className="legend-swatch legend-bar [.dashboard-page_&]:[background:#6687ff]" /> Units produced (bars)</span>
        <span className="chart-legend-item"><i className="legend-swatch legend-line" /> Production transactions (line)</span>
      </div>
      <ChartFrame height={300} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 10, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 9 }} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
            <YAxis yAxisId="units" allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={44} />
            <YAxis yAxisId="transactions" orientation="right" allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={34} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(102, 135, 255, .09)' }} />
            <Bar yAxisId="units" dataKey="units" name="Units produced" fill="#6687ff" radius={[5, 5, 0, 0]} maxBarSize={30} />
            <Line yAxisId="transactions" dataKey="transactions" name="Production transactions" type="monotone" stroke="#32c997" strokeWidth={2.2} dot={{ r: 2.4, fill: '#32c997', strokeWidth: 0 }} activeDot={{ r: 4.5 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No production submitted in this range — record production and the trend fills in.'
          : 'Units produced per period (bars, left axis) against the number of production transactions (line, right axis).'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inquiry by source — donut with the lead total in the center          */
/* ------------------------------------------------------------------ */
// Known inquiry sources: always shown in the legend, at 0 when the range has none.
const KNOWN_SOURCES = ['viber', 'facebook', 'gmail', 'walk in', 'referral'];

// Fixed source colors so every panel reads the same channel the same way.
// Gmail is drawn with a gradient (see GMAIL_* below); its solid value is only a fallback.
const SOURCE_COLORS = {
  facebook: '#0865FF',
  viber: '#8460F4',
  gmail: '#34A853',
  'walk in': '#8B5E3C', // professional brown
  referral: '#D4AF37', // gold
};

// Gmail logo colors: red -> yellow -> green -> blue.
const GMAIL_GRADIENT_ID = 'source-gmail-gradient';
const GMAIL_STOPS = [
  { offset: '0%', color: '#EA4335' },
  { offset: '35%', color: '#FBBC04' },
  { offset: '68%', color: '#34A853' },
  { offset: '100%', color: '#4285F4' },
];
const GMAIL_CSS_GRADIENT = 'linear-gradient(90deg, #EA4335 0%, #FBBC04 35%, #34A853 68%, #4285F4 100%)';

const isGmail = (name) => String(name).toLowerCase() === 'gmail';
const sourceColor = (name, index) => SOURCE_COLORS[String(name).toLowerCase()] || PALETTE[Math.max(0, index) % PALETTE.length];
// Fill for SVG shapes (bars, donut slices): Gmail uses the gradient defined in <SourceGradientDefs />.
const sourceFill = (name, index) => (isGmail(name) ? `url(#${GMAIL_GRADIENT_ID})` : sourceColor(name, index));
// Background for the small legend dot (plain CSS, so it needs the CSS gradient).
const sourceSwatch = (name, index) => (isGmail(name) ? GMAIL_CSS_GRADIENT : sourceColor(name, index));

/** SVG gradient definition. Place it as a direct child of BarChart / PieChart. */
function SourceGradientDefs() {
  return (
    <defs>
      <linearGradient id={GMAIL_GRADIENT_ID} x1="0" y1="0" x2="1" y2="0">
        {GMAIL_STOPS.map((stop) => (
          <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
        ))}
      </linearGradient>
    </defs>
  );
}

// Optional categories: the "By Branch" view passes its own four names and brand colors.
// Without them the donut is exactly the source view it always was.
export function SourceDonut({ entries, categories = KNOWN_SOURCES, colors = null }) {
  const byName = new Map((entries || []).map((entry) => [String(entry.name).toLowerCase(), Number(entry.value) || 0]));
  const known = new Set(categories.map((name) => name.toLowerCase()));
  // Any channel the API reports outside the fixed list still gets a slice and a
  // legend row, so the donut total always matches the inquiry count.
  const extras = [...byName.keys()].filter((name) => !known.has(name));
  const fillAt = (name, index) => (colors ? colors[index % colors.length] : sourceFill(name, index));
  const swatchAt = (name, index) => (colors ? colors[index % colors.length] : sourceSwatch(name, index));
  const legend = [
    ...categories.map((name, index) => ({ name, value: byName.get(name.toLowerCase()) || 0, fill: fillAt(name, index), swatch: swatchAt(name, index) })),
    ...extras.map((name, index) => ({ name, value: byName.get(name) || 0, fill: fillAt(name, categories.length + index), swatch: swatchAt(name, categories.length + index) })),
  ];
  const total = legend.reduce((sum, entry) => sum + entry.value, 0);
  const empty = total <= 0;
  // Empty: one neutral full ring keeps the donut shape visible.
  const data = empty ? [{ name: 'none', value: 1, fill: 'var(--border)' }] : legend.filter((entry) => entry.value > 0);
  const percentOf = (value) => (total > 0 ? Math.round((value / total) * 100) : 0);

  return (
    <div className="[.dashboard-page_&]:grid [.dashboard-page_&]:grid-cols-[minmax(0,_1fr)_minmax(170px,_0.85fr)] [.dashboard-page_&]:gap-3 [.dashboard-page_&]:items-center [.dashboard-page_&]:p-[12px_16px_16px] max-[1121px]:later:[.dashboard-page_&]:grid-cols-[1fr]">
      <div className="[.dashboard-page_&]:relative [.dashboard-page_&]:min-w-0">
        <ChartFrame height={224} empty={empty}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <SourceGradientDefs />
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="88%" paddingAngle={2} stroke="none" isAnimationActive>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.fill} fillOpacity={empty ? 0.35 : 1} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </ChartFrame>
        <div className="[.dashboard-page_&]:absolute [.dashboard-page_&]:inset-0 [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-center [.dashboard-page_&]:pointer-events-none [.dashboard-page_&_strong]:text-text later-3:[.dashboard-page_&_strong]:text-[clamp(22px,_2.4vw,_29px)] later:[.dashboard-page_&_strong]:tracking-[-0.045em] later:[.dashboard-page_&_strong]:leading-[1] [.dashboard-page_&_span]:mt-[5px] [.dashboard-page_&_span]:text-muted later-4:[.dashboard-page_&_span]:text-[8px] [.dashboard-page_&_span]:font-[800] [.dashboard-page_&_span]:tracking-[0.14em] [.dashboard-page_&_span]:uppercase">
          <strong>{formatNumber(total)}</strong>
          <span>leads</span>
        </div>
      </div>
      <ul className="donut-legend [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:gap-[9px] [.dashboard-page_&]:m-0 [.dashboard-page_&]:p-0 [.dashboard-page_&]:[list-style:none] [.dashboard-page_&_li]:grid [.dashboard-page_&_li]:grid-cols-[10px_minmax(0,_1fr)_auto_auto] [.dashboard-page_&_li]:gap-[9px] [.dashboard-page_&_li]:items-center [.dashboard-page_&_li]:p-[8px_10px] [.dashboard-page_&_li]:border [.dashboard-page_&_li]:border-line [.dashboard-page_&_li]:rounded-[11px] [.dashboard-page_&_li]:[background:var(--surface-subtle)] [.dashboard-page_&_li]:text-text-secondary [.dashboard-page_&_li]:text-[9px] [.dashboard-page_&_li_strong]:text-text [.dashboard-page_&_li_strong]:text-[11.5px] [.dashboard-page_&_li_small]:min-w-[32px] [.dashboard-page_&_li_small]:text-muted [.dashboard-page_&_li_small]:text-[8px] [.dashboard-page_&_li_small]:text-right [.dashboard-page_&_li.legend-normal_strong]:text-success-text later:[.dashboard-page_&_li.legend-low_strong]:text-[color:var(--warning-text)] later-2:[.dashboard-page_&_li.legend-critical_strong]:text-danger-text">
        {legend.map((entry) => (
          <li key={entry.name}>
            <span className="[.dashboard-page_&]:w-[9px] [.dashboard-page_&]:h-[9px] [.dashboard-page_&]:rounded-[50%]" style={{ background: entry.swatch }} />
            <span className="[.dashboard-page_.donut-legend_&]:whitespace-nowrap [.dashboard-page_.donut-legend_&]:overflow-hidden [.dashboard-page_.donut-legend_&]:text-ellipsis">{titleCase(entry.name)}</span>
            <strong>{formatNumber(entry.value)}</strong>
            <small>{percentOf(entry.value)}%</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inquiry acquisition — horizontal bars of conversion rate per channel */
/* ------------------------------------------------------------------ */
function acquisitionTooltip({ active, payload }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="chart-tooltip [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:gap-1 [.dashboard-page_&]:p-[9px_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line-strong [.dashboard-page_&]:rounded-[11px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel-2)_96%,_transparent)] [.dashboard-page_&]:[box-shadow:var(--shadow-md)] [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:pointer-events-none [.dashboard-page_&_strong]:text-text later-2:[.dashboard-page_&_strong]:text-[9.5px]">
      <strong>{titleCase(row.source)}</strong>
      <span>Conversion: {formatPercent(row.conversion_rate_percent)}</span>
      <span>Lead volume: {formatNumber(row.leads)}</span>
      <span>Converted: {formatNumber(row.converted)}</span>
    </div>
  );
}

// Known inquiry channels, shown with zero values when the range returns none.
const FALLBACK_CHANNELS = ['viber', 'facebook', 'gmail', 'walk in', 'referral'];

export function AcquisitionBars({ rows }) {
  const apiRows = rows || [];
  const source = apiRows.length
    ? apiRows
    : FALLBACK_CHANNELS.map((name) => ({ source: name, leads: 0, converted: 0, conversion_rate_percent: 0 }));
  // Coerce everything to finite numbers so a missing value can never produce NaN.
  // Biggest channels first: the length of the bar is the lead volume, so a
  // channel with leads is always visible even before its first approval.
  const data = source
    .map((row) => ({
      source: row.source,
      leads: Number(row.leads || 0),
      converted: Number(row.converted || 0),
      // Same shared formula as the KPI card; converted can never exceed leads.
      conversion_rate_percent: conversionRatePercent(Math.min(Number(row.converted || 0), Number(row.leads || 0)), row.leads),
    }))
    .sort((a, b) => b.leads - a.leads || b.conversion_rate_percent - a.conversion_rate_percent);
  const totalLeads = data.reduce((sum, row) => sum + row.leads, 0);
  const maxLeads = Math.max(1, ...data.map((row) => row.leads));
  // Empty means no leads in the range. The frame still renders; only the bars are zero.
  const empty = totalLeads <= 0;

  return (
    <div className="chart-surface">
      <ChartFrame height={260} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 8, right: 56, left: 8, bottom: 4 }} barCategoryGap={14}>
            <SourceGradientDefs />
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" domain={[0, maxLeads]} allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={{ stroke: GRID }} tickLine={false} />
            <YAxis type="category" dataKey="source" tickFormatter={titleCase} tick={{ fill: '#c9d1e4', fontSize: 10 }} axisLine={false} tickLine={false} width={92} />
            <Tooltip content={acquisitionTooltip} cursor={{ fill: 'rgba(102, 135, 255, .09)' }} />
            <Bar dataKey="leads" name="Leads" radius={[0, 7, 7, 0]} maxBarSize={26}>
              {data.map((entry) => (
                <Cell key={entry.source} fill={sourceFill(entry.source, data.indexOf(entry))} />
              ))}
              <LabelList content={countBarLabel} position="right" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No leads acquired in this range — widen the date filter to compare channels.'
          : 'Bars show leads acquired per channel (Admin and Marketing entries) — hover a bar for its conversion rate and converted leads.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Applicant funnel — inverted pyramid with drop-off between stages     */
/* ------------------------------------------------------------------ */
const FUNNEL_FLOW = ['inquiry', 'qualified', 'scheduled', 'loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee'];
const FUNNEL_STAGES = [
  { key: 'inquiry', label: 'Inquiry', from: 0 },
  { key: 'qualified', label: 'Qualified', from: 1 },
  { key: 'interview', label: 'Interview', from: 2 },
  { key: 'approved', label: 'Approved', from: 6 },
];

export function ApplicantFunnel({ funnel }) {
  const counts = funnel || {};
  const reached = (from) => FUNNEL_FLOW.slice(from).reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  const stages = FUNNEL_STAGES.map((stage, index) => ({
    ...stage,
    // Step 1 is the raw lead total the API reports under `inquiry` (every lead in
    // the range). Summing it together with the applicant stages would count each
    // progressed applicant twice, so only the later steps use the running total.
    value: index === 0 ? Number(counts.inquiry || 0) : reached(stage.from),
  }));
  const top = stages[0]?.value || 0;
  const empty = top <= 0;

  return (
    <div className="[.dashboard-page_&]:p-[16px_18px_8px]">
      <div className="[.dashboard-page_&]:relative [.dashboard-page_&]:min-h-[252px] [.dashboard-page_&_.chart-empty-note]:top-auto [.dashboard-page_&_.chart-empty-note]:bottom-[8px] [.dashboard-page_&_.chart-empty-note]:right-[50%] [.dashboard-page_&_.chart-empty-note]:[transform:translateX(50%)]">
        <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[3px]">
          {stages.map((stage, index) => {
            const previous = index > 0 ? stages[index - 1] : null;
            const lost = previous ? Math.max(0, previous.value - stage.value) : 0;
            const drop = previous && previous.value > 0 ? (lost / previous.value) * 100 : 0;
            // With no rows every step spans the full frame so the funnel still reads as a shape.
            // Cumulative steps can never grow, and the share is clamped so a wider
            // later step can never render outside the frame.
            const share = empty ? 100 : Math.min(100, Math.max(8, (stage.value / top) * 100));

            return (
              <React.Fragment key={stage.key}>
                {previous && (
                  <div className={`[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[10px] [.dashboard-page_&]:m-[4px_0] [.dashboard-page_&]:p-[4px_13px] [.dashboard-page_&]:border [.dashboard-page_&]:border-dashed [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:font-[700] [.dashboard-page_&_small]:text-muted [.dashboard-page_&_small]:text-[8px] [.dashboard-page_&_small]:font-[500] [.dashboard-page_&.has-loss]:border-[color:color-mix(in_srgb,_var(--danger)_38%,_transparent)] [.dashboard-page_&.has-loss]:text-danger-text [.dashboard-page_&.has-loss]:[background:color-mix(in_srgb,_var(--danger)_7%,_transparent)] [.dashboard-page_&.has-loss_small]:text-[color:color-mix(in_srgb,_var(--danger-text)_78%,_var(--muted))] ${drop > 0 ? ' has-loss' : ''}`}>
                    <span>↓ {formatNumber(drop, 1)}% drop-off</span>
                    <small>{formatNumber(lost)} did not continue</small>
                  </div>
                )}
                <div className="[.dashboard-page_&]:min-w-[215px] [.dashboard-page_&]:min-h-[56px] [.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-between [.dashboard-page_&]:gap-[18px] [.dashboard-page_&]:p-[0_clamp(18px,_4vw,_42px)] [.dashboard-page_&]:[clip-path:polygon(3%_0,_97%_0,_100%_100%,_0_100%)] [.dashboard-page_&]:[background:linear-gradient(_135deg,_color-mix(in_srgb,_var(--accent)_88%,_#05070d),_color-mix(in_srgb,_var(--accent-2)_88%,_#05070d)_)] [.dashboard-page_&]:[filter:hue-rotate(calc(var(--funnel-step,_0)_*_24deg))] [.dashboard-page_&]:[box-shadow:0_14px_30px_color-mix(in_srgb,_var(--accent)_18%,_transparent)] later:[.dashboard-page_&_strong]:text-[#fff] later-4:[.dashboard-page_&_strong]:text-[clamp(16px,_1.7vw,_21px)] later-2:[.dashboard-page_&_strong]:tracking-[-0.03em] max-[681px]:later:[.dashboard-page_&]:min-w-[160px] max-[681px]:later:[.dashboard-page_&]:p-[0_16px]" style={{ width: `${share}%`, '--funnel-step': index }}>
                  <span className="[.dashboard-page_&]:text-[rgba(255,_255,_255,_0.9)] [.dashboard-page_&]:text-[10px] [.dashboard-page_&]:font-[780] [.dashboard-page_&]:tracking-[0.06em] [.dashboard-page_&]:uppercase [.dashboard-page_&]:whitespace-nowrap">{stage.label}</span>
                  <strong>{formatNumber(stage.value)}</strong>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        {empty && <span className="chart-empty-note [.dashboard-page_&]:absolute [.dashboard-page_&]:top-[8px] [.dashboard-page_&]:right-[12px] [.dashboard-page_&]:z-3 [.dashboard-page_&]:p-[4px_11px] [.dashboard-page_&]:border [.dashboard-page_&]:border-dashed [.dashboard-page_&]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_var(--border))] [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--panel)_90%,_#000_10%)] [.dashboard-page_&]:text-muted [.dashboard-page_&]:text-[9px] [.dashboard-page_&]:font-[700] [.dashboard-page_&]:tracking-[0.04em] [.dashboard-page_&]:pointer-events-none [.dashboard-page_&]:whitespace-nowrap">No data in this range</span>}
      </div>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No leads or applicants in this range — widen the date filter to see the pipeline.'
          : 'Inquiry → Qualified → Interview → Approved. Each step counts everyone who reached it, so it never grows past the step above.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inventory health — donut, center = total SKUs                        */
/* ------------------------------------------------------------------ */
export function InventoryDonut({ status }) {
  const colors = { normal: '#32c997', low: '#f4b84a', critical: '#f56d7d' };
  const data = Object.entries(status || {})
    .map(([key, value]) => ({ key, name: titleCase(key), value: Number(value || 0), color: colors[key] || '#6687ff' }))
    .filter((entry) => entry.value > 0);
  const total = data.reduce((sum, entry) => sum + entry.value, 0);
  const empty = total <= 0;

  return (
    <div className="[.dashboard-page_&]:grid [.dashboard-page_&]:grid-cols-[minmax(0,_1fr)_minmax(170px,_0.85fr)] [.dashboard-page_&]:gap-3 [.dashboard-page_&]:items-center [.dashboard-page_&]:p-[12px_16px_16px] max-[1121px]:later:[.dashboard-page_&]:grid-cols-[1fr]">
      <div className="[.dashboard-page_&]:relative [.dashboard-page_&]:min-w-0">
        <ChartFrame height={224} empty={empty}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="90%" paddingAngle={3} stroke="none">
                {data.map((entry) => (
                  <Cell key={entry.key} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </ChartFrame>
        <div className="[.dashboard-page_&]:absolute [.dashboard-page_&]:inset-0 [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-center [.dashboard-page_&]:pointer-events-none [.dashboard-page_&_strong]:text-text later-3:[.dashboard-page_&_strong]:text-[clamp(22px,_2.4vw,_29px)] later:[.dashboard-page_&_strong]:tracking-[-0.045em] later:[.dashboard-page_&_strong]:leading-[1] [.dashboard-page_&_span]:mt-[5px] [.dashboard-page_&_span]:text-muted later-4:[.dashboard-page_&_span]:text-[8px] [.dashboard-page_&_span]:font-[800] [.dashboard-page_&_span]:tracking-[0.14em] [.dashboard-page_&_span]:uppercase">
          <strong>{formatNumber(total)}</strong>
          <span>SKUs</span>
        </div>
      </div>
      <ul className="donut-legend [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:gap-[9px] [.dashboard-page_&]:m-0 [.dashboard-page_&]:p-0 [.dashboard-page_&]:[list-style:none] [.dashboard-page_&_li]:grid [.dashboard-page_&_li]:grid-cols-[10px_minmax(0,_1fr)_auto_auto] [.dashboard-page_&_li]:gap-[9px] [.dashboard-page_&_li]:items-center [.dashboard-page_&_li]:p-[8px_10px] [.dashboard-page_&_li]:border [.dashboard-page_&_li]:border-line [.dashboard-page_&_li]:rounded-[11px] [.dashboard-page_&_li]:[background:var(--surface-subtle)] [.dashboard-page_&_li]:text-text-secondary [.dashboard-page_&_li]:text-[9px] [.dashboard-page_&_li_strong]:text-text [.dashboard-page_&_li_strong]:text-[11.5px] [.dashboard-page_&_li_small]:min-w-[32px] [.dashboard-page_&_li_small]:text-muted [.dashboard-page_&_li_small]:text-[8px] [.dashboard-page_&_li_small]:text-right [.dashboard-page_&_li.legend-normal_strong]:text-success-text later:[.dashboard-page_&_li.legend-low_strong]:text-[color:var(--warning-text)] later-2:[.dashboard-page_&_li.legend-critical_strong]:text-danger-text">
        {empty ? (
          <li className="muted-note text-muted text-[8px] leading-[1.6]">No inventory records in this view.</li>
        ) : data.map((entry) => (
          <li key={entry.key} className={`legend-${entry.key}`}>
            <span className="[.dashboard-page_&]:w-[9px] [.dashboard-page_&]:h-[9px] [.dashboard-page_&]:rounded-[50%]" style={{ background: entry.color }} />
            <span className="[.dashboard-page_.donut-legend_&]:whitespace-nowrap [.dashboard-page_.donut-legend_&]:overflow-hidden [.dashboard-page_.donut-legend_&]:text-ellipsis">{entry.name}</span>
            <strong>{formatNumber(entry.value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top performing branches — volume / transaction-count toggle          */
/* ------------------------------------------------------------------ */
export function TopBranchesBars({ rows, metric }) {
  const data = (rows || []).map((row) => ({
    location_id: row.location_id,
    name: row.name,
    quantity: Number(row.quantity || 0),
    sales: Number(row.sales || 0),
  }));
  const hasData = data.some((row) => row.quantity > 0 || row.sales > 0);
  const empty = data.length === 0 || !hasData;

  const dataKey = metric === 'sales' ? 'sales' : 'quantity';
  const unit = metric === 'sales' ? 'sales' : 'units';

  return (
    <div className="chart-surface">
      <ChartFrame height={300} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 8, right: 58, left: 8, bottom: 4 }} barCategoryGap={10}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={{ stroke: GRID }} tickLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fill: '#c9d1e4', fontSize: 9.5 }} axisLine={false} tickLine={false} width={116} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(102, 135, 255, .09)' }} />
            <Bar dataKey={dataKey} name={metric === 'sales' ? 'Transactions' : 'Units sold'} radius={[0, 7, 7, 0]} maxBarSize={24}>
              {data.map((row, index) => (
                <Cell key={row.location_id} fill={metric === 'sales' ? '#32c997' : PALETTE[index % PALETTE.length]} />
              ))}
              <LabelList content={countBarLabel} position="right" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No branch sales in this range — rankings appear once branches record sales.'
          : `${metric === 'sales' ? 'Number of sale transactions per branch.' : 'Total units sold per branch.'} (${unit})`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Requests per stage — vertical bar chart                              */
/* ------------------------------------------------------------------ */
export function StageBarChart({ stages }) {
  const data = (stages || []).map((stage) => ({ ...stage, count: Number(stage.count || 0) }));
  const total = data.reduce((sum, stage) => sum + stage.count, 0);
  const empty = total <= 0;

  return (
    <div className="chart-surface">
      <ChartFrame height={260} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 14, right: 10, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 8.5 }} axisLine={{ stroke: GRID }} tickLine={false} interval={0} angle={-18} textAnchor="end" height={46} />
            <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(102, 135, 255, .09)' }} />
            <Bar dataKey="count" name="Requests" radius={[6, 6, 0, 0]} maxBarSize={44}>
              {data.map((stage) => (
                <Cell key={stage.key} fill={STAGE_COLORS[stage.key] || '#6687ff'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No supply requests in this range — stage volumes appear as requests arrive.'
          : 'Open and historical requests by workflow stage.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fulfillment trend — submitted vs completed per month                 */
/* ------------------------------------------------------------------ */
export function FulfillmentTrend({ rows }) {
  const data = (rows || []).map((row) => ({
    ...row,
    label: String(row.period || '').length === 7
      ? new Date(`${row.period}-02T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
      : row.period,
  }));
  const empty = !data.length;

  return (
    <div className="chart-surface">
      <div className="chart-legend [.dashboard-page_&]:flex [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:gap-[15px] [.dashboard-page_&]:p-[12px_16px_0]">
        <span className="chart-legend-item"><i className="legend-swatch legend-line [.dashboard-page_&.legend-line]:[background:#6687ff]" /> Submitted</span>
        <span className="chart-legend-item"><i className="legend-swatch legend-line [.dashboard-page_&.legend-line]:[background:#32c997]" /> Completed</span>
      </div>
      <ChartFrame height={260} empty={empty}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 9 }} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={14} />
            <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 9 }} axisLine={false} tickLine={false} width={40} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(102, 135, 255, .35)' }} />
            <Line dataKey="submitted" name="Submitted" type="monotone" stroke="#6687ff" strokeWidth={2.2} dot={{ r: 2.4, fill: '#6687ff', strokeWidth: 0 }} />
            <Line dataKey="completed" name="Completed" type="monotone" stroke="#32c997" strokeWidth={2.2} dot={{ r: 2.4, fill: '#32c997', strokeWidth: 0 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="muted-note text-muted text-[8px] leading-[1.6] chart-caption">
        {empty
          ? 'No supply requests in this range — widen the date filter to see the trend.'
          : 'Supply requests submitted versus completed each month.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Supply pipeline stage tracker (stepper + KPI cards + table)          */
/* ------------------------------------------------------------------ */
const TRACKER_CARDS = [
  { key: 'today', label: "Today's requests", Icon: FaClipboardList, tone: 'accent' },
  { key: 'approved', label: 'Approved requests', Icon: FaClipboardCheck, tone: 'success' },
  { key: 'queue', label: 'Queue count', Icon: FaTriangleExclamation, tone: 'danger' },
  { key: 'route_to_branch', label: 'Route to branch', Icon: FaTruckFast, tone: 'info' },
  { key: 'branch_confirmation', label: 'Branch confirmation', Icon: FaCircleCheck, tone: 'confirm' },
];

export function SupplyStageTracker({ data, loading, error }) {
  if (loading) return <LoadingState label="Loading supply pipeline…" />;
  if (error) return <Notice type="error">{error}</Notice>;

  const stages = data?.stages || [];
  const kpis = data?.kpis || {};
  const rows = data?.rows || [];

  return (
    <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] later:[.dashboard-page_&]:border-[color:color-mix(in_srgb,_var(--accent)_24%,_var(--border))] [.dashboard-page_&]:[background:radial-gradient(circle_at_14%_0%,_color-mix(in_srgb,_var(--accent)_9%,_transparent),_transparent_42%),_color-mix(in_srgb,_var(--panel)_96%,_transparent)]">
      <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
        <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
          <h2>Integrated supply pipeline analytics</h2>
          <span>
            Real-time stage tracking · average cycle time {formatNumber(data?.avg_cycle_time, 1)} days
          </span>
        </div>
      </div>

      <div className="[.dashboard-page_&]:grid [.dashboard-page_&]:grid-cols-[repeat(6,_minmax(0,_1fr))] [.dashboard-page_&]:p-[24px_26px_14px] max-[981px]:later:[.dashboard-page_&]:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[981px]:[.dashboard-page_&]:gap-y-[18px] max-[681px]:later-2:[.dashboard-page_&]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[681px]:later:[.dashboard-page_&]:p-[20px_16px_12px]">
        {stages.map((stage, index) => {
          const Icon = STAGE_ICONS[stage.key] || FaClipboardList;
          return (
            <div className="tracker-step [.dashboard-page_&]:relative [.dashboard-page_&]:min-w-0 [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-[9px]" key={stage.key} data-stage={stage.key}>
              <span className="[.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:text-[9.5px] [.dashboard-page_&]:font-[740] [.dashboard-page_&]:text-center [.dashboard-page_&]:whitespace-nowrap">{stage.label}</span>
              <div className="[.dashboard-page_&]:relative [.dashboard-page_&]:w-full [.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-center">
                <span className="[.dashboard-page_&]:[--stage-c:var(--accent)] [.dashboard-page_&]:relative [.dashboard-page_&]:z-1 [.dashboard-page_&]:w-[48px] [.dashboard-page_&]:h-[48px] [.dashboard-page_&]:grid [.dashboard-page_&]:place-items-center [.dashboard-page_&]:[border:1px_solid_color-mix(in_srgb,_var(--stage-c)_55%,_transparent)] [.dashboard-page_&]:rounded-[50%] [.dashboard-page_&]:text-[color:var(--stage-c)] [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--stage-c)_13%,_var(--panel-2))] [.dashboard-page_&]:[box-shadow:0_0_0_7px_color-mix(in_srgb,_var(--stage-c)_8%,_transparent),_0_0_20px_color-mix(in_srgb,_var(--stage-c)_38%,_transparent)] [.dashboard-page_&]:text-[17px] [.dashboard-page_.tracker-step[data-stage='submitted']_&]:[--stage-c:#54a8ff] later:[.dashboard-page_.tracker-step[data-stage='under\_review']_&]:[--stage-c:#6687ff] later-2:[.dashboard-page_.tracker-step[data-stage='waiting\_logistics']_&]:[--stage-c:#8b6dff] later-3:[.dashboard-page_.tracker-step[data-stage='preparing']_&]:[--stage-c:#f4b84a] later-4:[.dashboard-page_.tracker-step[data-stage='dispatched']_&]:[--stage-c:#9db2ff] later-5:[.dashboard-page_.tracker-step[data-stage='delivered']_&]:[--stage-c:#32c997]"><Icon aria-hidden="true" /></span>
                {index < stages.length - 1 && <span className="[.dashboard-page_&]:absolute [.dashboard-page_&]:left-[50%] [.dashboard-page_&]:-right-[50%] [.dashboard-page_&]:top-[50%] [.dashboard-page_&]:h-[2px] [.dashboard-page_&]:[transform:translateY(-50%)] [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:[background:linear-gradient(_90deg,_color-mix(in_srgb,_var(--accent)_75%,_transparent),_color-mix(in_srgb,_var(--accent-2)_55%,_transparent)_)] max-[981px]:[.dashboard-page_&]:hidden" aria-hidden="true" />}
              </div>
              <span className="[.dashboard-page_&]:min-w-[36px] [.dashboard-page_&]:p-[3px_9px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[999px] [.dashboard-page_&]:text-text-secondary [.dashboard-page_&]:[background:var(--surface-subtle)] [.dashboard-page_&]:text-[8.5px] [.dashboard-page_&]:font-[780] [.dashboard-page_&]:text-center">{formatNumber(stage.count)}</span>
            </div>
          );
        })}
      </div>

      <div className="[.dashboard-page_&]:grid [.dashboard-page_&]:grid-cols-[repeat(5,_minmax(0,_1fr))] [.dashboard-page_&]:gap-3 [.dashboard-page_&]:p-[12px_18px_8px] max-[981px]:later:[.dashboard-page_&]:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-2:[.dashboard-page_&]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[681px]:later:[.dashboard-page_&]:p-[10px_14px_6px] max-[481px]:later-3:[.dashboard-page_&]:grid-cols-[1fr]">
        {TRACKER_CARDS.map((card) => {
          const payload = kpis[card.key] || {};
          const critical = Number(payload.critical || 0);
          const showCritical = card.key === 'queue';
          return (
            <article
              className={`[.dashboard-page_&]:min-w-0 [.dashboard-page_&]:flex [.dashboard-page_&]:flex-col [.dashboard-page_&]:gap-2 [.dashboard-page_&]:p-[15px] [.dashboard-page_&]:border [.dashboard-page_&]:border-line [.dashboard-page_&]:rounded-[15px] [.dashboard-page_&]:[background:linear-gradient(_160deg,_color-mix(in_srgb,_var(--panel-2)_94%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent)_)] [.dashboard-page_&]:[box-shadow:var(--shadow-sm)] [.dashboard-page_&]:[transition:transform_0.2s_ease,_border-color_0.2s_ease,_box-shadow_0.2s_ease] [.dashboard-page_&:hover]:[transform:translateY(-2px)] [.dashboard-page_&:hover]:border-line-strong [.dashboard-page_&:hover]:[box-shadow:var(--shadow-md)] later-2:[.dashboard-page_&_strong]:text-text later-5:[.dashboard-page_&_strong]:text-[clamp(23px,_2.2vw,_28px)] later-3:[.dashboard-page_&_strong]:tracking-[-0.045em] later:[.dashboard-page_&_strong]:leading-[1] [.dashboard-page_&_small]:min-h-[12px] [.dashboard-page_&_small]:text-muted [.dashboard-page_&_small]:text-[8px] later:[.dashboard-page_&.has-critical]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_var(--border))] later:[.dashboard-page_&.has-critical]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--danger)_10%,_transparent),_var(--shadow-sm)] [.dashboard-page_&.has-critical_strong]:text-danger-text later:[.dashboard-page_&.has-critical_small]:text-danger-text tracker-tone-${card.tone}${showCritical && critical > 0 ? ' has-critical' : ''}`}
              key={card.key}
            >
              <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-between [.dashboard-page_&]:gap-2 [.dashboard-page_&>span:first-child]:text-muted later:[.dashboard-page_&>span:first-child]:text-[8.5px] [.dashboard-page_&>span:first-child]:font-[760] [.dashboard-page_&>span:first-child]:tracking-[0.05em] [.dashboard-page_&>span:first-child]:uppercase">
                <span>{card.label}</span>
                <span className="[.dashboard-page_&]:w-[30px] [.dashboard-page_&]:h-[30px] [.dashboard-page_&]:grid [.dashboard-page_&]:place-items-center [.dashboard-page_&]:flex-[0_0_auto] [.dashboard-page_&]:rounded-[10px] [.dashboard-page_&]:text-accent-text [.dashboard-page_&]:[background:color-mix(in_srgb,_var(--accent)_11%,_transparent)] [.dashboard-page_&]:text-[13px] [.dashboard-page_.tracker-tone-success_&]:text-success-text [.dashboard-page_.tracker-tone-success_&]:[background:color-mix(in_srgb,_var(--success)_11%,_transparent)] later:[.dashboard-page_.tracker-tone-danger_&]:text-danger-text later:[.dashboard-page_.tracker-tone-danger_&]:[background:color-mix(in_srgb,_var(--danger)_11%,_transparent)] later-2:[.dashboard-page_.tracker-tone-info_&]:text-[color:var(--info)] later-2:[.dashboard-page_.tracker-tone-info_&]:[background:color-mix(in_srgb,_var(--info)_12%,_transparent)] later-2:[.dashboard-page_.tracker-tone-confirm_&]:text-[color:var(--info)] later-2:[.dashboard-page_.tracker-tone-confirm_&]:[background:color-mix(in_srgb,_var(--info)_12%,_transparent)]"><card.Icon aria-hidden="true" /></span>
              </div>
              <strong>{formatNumber(payload.value)}</strong>
              <small>
                {showCritical
                  ? (critical > 0 ? `Critical: ${critical}` : 'Nothing overdue')
                  : (payload.meta || '')}
              </small>
            </article>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState label="No supply requests yet." detail="The tracker fills in as soon as a branch submits a request." />
      ) : (
        <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer [.dashboard-page_&]:pt-[6px]">
          <table>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Branch</th>
                <th>Product category</th>
                <th>Stage</th>
                <th>Queue days</th>
                <th>Last update</th>
                <th>Avg cycle time (days)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.id}</strong></td>
                  <td>{row.branch}</td>
                  <td>{row.category}</td>
                  <td><StatusBadge value={row.stage} /></td>
                  <td>{formatNumber(row.queue_days, 1)}</td>
                  <td>{row.last_update}</td>
                  <td>{formatNumber(row.cycle_days, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
