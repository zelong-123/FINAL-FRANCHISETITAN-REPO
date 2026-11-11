import { useState } from 'react';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { printDeliveryReceipt } from '../../lib/deliveryReceipt';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';
import { Callout } from './supplyUi';
import { BTN_GHOST, BTN_PRIMARY, INPUT, LABEL, qty } from './supplyStyles';

const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const FIELDS = [
  { key: 'driver_name', label: 'Driver name', type: 'text', placeholder: 'Juan Dela Cruz', hint: 'Letters, spaces and . - \' only' },
  { key: 'driver_contact', label: 'Driver contact', type: 'tel', placeholder: '09171234567', hint: '11 digits', max: 11 },
  { key: 'plate_number', label: 'Plate number', type: 'text', placeholder: 'ABC 1234' },
  { key: 'departed_at', label: 'Departure', type: 'datetime-local', hint: 'Not in the future' },
  { key: 'eta_at', label: 'ETA', type: 'datetime-local', hint: 'On or after the departure' },
];
/** Saturday or Sunday in Manila for a datetime-local value (entered in the browser's zone). */
function weekendInManila(value) {
  if (!value) return false;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' }).format(new Date(value));
  return day === 'Sat' || day === 'Sun';
}

/**
 * Dispatch a request that is Preparing: driver, vehicle, departure and ETA. The endorsed quantities
 * leave the warehouse now. Afterwards the Delivery Receipt can be printed.
 */
export default function MarkDispatchedModal({ requestId, onClose, onDispatched }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [done, setDone] = useState(null); // the dispatched request
  const [form, setForm] = useState(() => ({ driver_name: '', driver_contact: '', plate_number: '', departed_at: nowLocal(), eta_at: nowLocal() }));
  const complete = FIELDS.every((field) => String(form[field.key] || '').trim());
  const remote = useRemote(async () => (await api.get(`/supply-requests/${requestId}`)).data, [requestId]);
  const request = remote.data;
  const items = (request?.items || []).filter((i) => Number(i.quantity_endorsed ?? i.quantity_requested) > 0);
  const weekend = weekendInManila(form.eta_at);

  const confirm = async () => {
    setSaving(true); setError(''); setFieldErrors({});
    try {
      const res = await api.post(`/supply-requests/${requestId}/dispatch`, {
        ...form, plate_number: form.plate_number.toUpperCase(),
        departed_at: new Date(form.departed_at).toISOString(), eta_at: new Date(form.eta_at).toISOString(),
      });
      setDone(res.data);
    } catch (caught) {
      const errors = caught instanceof ApiError ? Object.fromEntries(Object.entries(caught.errors || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) : {};
      setFieldErrors(errors);
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };
  const print = async () => {
    try {
      const opened = await printDeliveryReceipt(async () => (await api.get(`/supply-requests/${requestId}/delivery-receipt`)).data);
      if (!opened) setError('Allow pop-ups for this site to print the Delivery Receipt.');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  const footer = done ? (
    <>
      <button type="button" className={BTN_GHOST} onClick={print}>Print Delivery Receipt</button>
      <button type="button" className={BTN_PRIMARY} onClick={() => onDispatched(done)}>Done</button>
    </>
  ) : request ? (
    <>
      <button type="button" className={BTN_GHOST} onClick={onClose} disabled={saving}>Back</button>
      <button type="button" className={BTN_PRIMARY} onClick={confirm} disabled={saving || !complete}>{saving ? 'Dispatching…' : 'Confirm dispatch'}</button>
    </>
  ) : null;

  return (
    <Modal title={request ? `Dispatch ${request.request_number}` : 'Dispatch request'} onClose={done ? () => onDispatched(done) : onClose} footer={footer}>
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      <Notice type="error">{error}</Notice>
      {!request && !remote.error && <EmptyState label="Loading request…" />}
      {done && (
        <>
          <Notice type="success">{done.request_number} is on the way. The warehouse stock was deducted and the branch was notified.</Notice>
          {(done.warnings || []).map((w) => <Callout key={w}>{w}</Callout>)}
          <p className="text-muted text-[12px]">Print the Delivery Receipt for the driver: it lists the items, driver, plate, departure, ETA and the signature lines.</p>
        </>
      )}
      {request && !done && (
        <>
          <div className="grid grid-cols-2 gap-[12px] max-[560px]:grid-cols-1">
            {FIELDS.map((field) => (
              <div key={field.key}>
                <label className={LABEL} htmlFor={`dispatch-${field.key}`}>{field.label}</label>
                <input
                  id={`dispatch-${field.key}`} className={INPUT} type={field.type} value={form[field.key]} placeholder={field.placeholder}
                  maxLength={field.max || 120} max={field.key === 'departed_at' ? nowLocal() : undefined} aria-invalid={Boolean(fieldErrors[field.key])}
                  onChange={(e) => setForm((current) => ({ ...current, [field.key]: e.target.value }))}
                />
                {fieldErrors[field.key] ? <small role="alert" className="block mt-[4px] text-danger-text text-[11.5px]">{fieldErrors[field.key]}</small> : field.hint && <small className="block mt-[4px] text-muted text-[11px]">{field.hint}</small>}
              </div>
            ))}
          </div>
          {weekend && <Callout>The ETA is on a weekend. Make sure the branch can receive.</Callout>}
          <h4 className="m-[16px_0_6px] text-muted text-[10.5px] font-[800] tracking-[.14em] uppercase">Items to load (endorsed)</h4>
          <ul className="m-0 p-0 [list-style:none] grid gap-[6px]">
            {items.map((item) => (
              <li key={item.id} className="flex justify-between gap-3 p-[8px_12px] border border-line rounded-[10px] text-[13px]">
                <span className="text-text">{item.product?.name || item.product_name_snapshot}</span>
                <b className="text-text">{qty(item.quantity_endorsed ?? item.quantity_requested)} {item.product?.unit || item.unit_snapshot}</b>
              </li>
            ))}
          </ul>
          <small className="block mt-[8px] text-muted text-[11.5px]">The prepared quantity must equal the endorsed one. If something is short, close this and use Report shortage.</small>
        </>
      )}
    </Modal>
  );
}
