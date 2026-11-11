// Branch portal: supply requests. Left: the New Request form (items with the estimate and days
// covered, urgency, target date with the earliest-date hint, bulk reason only when needed, the
// duplicate warning, address and contact, remarks; save as draft or submit). Right: My requests
// with the 4-step tracker, Edit and resubmit, Cancel while editable, and Confirm Receipt.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import {
  BRANCH_EDITABLE, BRANCH_STEPS, branchStep, combineLine, findDuplicate, putLine, removeLine, toRequestItems,
} from '../../lib/branchWorkspace';
import { EmptyState, LoadingState, Notice } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import useRemote from '../../lib/useRemote';
import EstimateHint from '../supply/EstimateHint';
import BranchReceiptModal from './BranchReceiptModal';
import { ReasonModal } from '../supply/SupplyModals';
import { Callout, Chip, UrgencyChip } from '../supply/supplyUi';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SMALL, INPUT, LABEL, qty } from '../supply/supplyStyles';

const NO_PICK = { product_id: '', quantity: '' };
const STATUS_FILTERS = [['', 'All requests'], ['open', 'Open'], ['returned', 'Returned'], ['draft', 'Drafts'], ['in_transit', 'On the way'], ['done', 'Received'], ['closed', 'Cancelled or rejected']];
const FILTER_QUERY = { open: { view: 'active' }, returned: { status: 'returned' }, draft: { status: 'draft' }, in_transit: { tab: 'dispatched' }, done: { tab: 'completed' }, closed: { tab: 'closed' } };
const PANEL_CLASS = 'data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] flex flex-col';
const PANEL_HEAD = 'min-h-[64px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_4px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent,_var(--accent))_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_h2]:font-[780] [&_p]:m-[2px_0_0] [&_p]:text-muted [&_p]:text-[12px]';
const isWeekend = (day) => Boolean(day) && [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—');
const emptyForm = (location) => ({
  urgency: 'normal', urgency_reason: '', target_delivery_date: '', bulk_reason: '',
  delivery_address: location?.address || location?.name || '', contact_number: location?.contact_number || '', remarks: '',
});

function Tracker({ request }) {
  const { step, stopped, label } = branchStep(request.status, request.branch_received_at);
  return (
    <div>
      <ol className="m-0 p-0 [list-style:none] grid grid-cols-4 gap-[4px]" aria-label={`Progress: ${label}`}>
        {BRANCH_STEPS.map((name, index) => {
          const state = stopped ? (index === 0 ? 'stopped' : 'todo') : index < step ? 'done' : index === step ? 'current' : 'todo';
          return (
            <li key={name} className="min-w-0">
              <span className={`block h-[5px] rounded-[3px] ${{ done: '[background:var(--accent)]', current: '[background:var(--accent-2)] [box-shadow:0_0_6px_var(--accent-2)]', stopped: '[background:var(--danger)]', todo: '[background:var(--surface-strong)]' }[state]}`} />
              <span className={`block mt-[4px] text-[10.5px] truncate ${state === 'todo' ? 'text-muted' : 'text-text-secondary font-[700]'}`}>{name}</span>
            </li>
          );
        })}
      </ol>
      <div className={`mt-[3px] text-[12.5px] font-[700] ${stopped || request.status === 'returned' ? 'text-danger-text' : 'text-text'}`}>{label}</div>
    </div>
  );
}

function RequestCard({ request, preview, onEdit, onCancel, onReceive }) {
  const editable = BRANCH_EDITABLE.includes(request.status);
  const inTransit = ['dispatched', 'delivered'].includes(request.status) && !request.branch_received_at;
  const d = request.delivery;
  const date = request.confirmed_delivery_date || request.effective_delivery_date || request.target_delivery_date;
  const received = request.branch_received_at && (request.items || []).some((i) => i.received_good !== null);
  return (
    <article className={`p-[13px_14px] border-b border-line last:border-b-0 ${request.status === 'returned' || inTransit ? '[box-shadow:inset_3px_0_var(--accent-2)]' : ''}`} data-request={request.request_number}>
      <header className="flex flex-wrap items-start justify-between gap-[8px]">
        <div className="min-w-0">
          <strong className="block text-text text-[13px] [font-family:ui-monospace,monospace]">{request.request_number}</strong>
          <small className="block text-muted text-[11.5px]">Requested {formatDate(request.submitted_at || request.created_at) || '—'} · Delivery {formatDate(date) || '—'}{request.confirmed_delivery_date ? ' (confirmed)' : ''}</small>
        </div>
        <span className="flex flex-wrap gap-[5px]">{request.urgency !== 'normal' && <UrgencyChip urgency={request.urgency} />}{request.parent_request_number && <Chip>Backorder of {request.parent_request_number}</Chip>}</span>
      </header>
      <div className="mt-[9px]"><Tracker request={request} /></div>
      <ul className="m-[8px_0_0] p-0 [list-style:none] grid gap-[3px] text-[12.5px]">
        {(request.items || []).map((item) => (
          <li key={item.id} className="flex justify-between gap-3 text-text-secondary">
            <span>{item.product?.name || item.product_name_snapshot}</span>
            <span className="text-text font-[650] whitespace-nowrap">
              {qty(item.quantity_endorsed ?? item.quantity_requested)} {item.product?.unit || item.unit_snapshot}
              {received && <span className="ml-[6px] text-muted font-[400]">({qty(item.received_good)} good{Number(item.received_damaged) ? `, ${qty(item.received_damaged)} damaged` : ''}{Number(item.received_short) ? `, ${qty(item.received_short)} short` : ''})</span>}
            </span>
          </li>
        ))}
      </ul>
      {request.status === 'returned' && <Callout><b>Returned for correction:</b> {request.returned_reason}</Callout>}
      {request.status === 'on_hold' && <Callout><b>On hold for restock</b> (expected {formatDate(request.expected_restock_date) || '—'}). {request.fulfillment_reason}</Callout>}
      {request.status === 'rejected' && <Callout tone="danger"><b>Rejected:</b> {request.rejected_reason}</Callout>}
      {request.status === 'cancelled' && <Callout tone="danger"><b>Cancelled:</b> {request.cancelled_reason}</Callout>}
      {request.status === 'discrepancy_review' && <Callout tone="info">Received with damaged or short items. Admin is reviewing it.</Callout>}
      {request.status === 'completed_with_discrepancy' && <Callout tone="info"><b>Discrepancy resolved:</b> {request.discrepancy_remarks}</Callout>}
      {inTransit && d?.driver_name && (
        <div className="mt-[9px] grid grid-cols-3 gap-[6px] max-[560px]:grid-cols-1 [&>div]:p-[7px_10px] [&>div]:rounded-[10px] [&>div]:border [&>div]:border-line [&_small]:block [&_small]:text-muted [&_small]:text-[10.5px] [&_b]:text-text [&_b]:text-[12.5px]">
          <div><small>Driver</small><b>{d.driver_name}</b></div>
          <div><small>Plate</small><b>{d.plate_number}</b></div>
          <div><small>ETA</small><b>{when(d.eta_at)}</b></div>
        </div>
      )}
      {!preview && (editable || inTransit) && (
        <footer className="mt-[10px] flex flex-wrap justify-end gap-[8px]">
          {editable && <button type="button" className={`${BTN_DANGER} ${BTN_SMALL}`} onClick={() => onCancel(request)}>Cancel request</button>}
          {editable && <button type="button" className={`${request.status === 'returned' ? BTN_PRIMARY : BTN_GHOST} ${BTN_SMALL}`} onClick={() => onEdit(request)}>{request.status === 'returned' ? 'Edit and resubmit' : request.status === 'draft' ? 'Edit draft' : 'Edit'}</button>}
          {inTransit && <button type="button" className={`${BTN_PRIMARY} ${BTN_SMALL}`} onClick={() => onReceive(request)}>Confirm receipt</button>}
        </footer>
      )}
    </article>
  );
}

/**
 * The branch portal has no notification bell: unread supply notifications (receipt reminder,
 * returned, scheduled, dispatched, …) are listed here, each with Show and Mark as read.
 */
function SupplyUpdates({ updates, requests, onShow }) {
  const list = (updates.data || []).filter((n) => String(n.type || '').startsWith('supply_request'));
  if (!list.length) return null;
  const read = async (ids) => {
    await Promise.all(ids.map((id) => api.patch(`/notifications/${id}/read`, {}).catch(() => null)));
    void updates.reload({ silent: true });
  };
  return (
    <div className="m-[12px_16px_0] p-[10px_12px] border rounded-[12px] [border-color:color-mix(in_srgb,_var(--branch-accent,_var(--accent))_45%,_var(--border))] [background:color-mix(in_srgb,_var(--branch-accent,_var(--accent))_7%,_transparent)]" aria-live="polite">
      <div className="flex items-center justify-between gap-2 mb-[6px]">
        <b className="text-text text-[13px]">Supply updates ({list.length})</b>
        <button type="button" className="p-0 border-0 [background:none] text-accent-text text-[12px] font-[700] cursor-pointer" onClick={() => read(list.map((n) => n.id))}>Mark all as read</button>
      </div>
      <ul className="m-0 p-0 [list-style:none] grid gap-[6px]">
        {list.slice(0, 6).map((n) => {
          const request = requests.find((r) => Number(r.id) === Number(n.data?.supply_request_id));
          return (
            <li key={n.id} className="flex flex-wrap items-start justify-between gap-[8px] text-[12.5px]">
              <span className="min-w-0 flex-1"><b className="text-text">{n.title}</b> <span className="text-text-secondary">{n.message}</span></span>
              <span className="flex gap-[10px]">
                {request && <button type="button" className="p-0 border-0 [background:none] text-accent-text text-[12px] font-[700] cursor-pointer" onClick={() => { onShow(request.request_number); void read([n.id]); }}>Show</button>}
                <button type="button" className="p-0 border-0 [background:none] text-muted text-[12px] font-[700] cursor-pointer" onClick={() => read([n.id])}>Mark as read</button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function BranchSupplyPanel({ branchQuery = {}, location = null, preview = false }) {
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [lines, setLines] = useState([]);
  const [pick, setPick] = useState(NO_PICK);
  const [editingLine, setEditingLine] = useState(null);
  const [duplicate, setDuplicate] = useState(null);
  const [form, setForm] = useState(() => emptyForm(location));
  const [editing, setEditing] = useState(null); // the draft / submitted / returned request being edited
  const [settings, setSettings] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [receiveFor, setReceiveFor] = useState(null);
  const [cancelFor, setCancelFor] = useState(null);
  const submitLock = useRef(false);
  const formRef = useRef(null);

  useEffect(() => {
    let active = true;
    api.get('/branch/workspace/warehouse-products', branchQuery)
      .then((response) => { if (active) setProducts(response.data?.products || []); })
      .catch((caught) => { if (active) setError(firstValidationMessage(caught)); })
      .finally(() => { if (active) setLoadingProducts(false); });
    api.get('/supply-settings').then((r) => { if (active) setSettings(r.data); }).catch(() => {});
    return () => { active = false; };
  }, [branchQuery]);

  const locationId = location?.id;
  const remote = useRemote(
    async () => (await api.get('/supply-requests', { tab: 'all', sort: 'newest', per_page: 50, ...(preview && locationId ? { location_id: locationId } : {}), ...(FILTER_QUERY[filter] || {}) })).data || [],
    [filter, preview, locationId],
  );
  const requests = remote.data || [];
  const updates = useRemote(async () => (preview ? [] : (await api.get('/notifications', { unread_only: 1, per_page: 20 })).data || []), [preview]);
  const reloadUpdates = updates.reload;
  const { reload } = remote;
  const loadRequests = useCallback(() => reload({ silent: true }), [reload]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !receiveFor && !cancelFor) { void loadRequests(); void reloadUpdates({ silent: true }); } }, 15000);
    return () => window.clearInterval(timer);
  }, [loadRequests, reloadUpdates, receiveFor, cancelFor]);

  // Live check of the whole request (bulk reason needed? duplicates? days covered? date?).
  const payload = useCallback(() => ({
    location_id: location?.id, ...form, target_delivery_date: form.target_delivery_date || null,
    urgency_reason: form.urgency === 'normal' ? null : form.urgency_reason, items: toRequestItems(lines),
  }), [form, lines, location?.id]);
  useEffect(() => {
    if (preview || !location?.id || !lines.length) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      api.post('/supply-requests/check', { ...payload(), ...(editing ? { existing_id: editing.id } : {}) })
        .then((r) => { if (alive) setCheck(r.data); })
        .catch(() => { if (alive) setCheck(null); });
    }, 350);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [payload, preview, location?.id, lines.length, editing]);
  const liveCheck = lines.length ? check : null;

  /** Scrolls to a request card and highlights it for a moment. */
  const showRequest = (number) => {
    const card = document.querySelector(`article[data-request="${number}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.animate?.([{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }, { background: 'transparent' }], { duration: 1600 });
  };

  const resetForm = () => { setLines([]); setPick(NO_PICK); setEditingLine(null); setDuplicate(null); setForm(emptyForm(location)); setEditing(null); setCheck(null); };

  const addToList = (event) => {
    event.preventDefault();
    setError(''); setNotice('');
    const product = products.find((row) => String(row.id) === String(pick.product_id));
    const quantity = Number(pick.quantity);
    if (!product) { setError('Choose a warehouse item to add.'); return; }
    if (!Number.isFinite(quantity) || quantity <= 0) { setError('Quantity must be greater than zero.'); return; }
    const line = { product_id: product.id, name: product.name, unit: product.unit, quantity };
    const existing = findDuplicate(lines, product.id, editingLine);
    if (existing) { setDuplicate({ line, existing }); return; }
    setLines((current) => putLine(current, line, editingLine));
    setPick(NO_PICK); setEditingLine(null);
  };

  const editRequest = (request) => {
    setError(''); setNotice('');
    setEditing(request);
    setLines((request.items || []).map((i) => ({ product_id: i.product_id, name: i.product?.name || i.product_name_snapshot, unit: i.product?.unit || i.unit_snapshot, quantity: Number(i.quantity_requested) })));
    setForm({
      urgency: request.urgency || 'normal', urgency_reason: request.urgency_reason || '', target_delivery_date: request.target_delivery_date || '',
      bulk_reason: request.bulk_reason || '', delivery_address: request.delivery_address || '', contact_number: request.contact_number || '', remarks: request.remarks || '',
    });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const save = async (submit) => {
    if (submitLock.current || preview || !location?.id || lines.length === 0) return;
    submitLock.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      let saved;
      if (editing) {
        await api.put(`/supply-requests/${editing.id}`, payload());
        saved = submit && editing.status !== 'submitted' ? (await api.post(`/supply-requests/${editing.id}/submit`, {})).data : { ...editing };
      } else {
        saved = (await api.post('/supply-requests', { ...payload(), submit })).data;
      }
      const number = saved.request_number || editing?.request_number;
      setNotice(submit
        ? `${number} ${editing?.status === 'returned' ? 'resubmitted under the same number' : editing ? 'updated' : 'submitted'}. Admin will review it.${(saved.warnings || []).length ? ` ${saved.warnings.join(' ')}` : ''}`
        : `${number} saved as a draft. Submit it when you are ready.`);
      resetForm();
      await loadRequests();
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };

  const urgent = form.urgency !== 'normal';
  const earliest = settings ? (urgent ? settings.earliest_urgent : settings.earliest_normal) : null;
  const targetShown = form.target_delivery_date || earliest;
  const lineInfo = new Map((liveCheck?.items || []).map((i) => [Number(i.product_id), i]));
  const issues = liveCheck?.issues || {};
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="branch-supply">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      <div className="grid gap-4 grid-cols-[minmax(0,_2fr)_minmax(0,_3fr)] items-start max-[1181px]:grid-cols-1">
        <section className={PANEL_CLASS} ref={formRef}>
          <header className={PANEL_HEAD}>
            <div>
              <h2>{editing ? (editing.status === 'returned' ? `Edit and resubmit ${editing.request_number}` : `Edit ${editing.request_number}`) : 'New request'}</h2>
              <p>{editing ? 'Same request number; the history is kept.' : 'Items from your brand’s warehouse catalog.'}</p>
            </div>
            {editing && <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={resetForm}>Stop editing</button>}
          </header>
          <div className="p-[16px_20px_20px] max-[761px]:p-[14px]">
            {editing?.status === 'returned' && <Callout><b>Admin returned it:</b> {editing.returned_reason}</Callout>}
            {loadingProducts ? <LoadingState label="Loading warehouse items…" /> : products.length === 0 ? (
              <EmptyState label="No warehouse items are available for this brand yet." detail="Admin adds warehouse products per brand." />
            ) : (
              <div className="grid gap-[14px] mt-[4px]">
                <form onSubmit={addToList} className="grid gap-[8px]">
                  <div>
                    <label className={LABEL} htmlFor="branch-pick-item">Item</label>
                    <select id="branch-pick-item" className={INPUT} value={pick.product_id} disabled={busy || preview} onChange={(e) => { setDuplicate(null); setPick({ ...pick, product_id: e.target.value }); }}>
                      <option value="">Select an item</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-end gap-[8px]">
                    <div className="flex-[1_1_140px]">
                      <label className={LABEL} htmlFor="branch-pick-qty">Quantity</label>
                      <input id="branch-pick-qty" className={INPUT} type="number" min="0.01" step="any" inputMode="decimal" value={pick.quantity} disabled={busy || preview} onChange={(e) => { setDuplicate(null); setPick({ ...pick, quantity: e.target.value }); }} />
                    </div>
                    <button type="submit" className={BTN_GHOST} disabled={preview}>{editingLine === null ? 'Add to list' : 'Update item'}</button>
                    {editingLine !== null && <button type="button" className={BTN_GHOST} onClick={() => { setPick(NO_PICK); setEditingLine(null); }}>Cancel edit</button>}
                  </div>
                  {pick.product_id && !preview && <EstimateHint locationId={location?.id} productId={pick.product_id} />}
                </form>

                {duplicate && (
                  <Callout>
                    <b>{duplicate.line.name}</b> is already in the list ({formatNumber(duplicate.existing.quantity, 2)}). Combine to {formatNumber(Number(duplicate.existing.quantity) + duplicate.line.quantity, 2)}?
                    <div className="mt-[8px] flex gap-[8px]">
                      <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => { setLines((c) => combineLine(c, duplicate.line, editingLine)); setDuplicate(null); setPick(NO_PICK); setEditingLine(null); }}>Combine</button>
                      <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => setDuplicate(null)}>Keep as is</button>
                    </div>
                  </Callout>
                )}

                <div>
                  <span className={LABEL}>Request list</span>
                  {lines.length === 0 ? (
                    <p className="m-0 p-[20px_14px] border border-input-line rounded-[11px] text-muted [background:var(--input-bg)] text-[13px] text-center">No items yet. Choose an item and a quantity, then Add to list.</p>
                  ) : (
                    <ul className="m-0 p-0 [list-style:none] grid gap-[6px]">
                      {lines.map((line) => {
                        const info = lineInfo.get(Number(line.product_id));
                        return (
                          <li key={line.product_id} className={`p-[9px_11px] border rounded-[11px] ${info?.over_bulk ? 'border-[color:var(--warning)]' : 'border-line'} ${editingLine === line.product_id ? '[background:var(--hover)]' : ''}`}>
                            <div className="flex flex-wrap items-center justify-between gap-[8px]">
                              <span className="text-text text-[13px] font-[650]">{line.name} × {formatNumber(line.quantity, 2)} <small className="text-muted">{line.unit}</small></span>
                              <span className="flex gap-[10px]">
                                <button type="button" className="p-0 border-0 [background:none] text-accent-text text-[12.5px] font-[700] cursor-pointer" onClick={() => { setEditingLine(line.product_id); setPick({ product_id: String(line.product_id), quantity: String(line.quantity) }); }}>Edit</button>
                                <button type="button" className="p-0 border-0 [background:none] text-danger-text text-[12.5px] font-[700] cursor-pointer" onClick={() => setLines((c) => removeLine(c, line.product_id))}>Remove</button>
                              </span>
                            </div>
                            <div className="mt-[4px] flex flex-wrap gap-[6px] items-center text-[11.5px] text-muted">
                              <span>Days covered: <b className="text-text-secondary">{info?.days_covered ?? '—'}</b></span>
                              {info?.over_bulk && <Chip tone="warning">More than {liveCheck?.bulk_percent ?? 50}% above the suggestion</Chip>}
                            </div>
                            {!preview && <EstimateHint locationId={location?.id} productId={line.product_id} />}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {(liveCheck?.warnings || []).map((w) => <Callout key={w} tone="info">{w}</Callout>)}

                <div className="grid grid-cols-2 gap-[10px] max-[560px]:grid-cols-1">
                  <div>
                    <label className={LABEL} htmlFor="branch-urgency">Urgency</label>
                    <select id="branch-urgency" className={INPUT} value={form.urgency} disabled={preview} onChange={(e) => set('urgency', e.target.value)}>
                      <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
                    </select>
                  </div>
                  <div>
                    <label className={LABEL} htmlFor="branch-target">Target delivery date</label>
                    <input id="branch-target" className={INPUT} type="date" min={earliest || undefined} value={form.target_delivery_date} disabled={preview} onChange={(e) => set('target_delivery_date', e.target.value)} />
                    {earliest && <small className="block mt-[4px] text-muted text-[11.5px]">Earliest delivery date: {new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${earliest}T00:00:00Z`))}{form.target_delivery_date ? '' : ' (used when left blank)'}</small>}
                    {isWeekend(targetShown) && <small className="block mt-[3px] text-[color:var(--warning-text)] text-[11.5px]">Target date is a weekend. Make sure the branch can receive.</small>}
                    {issues.target_delivery_date && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{issues.target_delivery_date}</small>}
                  </div>
                </div>
                {urgent && (
                  <div>
                    <label className={LABEL} htmlFor="branch-urgency-reason">Why is it {form.urgency}? (required)</label>
                    <input id="branch-urgency-reason" className={INPUT} maxLength={500} value={form.urgency_reason} onChange={(e) => set('urgency_reason', e.target.value)} placeholder="For example: out of coffee beans since this morning" />
                    {issues.urgency_reason && form.urgency_reason && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{issues.urgency_reason}</small>}
                  </div>
                )}
                {(liveCheck?.bulk_required || (editing && form.bulk_reason)) && (
                  <div>
                    <label className={LABEL} htmlFor="branch-bulk-reason">Bulk reason (required)</label>
                    <input id="branch-bulk-reason" className={INPUT} maxLength={500} value={form.bulk_reason} onChange={(e) => set('bulk_reason', e.target.value)} placeholder="Why more than usual? For example: town fiesta next week" />
                    <small className="block mt-[3px] text-muted text-[11.5px]">Some quantities are more than {liveCheck?.bulk_percent ?? 50}% above the suggested quantity. This is not a block; Admin decides.</small>
                  </div>
                )}
                <details open={Boolean(editing)}>
                  <summary className="text-text-secondary text-[13px] font-[700] cursor-pointer">Delivery address, contact and remarks</summary>
                  <div className="grid gap-[10px] mt-[10px]">
                    <div><label className={LABEL} htmlFor="branch-address">Delivery address</label><input id="branch-address" className={INPUT} value={form.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} /></div>
                    <div><label className={LABEL} htmlFor="branch-contact">Contact number</label><input id="branch-contact" className={INPUT} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} /></div>
                    <div><label className={LABEL} htmlFor="branch-remarks">Remarks</label><textarea id="branch-remarks" className={`${INPUT} min-h-[70px]`} maxLength={2000} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} placeholder="Optional note for the warehouse" /></div>
                  </div>
                </details>

                {!preview && (
                  <div className="flex flex-wrap justify-end gap-[8px]">
                    {(!editing || editing.status === 'draft') && <button type="button" className={BTN_GHOST} disabled={busy || lines.length === 0} onClick={() => save(false)}>Save as draft</button>}
                    <button type="button" className={BTN_PRIMARY} disabled={busy || lines.length === 0} onClick={() => save(true)}>
                      {busy ? 'Saving…' : editing?.status === 'returned' ? 'Resubmit request' : editing?.status === 'submitted' ? 'Save changes' : 'Submit request'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section className={PANEL_CLASS}>
          <header className={PANEL_HEAD}>
            <div><h2>My requests</h2><p>Submitted → Approved → On the way → Received</p></div>
            <select aria-label="Show" className={`${INPUT} !w-auto`} value={filter} onChange={(e) => setFilter(e.target.value)}>
              {STATUS_FILTERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </header>
          {remote.error && (
            <div className="p-[12px_16px_0]">
              <Notice type="error">{`Your requests could not be loaded. ${remote.error}`}</Notice>
              <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => void reload()}>Retry</button>
            </div>
          )}
          {!preview && <SupplyUpdates updates={updates} requests={requests} onShow={showRequest} />}
          {remote.loading && !remote.data ? <LoadingState label="Loading requests…" /> : requests.length === 0 ? (
            <EmptyState label={filter ? 'No requests in this view.' : 'No supply requests for this branch yet.'} detail={filter ? 'Choose another view.' : 'Add items to the list and submit your first request.'} />
          ) : (
            <div>
              {requests.map((request) => (
                <RequestCard key={request.id} request={request} preview={preview} onEdit={editRequest} onCancel={setCancelFor} onReceive={setReceiveFor} />
              ))}
            </div>
          )}
        </section>
      </div>

      {receiveFor && (
        <BranchReceiptModal
          request={receiveFor}
          onClose={() => setReceiveFor(null)}
          onDone={(saved) => {
            setReceiveFor(null);
            setNotice(saved.status === 'discrepancy_review'
              ? `${saved.request_number}: receipt saved. The good items were added to your stock; Admin will review the damaged or short items.`
              : `${saved.request_number}: receipt saved. The items were added to your stock.`);
            void loadRequests();
          }}
        />
      )}
      {cancelFor && (
        <ReasonModal kind="cancel" request={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); setNotice(`${cancelFor.request_number} cancelled.`); if (editing?.id === cancelFor.id) resetForm(); void loadRequests(); }} />
      )}
    </div>
  );
}
