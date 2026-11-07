import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FaPlus, FaTruckFast, FaXmark } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, formatNumber, localDateInputValue, titleCase } from '../lib/format';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, Pagination } from '../components/ApiUi';
import { getSupplyActions, supplyStatusLabel } from '../lib/supplyActions';
import SupplyRequestDetailModal from '../components/supply/SupplyRequestDetailModal';
import MarkDispatchedModal from '../components/supply/MarkDispatchedModal';
import MarkDeliveredModal from '../components/supply/MarkDeliveredModal';
import StartPrepareModal from '../components/supply/StartPrepareModal';
import CancelRejectModal from '../components/supply/CancelRejectModal';
import DateRevisionModal from '../components/supply/DateRevisionModal';
import SupplyHistoryPanel from '../components/supply/SupplyHistoryPanel';
import EstimateHint from '../components/supply/EstimateHint';
import { useAuth } from '../context/AuthContext';

/* ------------------------------------------------------------------ */
/* Workflow configuration                                              */
/* ------------------------------------------------------------------ */

// Ordered main flow. "completed" is the final state (all dots filled).
const workflowStage = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'under_review', label: 'Under review' },
  { key: 'endorsed', label: 'Endorsed' },
  // "preparing" is the Start Prepare step: the warehouse stock is deducted here.
  { key: 'preparing', label: 'Preparing' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'completed', label: 'Completed' },
];

// The tracker shows 6 dots; "completed" fills all of them.
const TRACK = workflowStage.slice(0, 6);

// The button label describes the ACTION that moves the request INTO that status.
const actionLabel = {
  submitted: 'Submit',
  under_review: 'Start review',
  endorsed: 'Endorse',
  preparing: 'Start Prepare',
  dispatched: 'Mark Dispatched',
  delivered: 'Mark Delivered',
  completed: 'Mark as Complete',
  rejected: 'Reject',
  cancelled: 'Cancel',
};

const DANGER_STATUSES = ['rejected', 'cancelled'];
// Action key -> the status it moves the request into (table buttons only).
const FORWARD_STATUS = {
  endorse: 'endorsed',
  start_preparing: 'preparing',
  dispatch: 'dispatched',
  deliver: 'delivered',
  complete: 'completed',
  reject: 'rejected',
  cancel: 'cancelled',
};
// Rows from Endorsed onward open the detail modal (Under review keeps its own Branches-panel review flow).
const DETAIL_STATUSES = ['endorsed', 'preparing', 'dispatched', 'delivered'];
const TERMINAL_STATUSES = ['completed', 'rejected', 'cancelled'];

const newItem = () => ({ product_id: '', quantity_requested: 1 });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DAY_MS = 86400000;

