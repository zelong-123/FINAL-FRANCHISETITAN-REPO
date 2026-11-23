import { useState } from 'react';
import { FaCircleInfo } from 'react-icons/fa6';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { printDeliveryReceipt } from '../../lib/deliveryReceipt';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';
import { Callout, Section } from './supplyUi';
import { BTN_GHOST, BTN_PRIMARY, BTN_SMALL, INPUT, LABEL, qty } from './supplyStyles';
import SchedulePicker from './SchedulePicker';

const pad2 = (value) => String(value).padStart(2, '0');
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
/** "YYYY-MM-DD" plus a number of days, staying in the browser's own calendar. */
const addDays = (day, days) => {
  const [year, month, date] = String(day).split('-').map(Number);
  const next = new Date(year, month - 1, date + days);
  return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
};
const FIELDS = [
  { key: 'driver_name', label: 'Driver name', type: 'text', placeholder: 'Juan Dela Cruz', hint: 'Letters, spaces and . - \' only', group: 'driver' },
  { key: 'driver_contact', label: 'Driver contact', type: 'tel', placeholder: '09171234567', hint: '11 digits', max: 11, group: 'driver' },
  { key: 'plate_number', label: 'Plate number', type: 'text', placeholder: 'ABC 1234', group: 'driver' },
  { key: 'departed_at', label: 'Departure', hint: 'Not in the future', group: 'schedule' },
  { key: 'eta_at', label: 'ETA (arrival date)', hint: 'At least 2 days after departure · weekends allowed', group: 'schedule' },
];
/** Saturday or Sunday in Manila for a datetime-local value (entered in the browser's zone). */
function weekendInManila(value) {
  if (!value) return false;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' }).format(new Date(value));
  return day === 'Sat' || day === 'Sun';
}

