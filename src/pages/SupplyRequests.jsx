// Supply Requests: the one place where Admin and Logistics see and work every request.
// KPI cards and tabs come with counts from the API (GET /supply-requests meta), the toolbar filters
// and sorts on the server, a row opens the drawer, and each action opens its own modal.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FaGear, FaPlus, FaXmark } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, formatNumber } from '../lib/format';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, Pagination } from '../components/ApiUi';
import { rowActionLabel } from '../lib/supplyActions';
import { supplyStatusLabel } from '../lib/supplyStatus';
import SupplyDrawer from '../components/supply/SupplyDrawer';
import MarkDispatchedModal from '../components/supply/MarkDispatchedModal';
import MarkDeliveredModal from '../components/supply/MarkDeliveredModal';
import DateRevisionModal from '../components/supply/DateRevisionModal';
import EstimateHint from '../components/supply/EstimateHint';
import {
  FulfillmentModal, ReasonModal, RequestDateModal, ResolveDiscrepancyModal, RestockDateModal, ShortageModal, SupplySettingsModal,
} from '../components/supply/SupplyModals';
import { Chip, StatusChip, Stepper, UrgencyChip } from '../components/supply/supplyUi';
import { BTN_GHOST, BTN_PRIMARY, BTN_SMALL, TOOL, PANEL, branchLabel, waitingText } from '../components/supply/supplyStyles';
import { useAuth } from '../context/AuthContext';

const TABS = [
  ['needs_action', 'Needs my action'], ['all', 'All'], ['under_review', 'Under review'], ['on_hold', 'On hold'],
  ['scheduled_preparing', 'Scheduled / Preparing'], ['dispatched', 'Dispatched'], ['discrepancy', 'Discrepancy'],
  ['completed', 'Completed'], ['closed', 'Closed'],
];
const SORTS = [['priority', 'Priority'], ['newest', 'Date requested: newest'], ['oldest', 'Date requested: oldest'], ['target', 'Target delivery date'], ['branch', 'Branch A–Z'], ['brand', 'Brand']];
const KPIS = [
  ['needs_action', 'Needs my action', (role) => `Waiting for ${role === 'logistics' ? 'Logistics' : 'Admin'}`, { tab: 'needs_action' }],
  ['overdue', 'Overdue', () => 'Past a working-day deadline', { tab: 'all', overdue: '1' }],
  ['on_hold', 'On hold', () => 'Waiting for restock', { tab: 'on_hold' }],
  ['in_transit', 'In transit', () => 'Dispatched or delivered', { tab: 'dispatched' }],
  ['discrepancies', 'Discrepancies', () => 'For Admin review', { tab: 'discrepancy' }],
];
const METRIC = "relative min-h-[118px] flex flex-col justify-between overflow-hidden p-[16px] border border-line rounded-[18px] text-left cursor-pointer [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease] hover:[transform:translateY(-2px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_30%,_var(--border))] focus-visible:[outline:2px_solid_var(--accent)] [&_small]:text-muted [&_small]:text-[11px] [&_small]:font-[650] [&_strong]:block [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_30px)] [&_strong]:leading-[1.05] [&_strong]:tracking-[-.04em]";
const EMPTY_FILTERS = { search: '', brand_id: '', urgency: '', from: '', to: '', sort: 'priority' };
/** What an empty tab means, in words. */
const EMPTY = {
  needs_action: ['Nothing is waiting for you.', 'New requests and steps for your role appear here.'],
  all: ['No supply requests yet.', 'Branches create requests in their portal.'],
  under_review: ['Nothing to review.', 'Submitted and returned requests appear here.'],
  on_hold: ['Nothing is on hold.', 'Requests held for a restock appear here.'],
  scheduled_preparing: ['Nothing to schedule or prepare.', 'Endorsed requests appear here.'],
  dispatched: ['Nothing is on the road.', 'Dispatched and delivered requests appear here until the branch confirms.'],
  discrepancy: ['No discrepancies.', 'Receipts with damaged or short items appear here.'],
  completed: ['Nothing completed yet.', 'Finished requests appear here.'],
  closed: ['Nothing rejected or cancelled.', 'Closed requests appear here.'],
  overdue: ['Nothing is overdue.', 'Every request is within its working-day deadline.'],
};

