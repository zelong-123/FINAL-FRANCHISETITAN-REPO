// The Supply Requests action modals. Every reason the API requires is required here too, and the
// API's own messages appear under the field they belong to.
import React, { useEffect, useMemo, useState } from 'react';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { Modal, Notice } from '../ApiUi';
import { Callout } from './supplyUi';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, INPUT, LABEL, qty } from './supplyStyles';

const REASON_MIN = 5;
const todayInput = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Field errors from an API 422: { field: message }. */
function errorsOf(error) {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(error.errors || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]));
}
function FieldError({ children }) {
  if (!children) return null;
  return <small role="alert" className="block mt-[4px] text-danger-text text-[11.5px] leading-[1.4]">{children}</small>;
}

/** Shared submit state for every modal. */
function useSubmit(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const run = async (fn) => {
    setBusy(true); setError(''); setFields({});
    try {
      const result = await fn();
      onDone(result);
    } catch (caught) {
      const byField = errorsOf(caught);
      setFields(byField);
      setError(Object.keys(byField).length ? 'Please check the highlighted fields.' : firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, run, setError };
}

function Footer({ onClose, busy, label, onConfirm, danger = false, disabled = false }) {
  return (
    <>
      <button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Back</button>
      <button type="button" className={danger ? BTN_DANGER : BTN_PRIMARY} onClick={onConfirm} disabled={busy || disabled}>{busy ? 'Saving…' : label}</button>
    </>
  );
}

function ReasonField({ id, label = 'Reason', value, onChange, error, placeholder }) {
  return (
    <div className="mt-[12px]">
      <label className={LABEL} htmlFor={id}>{label} (required, at least {REASON_MIN} characters)</label>
      <textarea id={id} className={`${INPUT} min-h-[84px] [resize:vertical]`} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-invalid={Boolean(error)} />
      <FieldError>{error}</FieldError>
    </div>
  );
}

const REASON_COPY = {
  return: { title: 'Return for correction', confirm: 'Return to branch', path: 'return', note: 'The branch edits the request and resubmits it under the same number.' },
  reject: { title: 'Reject request', confirm: 'Reject request', path: 'reject', danger: true, note: 'This is final. Any reserved stock is released.' },
  cancel: { title: 'Cancel request', confirm: 'Cancel request', path: 'cancel', danger: true, note: 'Allowed until the request is dispatched. Reserved stock is released.' },
};

/** Return, Reject and Cancel: a required reason. */
export function ReasonModal({ kind, request, onClose, onDone }) {
  const copy = REASON_COPY[kind];
  const [reason, setReason] = useState('');
  const s = useSubmit(onDone);
  const submit = () => {
    if (reason.trim().length < REASON_MIN) { s.setError(`Enter a reason of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/${copy.path}`, { reason: reason.trim() }));
  };
  return (
    <Modal title={copy.title} size="small" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label={copy.confirm} danger={copy.danger} onConfirm={submit} />}>
      <Notice type="error">{s.error}</Notice>
      <p className="m-0 text-text text-[13px] font-[700]">{request.request_number}</p>
      <p className="m-[4px_0_0] text-muted text-[12px] leading-[1.5]">{copy.note}</p>
      <ReasonField id={`reason-${kind}`} value={reason} onChange={setReason} error={s.fields.reason} />
    </Modal>
  );
}

const ACTIONS = [
  ['accept_loss', 'Accept loss', 'The damaged or short items are written off.'],
  ['logistics_investigation', 'For Logistics investigation', 'Logistics looks into the packing or the trip.'],
  ['branch_rerequest', 'Branch to re-request', 'The branch creates a new request for what it still needs.'],
];
export function ResolveDiscrepancyModal({ request, onClose, onDone }) {
  const [action, setAction] = useState('');
  const [remarks, setRemarks] = useState('');
  const s = useSubmit(onDone);
  const submit = () => {
    if (!action) { s.setError('Choose how the discrepancy is resolved.'); return; }
    if (remarks.trim().length < REASON_MIN) { s.setError(`Enter remarks of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/discrepancy/resolve`, { action, remarks: remarks.trim() }));
  };
  return (
    <Modal title="Resolve discrepancy" size="small" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Complete with discrepancy" onConfirm={submit} />}>
      <Notice type="error">{s.error}</Notice>
      <fieldset className="m-0 p-0 border-0 grid gap-[8px]">
        <legend className={LABEL}>Action (required)</legend>
        {ACTIONS.map(([key, label, hint]) => (
          <label key={key} className={`flex gap-[10px] items-start p-[10px_12px] border rounded-[11px] cursor-pointer ${action === key ? 'border-accent [background:var(--hover)]' : 'border-line'}`}>
            <input type="radio" name="discrepancy-action" value={key} checked={action === key} onChange={() => setAction(key)} className="mt-[3px]" />
            <span><b className="block text-text text-[13px]">{label}</b><small className="text-muted text-[11.5px]">{hint}</small></span>
          </label>
        ))}
      </fieldset>
      <FieldError>{s.fields.action}</FieldError>
      <ReasonField id="discrepancy-remarks" label="Remarks" value={remarks} onChange={setRemarks} error={s.fields.remarks} />
    </Modal>
  );
}

const TYPES = [
  ['hold', 'Hold for Restock', 'Nothing ships yet; the request waits on hold.'],
  ['partial_ship_now', 'Partial – Ship Now', 'The available part ships; the rest becomes a -B backorder on hold.'],
  ['partial_consolidated', 'Partial – Consolidated', 'The available part is reserved; everything ships together after the restock.'],
];

/**
 * Fulfillment Decision: a per-item grid (available, unavailable, restock date), the type and a
 * reason. The preview from /fulfillment/preview is shown before confirming.
 */
export function FulfillmentModal({ request, onClose, onDone }) {
  const [type, setType] = useState('partial_ship_now');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState(null); // [{ item_id, name, unit, requested, max_available, available, restock_date }]
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const s = useSubmit(onDone);

  // The first preview gives the per-item caps (warehouse net of reservations, or the reported count).
  useEffect(() => {
    let alive = true;
    api.post(`/supply-requests/${request.id}/fulfillment/preview`, { type: 'hold' })
      .then((res) => { if (alive) setLines(res.data.items.map((i) => ({ ...i, available: String(i.max_available), restock_date: '' }))); })
      .catch((error) => { if (alive) setPreviewError(firstValidationMessage(error)); });
    return () => { alive = false; };
  }, [request.id]);

  const payloadItems = useMemo(() => (lines || []).map((l) => ({ item_id: l.item_id, available: l.available === '' ? null : Number(l.available), restock_date: l.restock_date || null })), [lines]);

  // Live preview of what will happen (debounced).
  useEffect(() => {
    if (!lines) return undefined;
    const timer = window.setTimeout(() => {
      api.post(`/supply-requests/${request.id}/fulfillment/preview`, { type, items: payloadItems })
        .then((res) => { setPreview(res.data); setPreviewError(''); })
        .catch((error) => { setPreview(null); setPreviewError(firstValidationMessage(error)); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [type, payloadItems, lines, request.id]);

  const setLine = (index, patch) => setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const submit = () => {
    if (reason.trim().length < REASON_MIN) { s.setError(`Enter a reason of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/fulfillment`, { type, reason: reason.trim(), items: payloadItems }));
  };

  return (
    <Modal title={`Fulfillment decision · ${request.request_number}`} size="wide" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Confirm decision" onConfirm={submit} disabled={!lines || Boolean(previewError)} />}>
      <Notice type="error">{s.error}</Notice>
      {request.pending_shortage_report && (
        <Callout><b>Shortage reported by Logistics:</b> {request.pending_shortage_report.reason}. The available quantities are capped by the actual count.</Callout>
      )}
      <fieldset className="m-[4px_0_0] p-0 border-0 grid grid-cols-3 gap-[8px] max-[720px]:grid-cols-1">
        <legend className={LABEL}>Fulfillment type</legend>
        {TYPES.map(([key, label, hint]) => (
          <label key={key} className={`flex gap-[9px] items-start p-[10px_12px] border rounded-[11px] cursor-pointer ${type === key ? 'border-accent [background:var(--hover)]' : 'border-line'}`}>
            <input type="radio" name="fulfillment-type" value={key} checked={type === key} onChange={() => setType(key)} className="mt-[3px]" />
            <span><b className="block text-text text-[13px]">{label}</b><small className="text-muted text-[11.5px] leading-[1.4]">{hint}</small></span>
          </label>
        ))}
      </fieldset>

      <div className="mt-[14px] overflow-x-auto">
        {!lines ? <p className="text-muted text-[12px]">{previewError || 'Loading the warehouse availability…'}</p> : (
          <table className="w-full min-w-[620px] [border-collapse:collapse] text-[12.5px] [&_th]:p-[8px] [&_th]:text-left [&_th]:text-muted [&_th]:text-[10.5px] [&_th]:font-[750] [&_th]:tracking-[.08em] [&_th]:uppercase [&_td]:p-[8px] [&_td]:border-t [&_td]:border-line [&_td]:align-top">
            <thead><tr><th>Item</th><th>Requested</th><th>Available (max)</th><th>Unavailable</th><th>Expected restock</th></tr></thead>
            <tbody>
              {lines.map((line, index) => {
                const unavailable = Math.max(0, Number(line.requested) - Number(line.available || 0));
                return (
                  <tr key={line.item_id}>
                    <td className="text-text font-[650]">{line.name}</td>
                    <td>{qty(line.requested)} {line.unit}</td>
                    <td>
                      <input aria-label={`${line.name} available`} className={`${INPUT} !min-h-[34px] w-[110px]`} type="number" min="0" step="0.01" max={line.max_available} value={line.available} onChange={(e) => setLine(index, { available: e.target.value })} />
                      <small className="block text-muted text-[11px] mt-[3px]">max {qty(line.max_available)}</small>
                      <FieldError>{s.fields[`items.${index}.available`]}</FieldError>
                    </td>
                    <td className={unavailable > 0 ? 'text-danger-text font-[700]' : ''}>{qty(unavailable)} {line.unit}{unavailable > 0 ? ' ⚠' : ''}</td>
                    <td>
                      {unavailable > 0 ? (
                        <>
                          <input aria-label={`${line.name} expected restock date`} className={`${INPUT} !min-h-[34px] w-[150px]`} type="date" min={todayInput()} value={line.restock_date} onChange={(e) => setLine(index, { restock_date: e.target.value })} />
                          <small className="block text-muted text-[11px] mt-[3px]">Required</small>
                        </>
                      ) : <span className="text-muted" title="Nothing is unavailable">—</span>}
                      <FieldError>{s.fields[`items.${index}.restock_date`]}</FieldError>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {previewError && lines && <Callout tone="danger">{previewError}</Callout>}
      {preview && !previewError && <Callout tone="info"><b>Preview:</b> {preview.message}</Callout>}
      <FieldError>{s.fields.type}</FieldError>
      <ReasonField id="fulfillment-reason" label="Admin reason" value={reason} onChange={setReason} error={s.fields.reason} placeholder={type === 'partial_consolidated' ? 'For example: same trip' : ''} />
    </Modal>
  );
}

export function RestockDateModal({ request, onClose, onDone }) {
  const [date, setDate] = useState(request.expected_restock_date || '');
  const [reason, setReason] = useState('');
  const s = useSubmit(onDone);
  const submit = () => {
    if (!date) { s.setError('Choose the new expected restock date.'); return; }
    if (reason.trim().length < REASON_MIN) { s.setError(`Enter a reason of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/restock-date`, { restock_date: date, reason: reason.trim() }));
  };
  return (
    <Modal title="Update restock date" size="small" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Save restock date" onConfirm={submit} />}>
      <Notice type="error">{s.error}</Notice>
      <p className="m-0 text-muted text-[12px]">Current: {request.expected_restock_date || 'not set'} · changed {request.restock_revision_count || 0} time(s). The branch is notified.</p>
      <div className="mt-[12px]">
        <label className={LABEL} htmlFor="restock-date">New expected restock date</label>
        <input id="restock-date" className={INPUT} type="date" min={todayInput()} value={date} onChange={(e) => setDate(e.target.value)} />
        <FieldError>{s.fields.restock_date}</FieldError>
      </div>
      <ReasonField id="restock-reason" value={reason} onChange={setReason} error={s.fields.reason} />
    </Modal>
  );
}

export function RequestDateModal({ request, onClose, onDone }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const s = useSubmit(onDone);
  const submit = () => {
    if (!date) { s.setError('Choose the proposed delivery date.'); return; }
    if (reason.trim().length < REASON_MIN) { s.setError(`Enter a reason of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/date-change`, { proposed_date: date, reason: reason.trim() }));
  };
  return (
    <Modal title="Request new delivery date" size="small" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Send to Admin" onConfirm={submit} />}>
      <Notice type="error">{s.error}</Notice>
      <p className="m-0 text-muted text-[12px]">Current date: {request.effective_delivery_date || request.target_delivery_date || 'not set'}. Admin approves or rejects the new date.</p>
      <div className="mt-[12px]">
        <label className={LABEL} htmlFor="proposed-date">Proposed delivery date</label>
        <input id="proposed-date" className={INPUT} type="date" min={todayInput()} value={date} onChange={(e) => setDate(e.target.value)} />
        <FieldError>{s.fields.proposed_date}</FieldError>
      </div>
      <ReasonField id="date-reason" value={reason} onChange={setReason} error={s.fields.reason} />
    </Modal>
  );
}

/** Report Shortage: the actual count of every item, and a reason. Inventory is not changed. */
export function ShortageModal({ request, onClose, onDone }) {
  const items = request.items || [];
  const [counts, setCounts] = useState(() => Object.fromEntries(items.map((i) => [i.id, ''])));
  const [reason, setReason] = useState('');
  const s = useSubmit(onDone);
  const submit = () => {
    if (items.some((i) => counts[i.id] === '')) { s.setError('Enter the actual count of every item.'); return; }
    if (reason.trim().length < REASON_MIN) { s.setError(`Enter a reason of at least ${REASON_MIN} characters.`); return; }
    s.run(() => api.post(`/supply-requests/${request.id}/shortage`, { reason: reason.trim(), items: items.map((i) => ({ item_id: i.id, actual_count: Number(counts[i.id]) })) }));
  };
  return (
    <Modal title={`Report shortage · ${request.request_number}`} onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Send to Admin" onConfirm={submit} />}>
      <Notice type="error">{s.error}</Notice>
      <p className="m-0 text-muted text-[12px] leading-[1.5]">Count what is really on the shelf. Admin makes a new Fulfillment Decision. This does not change the warehouse quantity; use Warehouse inventory → Adjust for that.</p>
      <div className="mt-[12px] grid gap-[8px]">
        {items.map((item, index) => {
          const toShip = Number(item.quantity_endorsed ?? item.quantity_requested);
          return (
            <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_150px] gap-[10px] items-center p-[9px_12px] border border-line rounded-[11px] max-[520px]:grid-cols-1">
              <div><b className="block text-text text-[13px]">{item.product?.name || item.product_name_snapshot}</b><small className="text-muted text-[11.5px]">To ship: {qty(toShip)} {item.product?.unit || item.unit_snapshot}</small></div>
              <div>
                <input aria-label={`${item.product?.name} actual count`} className={INPUT} type="number" min="0" step="0.01" placeholder="Actual count" value={counts[item.id]} onChange={(e) => setCounts((c) => ({ ...c, [item.id]: e.target.value }))} />
                <FieldError>{s.fields[`items.${index}.actual_count`]}</FieldError>
              </div>
            </div>
          );
        })}
      </div>
      <FieldError>{s.fields.items}</FieldError>
      <ReasonField id="shortage-reason" value={reason} onChange={setReason} error={s.fields.reason} />
    </Modal>
  );
}

/** Admin: the two supply settings. They do not change the forecast's own lead time. */
export function SupplySettingsModal({ onClose, onDone }) {
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState('');
  const s = useSubmit(onDone);
  useEffect(() => {
    api.get('/supply-settings')
      .then((res) => setForm({ lead: String(res.data.lead_days), bulk: String(res.data.bulk_percent), current: res.data }))
      .catch((error) => setLoadError(firstValidationMessage(error)));
  }, []);
  const submit = () => s.run(() => api.put('/supply-settings', { supply_lead_time_working_days: Number(form.lead), bulk_threshold_percent: Number(form.bulk) }));
  return (
    <Modal title="Supply settings" size="small" onClose={onClose} footer={<Footer onClose={onClose} busy={s.busy} label="Save settings" onConfirm={submit} disabled={!form} />}>
      <Notice type="error">{loadError || s.error}</Notice>
      {form && (
        <>
          <p className="m-0 text-muted text-[12px]">Current: {form.current.lead_days} working day(s) lead time · bulk check above {form.current.bulk_percent}% of the suggestion.</p>
          <div className="mt-[12px]">
            <label className={LABEL} htmlFor="setting-lead">Lead time (working days, 1–10)</label>
            <input id="setting-lead" className={INPUT} type="number" min="1" max="10" step="1" value={form.lead} onChange={(e) => setForm({ ...form, lead: e.target.value })} />
            <small className="block mt-[4px] text-muted text-[11.5px]">The earliest target date a branch may choose (Mon–Fri; weekends are not counted).</small>
            <FieldError>{s.fields.supply_lead_time_working_days}</FieldError>
          </div>
          <div className="mt-[12px]">
            <label className={LABEL} htmlFor="setting-bulk">Bulk threshold (%)</label>
            <input id="setting-bulk" className={INPUT} type="number" min="0" max="1000" step="1" value={form.bulk} onChange={(e) => setForm({ ...form, bulk: e.target.value })} />
            <small className="block mt-[4px] text-muted text-[11.5px]">A quantity this much above the suggested quantity needs a bulk reason (not a block).</small>
            <FieldError>{s.fields.bulk_threshold_percent}</FieldError>
          </div>
          <Callout tone="info">These settings are for supply requests only. They do <b>not</b> change the forecast's own lead time (Analytics and Forecasting settings).</Callout>
        </>
      )}
    </Modal>
  );
}
