// Branch portal: supply requests. Left: the New Request form (items with the estimate and days
// covered, urgency, target date with the earliest-date hint, bulk reason only when needed, the
// duplicate warning, address and contact, remarks; save as draft or submit). Right: My requests
// with the 4-step tracker, Edit and resubmit, Cancel while editable, and Confirm Receipt.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaChevronRight, FaPlus, FaTriangleExclamation } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import {
  BRANCH_EDITABLE, BRANCH_STEPS, branchStep, combineLine, findDuplicate, putLine, removeLine, toRequestItems,
} from '../../lib/branchWorkspace';
import { EmptyState, LoadingState, Notice } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import { estimateNotice } from '../../lib/supplyEstimate';
import useRemote from '../../lib/useRemote';
import EstimateHint from '../supply/EstimateHint';
import BranchReceiptModal from './BranchReceiptModal';
import { ReasonModal } from '../supply/SupplyModals';
import { Callout, Chip, UrgencyChip } from '../supply/supplyUi';
import { BTN_GHOST, BTN_SMALL, qty } from '../supply/supplyStyles';

const NO_PICK = { product_id: '', quantity: '' };
const STATUS_FILTERS = [['', 'All requests'], ['open', 'Open'], ['returned', 'Returned'], ['draft', 'Drafts'], ['in_transit', 'On the way'], ['done', 'Received'], ['closed', 'Cancelled or rejected']];
const FILTER_QUERY = { open: { view: 'active' }, returned: { status: 'returned' }, draft: { status: 'draft' }, in_transit: { tab: 'dispatched' }, done: { tab: 'completed' }, closed: { tab: 'closed' } };
const PANEL_CLASS = 'data-panel overflow-hidden mb-[18px] border border-line rounded-[8px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] flex flex-col';
const PANEL_HEAD = 'flex flex-wrap items-start justify-between gap-3 m-[0_16px] p-[16px_2px_10px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[750] [&_h2]:tracking-[-.01em] [&_p]:m-[4px_0_0] [&_p]:text-muted [&_p]:text-[13px] [&_p]:leading-[1.5]';
// Form look for the New request card: taller fields, light labels, one card per request line.
const FIELD = 'min-h-[44px] w-full p-[9px_12px] border border-input-line rounded-[8px] [outline:none] text-text [background:var(--input-bg)] text-[13.5px] [transition:border-color_.16s_ease] focus:border-[color:var(--branch-accent,_var(--accent))]';
const FORM_LABEL = 'block mb-[6px] text-text-secondary text-[12px] font-[600]';
const LINE_CARD = 'p-[16px] border border-line rounded-[8px] [background:color-mix(in_srgb,_var(--bg)_76%,_#000_24%)] light:[background:var(--panel-3)]';
const BTN_ADD = 'min-h-[44px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-input-line rounded-[8px] [background:transparent] text-text text-[13.5px] font-[600] cursor-pointer [transition:background_.16s_ease,_border-color_.16s_ease] hover:[background:var(--hover)] hover:border-[color:var(--branch-accent,_var(--accent))] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed';
const REQUESTS_PANEL = 'flex flex-col min-w-0';
const REQUESTS_HEAD = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-[10px] pb-[14px]';
const GHOST_FILTER = 'min-h-[44px] w-auto p-[0_12px] border border-[#2f3752] rounded-[10px] [background:transparent] text-[#e8ebf3] text-[13.5px] font-[500] cursor-pointer [color-scheme:dark] [outline:none] [&>option]:text-[#e8ebf3] [&>option]:[background:#151c2e] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[640px]:w-full';
// Same surface as the New request panel, so both columns read as one colour.
const CARD_CLASS = 'p-[24px] rounded-[8px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] max-[640px]:p-[18px]';
const BTN_SOLID_44 = 'min-h-[44px] inline-flex items-center justify-center p-[0_16px] border-0 rounded-[10px] text-[#fff] [background:#5160ee] text-[13.5px] font-[600] cursor-pointer [transition:background_.16s_ease] hover:[background:#6573f3] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed';
const BTN_TEXT_CANCEL = 'min-h-[44px] inline-flex items-center justify-center p-[0_12px] border-0 rounded-[8px] [background:transparent] text-[#ff9d9d] text-[13.5px] font-[600] cursor-pointer [transition:background_.16s_ease] hover:[background:#2a1c24] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed';
const BTN_QUIET_44 = 'min-h-[44px] inline-flex items-center justify-center p-[0_14px] border border-input-line rounded-[10px] [background:transparent] text-text text-[13.5px] font-[600] cursor-pointer hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed';
const isWeekend = (day) => Boolean(day) && [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—');
const emptyForm = (location) => ({
  urgency: 'normal', urgency_reason: '', target_delivery_date: '', bulk_reason: '',
  delivery_address: location?.address || location?.name || '', contact_number: location?.contact_number || '', remarks: '',
});

// Status colors for the card: amber = Returned, green = Received, info blue = in progress, gray = stopped.
const BADGE_TONE = {
  returned: ['#f2b866', '#2b2417'],
  received: ['#7fd8a8', '#1b3a30'],
  info: ['#b9c3ff', '#26305a'],
  muted: ['#98a2b8', '#252c42'],
  rejected: ['#ff9d9d', '#2a1c24'],
};

function statusTone(request, step) {
  if (request.status === 'returned') return 'returned';
  if (request.status === 'rejected') return 'rejected';
  if (request.status === 'cancelled' || request.status === 'draft') return 'muted';
  return step >= 3 ? 'received' : 'info';
}

/** The badge text: one word for the stage the request is in, with the side statuses named. */
function statusLabel(request, step) {
  if (request.status === 'returned') return 'Returned';
  if (request.status === 'draft') return 'Draft';
  if (request.status === 'on_hold') return 'On hold';
  if (request.status === 'rejected') return 'Rejected';
  if (request.status === 'cancelled') return 'Cancelled';
  if (request.status === 'discrepancy_review' || request.status === 'completed_with_discrepancy') return 'Received';
  return step >= 0 ? BRANCH_STEPS[step] : 'Draft';
}

function Tracker({ request }) {
  const { step, stopped } = branchStep(request.status, request.branch_received_at);
  // Gold marks every filled stage; a received request turns the whole bar green.
  const doneColor = step >= 3 ? '#7fd8a8' : '#f2b866';
  return (
    <ol className="m-0 p-0 [list-style:none] grid grid-cols-4 gap-[6px]" aria-label={`Progress: ${BRANCH_STEPS[step] || 'Draft'}`}>
      {BRANCH_STEPS.map((name, index) => {
        const current = index === step;
        const filled = !stopped && index <= step;
        const segment = stopped ? (index === 0 ? '#98a2b8' : '#252c42') : filled ? doneColor : '#252c42';
        return (
          <li key={name} className={`min-w-0 ${current ? '' : 'max-[640px]:hidden'}`}>
            <span className="block h-[4px] rounded-[2px]" style={{ background: segment }} />
            <span className={`block mt-[8px] text-[13px] truncate ${current ? 'text-[#e8ebf3] font-[600]' : 'text-[#98a2b8]'}`}>{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RequestCard({ request, preview, onEdit, onCancel, onReceive }) {
  const editable = BRANCH_EDITABLE.includes(request.status);
  const inTransit = ['dispatched', 'delivered'].includes(request.status) && !request.branch_received_at;
  const d = request.delivery;
  const date = request.confirmed_delivery_date || request.effective_delivery_date || request.target_delivery_date;
  const received = request.branch_received_at && (request.items || []).some((i) => i.received_good !== null);
  const { step } = branchStep(request.status, request.branch_received_at);
  const tone = BADGE_TONE[statusTone(request, step)];
  const items = request.items || [];
  const [itemsOpen, setItemsOpen] = useState(true);
  const [open, setOpen] = useState(true);
  return (
    <article className={CARD_CLASS} data-request={request.request_number}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-[10px]">
        <div className="min-w-0">
          <strong className="block text-[#e8ebf3] text-[15px] font-[600] [font-family:ui-monospace,SFMono-Regular,Menlo,monospace] [overflow-wrap:anywhere]">{request.request_number}</strong>
          <small className="block mt-[6px] text-[13px] text-[#98a2b8]">Requested {formatDate(request.submitted_at || request.created_at) || '—'} · Delivery {formatDate(date) || '—'}{request.confirmed_delivery_date ? ' (confirmed)' : ''}</small>
          {(request.urgency !== 'normal' || request.parent_request_number) && (
            <div className="mt-[9px] flex flex-wrap gap-[6px]">
              {request.urgency !== 'normal' && <UrgencyChip urgency={request.urgency} />}
              {request.parent_request_number && <Chip>Backorder of {request.parent_request_number}</Chip>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-[8px]">
          <span className="inline-flex items-center gap-[7px] p-[5px_11px] rounded-[999px] text-[13px] font-[600] whitespace-nowrap" style={{ color: tone[0], background: tone[1] }}>
            <i aria-hidden="true" className="block w-[7px] h-[7px] rounded-full" style={{ background: tone[0] }} />
            {statusLabel(request, step)}
          </span>
          <button
            type="button"
            className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center border border-line rounded-[8px] [background:transparent] text-muted cursor-pointer [transition:color_.16s_ease,_border-color_.16s_ease] hover:text-text hover:border-line-strong"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={`request-body-${request.id}`}
            aria-label={open ? 'Hide request details' : 'Show request details'}
          >
            <FaChevronRight aria-hidden="true" className={`text-[10px] [transition:transform_.3s_ease] ${open ? 'rotate-90' : ''}`} />
          </button>
        </div>
      </header>
      <div className={`grid [transition:grid-template-rows_.3s_ease] ${open ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'}`}>
        <div id={`request-body-${request.id}`} className={`min-h-0 overflow-hidden [transition:opacity_.25s_ease] ${open ? 'opacity-100' : 'opacity-0'}`}>
      <div className="mt-[18px]"><Tracker request={request} /></div>
      {request.status === 'returned' && (
        <div className="mt-[16px] p-[14px_16px] rounded-[10px] [background:#2b2417]">
          <p className="m-0 text-[#f2b866] text-[13px] font-[600]">Returned for correction</p>
          <p className="m-0 mt-[4px] text-[#e8ebf3] text-[15px] leading-[1.5] [overflow-wrap:anywhere]">{request.returned_reason}</p>
        </div>
      )}
      {items.length > 0 && (
        <div className="mt-[20px]">
          <button
            type="button"
            className="flex w-full items-center gap-[7px] border-0 [background:none] p-0 text-[#98a2b8] text-[13px] font-[600] cursor-pointer"
            onClick={() => setItemsOpen((value) => !value)}
            aria-expanded={itemsOpen}
            aria-controls={`request-items-${request.id}`}
          >
            <FaChevronRight aria-hidden="true" className={`flex-none text-[10px] [transition:transform_.16s_ease] ${itemsOpen ? 'rotate-90' : ''}`} />
            Items · {items.length}
            <span className="ml-auto text-muted text-[12px] font-[600]">{itemsOpen ? 'Hide' : 'Show'}</span>
          </button>
          {itemsOpen && (
            <ul id={`request-items-${request.id}`} className="m-0 mt-[4px] p-0 [list-style:none]">
              {items.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-3 py-[12px] border-t border-[#1f2639] text-[15px]">
                  <span className="min-w-0 text-[#e8ebf3] [overflow-wrap:anywhere]">{item.product?.name || item.product_name_snapshot}</span>
                  <span className="text-[#e8ebf3] font-[600] whitespace-nowrap text-right">
                    {qty(item.quantity_endorsed ?? item.quantity_requested)} {item.product?.unit || item.unit_snapshot}
                    {received && <span className="ml-[6px] text-[#98a2b8] text-[13px] font-[400]">({qty(item.received_good)} good{Number(item.received_damaged) ? `, ${qty(item.received_damaged)} damaged` : ''}{Number(item.received_short) ? `, ${qty(item.received_short)} short` : ''})</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
        <footer className="mt-[6px] flex flex-wrap items-center justify-end gap-[8px] max-[640px]:flex-col-reverse max-[640px]:items-stretch">
          {editable && <button type="button" className={BTN_TEXT_CANCEL} onClick={() => onCancel(request)}>Cancel request</button>}
          {editable && (request.status === 'returned'
            ? <button type="button" className={BTN_SOLID_44} onClick={() => onEdit(request)}>Edit and resubmit</button>
            : <button type="button" className={BTN_QUIET_44} onClick={() => onEdit(request)}>{request.status === 'draft' ? 'Edit draft' : 'Edit'}</button>)}
          {inTransit && <button type="button" className={BTN_SOLID_44} onClick={() => onReceive(request)}>Confirm receipt</button>}
        </footer>
      )}
        </div>
      </div>
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
  const [extraOpen, setExtraOpen] = useState(false);
  useEffect(() => { setExtraOpen(Boolean(editing)); }, [editing]);
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
          <div className="p-[14px_16px_16px] max-[761px]:p-[12px]">
            {editing?.status === 'returned' && <Callout><b>Admin returned it:</b> {editing.returned_reason}</Callout>}
            {loadingProducts ? <LoadingState label="Loading warehouse items…" /> : products.length === 0 ? (
              <EmptyState label="No warehouse items are available for this brand yet." detail="Admin adds warehouse products per brand." />
            ) : (
              <div className="grid gap-[16px] mt-[2px]">
                <form onSubmit={addToList} className="grid grid-cols-[minmax(0,_1.9fr)_minmax(0,_1fr)_auto] items-end gap-[10px] max-[700px]:grid-cols-1">
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-pick-item">Item</label>
                    <select id="branch-pick-item" className={FIELD} value={pick.product_id} disabled={busy || preview} onChange={(e) => { setDuplicate(null); setPick({ ...pick, product_id: e.target.value }); }}>
                      <option value="">Select an item</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-pick-qty">Quantity</label>
                    <input id="branch-pick-qty" className={FIELD} type="number" min="0.01" step="any" inputMode="decimal" value={pick.quantity} disabled={busy || preview} onChange={(e) => { setDuplicate(null); setPick({ ...pick, quantity: e.target.value }); }} />
                  </div>
                  <div className="flex items-center gap-[8px] max-[700px]:flex-wrap">
                    <button type="submit" className={BTN_ADD} disabled={preview}>
                      <FaPlus aria-hidden="true" className="flex-none text-[11px]" /> {editingLine === null ? 'Add to list' : 'Update item'}
                    </button>
                    {editingLine !== null && <button type="button" className={BTN_QUIET_44} onClick={() => { setPick(NO_PICK); setEditingLine(null); }}>Cancel edit</button>}
                  </div>
                  {pick.product_id && !preview && <div className="col-span-full"><EstimateHint locationId={location?.id} productId={pick.product_id} /></div>}
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
                  <div className="flex items-baseline gap-[6px] mb-[8px]">
                    <span className="text-text-secondary text-[12.5px] font-[600]">Request list</span>
                    {lines.length > 0 && <span className="text-muted text-[12.5px]">· {lines.length}</span>}
                  </div>
                  {lines.length === 0 ? (
                    <p className="m-0 p-[20px_14px] border border-input-line rounded-[11px] text-muted [background:var(--input-bg)] text-[13px] text-center">No items yet. Choose an item and a quantity, then Add to list.</p>
                  ) : (
                    <ul className="m-0 p-0 [list-style:none] grid gap-[8px]">
                      {lines.map((line) => {
                        const info = lineInfo.get(Number(line.product_id));
                        const notice = estimateNotice(info, liveCheck?.bulk_percent ?? 50);
                        return (
                          <li key={line.product_id} className={`${LINE_CARD} ${editingLine === line.product_id ? 'border-[color:var(--branch-accent,_var(--accent))]' : ''}`}>
                            <div className="flex flex-wrap items-start justify-between gap-x-[12px] gap-y-[2px]">
                              <span className="flex min-w-0 items-baseline gap-[8px]">
                                <strong className="text-text text-[15px] font-[700] leading-[1.35]">{line.name}</strong>
                                <span className="flex-none text-muted text-[13px]">{formatNumber(line.quantity, 2)} {line.unit}</span>
                              </span>
                              <span className="flex flex-none gap-[14px]">
                                <button type="button" className="border-0 [background:none] p-0 text-accent-text text-[12.5px] font-[700] cursor-pointer" onClick={() => { setEditingLine(line.product_id); setPick({ product_id: String(line.product_id), quantity: String(line.quantity) }); }}>Edit</button>
                                <button type="button" className="border-0 [background:none] p-0 text-[color:var(--danger-text)] text-[12.5px] font-[700] cursor-pointer" onClick={() => setLines((c) => removeLine(c, line.product_id))}>Remove</button>
                              </span>
                            </div>
                            <div className="mt-[12px] flex items-baseline gap-[6px] text-[12.5px]">
                              <span className="text-muted">Days covered</span>
                              <b className="text-text font-[700]">{info?.days_covered ?? '—'}</b>
                            </div>
                            {notice && (
                              <div className={`mt-[10px] flex items-start gap-[9px] rounded-[8px] border p-[10px_12px] ${notice.tone === 'warning' ? 'border-[color:color-mix(in_srgb,_var(--warning)_36%,_transparent)] [background:color-mix(in_srgb,_var(--warning)_11%,_transparent)]' : 'border-line [background:var(--surface-subtle)]'}`}>
                                <FaTriangleExclamation aria-hidden="true" className={`mt-[1px] flex-none text-[13px] ${notice.tone === 'warning' ? 'text-[color:var(--warning-text)]' : 'text-muted'}`} />
                                <div className="min-w-0">
                                  <strong className={`block text-[12.5px] font-[700] leading-[1.4] ${notice.tone === 'warning' ? 'text-[color:var(--warning-text)]' : 'text-text-secondary'}`}>{notice.text}</strong>
                                  {notice.detail && <span className={`mt-[2px] block text-[12px] leading-[1.45] ${notice.tone === 'warning' ? 'text-[color:var(--warning-text)] opacity-80' : 'text-muted'}`}>{notice.detail}</span>}
                                </div>
                              </div>
                            )}
                            {!preview && !notice && <div className="mt-[10px]"><EstimateHint locationId={location?.id} productId={line.product_id} plain /></div>}
                            {!preview && <small className="mt-[10px] block text-muted text-[11px]">Estimate only, not filled in.</small>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {(liveCheck?.warnings || []).map((w) => <Callout key={w} tone="info">{w}</Callout>)}

                <div className="grid grid-cols-2 gap-[10px] max-[560px]:grid-cols-1">
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-urgency">Urgency</label>
                    <select id="branch-urgency" className={FIELD} value={form.urgency} disabled={preview} onChange={(e) => set('urgency', e.target.value)}>
                      <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
                    </select>
                  </div>
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-target">Target delivery date</label>
                    <input id="branch-target" className={FIELD} type="date" min={earliest || undefined} value={form.target_delivery_date} disabled={preview} onChange={(e) => set('target_delivery_date', e.target.value)} />
                    {earliest && <small className="block mt-[6px] text-muted text-[11.5px] leading-[1.5]">Earliest: {new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${earliest}T00:00:00Z`))}.{form.target_delivery_date ? '' : ' Used when left blank.'}</small>}
                    {isWeekend(targetShown) && <small className="block mt-[3px] text-[color:var(--warning-text)] text-[11.5px]">Target date is a weekend. Make sure the branch can receive.</small>}
                    {issues.target_delivery_date && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{issues.target_delivery_date}</small>}
                  </div>
                </div>
                {urgent && (
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-urgency-reason">Why is it {form.urgency}? (required)</label>
                    <input id="branch-urgency-reason" className={FIELD} maxLength={500} value={form.urgency_reason} onChange={(e) => set('urgency_reason', e.target.value)} placeholder="For example: out of coffee beans since this morning" />
                    {issues.urgency_reason && form.urgency_reason && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{issues.urgency_reason}</small>}
                  </div>
                )}
                {(liveCheck?.bulk_required || (editing && form.bulk_reason)) && (
                  <div>
                    <label className={FORM_LABEL} htmlFor="branch-bulk-reason">Bulk reason (required)</label>
                    <input id="branch-bulk-reason" className={FIELD} maxLength={500} value={form.bulk_reason} onChange={(e) => set('bulk_reason', e.target.value)} placeholder="Why more than usual? For example: town fiesta next week" />
                    <small className="block mt-[3px] text-muted text-[11.5px]">Some quantities are more than {liveCheck?.bulk_percent ?? 50}% above the suggested quantity. When the suggestion is 0, current stock already covers the estimated 7-day requirement, so any quantity counts. This is not a block; Admin decides.</small>
                  </div>
                )}
                <div className="border-t border-line pt-[14px]">
                  <button
                    type="button"
                    className="flex w-full items-center gap-[9px] border-0 [background:none] p-0 text-text text-[13px] font-[650] cursor-pointer"
                    onClick={() => setExtraOpen((value) => !value)}
                    aria-expanded={extraOpen}
                    aria-controls="branch-extra-fields"
                  >
                    <FaChevronRight aria-hidden="true" className={`flex-none text-muted text-[11px] [transition:transform_.16s_ease] ${extraOpen ? 'rotate-90' : ''}`} />
                    Delivery address, contact and remarks
                  </button>
                  <div className={`grid [transition:grid-template-rows_.28s_ease] ${extraOpen ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'}`}>
                    <div id="branch-extra-fields" className={`min-h-0 overflow-hidden [transition:opacity_.22s_ease] ${extraOpen ? 'opacity-100' : 'opacity-0'}`}>
                      <div className="grid gap-[12px] pt-[12px]">
                    <div><label className={FORM_LABEL} htmlFor="branch-address">Delivery address</label><input id="branch-address" className={FIELD} value={form.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} /></div>
                    <div><label className={FORM_LABEL} htmlFor="branch-contact">Contact number</label><input id="branch-contact" className={FIELD} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} /></div>
                    <div><label className={FORM_LABEL} htmlFor="branch-remarks">Remarks</label><textarea id="branch-remarks" className={`${FIELD} min-h-[70px]`} maxLength={2000} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} placeholder="Optional note for the warehouse" /></div>
                      </div>
                    </div>
                  </div>
                </div>

                {!preview && (
                  <div className="-mx-[16px] -mb-[16px] mt-[2px] flex flex-wrap justify-end gap-[10px] border-t border-line p-[12px_16px] max-[761px]:-mx-[12px] max-[761px]:-mb-[12px] max-[761px]:p-[10px_12px]">
                    {(!editing || editing.status === 'draft') && <button type="button" className={BTN_QUIET_44} disabled={busy || lines.length === 0} onClick={() => save(false)}>Save as draft</button>}
                    <button type="button" className={BTN_SOLID_44} disabled={busy || lines.length === 0} onClick={() => save(true)}>
                      {busy ? 'Saving…' : editing?.status === 'returned' ? 'Resubmit request' : editing?.status === 'submitted' ? 'Save changes' : 'Submit request'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section className={REQUESTS_PANEL}>
          <header className={REQUESTS_HEAD}>
            <h2 className="m-0 text-[#e8ebf3] text-[20px] font-[700]">My requests</h2>
            <select aria-label="Show" className={GHOST_FILTER} value={filter} onChange={(e) => setFilter(e.target.value)}>
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
            <div className="py-[48px] flex flex-col items-center justify-center gap-[6px] text-center text-[#98a2b8]">
              <p className="m-0 text-[15px] font-[500]">{filter ? 'No requests in this view.' : 'No requests yet.'}</p>
              <p className="m-0 text-[13px]">{filter ? 'Choose another view.' : 'Submitted requests will appear here.'}</p>
            </div>
          ) : (
            <div className="grid gap-[18px] pb-[4px]">
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