function itemsSummary(request) {
  const names = (request.items || []).map((i) => i.product?.name || i.product_name_snapshot || 'Item');
  return { count: names.length, first: names.slice(0, 2).join(', ') + (names.length > 2 ? '…' : '') };
}

function TargetCell({ request }) {
  const date = request.effective_delivery_date || request.target_delivery_date;
  return (
    <>
      <strong className="block text-text text-[13.5px] font-[650]">{date ? formatDate(date) : '—'}</strong>
      {request.overdue && <span className="block mt-[3px] text-danger-text text-[11px] font-[800] tracking-[.04em]" title={request.overdue_reason}>● OVERDUE</span>}
    </>
  );
}

function ProgressCell({ request }) {
  return (
    <>
      <Stepper status={request.status} />
      <div className="mt-[5px] flex flex-wrap items-center gap-[6px]">
        {request.status === 'returned' ? <StatusChip status="returned" /> : <span className="text-text text-[13px] font-[650]">{supplyStatusLabel(request.status)}</span>}
        {request.pending_date_change && <Chip tone="warning">New date requested</Chip>}
        {request.pending_shortage && <Chip tone="danger">Shortage reported</Chip>}
      </div>
      <div className="text-muted text-[11.5px]">{waitingText(request.owners)}</div>
    </>
  );
}

