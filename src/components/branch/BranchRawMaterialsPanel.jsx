import { useCallback, useEffect, useMemo, useState } from 'react';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, Field, LoadingState, Modal, Notice, Pagination } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import useCosting from '../../lib/useCosting';
import {
  lastCountLabel, sortWorstFirst, STOCK_STATUS_LABELS, STOCK_TEXT_CLASS, stockStatusOf, toMilli, varianceText,
} from '../../lib/stockView';

const money = (value) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
const newKey = () => globalThis.crypto?.randomUUID?.() || `mat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const qty = (value, unit) => `${formatNumber(Number(value || 0), 3)} ${unit || ''}`.trim();
const MATERIALS_PER_PAGE = 7;
const COUNT_PER_PAGE = 7;

const GHOST = 'ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]';
const PRIMARY = 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] disabled:opacity-50 disabled:cursor-not-allowed';
const CARD = 'metric-card relative min-h-[64px] flex items-center justify-between gap-3 overflow-hidden p-[10px_16px] border border-line rounded-[10px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [&>span]:text-muted [&>span]:text-[12.5px] [&>span]:font-[650] [&>span]:leading-[1.3] [&_strong]:block [&_strong]:flex-none [&_strong]:text-[clamp(20px,_2.1vw,_26px)] [&_strong]:leading-none [&_strong]:tracking-[-.03em] [&_strong]:text-right';
const PANEL = 'data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)]';
const HEADING = 'branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]';

/** Branch Inventory: raw materials with status against the levels Logistics set, receipts and physical counts. */
export default function BranchRawMaterialsPanel({ branchQuery = {}, preview = false }) {
  const costing = useCosting();
  const [materials, setMaterials] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [sortStatus, setSortStatus] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [materialRows, unitRows] = await Promise.all([
        api.get('/branch/workspace/materials', branchQuery),
        api.get('/units'),
      ]);
      setMaterials(materialRows.data || []);
      setUnits(unitRows.data || []);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = preview;
  const sorted = useMemo(() => sortWorstFirst(materials.filter((m) => m.is_active !== false)), [materials]);
  const tally = (...statuses) => sorted.filter((m) => statuses.includes(m.status)).length;
  const lastCount = sorted.map((m) => m.last_counted_at).filter(Boolean).sort().pop() || null;
  // Client-side pagination of the inventory table; the shared Pagination reads this meta shape.
  // The status sort only moves the chosen status to the top; the rest keep the worst-first order.
  const ordered = useMemo(() => (sortStatus
    ? [...sorted].sort((a, b) => (a.status === sortStatus ? 0 : 1) - (b.status === sortStatus ? 0 : 1))
    : sorted), [sorted, sortStatus]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return ordered;
    return ordered.filter((m) => [m.name, m.variant, m.source].some((value) => String(value || '').toLowerCase().includes(term)));
  }, [ordered, query]);
  const lastPage = Math.max(1, Math.ceil(filtered.length / MATERIALS_PER_PAGE));
  const currentPage = Math.min(page, lastPage);
  const pageRows = filtered.slice((currentPage - 1) * MATERIALS_PER_PAGE, currentPage * MATERIALS_PER_PAGE);
  const pageMeta = { current_page: currentPage, last_page: lastPage, per_page: MATERIALS_PER_PAGE, total: filtered.length };
  const open = (setter) => () => { setNotice(''); setter(true); };

  return (
    <div className="branch-raw-materials">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      {sorted.length > 0 && (
        <section className="grid grid-cols-[repeat(auto-fit,_minmax(170px,_1fr))] gap-3 mb-4" aria-label="Raw materials status">
          <article className={`${CARD} ${tally('critical', 'out') ? 'border-[color:color-mix(in_srgb,var(--danger-text)_45%,var(--border))]' : ''}`} title="Request supply now">
            <span>Critical / no stock</span><strong className={tally('critical', 'out') ? 'text-danger-text' : 'text-text'}>{tally('critical', 'out')}</strong>
          </article>
          <article className={`${CARD} ${tally('low') ? 'border-[color:color-mix(in_srgb,var(--warning-text)_45%,var(--border))]' : ''}`} title="Plan your next request">
            <span>Low stock</span><strong className={tally('low') ? 'text-[color:var(--warning-text)]' : 'text-text'}>{tally('low')}</strong>
          </article>
          <article className={CARD} title="Above the low level"><span>Normal</span><strong className="text-success-text">{tally('ok')}</strong></article>
          <article className={CARD} title="Count milk, cups and lids daily"><span>Last physical count</span><strong className="text-text">{lastCountLabel(lastCount).replace(/^Today, .*/, 'Today')}</strong></article>
        </section>
      )}

      {countOpen && !readOnly && (
        <PhysicalCountSheet
          materials={sorted}
          onClose={() => setCountOpen(false)}
          onSaved={async (message) => {
            setCountOpen(false);
            setNotice(message);
            await load(true);
          }}
        />
      )}

      <section className={`${PANEL} p-[18px]`}>
        <div className={HEADING}>
          <div>
            <h2>Raw materials</h2>
            <p>{costing ? 'Branch stock of ingredients and packaging, valued at weighted-average cost.' : 'Branch stock of ingredients and packaging.'} Levels are set by Logistics.</p>
          </div>
          {!readOnly && (
            <div className="flex flex-wrap gap-2 justify-end items-center">
              <label className="flex items-center gap-2 w-[200px] max-w-full px-3 py-2 border rounded-[8px] [border-color:var(--branch-accent)] [background:var(--input-bg)] text-muted focus-within:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)]">
                <FaMagnifyingGlass aria-hidden="true" className="flex-none text-[12px]" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                  placeholder="Search materials…"
                  aria-label="Search raw materials"
                  className="w-full min-w-0 bg-transparent border-0 outline-none text-text text-[12px] placeholder:text-placeholder"
                />
              </label>
              <select
                value={sortStatus}
                onChange={(event) => { setSortStatus(event.target.value); setPage(1); }}
                aria-label="Sort by status"
                className="min-h-[38px] px-3 py-2 border rounded-[8px] [border-color:var(--branch-accent)] [background:var(--input-bg)] text-text text-[12px] font-[600] cursor-pointer focus:[outline:0] [&>option]:[background:var(--panel)] [&>option]:text-text"
              >
                <option value="">Status</option>
                <option value="ok">Normal</option>
                <option value="low">Low stock</option>
                <option value="critical">Critical</option>
                <option value="out">No stock</option>
              </select>
              <button type="button" className={GHOST} onClick={open(setReceiveOpen)}>Receive Stock</button>
              <button type="button" className={GHOST} onClick={open(setAddOpen)}>Add Material</button>
              <button type="button" className={PRIMARY} disabled={!sorted.length || countOpen} onClick={open(setCountOpen)}>Physical count</button>
            </div>
          )}
        </div>

        {loading && !materials.length ? <LoadingState label="Loading raw materials…" /> : materials.length === 0 ? (
          <EmptyState label="No raw materials yet." detail="Add a material or receive a delivered supply request." />
        ) : (
          <div className="table-wrap overflow-x-auto [&_table]:text-[15px] [&_th]:text-[13px] [&_th]:font-[800] [&_td]:font-[600] [&_td_strong]:text-[16px] [&_td_strong]:font-[800] [&_td_small]:text-[13px] [&_td_small]:font-[600]">
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Source</th>
                  <th>On hand</th>
                  <th>Low / Critical</th>
                  <th>Status</th>
                  <th>Last count</th>
                  {costing && <th>Unit cost</th>}
                  {costing && <th>Stock value</th>}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((material) => {
                  const balance = material.balance || {};
                  const unitCost = balance.unit_cost_micropesos == null ? null : Number(balance.unit_cost_micropesos) / 1_000_000;
                  return (
                    <tr key={material.id}>
                      <td><strong>{material.name}</strong>{material.variant ? <small>{material.variant}</small> : null}</td>
                      <td><span className="inline-flex p-[3px_8px] rounded-[999px] text-text-secondary [background:var(--surface-subtle)] border border-line text-[10px] font-[750]">{material.source || 'Manual'}</span></td>
                      <td><strong>{qty(material.on_hand ?? Number(balance.quantity_milli || 0) / 1000, material.unit)}</strong></td>
                      <td>
                        {formatNumber(material.low_level, 3)} / {formatNumber(material.critical_level, 3)} {material.unit}
                        {material.levels_source === 'default' && <small className="block text-muted">Default levels</small>}
                      </td>
                      <td><b className={`${STOCK_TEXT_CLASS} is-${material.status}`}>{material.status_label || STOCK_STATUS_LABELS[material.status] || '—'}</b></td>
                      <td className={material.last_counted_at ? '' : 'text-muted'}>{lastCountLabel(material.last_counted_at)}</td>
                      {costing && <td>{unitCost == null ? '—' : money(unitCost)}</td>}
                      {costing && <td>{balance.value_cents == null ? '—' : money(Number(balance.value_cents) / 100)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {materials.length > 0 && <div className="[&_nav]:text-[15px] [&_nav]:font-[700] [&_nav_span]:text-[15px] [&_nav_span]:font-[700] [&_nav_button]:text-[15px] [&_nav_button]:font-[800] [&_nav_button]:min-h-[40px] [&_nav_button]:px-[16px]"><Pagination meta={pageMeta} onPage={setPage} /></div>}
      </section>

      {addOpen && (
        <AddMaterialModal
          branchQuery={branchQuery}
          units={units}
          onClose={() => setAddOpen(false)}
          onSaved={async (name) => {
            setAddOpen(false);
            setNotice(`${name} was added to branch raw materials.`);
            await load(true);
          }}
        />
      )}

      {receiveOpen && (
        <ReceiveStockModal
          branchQuery={branchQuery}
          materials={materials}
          onClose={() => setReceiveOpen(false)}
          onSaved={async (message) => {
            setReceiveOpen(false);
            setNotice(message);
            await load(true);
          }}
        />
      )}

    </div>
  );
}

const COUNT_REASONS = [
  ['spoiled', 'Spoiled or expired'], ['damaged', 'Damaged'], ['spilled', 'Spilled or wasted'],
  ['unrecorded_use', 'Used but not recorded'], ['encoding_error', 'Encoding error'], ['other', 'Other'],
];
const INPUT = 'min-h-[38px] w-full max-w-[150px] p-[6px_10px] border border-input-line rounded-[10px] text-text [background-color:var(--input-bg)] text-[13px] focus:[outline:0] focus:border-accent';

/**
 * The count sheet: one row per active material. Blank rows are skipped (a partial daily count is
 * fine); a row equal to the system is saved as a count with no adjustment. A reason is required
 * when the count differs, and a note for "Other". Everything is saved in one request.
 */
function PhysicalCountSheet({ materials, onClose, onSaved }) {
  const [rows, setRows] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const [page, setPage] = useState(1);
  const update = (id, patch) => setRows((current) => ({ ...current, [id]: { ...(current[id] || {}), ...patch } }));

  const lines = materials.map((m) => {
    const row = rows[m.id] || {};
    const raw = String(row.actual ?? '').trim();
    const filled = raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0;
    const invalid = raw !== '' && !filled;
    const differs = filled && toMilli(raw) !== toMilli(m.on_hand);
    const needsNote = differs && row.reason === 'other' && String(row.note || '').trim().length < 3;
    const missingReason = differs && (!row.reason || needsNote);
    const after = filled ? stockStatusOf(Number(raw), m.low_level, m.critical_level) : null;
    return { m, row, raw, filled, invalid, differs, missingReason, needsNote, after };
  });
  const counted = lines.filter((l) => l.filled).length;
  const missing = lines.filter((l) => l.missingReason).length;
  const invalid = lines.some((l) => l.invalid);
  const ready = counted > 0 && missing === 0 && !invalid && !saving;
  // 7 rows per page; the save still sends every filled row, on any page.
  const lastPage = Math.max(1, Math.ceil(lines.length / COUNT_PER_PAGE));
  const currentPage = Math.min(page, lastPage);
  const pageLines = lines.slice((currentPage - 1) * COUNT_PER_PAGE, currentPage * COUNT_PER_PAGE);
  const pageMeta = { current_page: currentPage, last_page: lastPage, per_page: COUNT_PER_PAGE, total: lines.length };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const items = lines.filter((l) => l.filled).map((l) => ({
        material_id: l.m.id, counted_quantity_milli: toMilli(l.raw),
        ...(l.differs ? { reason_code: l.row.reason, ...(l.row.reason === 'other' ? { note: String(l.row.note || '').trim() } : {}) } : {}),
      }));
      const response = await api.post('/branch/workspace/physical-count', { idempotency_key: key, items });
      await onSaved(response.message || `${response.data?.counted} counted, ${response.data?.adjusted} adjusted.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${PANEL} p-[18px]`} aria-labelledby="physical-count-title">
      <div className={HEADING}>
        <div>
          <h2 id="physical-count-title">Physical count</h2>
          <p>Enter what you actually counted. Leave a row blank to skip it. A reason is required when the count differs from the system.</p>
        </div>
        <button type="button" className={GHOST} aria-label="Close the physical count" onClick={onClose} disabled={saving}>×</button>
      </div>
      <Notice type="error">{error}</Notice>
      <div className="table-wrap overflow-x-auto [&_table]:text-[15px] [&_th]:text-[13px] [&_th]:font-[800] [&_td]:font-[600] [&_td_strong]:text-[16px] [&_td_strong]:font-[800] [&_td_small]:text-[13px] [&_td_small]:font-[600] [&_input]:text-[14px]">
        <table>
          <thead>
            <tr><th>Material</th><th>System</th><th>Actual count</th><th>Variance</th><th>Reason</th><th>Status after</th></tr>
          </thead>
          <tbody>
            {pageLines.map(({ m, row, filled, invalid: bad, differs, missingReason, needsNote, after }) => {
              const variance = varianceText(row.actual ?? '', m.on_hand, m.unit);
              return (
                <tr key={m.id} className={filled ? '[background:var(--surface-subtle)]' : ''}>
                  <td><strong>{m.name}</strong>{m.variant ? <small>{m.variant}</small> : null}</td>
                  <td>{qty(m.on_hand, m.unit)}</td>
                  <td>
                    <span className="inline-flex items-center gap-2">
                      <input
                        className={INPUT}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="—"
                        aria-label={`Actual count of ${m.name} in ${m.unit}`}
                        aria-invalid={bad}
                        value={row.actual ?? ''}
                        onChange={(e) => update(m.id, { actual: e.target.value })}
                      />
                      <small className="text-muted">{m.unit}</small>
                    </span>
                    {bad && <small className="block text-danger-text">Enter 0 or more.</small>}
                  </td>
                  <td className={variance.tone === 'down' ? 'text-danger-text font-[650]' : variance.tone === 'up' ? 'text-success-text font-[650]' : 'text-muted'}>{variance.text}</td>
                  <td>
                    {differs ? (
                      <div className="grid gap-1 min-w-[180px]">
                        <select className={INPUT.replace('max-w-[150px]', 'max-w-[220px]')} aria-label={`Reason for ${m.name}`} aria-invalid={missingReason && !row.reason} value={row.reason || ''} onChange={(e) => update(m.id, { reason: e.target.value })}>
                          <option value="">Choose a reason</option>
                          {COUNT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        {row.reason === 'other' && (
                          <input className={INPUT.replace('max-w-[150px]', 'max-w-[220px]')} placeholder="Short note" aria-label={`Note for ${m.name}`} value={row.note || ''} onChange={(e) => update(m.id, { note: e.target.value })} />
                        )}
                        {missingReason && <small className="text-danger-text">{needsNote ? 'Add a short note' : 'Required'}</small>}
                      </div>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    {after ? (
                      <>
                        <b className={`${STOCK_TEXT_CLASS} is-${after}`}>{STOCK_STATUS_LABELS[after]}</b>
                        {after !== m.status && <small className="block text-muted">(was {STOCK_STATUS_LABELS[m.status] || m.status})</small>}
                      </>
                    ) : <span className="text-muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {lines.length > COUNT_PER_PAGE && (
        <div className="[&_nav]:text-[15px] [&_nav]:font-[700] [&_nav_span]:text-[15px] [&_nav_span]:font-[700] [&_nav_button]:text-[15px] [&_nav_button]:font-[800] [&_nav_button]:min-h-[40px] [&_nav_button]:px-[16px]">
          <Pagination meta={pageMeta} onPage={setPage} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
        <small className="text-muted" aria-live="polite">{counted} of {materials.length} counted · {missing} reason{missing === 1 ? '' : 's'} missing</small>
        <span className="flex gap-2">
          <button type="button" className={GHOST} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={!ready} onClick={() => void save()}>{saving ? 'Saving…' : 'Save count'}</button>
        </span>
      </div>
    </section>
  );
}

function AddMaterialModal({ branchQuery, units, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', variant: '', unit: '' });
  const [unitList, setUnitList] = useState(units);
  const [newUnit, setNewUnit] = useState('');
  const [showNewUnit, setShowNewUnit] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const addUnit = async () => {
    setError('');
    try {
      const response = await api.post('/units', { name: newUnit });
      setUnitList((rows) => [...rows, response.data]);
      setForm((current) => ({ ...current, unit: response.data.name }));
      setNewUnit('');
      setShowNewUnit(false);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/profittrack/materials', {
        name: form.name.trim(),
        variant: form.variant.trim(),
        unit: form.unit,
      }, { query: branchQuery });
      await onSaved(form.name.trim());
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add material"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" form="add-material-form" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>
            {saving ? 'Saving…' : 'Add material'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="add-material-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        <Field label="Material name" required>
          <input required maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Caramel Syrup" />
        </Field>
        <Field label="Variant">
          <input maxLength={100} value={form.variant} onChange={(event) => setForm({ ...form, variant: event.target.value })} placeholder="e.g. Original" />
        </Field>
        <Field label="Unit" required>
          <select required value={form.unit} onChange={(event) => {
            if (event.target.value === '__add') { setShowNewUnit(true); return; }
            setForm({ ...form, unit: event.target.value });
          }}>
            <option value="">Select a unit</option>
            {unitList.map((unit) => <option key={unit.id || unit.name} value={unit.name}>{unit.name}</option>)}
            <option value="__add">+ Add Unit</option>
          </select>
        </Field>
        {showNewUnit && (
          <Field label="New unit" hint="Letters only, unique." full>
            <div className="flex gap-2 items-center [&_input]:flex-[1_1_auto] [&_input]:min-w-0">
              <input maxLength={20} value={newUnit} onChange={(event) => setNewUnit(event.target.value)} placeholder="e.g. bottle" />
              <button type="button" onClick={() => void addUnit()} disabled={!newUnit.trim()}>Save unit</button>
            </div>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function ReceiveStockModal({ branchQuery, materials, onClose, onSaved }) {
  const costing = useCosting();
  const [mode, setMode] = useState('request');
  const [requests, setRequests] = useState([]);
  const [requestId, setRequestId] = useState('');
  const [lines, setLines] = useState({});
  const [totalCost, setTotalCost] = useState('');
  const [form, setForm] = useState({ material_id: '', quantity: '', total_cost: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'request') return;
    let active = true;
    setLoading(true);
    api.get('/branch/workspace/receivable-requests', branchQuery)
      .then((response) => { if (active) setRequests(response.data || []); })
      .catch((caught) => { if (active) setError(firstValidationMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, branchQuery]);

  // With costing: deliveries whose receipt cost is still missing (their quantities are
  // already on hand). Without costing: only deliveries not yet added to Branch Inventory.
  const openRequests = requests.filter((request) => (costing ? !request.cost_recorded : !request.received_at));
  const selectedRequest = openRequests.find((request) => String(request.id) === String(requestId));

  useEffect(() => {
    if (!selectedRequest) { setLines({}); return; }
    setLines(Object.fromEntries((selectedRequest.items || []).map((item) => [item.product_id, String(Number(item.quantity_requested))])));
  }, [selectedRequest]);

  const selectedMaterial = materials.find((material) => String(material.id) === String(form.material_id));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (mode === 'manual') {
        await api.post('/profittrack/materials/receive', {
          material_id: Number(form.material_id),
          quantity_milli: Math.round(Number(form.quantity) * 1000),
          ...(costing ? { total_cost_cents: Math.round(Number(form.total_cost || 0) * 100) } : {}),
          idempotency_key: newKey(),
        }, { query: branchQuery });
        await onSaved('Stock received into branch raw materials.');
        return;
      }
      if (!selectedRequest) {
        setError('Choose a delivered supply request.');
        return;
      }
      const response = await api.post('/branch/workspace/receive-stock', {
        supply_request_id: Number(selectedRequest.id),
        ...(costing ? { total_cost_cents: Math.round(Number(totalCost || 0) * 100) } : {}),
        lines: (selectedRequest.items || [])
          .filter((item) => Number(lines[item.product_id]) > 0)
          .map((item) => ({ product_id: Number(item.product_id), quantity: Number(lines[item.product_id]) })),
      });
      await onSaved(response.message || 'Receipt saved.');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Receive stock"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" form="receive-stock-form" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>
            {saving ? 'Saving…' : 'Receive stock'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <div className="flex flex-wrap gap-[6px] mb-[14px]" style={{ marginTop: 0 }}>
        <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${mode === 'request' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMode('request')}>From supply request</button>
        <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${mode === 'manual' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMode('manual')}>Manual</button>
      </div>

      <form id="receive-stock-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        {mode === 'manual' ? (
          <>
            <Field label="Material" required full>
              <select required value={form.material_id} onChange={(event) => setForm({ ...form, material_id: event.target.value })}>
                <option value="">Select a material</option>
                {materials.map((material) => (
                  <option key={material.id} value={material.id}>{material.name}{material.variant ? ` · ${material.variant}` : ''} ({material.unit})</option>
                ))}
              </select>
            </Field>
            <Field label={`Quantity${selectedMaterial ? ` (${selectedMaterial.unit})` : ''}`} required>
              <input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
            </Field>
            {costing && (
              <Field label="Total receipt cost (PHP)" required>
                <input required type="number" min="0" step="0.01" value={form.total_cost} onChange={(event) => setForm({ ...form, total_cost: event.target.value })} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Delivered supply request" required full>
              <select required value={requestId} onChange={(event) => setRequestId(event.target.value)} disabled={loading}>
                <option value="">{loading ? 'Loading delivered requests…' : 'Select a delivered request'}</option>
                {openRequests.map((request) => (
                  <option key={request.id} value={request.id}>{request.request_number} · {formatDate(request.created_at)}{costing && request.received_at ? ' · cost missing' : ''}</option>
                ))}
              </select>
            </Field>
            {openRequests.length === 0 && !loading && (
              <p className="muted-note text-muted text-[8px] leading-[1.6]">{costing ? 'Every delivered request already has its stock and receipt cost.' : 'Every delivered request is already in Branch Inventory.'} Deliveries are added to Branch Inventory automatically when Logistics marks them Delivered.</p>
            )}
            {selectedRequest && (
              <p className="muted-note text-muted text-[8px] leading-[1.6]">
                {selectedRequest.received_at
                  ? 'The quantities below are already on hand. Enter the total receipt cost to set their value.'
                  : 'These delivered quantities will be added to Branch Inventory once you confirm.'}
              </p>
            )}
            {selectedRequest && (
              <div className="grid gap-[10px] mt-1 [&_table]:min-w-0 [&_input]:min-h-[34px] [&_input]:w-[110px] [&_input]:p-[4px_8px]" style={{ gridColumn: '1 / -1' }}>
                <table>
                  <thead><tr><th>Item</th><th>Delivered</th><th>Received quantity</th></tr></thead>
                  <tbody>
                    {(selectedRequest.items || []).map((item) => (
                      <tr key={item.id}>
                        <td>{item.product?.name || item.product_name_snapshot || 'Item'}<small>{item.product?.unit || item.unit_snapshot || ''}</small></td>
                        <td>{formatNumber(item.quantity_requested)}</td>
                        <td>
                          {selectedRequest.received_at ? (
                            <span>{formatNumber(lines[item.product_id] ?? item.quantity_requested)} · on hand</span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={lines[item.product_id] ?? ''}
                              onChange={(event) => setLines((current) => ({ ...current, [item.product_id]: event.target.value }))}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {costing && (
                  <Field label="Total receipt cost (PHP)" required>
                    <input required type="number" min="0" step="0.01" value={totalCost} onChange={(event) => setTotalCost(event.target.value)} />
                  </Field>
                )}
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}