function stageIndex(status) {
  return workflowStage.findIndex((item) => item.key === status);
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function overdueDays(request) {
  if (!request.target_delivery_date || TERMINAL_STATUSES.includes(request.status)) return 0;
  const diff = Math.floor((startOfDay(new Date()) - startOfDay(request.target_delivery_date)) / DAY_MS);
  return diff > 0 ? diff : 0;
}

function daysInStage(request) {
  const ref = request.status_changed_at || request.updated_at;
  if (!ref) return null;
  const diff = Math.floor((startOfDay(new Date()) - startOfDay(ref)) / DAY_MS);
  return diff > 0 ? diff : 0;
}

function totalQuantity(request) {
  return (request.items || []).reduce((sum, item) => sum + Number(item.quantity_requested || 0), 0);
}

/* ------------------------------------------------------------------ */
/* KPI cards                                                           */
/* ------------------------------------------------------------------ */

function SupplyKpis({ stats }) {
  const done = Number(stats?.by_status?.completed || 0);
  const active = Number(stats?.active || 0);
  const total = Number(stats?.total || 0) || 1;
  const percent = Math.min(100, Math.round((done / total) * 100));

  const cards = [
    ['Active orders', stats?.active, 'Submitted through dispatched'],
    ['Overdue', stats?.overdue, 'Past the target delivery date'],
    ['Dispatch queue', (stats?.by_status?.endorsed || 0) + (stats?.by_status?.preparing || 0), 'Endorsed or preparing'],
    ['Completed this month', stats?.completed_this_month, `Avg ${stats?.avg_fulfillment_days ?? 0} days to fulfill`],
  ];

  return (
    <section className="metric-grid grid grid-cols-[repeat(6,_minmax(0,_1fr))] gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-2:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-3:grid-cols-[1fr] supply-kpi-grid" aria-label="Supply request KPIs">
      {cards.map(([label, value, caption]) => (
        <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]" key={label}>
          <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span>{label}</span></div>
          <strong>{formatNumber(value)}</strong>
          <small className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{caption}</small>
        </article>
      ))}
      <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px] metric-tone-success">
        <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span>Fulfillment progress</span></div>
        <strong>{percent}%</strong>
        <div className="h-[6px] m-[10px_0_8px] rounded-[999px] [background:var(--sr-todo)] overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-[inherit] [background:var(--sr-accent)] [transition:width_0.4s_ease] motion-reduce:later:[transition:none]" style={{ width: `${percent}%` }} />
        </div>
        <small className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{formatNumber(done)} completed · {formatNumber(active)} in progress</small>
      </article>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Progress tracker (dots + label)                                     */
/* ------------------------------------------------------------------ */

function ProgressTracker({ status, role }) {
  const idx = stageIndex(status);
  const inFlow = idx !== -1;
  const isFinal = status === 'completed';
  const label = inFlow ? workflowStage[idx].label : titleCase(status);
  // Admin tracker is blue, Logistics tracker is violet (accent per role).
  const accentClass = role === 'logistics' ? ' later:[--sr-accent:var(--accent-2)]' : role === 'admin' ? ' [--sr-accent:var(--accent)]' : '';

  return (
    <div className={`sr-progress${accentClass}`}>
      <ol className="flex items-center m-0 p-0 [list-style:none]" aria-label={`Progress: ${label}`}>
        {TRACK.map((step, i) => {
          let state = 'todo';
          if (inFlow) state = isFinal || i < idx ? 'done' : i === idx ? 'active' : 'todo';
          const lineDone = inFlow && (isFinal || i <= idx);
          return (
            <li className="flex items-center" key={step.key} title={step.label}>
              {i > 0 && <span className={`block w-[14px] h-[2px] [background:var(--sr-todo)] [transition:background_0.25s_ease] [&.is-done]:[background:var(--sr-accent)] motion-reduce:later:[transition:none] ${lineDone ? ' is-done' : ''}`} aria-hidden="true" />}
              <span className={`[box-sizing:border-box] block w-[12px] h-[12px] rounded-[50%] [border:2px_solid_var(--sr-todo)] [background:transparent] [transition:background_0.25s_ease,_border-color_0.25s_ease,_transform_0.25s_ease] [&.is-done]:border-[color:var(--sr-accent)] [&.is-done]:[background:var(--sr-accent)] [&.is-active]:w-[16px] [&.is-active]:h-[16px] [&.is-active]:border-[color:var(--sr-accent)] later:[&.is-active]:[background:transparent] motion-reduce:later:[transition:none] is-${state}`} aria-current={state === 'active' ? 'step' : undefined} />
            </li>
          );
        })}
      </ol>
      <span className={`text-[0.9rem] font-[600] text-[color:var(--sr-text)] [&.is-danger]:text-[color:var(--sr-danger)] later:[&.is-final]:text-[color:var(--sr-success)] ${DANGER_STATUSES.includes(status) ? ' is-danger' : ''}${isFinal ? ' is-final' : ''}`}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SupplyRequests() {
  const location = useLocation();
  const navigate = useNavigate();
  const { role } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [address, setAddress] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [items, setItems] = useState([newItem()]);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmTransition, setConfirmTransition] = useState(null); // only for Reject / Cancel
  const [detailId, setDetailId] = useState(null); // row detail modal
  const [dispatchId, setDispatchId] = useState(null); // Mark Dispatched modal
  const [deliverId, setDeliverId] = useState(null); // Mark Delivered modal
  const [prepareId, setPrepareId] = useState(null); // Start Prepare confirmation (deducts stock)
  const [cancelTarget, setCancelTarget] = useState(null); // { request, nextStatus } for Reject / Cancel
  const [dateRevisionId, setDateRevisionId] = useState(null); // DateRevisionModal for Logistics
  const [showHistory, setShowHistory] = useState(false); // closed-request transaction history
  // Requests Logistics has not opened yet: the red dot on a row (and on the nav item,
  // which the header computes from the same notifications) clears once acted on.
  const [unreadRequestIds, setUnreadRequestIds] = useState([]);

  // The 5s poll only re-reads the requests. Locations and products change on other pages,
  // so they are loaded once instead of on every tick (5 requests became 3).
  const remote = useRemote(async () => {
    const [requests, stats, activeCounts] = await Promise.all([
      api.get('/supply-requests', { page, per_page: 20, view: 'active', status }),
      api.get('/supply-requests/stats'),
      api.get('/supply-requests/active-counts'),
    ]);
    return { requests: requests.data, meta: requests.meta, stats: stats.data, activeCounts: activeCounts.data };
  }, [page, status]);

  const [lookups, setLookups] = useState({ locations: [], products: [] });
  useEffect(() => {
    let active = true;
    Promise.all([api.get('/locations'), api.get('/products', { per_page: 100 })])
      .then(([locations, products]) => {
        if (active) setLookups({ locations: locations.data || [], products: products.data || [] });
      })
      .catch(() => { /* the create form shows its own error when submitting */ });
    return () => { active = false; };
  }, []);

  const canCreate = ['admin', 'franchisee'].includes(role);
  const productMap = useMemo(
    () => new Map((lookups.products || []).map((product) => [product.id, product])),
    [lookups.products],
  );

  // Notification deep link: the bell routes a supply request here and the detail
  // modal opens for that exact request; the state is cleared so it never reopens.
  useEffect(() => {
    const focusId = location.state?.focusSupplyRequestId;
    if (!focusId) return undefined;
    navigate(location.pathname, { replace: true, state: null });
    setDetailId(String(focusId));
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // Live refresh every 5 seconds while the tab is visible
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void remote.reload({ silent: true });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [remote.reload]);

  useEffect(() => {
    if (role !== 'logistics') return undefined;
    let active = true;
    const load = async () => {
      try {
        const response = await api.get('/notifications', { per_page: 50, unread_only: 1 });
        const ids = (response.data || [])
          .filter((item) => String(item.type || '').startsWith('supply_request'))
          .map((item) => Number(item.data?.supply_request_id))
          .filter(Boolean);
        if (active) setUnreadRequestIds([...new Set(ids)]);
      } catch {
        // The dot is an extra cue; a failed poll never blocks the table.
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15000);
    return () => { active = false; window.clearInterval(interval); };
  }, [role]);

  const clearRequestDot = async (requestId) => {
    const id = Number(requestId);
    if (!unreadRequestIds.includes(id)) return;
    setUnreadRequestIds((ids) => ids.filter((value) => value !== id));
    try {
      const response = await api.get('/notifications', { per_page: 50, unread_only: 1 });
      const related = (response.data || []).filter((item) => Number(item.data?.supply_request_id) === id);
      await Promise.all(related.map((item) => api.patch(`/notifications/${item.id}/read`, {})));
      window.dispatchEvent(new Event('herald:notifications-updated'));
    } catch {
      // Keep the cleared dot locally; the next poll simply re-adds it if unread remained.
    }
  };

  /* ---------------- status chips ---------------- */
  const byStatus = remote.data?.activeCounts || {};
  const totalCount = Number(remote.data?.activeCounts?.active_total ?? 0);
  // The table covers the active view only: Under review onward (Submitted lives in the Branches panel).
  const chipKeys = ['under_review', 'endorsed', 'preparing', 'dispatched', 'delivered'].filter(
    (key) => Number(byStatus[key] || 0) > 0 || key === status,
  );

  /* ---------------- workflow actions ---------------- */
  // Row buttons come only from getSupplyActions (permission-checked). Submitted is never in this table.
  // One source for every row button: the actions getSupplyActions allows, split by danger.
  const actionsFor = (request) => getSupplyActions(role, request).filter((action) => !action.auto);
  const dateRevisionAction = (request) => actionsFor(request).find((action) => action.key === 'confirm_date');

  const dangerActions = (request) => actionsFor(request)
    .filter((action) => action.danger)
    .map((action) => FORWARD_STATUS[action.key])
    .filter(Boolean);

  const runTransition = async (request, nextStatus) => {
    setBusyId(request.id);
    setActionError('');
    setSuccess('');
    try {
      await api.patch(`/supply-requests/${request.id}/status`, { status: nextStatus });
      setSuccess(`${request.request_number} moved to ${supplyStatusLabel(nextStatus)}.`);
      setConfirmTransition(null);
      await remote.reload({ silent: true });
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  // Each action either opens its own modal or asks for confirmation first.
  const handleAction = (request, nextStatus) => {
    void clearRequestDot(request.id);
    // Mark Dispatched opens its own modal with the stock snapshot.
    if (nextStatus === 'dispatched') {
      setActionError('');
      setDispatchId(request.id);
      return;
    }
    // Mark Delivered opens its own modal with the optional delivery note.
    if (nextStatus === 'delivered') {
      setActionError('');
      setDeliverId(request.id);
      return;
    }
    // Reject / Cancel need a reason, so they get their own modal (the generic confirm has none).
    if (DANGER_STATUSES.includes(nextStatus)) {
      setActionError('');
      setCancelTarget({ request, nextStatus });
      return;
    }
    // Start Prepare opens the stock preview; the warehouse is only deducted when
    // Logistics confirms inside that modal.
    if (nextStatus === 'preparing') {
      setActionError('');
      setPrepareId(request.id);
      return;
    }
    // Complete closes the request, so it asks for confirmation first.
    if (nextStatus === 'completed') {
      setActionError('');
      setConfirmTransition({ request, nextStatus });
      return;
    }
    void runTransition(request, nextStatus);
  };


  /* ---------------- create request ---------------- */
  const createRequest = async (event) => {
    event.preventDefault();
    setSaving(true);
    setActionError('');
    setSuccess('');
    const productIds = items.map((item) => item.product_id);
    const invalidQuantity = items.find((item) => !Number.isInteger(Number(item.quantity_requested)) || Number(item.quantity_requested) < 1);
    if (invalidQuantity) {
      setActionError('Every requested quantity must be a whole number of at least 1.');
      setSaving(false);
      return;
    }
    if (new Set(productIds).size !== productIds.length) {
      setActionError('Each product can appear only once in a supply request. Combine duplicate quantities before submitting.');
      setSaving(false);
      return;
    }
    try {
      await api.post('/supply-requests', {
        location_id: Number(locationId),
        submit: true,
        target_delivery_date: deliveryDate || null,
        delivery_address: address.trim(),
        remarks: remarks.trim() || null,
        items: items.map((item) => ({ product_id: Number(item.product_id), quantity_requested: Number(item.quantity_requested) })),
      });
      setShowCreate(false);
      setLocationId('');
      setAddress('');
      setDeliveryDate('');
      setRemarks('');
      setItems([newItem()]);
      setSuccess('Supply request submitted successfully.');
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  /* ---------------- render ---------------- */
  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]">
      <PageHeader
        title="Supply requests"
        actions={(
          <>
            {(role === 'admin' || role === 'logistics') && (
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => navigate('/estimated-requirement')}>
                Analytics and Forecasting
              </button>
            )}
            {canCreate && (
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => { setActionError(''); setShowCreate(true); }}>
                <FaPlus /> New supply request
              </button>
            )}
          </>
        )}
      />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{!showCreate && !confirmTransition ? (actionError || remote.error) : remote.error}</Notice>

      {!remote.loading && remote.data?.stats && <SupplyKpis stats={remote.data.stats} />}

      <div className="flex justify-end m-[2px_0_10px]">
        <button
          type="button"
          className="min-h-[34px] p-[0_14px] [border:1px_solid_color-mix(in_srgb,_var(--sr-accent)_42%,_transparent)] rounded-[10px] text-[color:var(--sr-accent)] [background:color-mix(in_srgb,_var(--sr-accent)_12%,_transparent)] text-[0.78rem] font-[700] cursor-pointer hover:[background:color-mix(in_srgb,_var(--sr-accent)_20%,_transparent)]"
          onClick={() => setShowHistory((open) => !open)}
        >
          {showHistory ? 'Back to active requests' : 'Transaction History'}
        </button>
      </div>

      {showHistory ? <SupplyHistoryPanel /> : (
      <>
      {/* Status filter chips */}
      <div className="flex flex-wrap gap-[10px] m-[18px_0_14px]" role="tablist" aria-label="Filter supply request status">
        <button
          type="button"
          role="tab"
          aria-selected={status === ''}
          className={`inline-flex items-center gap-[6px] p-[9px_16px] [border:1px_solid_var(--sr-border-strong)] rounded-[12px] [background:transparent] text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] text-[0.95rem] font-[500] cursor-pointer [transition:background_0.15s_ease,_border-color_0.15s_ease] hover:[background:var(--sr-surface-hover)] [&.is-active]:border-[color:var(--sr-accent)] later:[&.is-active]:[background:var(--sr-accent-soft)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] motion-reduce:later:[transition:none] ${status === '' ? ' is-active' : ''}`}
          onClick={() => { setPage(1); setStatus(''); }}
        >
          All <span className="[font-variant-numeric:tabular-nums] font-[600]">{formatNumber(totalCount)}</span>
        </button>
        {chipKeys.map((key) => (
          <button
            type="button"
            role="tab"
            aria-selected={status === key}
            key={key}
            className={`inline-flex items-center gap-[6px] p-[9px_16px] [border:1px_solid_var(--sr-border-strong)] rounded-[12px] [background:transparent] text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] text-[0.95rem] font-[500] cursor-pointer [transition:background_0.15s_ease,_border-color_0.15s_ease] hover:[background:var(--sr-surface-hover)] [&.is-active]:border-[color:var(--sr-accent)] later:[&.is-active]:[background:var(--sr-accent-soft)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] motion-reduce:later:[transition:none] ${status === key ? ' is-active' : ''}`}
            onClick={() => { setPage(1); setStatus(key); }}
          >
            {supplyStatusLabel(key)} <span className="[font-variant-numeric:tabular-nums] font-[600]">{formatNumber(byStatus[key] || 0)}</span>
          </button>
        ))}
      </div>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        {remote.loading ? <LoadingState /> : !remote.data?.requests.length ? (
          <EmptyState label="No supply requests match this filter." detail="Choose another status or create a new restock request." />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
            <table className="w-full [border-collapse:collapse] [&_th]:p-[10px_14px] [&_th]:text-left [&_th]:text-[0.85rem] [&_th]:font-[500] [&_th]:text-[color:var(--sr-muted)] [&_th]:whitespace-nowrap [&_th.sr-th-right]:text-right [&_td]:p-[16px_14px] [&_td]:[vertical-align:middle] [&_td]:[border-top:1px_solid_var(--sr-border)] [&_tbody_tr]:[transition:opacity_0.15s_ease] [&_tbody_tr.is-busy]:opacity-[0.65] max-[861px]:later:[&_th]:pl-[10px] max-[861px]:later:[&_th]:pr-[10px] max-[861px]:later:[&_td]:pl-[10px] max-[861px]:later:[&_td]:pr-[10px] motion-reduce:later:[&_tbody_tr]:[transition:none]">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Progress</th>
                  <th>Target</th>
                  <th className="sr-th-right">Next step</th>
                </tr>
              </thead>
              <tbody>
                {remote.data.requests.map((request) => {
                  const late = overdueDays(request);
                  const stageDays = daysInStage(request);
                  const forward = actionsFor(request).find((action) => !action.danger && FORWARD_STATUS[action.key]);
                  const next = forward ? FORWARD_STATUS[forward.key] : undefined;
                  const dangers = dangerActions(request);
                  const needsDateReview = Boolean(dateRevisionAction(request));
                  const busy = busyId === request.id;
                  const clickable = needsDateReview || DETAIL_STATUSES.includes(request.status);
                  const itemNames = (request.items || [])
                    .map((item) => `${item.product?.name || productMap.get(item.product_id)?.name || 'Item'} × ${formatNumber(item.quantity_requested)}`)
                    .join(', ');

                  return (
                    <tr
                      key={request.id}
                      className={`${busy ? 'is-busy' : ''}${clickable ? ' sr-row-clickable' : ''}`}
                      onClick={() => {
                        if (needsDateReview) {
                          setDateRevisionId(request.id);
                          return;
                        }
                        if (DETAIL_STATUSES.includes(request.status)) {
                          void clearRequestDot(request.id);
                          setDetailId(request.id);
                        }
                      }}
                    >
                      <td>
                        <strong className="block text-[1rem] font-[600] text-[color:var(--sr-text)]">
                          {request.request_number}
                          {unreadRequestIds.includes(Number(request.id)) && (
                            <span
                              className="inline-block w-[8px] h-[8px] ml-[7px] rounded-[999px] [background:#8b6dff] [box-shadow:0_0_0_3px_color-mix(in_srgb,_#8b6dff_22%,_transparent)] [vertical-align:middle]"
                              title="New action for Logistics"
                              aria-label="New action for Logistics"
                            />
                          )}
                          {needsDateReview && (
                            <span
                              className="inline-block w-[8px] h-[8px] ml-[7px] rounded-[999px] [background:#8b6dff] [box-shadow:0_0_0_3px_color-mix(in_srgb,_#8b6dff_22%,_transparent)] [vertical-align:middle]"
                              title="Date change awaiting your confirmation"
                              aria-label="Date change awaiting your confirmation"
                            />
                          )}
                        </strong>
                        <span className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)]" title={itemNames || undefined}>
                          {request.location?.name || '—'} · {formatNumber(totalQuantity(request))} items
                        </span>
                      </td>

                      <td><ProgressTracker status={request.status} role={role} /></td>

                      <td>
                        <strong className="block text-[1rem] font-[600] text-[color:var(--sr-text)]">{formatDate(request.target_delivery_date)}</strong>
                        {late > 0 ? (
                          <span className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)] [&.is-late]:text-[color:var(--sr-danger)] is-late">Overdue {late}d</span>
                        ) : request.status === 'completed' ? (
                          <span className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)] [&.is-late]:text-[color:var(--sr-danger)]">Completed</span>
                        ) : stageDays === null ? null : (
                          <span className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)] [&.is-late]:text-[color:var(--sr-danger)]">{stageDays === 0 ? 'Just updated' : `${stageDays}d in stage`}</span>
                        )}
                      </td>

                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-end flex-wrap gap-2 [&_.danger-button]:min-h-[30px] [&_.danger-button]:p-[0_10px] [&_.danger-button]:rounded-[9px] [&_.danger-button]:text-[0.72rem] [&_.danger-button]:[box-shadow:none] max-[861px]:later:justify-start">
                          {needsDateReview && (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]"
                              onClick={() => setDateRevisionId(request.id)}
                              disabled={busy}
                            >
                              Review date change
                            </button>
                          )}
                          {dangers.map((danger) => (
                            <button
                              key={danger}
                              type="button"
                              className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] danger-button [-webkit-tap-highlight-color:transparent] border border-transparent tracking-[.01em] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]"
                              onClick={() => handleAction(request, danger)}
                              disabled={busy}
                            >
                              <FaXmark aria-hidden="true" /> {actionLabel[danger]}
                            </button>
                          ))}
                          {next && (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]"
                              onClick={() => handleAction(request, next)}
                              disabled={busy || forward?.disabled}
                              title={forward?.reason || undefined}
                            >
                              {busy ? 'Updating…' : actionLabel[next]}
                            </button>
                          )}
                          {!next && !dangers.length && !needsDateReview && <span className="text-[color:var(--sr-muted)]">—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination meta={remote.data?.meta} onPage={setPage} />
      </section>
      </>
      )}

      {showCreate && (
        <Modal
          title="Create supply request"
          onClose={() => setShowCreate(false)}
          size="wide"
          footer={<><button onClick={() => setShowCreate(false)}>Cancel</button><button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="supply-form" disabled={saving}>{saving ? 'Submitting…' : 'Submit request'}</button></>}
        >
          <Notice type="error">{actionError}</Notice>
          <form id="supply-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={createRequest}>
            <Field label="Destination location" required>
              <select
                required
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  const loc = lookups.locations.find((row) => String(row.id) === e.target.value);
                  setAddress(loc?.address || '');
                }}
              >
                <option value="">Select location</option>
                {lookups.locations.filter((location) => location.type === 'franchise').map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Target delivery date">
              <input type="date" min={localDateInputValue()} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </Field>
            <Field label="Delivery address" full required>
              <input required value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label="Items" full required hint="Each product may appear once. Quantities must be whole numbers of at least 1.">
              <div className="[&_button]:min-h-[34px] [&_button]:p-[0_10px] later-2:[&_button]:border later-2:[&_button]:border-line later-2:[&_button]:rounded-[9px] [&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-2:[&_button]:text-[9px] later-2:[&_button]:font-[700] [&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-col gap-[9px] p-[11px] border border-line rounded-[13px] [background:var(--surface-subtle)]">
                {items.map((item, index) => (
                  <div className="[&_input]:min-h-[40px] [&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:min-h-[40px] [&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] [&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] grid grid-cols-[minmax(0,_1fr)_125px_auto] gap-2 max-[681px]:later:grid-cols-[1fr]" key={`${index}-${item.product_id}`}>
                    <select
                      required
                      value={item.product_id}
                      onChange={(e) => setItems(items.map((row, i) => (i === index ? { ...row, product_id: e.target.value } : row)))}
                    >
                      <option value="">Select product</option>
                      {lookups.products.map((product) => (
                        <option
                          key={product.id}
                          value={product.id}
                          disabled={items.some((row, i) => i !== index && row.product_id === String(product.id))}
                        >
                          {product.name}
                        </option>
                      ))}
                    </select>
                    <input
                      required
                      aria-label="Requested quantity"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={item.quantity_requested}
                      onChange={(e) => setItems(items.map((row, i) => (i === index ? { ...row, quantity_requested: e.target.value } : row)))}
                    />
                    <button type="button" disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== index))}>Remove</button>
                    <EstimateHint locationId={locationId} productId={item.product_id} />
                  </div>
                ))}
                <button type="button" onClick={() => setItems([...items, newItem()])}>Add another item</button>
              </div>
            </Field>
            <Field label="Remarks" full>
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Delivery instructions, priority, or operational context" />
            </Field>
          </form>
        </Modal>
      )}

      {detailId && (
        <SupplyRequestDetailModal
          requestId={detailId}
          onClose={() => setDetailId(null)}
          onAction={(request, nextStatus) => {
            setDetailId(null);
            handleAction(request, nextStatus);
          }}
        />
      )}

      {dispatchId && (
        <MarkDispatchedModal
          requestId={dispatchId}
          onClose={() => setDispatchId(null)}
          onDispatched={async () => {
            setDispatchId(null);
            setSuccess('Request marked as dispatched.');
            await remote.reload({ silent: true });
          }}
        />
      )}

      {dateRevisionId && (
        <DateRevisionModal
          requestId={dateRevisionId}
          onClose={() => setDateRevisionId(null)}
          onConfirmed={async () => {
            setDateRevisionId(null);
            setSuccess('New delivery date confirmed. Request is now endorsed.');
            await remote.reload({ silent: true });
          }}
        />
      )}

      {cancelTarget && (
        <CancelRejectModal
          request={cancelTarget.request}
          nextStatus={cancelTarget.nextStatus}
          onClose={() => setCancelTarget(null)}
          onDone={async () => {
            const wasReject = cancelTarget.nextStatus === 'rejected';
            setCancelTarget(null);
            setSuccess(wasReject ? 'Request rejected.' : 'Request cancelled.');
            await remote.reload({ silent: true });
          }}
        />
      )}

      {prepareId && (
        <StartPrepareModal
          requestId={prepareId}
          onClose={() => setPrepareId(null)}
          onPrepared={async () => {
            setPrepareId(null);
            setSuccess('Preparing started — warehouse stock was deducted.');
            await remote.reload({ silent: true });
          }}
        />
      )}

      {deliverId && (
        <MarkDeliveredModal
          requestId={deliverId}
          onClose={() => setDeliverId(null)}
          onDelivered={async () => {
            setDeliverId(null);
            setSuccess('Request marked as delivered.');
            await remote.reload({ silent: true });
          }}
        />
      )}

      {confirmTransition && (
        <Modal
          title={confirmTransition.nextStatus === 'completed' ? 'Complete request' : `${actionLabel[confirmTransition.nextStatus]} request`}
          onClose={() => setConfirmTransition(null)}
          size="small"
          footer={
            <>
              <button onClick={() => setConfirmTransition(null)}>Keep request</button>
              <button
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                onClick={() => runTransition(confirmTransition.request, confirmTransition.nextStatus)}
                disabled={busyId === confirmTransition.request.id}
              >
                {busyId === confirmTransition.request.id
                  ? 'Updating…'
                  : (confirmTransition.nextStatus === 'completed'
                    ? 'Yes, mark complete'
                    : `Yes, ${actionLabel[confirmTransition.nextStatus].toLowerCase()}`)}
              </button>
            </>
          }
        >
          <Notice type="error">{actionError}</Notice>
          <div className="grid grid-cols-[48px_minmax(0,_1fr)] gap-[14px] [align-items:start] [&_strong]:block [&_strong]:m-[2px_0_7px] later-2:[&_strong]:text-text later-3:[&_strong]:text-[11px] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[9px] [&_p]:leading-[1.6] max-[451px]:later:grid-cols-[1fr]">
            <span className="confirmation-icon w-[48px] h-[48px] grid place-items-center rounded-[15px] text-danger-text [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)] text-[18px] [&.confirmation-icon]:text-accent-text [&.confirmation-icon]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)]"><FaTruckFast /></span>
            <div>
              <strong>{confirmTransition.request.request_number}</strong>
              <p>
                {confirmTransition.nextStatus === 'preparing'
                  ? 'Starting preparation deducts the requested quantities from warehouse stock now. If stock is short the request stays Endorsed — nothing is deducted — and Admin can propose a new delivery date instead.'
                  : 'Mark this request as Complete? It will leave the main table and move to history. This cannot be undone.'}
              </p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