/** One labelled field with its hint or field error; the API error always wins. */
function Field({ field, error, children }) {
  return (
    <div className="min-w-0">
      <label className={LABEL} htmlFor={`dispatch-${field.key}`}>{field.label}</label>
      {children}
      {error
        ? <small role="alert" className="block mt-[4px] text-danger-text text-[11.5px]">{error}</small>
        : field.hint && <small className="block mt-[4px] text-muted text-[11px]">{field.hint}</small>}
    </div>
  );
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
  const [showItems, setShowItems] = useState(true);
  // ETA is a date only: an arrival hour is guesswork, so the payload uses 09:00 local.
  const [form, setForm] = useState(() => ({
    driver_name: '', driver_contact: '', plate_number: '', departed_at: nowLocal(), eta_at: addDays(nowLocal().slice(0, 10), 2),
  }));
  const todayDay = nowLocal().slice(0, 10);
  const departureDay = form.departed_at.slice(0, 10);
  // ETA: two days after the dispatch day at the earliest, and never today or a past day.
  const twoDaysOut = departureDay ? addDays(departureDay, 2) : todayDay;
  const etaMinDay = twoDaysOut > todayDay ? twoDaysOut : addDays(todayDay, 1);
  const etaTooEarly = Boolean(form.eta_at) && Boolean(etaMinDay) && form.eta_at < etaMinDay;
  const complete = FIELDS.every((field) => String(form[field.key] || '').trim()) && !etaTooEarly;
  const remote = useRemote(async () => (await api.get(`/supply-requests/${requestId}`)).data, [requestId]);
  const request = remote.data;
  const items = (request?.items || []).filter((i) => Number(i.quantity_endorsed ?? i.quantity_requested) > 0);
  const itemLabel = (item) => `${item.product?.name || item.product_name_snapshot} ${qty(item.quantity_endorsed ?? item.quantity_requested)} ${item.product?.unit || item.unit_snapshot}`;
  const weekend = weekendInManila(form.eta_at ? `${form.eta_at}T12:00` : '');
  const setField = (key, raw) => setForm((current) => ({ ...current, [key]: key === 'plate_number' ? raw.toUpperCase() : raw }));

  const confirm = async () => {
    setSaving(true); setError(''); setFieldErrors({});
    try {
      const res = await api.post(`/supply-requests/${requestId}/dispatch`, {
        ...form, plate_number: form.plate_number.toUpperCase(),
        departed_at: new Date(form.departed_at).toISOString(), eta_at: new Date(`${form.eta_at}T09:00`).toISOString(),
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

  // The modal's own footer shrinks buttons; these keep them readable at every width.
  const footerButton = '!min-h-[44px] !px-[18px] !text-[13px]';
  const footer = done ? (
    <>
      <button type="button" className={`${BTN_GHOST} ${footerButton}`} onClick={print}>Print Delivery Receipt</button>
      <button type="button" className={`${BTN_PRIMARY} ${footerButton}`} onClick={() => onDispatched(done)}>Done</button>
    </>
  ) : request ? (
    <>
      <button type="button" className={`${BTN_GHOST} ${footerButton}`} onClick={onClose} disabled={saving}>Back</button>
      <button type="button" className={`${BTN_PRIMARY} ${footerButton}`} onClick={confirm} disabled={saving || !complete}>{saving ? 'Dispatching…' : 'Confirm dispatch'}</button>
    </>
  ) : null;
  const title = (
    <span className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
      <span className="text-text text-[19px] font-[750] tracking-[-.01em]">{request ? 'Dispatch' : 'Dispatch request'}</span>
      {request && <span className="text-muted text-[12px] font-[500] [font-family:ui-monospace,monospace]">{request.request_number}</span>}
    </span>
  );

  return (
    <Modal title={title} onClose={done ? () => onDispatched(done) : onClose} footer={footer} size="dispatch">
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      <Notice type="error">{error}</Notice>
      {!request && !remote.error && <EmptyState label="Loading request…" />}
      {done && (
        <>
          <Notice type="success">{done.request_number} is on the way. The warehouse stock was deducted and the branch was notified.</Notice>
          {(done.warnings || []).map((w) => <Callout key={w} tone="info">{w}</Callout>)}
          <p className="text-muted text-[12px]">Print the Delivery Receipt for the driver: it lists the items, driver, plate, departure, ETA and the signature lines.</p>
        </>
      )}
      {request && !done && (
        <>
          <Section title="Driver and vehicle">
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-[12px] max-[680px]:grid-cols-1">
              {FIELDS.filter((f) => f.group === 'driver').map((field) => (
                <Field key={field.key} field={field} error={fieldErrors[field.key]}>
                  <input
                    id={`dispatch-${field.key}`} className={INPUT} type={field.type} value={form[field.key]} placeholder={field.placeholder}
                    maxLength={field.max || 120} aria-invalid={Boolean(fieldErrors[field.key])}
                    onChange={(e) => setField(field.key, e.target.value)}
                  />
                </Field>
              ))}
            </div>
          </Section>

          <Section title="Schedule">
            <div className="grid grid-cols-2 gap-[12px] max-[560px]:grid-cols-1">
              <Field field={FIELDS[3]} error={fieldErrors.departed_at}>
                <SchedulePicker
                  id="dispatch-departed_at" value={form.departed_at} onChange={(value) => setField('departed_at', value)}
                  maxDay={nowLocal().slice(0, 10)} maxDateTime={nowLocal()}
                />
              </Field>
              <Field field={FIELDS[4]} error={fieldErrors.eta_at || (etaTooEarly ? 'Move this 2 days after the departure' : '')}>
                <SchedulePicker id="dispatch-eta_at" mode="date" value={form.eta_at} onChange={(value) => setField('eta_at', value)} minDay={etaMinDay} />
              </Field>
            </div>
            {weekend && (
              <Callout tone="info">
                The ETA is on a weekend. Branches receive deliveries on weekends, so this is fine — Admin
                processes the papers on the next working day.
              </Callout>
            )}
          </Section>

          <Section
            title="Items to load (endorsed)"
            aside={(
              <button
                type="button" aria-expanded={showItems}
                className={`${BTN_GHOST} ${BTN_SMALL} !border-0 !px-[8px]`}
                onClick={() => setShowItems((open) => !open)}
              >
                {showItems ? 'Hide' : 'Show'}
              </button>
            )}
          >
            <div className="border border-line rounded-[12px] overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] p-[10px_12px] [background:var(--surface-subtle)] text-[12.5px]">
                <span className="text-text-secondary [overflow-wrap:anywhere]">{items.map(itemLabel).join(' · ') || 'No endorsed quantities'}</span>
                <span className="ml-auto text-muted whitespace-nowrap">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
              </div>
              {/* Kept mounted so the list slides open: the 0fr→1fr grid row animates the height. */}
              <div
                aria-hidden={!showItems}
                className={`grid [transition:grid-template-rows_.28s_ease,_opacity_.22s_ease] motion-reduce:[transition:none] ${showItems ? '[grid-template-rows:1fr] opacity-100' : '[grid-template-rows:0fr] opacity-0 pointer-events-none'}`}
              >
                <div className="min-h-0 overflow-hidden">
                  <ul className="m-0 p-0 [list-style:none]">
                    {items.map((item) => (
                      <li key={item.id} className="flex justify-between gap-3 p-[9px_12px] border-t border-line text-[13px]">
                        <span className="text-text">{item.product?.name || item.product_name_snapshot}</span>
                        <b className="text-text whitespace-nowrap">{qty(item.quantity_endorsed ?? item.quantity_requested)} {item.product?.unit || item.unit_snapshot}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            <p className="m-[8px_0_0] flex items-start gap-[7px] text-muted text-[11.5px] leading-[1.5]">
              <FaCircleInfo aria-hidden="true" className="mt-[2px] shrink-0" />
              <span>The prepared quantity must equal the endorsed one. If something is short, close this and use Report shortage.</span>
            </p>
          </Section>
        </>
      )}
    </Modal>
  );
}