/** Admin creates a request for a branch (the branch normally does this in its portal). */
function CreateRequestModal({ onClose, onCreated }) {
  const [lookups, setLookups] = useState({ locations: [], products: [], settings: null });
  const [form, setForm] = useState({ location_id: '', urgency: 'normal', urgency_reason: '', target_delivery_date: '', delivery_address: '', contact_number: '', bulk_reason: '', remarks: '' });
  const [items, setItems] = useState([{ product_id: '', quantity_requested: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  useEffect(() => {
    Promise.all([api.get('/locations'), api.get('/products', { per_page: 100 }), api.get('/supply-settings')])
      .then(([l, p, s]) => setLookups({ locations: (l.data || []).filter((x) => x.type === 'franchise' && x.is_active), products: p.data || [], settings: s.data }))
      .catch((e) => setError(firstValidationMessage(e)));
  }, []);
  const location = lookups.locations.find((l) => String(l.id) === String(form.location_id));
  const products = lookups.products.filter((p) => !location || Number(p.brand_id) === Number(location.brand_id));
  const urgent = form.urgency !== 'normal';
  const earliest = lookups.settings ? (urgent ? lookups.settings.earliest_urgent : lookups.settings.earliest_normal) : null;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await api.post('/supply-requests', {
        ...form, location_id: Number(form.location_id), target_delivery_date: form.target_delivery_date || null,
        urgency_reason: urgent ? form.urgency_reason : null, bulk_reason: form.bulk_reason || null, submit: true,
        items: items.filter((i) => i.product_id).map((i) => ({ product_id: Number(i.product_id), quantity_requested: Number(i.quantity_requested) })),
      });
      setWarnings(res.data.warnings || []);
      onCreated(res.data);
    } catch (e) {
      setError(firstValidationMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const weekend = form.target_delivery_date && [0, 6].includes(new Date(`${form.target_delivery_date}T00:00:00Z`).getUTCDay());
  return (
    <Modal title="Create supply request" size="wide" onClose={onClose} footer={<><button type="button" className={BTN_GHOST} onClick={onClose}>Cancel</button><button type="submit" form="supply-create" className={BTN_PRIMARY} disabled={saving}>{saving ? 'Submitting…' : 'Submit request'}</button></>}>
      <Notice type="error">{error}</Notice>
      {warnings.map((w) => <Notice key={w} type="info">{w}</Notice>)}
      <form id="supply-create" onSubmit={submit} className="form-grid grid grid-cols-2 gap-[14px] max-[681px]:grid-cols-1">
        <Field label="Branch" required>
          <select required value={form.location_id} onChange={(e) => { const l = lookups.locations.find((x) => String(x.id) === e.target.value); setForm((f) => ({ ...f, location_id: e.target.value, delivery_address: l?.address || '', contact_number: l?.contact_number || '' })); setItems([{ product_id: '', quantity_requested: '' }]); }}>
            <option value="">Select branch</option>
            {lookups.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Urgency" required>
          <select value={form.urgency} onChange={(e) => set('urgency', e.target.value)}>
            <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
          </select>
        </Field>
        {urgent && <Field label="Urgency reason" full required><input required minLength={5} value={form.urgency_reason} onChange={(e) => set('urgency_reason', e.target.value)} /></Field>}
        <Field label="Target delivery date" hint={earliest ? `Earliest delivery date: ${formatDate(earliest)}${urgent ? ' (urgent/critical)' : ''}. Leave blank for the earliest.` : undefined}>
          <input type="date" min={earliest || undefined} value={form.target_delivery_date} onChange={(e) => set('target_delivery_date', e.target.value)} />
          {weekend && <small className="block mt-[4px] text-[color:var(--warning-text)] text-[11.5px]">Target date is a weekend. Make sure the branch can receive.</small>}
        </Field>
        <Field label="Contact number"><input value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} /></Field>
        <Field label="Delivery address" full required><input required value={form.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} /></Field>
        <Field label="Items" full required hint="Each product once; the quantity is in the product's unit.">
          <div className="grid gap-[8px]">
            {items.map((item, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_130px_auto] gap-[8px] items-start max-[560px]:grid-cols-1">
                <select required value={item.product_id} disabled={!location} onChange={(e) => setItems(items.map((row, i) => (i === index ? { ...row, product_id: e.target.value } : row)))}>
                  <option value="">{location ? 'Select product' : 'Choose the branch first'}</option>
                  {products.map((p) => <option key={p.id} value={p.id} disabled={items.some((row, i) => i !== index && row.product_id === String(p.id))}>{p.name} ({p.unit})</option>)}
                </select>
                <input required aria-label="Quantity" type="number" min="0.01" step="0.01" value={item.quantity_requested} onChange={(e) => setItems(items.map((row, i) => (i === index ? { ...row, quantity_requested: e.target.value } : row)))} />
                <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== index))}>Remove</button>
                <div className="col-span-full"><EstimateHint locationId={form.location_id} productId={item.product_id} /></div>
              </div>
            ))}
            <button type="button" className={`${BTN_GHOST} ${BTN_SMALL} justify-self-start`} onClick={() => setItems([...items, { product_id: '', quantity_requested: '' }])}>Add another item</button>
          </div>
        </Field>
        <Field label="Bulk reason" full hint={`Required when a quantity is more than ${lookups.settings?.bulk_percent ?? 50}% above the suggested quantity.`}><input value={form.bulk_reason} onChange={(e) => set('bulk_reason', e.target.value)} /></Field>
        <Field label="Remarks" full><textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

export default function SupplyRequests() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'needs_action';
  const overdue = params.get('overdue') === '1';
  const locationId = params.get('location_id') || '';
  const page = Number(params.get('page') || 1);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, ...Object.fromEntries([...params.entries()].filter(([k]) => k in EMPTY_FILTERS)) }));
  const [search, setSearch] = useState(filters.search);
  const [drawerId, setDrawerId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(null); // { key, request }
  const [notice, setNotice] = useState({ type: '', text: '' });
  const [brands, setBrands] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const update = useCallback((patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null || v === undefined) next.delete(k); else next.set(k, v); }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  }, [params, setParams]);

  // Search waits for typing to pause.
  useEffect(() => {
    const t = window.setTimeout(() => { if (search !== filters.search) { setFilters((f) => ({ ...f, search })); update({ search }); } }, 300);
    return () => window.clearTimeout(t);
  }, [search, filters.search, update]);
  useEffect(() => { api.get('/brands').then((r) => setBrands(r.data || [])).catch(() => {}); }, []);

  const query = useMemo(() => ({ tab, page, per_page: 20, overdue: overdue ? 1 : '', location_id: locationId, ...filters }), [tab, page, overdue, locationId, filters]);
  const remote = useRemote(async () => api.get('/supply-requests', query), [JSON.stringify(query), reloadKey]);
  const rows = remote.data?.data || [];
  const meta = remote.data?.meta;
  const tabs = meta?.tabs || {};
  const kpis = meta?.kpis || {};

  const { reload } = remote;
  useEffect(() => {
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible' && !modal) void reload({ silent: true }); }, 10000);
    return () => window.clearInterval(interval);
  }, [reload, modal]);

  // A notification opens its request (the bell passes it in the navigation state).
  const focusId = Number(location.state?.focusSupplyRequestId) || null;
  const openId = drawerId ?? focusId;
  const closeDrawer = () => {
    setDrawerId(null);
    if (focusId) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  };

  const refresh = () => { setReloadKey((k) => k + 1); };
  const say = (text, type = 'success') => setNotice({ type, text });
  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); update({ [key]: value }); };
  const branchName = locationId ? (rows[0]?.location?.name || `Branch #${locationId}`) : '';

  /** Simple actions run at once; the others open their modal. */
  const onAction = async (key, request) => {
    const direct = { start_review: ['start-review', 'Review started.'], endorse: ['endorse', 'Endorsed – Full: stock reserved and sent to Logistics.'], resume: ['resume', 'Resumed: stock reserved and sent to Logistics.'], accept_schedule: ['accept-schedule', 'Schedule accepted. The branch was notified.'], start_preparing: ['prepare', 'Preparing started.'] };
    if (direct[key]) {
      try {
        await api.post(`/supply-requests/${request.id}/${direct[key][0]}`, {});
        say(`${request.request_number}: ${direct[key][1]}`);
      } catch (e) {
        say(`${request.request_number}: ${firstValidationMessage(e)}`, 'error');
      }
      refresh();
      return;
    }
    setModal({ key, request });
  };
  const closeModal = () => setModal(null);
  const done = (text) => () => { setModal(null); say(text); refresh(); };

  const isAdmin = role === 'admin';
  const filtersOn = Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k]) || Boolean(locationId);
  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:p-[22px_14px_30px]">
      <PageHeader
        title="Supply requests"
        subtitle="Ordering and fulfillment workflow"
        actions={(
          <>
            {isAdmin && <button type="button" className={BTN_GHOST} onClick={() => setShowSettings(true)}><FaGear aria-hidden="true" /> Supply settings</button>}
            <button type="button" className={BTN_GHOST} onClick={() => navigate('/estimated-requirement')}>Analytics and Forecasting</button>
            {isAdmin && <button type="button" className={BTN_PRIMARY} onClick={() => setShowCreate(true)}><FaPlus aria-hidden="true" /> New supply request</button>}
          </>
        )}
      />
      <Notice type={notice.type || 'info'}>{notice.text}</Notice>
      {remote.error && (
        <div className="flex flex-wrap items-start gap-[10px] [&>div]:flex-1">
          <Notice type="error">{`Supply requests could not be loaded. ${remote.error}`}</Notice>
          <button type="button" className={BTN_GHOST} onClick={() => void reload()}>Retry</button>
        </div>
      )}

      <section className="grid grid-cols-5 gap-[12px] mb-[16px] max-[1100px]:grid-cols-3 max-[640px]:grid-cols-2" aria-label="Key figures">
        {KPIS.map(([key, label, caption, target]) => {
          const active = target.tab === tab && Boolean(target.overdue) === overdue;
          const loadingFigures = !meta;
          const value = kpis[key] ?? 0;
          return (
            <button key={key} type="button" aria-pressed={active} className={`${METRIC} ${active ? '!border-accent [box-shadow:0_0_0_1px_var(--accent)]' : ''}`} onClick={() => update({ tab: target.tab, overdue: target.overdue || '' })}>
              <small>{label}</small>
              <strong className={key === 'overdue' && value ? '!text-danger-text' : key === 'needs_action' && value ? '!text-accent-text' : ''}>{loadingFigures ? '—' : formatNumber(value)}</strong>
              <small>{caption(role)}</small>
            </button>
          );
        })}
      </section>

      <div className="flex flex-wrap gap-[6px] pb-[4px] mb-[10px]" role="tablist" aria-label="Request tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key && !overdue}
            className={`whitespace-nowrap inline-flex items-center gap-[7px] p-[8px_13px] border rounded-[11px] text-[12.5px] font-[680] cursor-pointer ${tab === key && !overdue ? 'border-accent text-text [background:color-mix(in_srgb,_var(--accent)_14%,_transparent)]' : 'border-line text-text-secondary [background:var(--surface-subtle)] hover:border-line-strong'}`}
            onClick={() => update({ tab: key, overdue: '' })}
          >
            {label}<span className="min-w-[22px] p-[1px_7px] rounded-[8px] text-[11px] [background:var(--surface-strong)]">{formatNumber(tabs[key] ?? 0)}</span>
          </button>
        ))}
        {overdue && <span className="self-center"><Chip tone="danger">Overdue only <button type="button" aria-label="Show all, not only overdue" className="ml-[2px] cursor-pointer [background:none] border-0 text-inherit" onClick={() => update({ overdue: '' })}><FaXmark /></button></Chip></span>}
      </div>

      <div className="flex flex-wrap gap-[8px] items-end mb-[12px]">
        <input aria-label="Search" className={`${TOOL} flex-[1_1_240px] min-w-[200px]`} placeholder="Search branch, city or request number" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Brand" className={`${TOOL}`} value={filters.brand_id} onChange={(e) => setFilter('brand_id', e.target.value)}>
          <option value="">All brands</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select aria-label="Urgency" className={`${TOOL}`} value={filters.urgency} onChange={(e) => setFilter('urgency', e.target.value)}>
          <option value="">All urgency</option><option value="critical">Critical</option><option value="urgent">Urgent</option><option value="normal">Normal</option>
        </select>
        <label className="flex items-center gap-[6px] text-muted text-[11.5px]">From <input aria-label="Requested from" type="date" className={`${TOOL}`} value={filters.from} onChange={(e) => setFilter('from', e.target.value)} /></label>
        <label className="flex items-center gap-[6px] text-muted text-[11.5px]">To <input aria-label="Requested to" type="date" className={`${TOOL}`} value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} /></label>
        <select aria-label="Sort" className={`${TOOL}`} value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
          {SORTS.map(([key, label]) => <option key={key} value={key}>Sort: {label}</option>)}
        </select>
        {(Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k]) || locationId) && (
          <button type="button" className={BTN_GHOST} onClick={() => { setFilters(EMPTY_FILTERS); setSearch(''); update({ ...Object.fromEntries(Object.keys(EMPTY_FILTERS).map((k) => [k, ''])), location_id: '' }); }}>Clear filters</button>
        )}
      </div>
      {locationId && <div className="mb-[10px]"><Chip tone="accent">Branch: {branchName} <button type="button" aria-label="Show every branch" className="ml-[2px] cursor-pointer [background:none] border-0 text-inherit" onClick={() => update({ location_id: '' })}><FaXmark /></button></Chip></div>}

      <section className={`${PANEL} overflow-hidden mb-[16px]`}>
        {remote.loading && !remote.data ? <LoadingState label="Loading supply requests…" /> : remote.error && !remote.data ? (
          <EmptyState label="The list is not available right now." detail="Check the connection, then press Retry above." />
        ) : !rows.length ? (
          <EmptyState label={EMPTY[overdue ? 'overdue' : tab]?.[0] || 'No requests in this view.'} detail={filtersOn ? 'Nothing matches these filters. Clear them to see more.' : (EMPTY[overdue ? 'overdue' : tab]?.[1] || 'Choose another tab.')} />
        ) : (
          <>
            <div className="overflow-x-auto max-[760px]:hidden">
              <table className="w-full min-w-[960px] [border-collapse:collapse] [&_th]:p-[11px_14px] [&_th]:text-left [&_th]:text-muted [&_th]:text-[10.5px] [&_th]:font-[800] [&_th]:tracking-[.12em] [&_th]:uppercase [&_th]:[background:var(--surface-subtle)] [&_td]:p-[13px_14px] [&_td]:border-t [&_td]:border-line [&_td]:align-middle">
                <thead><tr><th>Branch / request</th><th>Items</th><th>Urgency</th><th>Progress</th><th>Target</th><th className="!text-right">Next step</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const items = itemsSummary(r);
                    const label = rowActionLabel(role, r);
                    return (
                      <tr key={r.id} onClick={() => setDrawerId(r.id)} className={`cursor-pointer hover:[background:var(--hover)] ${r.needs_my_action ? '[&>td:first-child]:[box-shadow:inset_3px_0_var(--accent-2)]' : ''}`}>
                        <td>
                          <div className="text-text text-[14px] font-[720]">{branchLabel(r.location)}</div>
                          <div className="text-muted text-[11.5px] [font-family:ui-monospace,monospace]">{r.request_number}</div>
                        </td>
                        <td><div className="text-text text-[13px]">{items.count} item{items.count === 1 ? '' : 's'}</div><div className="text-muted text-[11.5px] max-w-[220px] truncate">{items.first}</div></td>
                        <td><UrgencyChip urgency={r.urgency} /></td>
                        <td><ProgressCell request={r} /></td>
                        <td><TargetCell request={r} /></td>
                        <td className="text-right" onClick={(e) => e.stopPropagation()}>
                          {label ? <button type="button" className={`${BTN_PRIMARY} ${BTN_SMALL}`} onClick={() => setDrawerId(r.id)}>{label}</button> : <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => setDrawerId(r.id)}>View</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="hidden max-[760px]:grid m-0 p-0 [list-style:none]">
              {rows.map((r) => {
                const items = itemsSummary(r);
                const label = rowActionLabel(role, r);
                return (
                  <li key={r.id} className={`p-[13px_14px] border-t border-line first:border-t-0 ${r.needs_my_action ? '[box-shadow:inset_3px_0_var(--accent-2)]' : ''}`}>
                    <button type="button" className="w-full text-left [background:none] border-0 p-0 cursor-pointer" onClick={() => setDrawerId(r.id)}>
                      <div className="flex justify-between gap-2">
                        <div className="min-w-0"><div className="text-text text-[14px] font-[720]">{branchLabel(r.location)}</div><div className="text-muted text-[11px] [font-family:ui-monospace,monospace]">{r.request_number}</div></div>
                        <UrgencyChip urgency={r.urgency} />
                      </div>
                      <div className="mt-[8px]"><ProgressCell request={r} /></div>
                      <div className="mt-[6px] flex justify-between gap-2 text-[12px]"><span className="text-muted">{items.count} item{items.count === 1 ? '' : 's'} · {items.first}</span><span className="text-right"><TargetCell request={r} /></span></div>
                    </button>
                    {label && <button type="button" className={`${BTN_PRIMARY} ${BTN_SMALL} mt-[9px] w-full`} onClick={() => setDrawerId(r.id)}>{label}</button>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="p-[0_14px]"><Pagination meta={meta} onPage={(p) => update({ page: String(p) })} /></div>
      </section>

      {openId && (
        <SupplyDrawer requestId={openId} role={role} reloadKey={reloadKey} onClose={closeDrawer} onAction={onAction} onOpenRequest={(id) => setDrawerId(id)} />
      )}

      {modal && ['return', 'reject', 'cancel'].includes(modal.key) && <ReasonModal kind={modal.key} request={modal.request} onClose={closeModal} onDone={done({ return: 'Returned to the branch for correction.', reject: 'Request rejected.', cancel: 'Request cancelled; reserved stock released.' }[modal.key])} />}
      {modal?.key === 'fulfillment' && <FulfillmentModal request={modal.request} onClose={closeModal} onDone={done('Fulfillment decision saved.')} />}
      {modal?.key === 'restock_date' && <RestockDateModal request={modal.request} onClose={closeModal} onDone={done('Restock date updated. The branch was notified.')} />}
      {modal?.key === 'request_date' && <RequestDateModal request={modal.request} onClose={closeModal} onDone={done('New date sent to Admin.')} />}
      {modal?.key === 'shortage' && <ShortageModal request={modal.request} onClose={closeModal} onDone={done('Shortage reported to Admin.')} />}
      {modal?.key === 'resolve_discrepancy' && <ResolveDiscrepancyModal request={modal.request} onClose={closeModal} onDone={done('Discrepancy resolved: completed with discrepancy.')} />}
      {modal?.key === 'decide_date' && <DateRevisionModal requestId={modal.request.id} onClose={closeModal} onConfirmed={done('Date change decided. Logistics and the branch were notified.')} />}
      {modal?.key === 'dispatch' && <MarkDispatchedModal requestId={modal.request.id} onClose={closeModal} onDispatched={done('Dispatched. The branch was notified.')} />}
      {modal?.key === 'pod' && <MarkDeliveredModal requestId={modal.request.id} onClose={closeModal} onDelivered={done('Proof of delivery saved.')} />}
      {showSettings && <SupplySettingsModal onClose={() => setShowSettings(false)} onDone={() => { setShowSettings(false); say('Supply settings saved.'); }} />}
      {showCreate && <CreateRequestModal onClose={() => setShowCreate(false)} onCreated={(sr) => { setShowCreate(false); say(`${sr.request_number} submitted.${(sr.warnings || []).length ? ` ${sr.warnings.join(' ')}` : ''}`); refresh(); }} />}
    </div>
  );
}
