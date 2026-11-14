// Confirm Receipt (branch): per item good, damaged and short, which must add up to what was
// dispatched; damaged needs a reason and a photo, short needs a reason. Only the good quantity is
// added to the branch stock.
import React, { useMemo, useState } from 'react';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { receiptLineErrors } from '../../lib/branchWorkspace';
import { Modal, Notice } from '../ApiUi';
import { BTN_GHOST, BTN_PRIMARY, INPUT, LABEL, qty } from '../supply/supplyStyles';

const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—');
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_MB = 10;

export default function BranchReceiptModal({ request, onClose, onDone }) {
  const items = request.items || [];
  const shippedOf = (item) => Number(item.quantity_prepared ?? item.quantity_endorsed ?? item.quantity_requested);
  const shipped = items.filter((item) => shippedOf(item) > 0);
  const [lines, setLines] = useState(() => Object.fromEntries(shipped.map((item) => [item.id, { good: String(shippedOf(item)), damaged: '0', short: '0', damage_reason: '', short_reason: '', photo: null }])));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serverFields, setServerFields] = useState({});
  const delivery = request.delivery;

  const errors = useMemo(() => Object.fromEntries(shipped.map((item) => [item.id, receiptLineErrors(lines[item.id], shippedOf(item))])), [lines, shipped]);
  const valid = shipped.every((item) => Object.keys(errors[item.id]).length === 0);
  const set = (id, patch) => setLines((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const pickPhoto = (id, file) => {
    if (!file) { set(id, { photo: null }); return; }
    if (!PHOTO_TYPES.includes(file.type)) { setError('The photo must be a JPG, PNG or WebP image.'); return; }
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) { setError(`The photo must be ${MAX_PHOTO_MB} MB or smaller.`); return; }
    setError('');
    set(id, { photo: file });
  };

  const submit = async () => {
    setTouched(true);
    if (!valid) { setError('Please fix the highlighted items.'); return; }
    setBusy(true); setError(''); setServerFields({});
    try {
      const form = new FormData();
      form.append('lines', JSON.stringify(shipped.map((item) => {
        const l = lines[item.id];
        return { item_id: item.id, good: Number(l.good), damaged: Number(l.damaged || 0), short: Number(l.short || 0), damage_reason: l.damage_reason.trim() || null, short_reason: l.short_reason.trim() || null };
      })));
      for (const item of shipped) if (lines[item.id].photo && Number(lines[item.id].damaged) > 0) form.append(`photo_${item.id}`, lines[item.id].photo);
      const res = await api.post(`/supply-requests/${request.id}/receipt`, form);
      onDone(res.data);
    } catch (caught) {
      if (caught instanceof ApiError) setServerFields(Object.fromEntries(Object.entries(caught.errors || {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])));
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Confirm receipt · ${request.request_number}`}
      onClose={onClose}
      footer={<><button type="button" className={BTN_GHOST} onClick={onClose} disabled={busy}>Back</button><button type="button" className={BTN_PRIMARY} onClick={submit} disabled={busy || (touched && !valid)}>{busy ? 'Saving…' : 'Confirm receipt'}</button></>}
    >
      <Notice type="error">{error}</Notice>
      {delivery?.driver_name && (
        <div className="grid grid-cols-3 gap-[8px] mb-[12px] max-[560px]:grid-cols-1 [&>div]:p-[8px_11px] [&>div]:border [&>div]:border-line [&>div]:rounded-[10px] [&_small]:block [&_small]:text-muted [&_small]:text-[10.5px] [&_b]:text-text [&_b]:text-[13px]">
          <div><small>Driver</small><b>{delivery.driver_name}</b> <span className="text-muted text-[12px]">{delivery.driver_contact}</span></div>
          <div><small>Plate number</small><b>{delivery.plate_number}</b></div>
          <div><small>ETA</small><b>{when(delivery.eta_at)}</b></div>
        </div>
      )}
      <p className="m-[0_0_10px] text-muted text-[12px] leading-[1.5]">Count what arrived. For each item, good + damaged + short must equal what was sent. Only the good quantity is added to your stock; damaged items are not returned to the warehouse.</p>
      <div className="grid gap-[10px]">
        {items.map((item, index) => {
          if (!(shippedOf(item) > 0)) return null;
          const l = lines[item.id];
          const e = touched || l.good !== String(shippedOf(item)) || l.damaged !== '0' || l.short !== '0' ? errors[item.id] : {};
          const server = (key) => serverFields[`lines.${index}${key ? `.${key}` : ''}`];
          const unit = item.product?.unit || item.unit_snapshot || '';
          const total = Number(l.good || 0) + Number(l.damaged || 0) + Number(l.short || 0);
          return (
            <fieldset key={item.id} className={`m-0 p-[11px_12px] border rounded-[12px] ${e.sum || server() ? 'border-[color:var(--danger)]' : 'border-line'}`}>
              <legend className="p-[0_4px] text-text text-[13px] font-[750]">{item.product?.name || item.product_name_snapshot} · sent {qty(shippedOf(item))} {unit}</legend>
              <div className="grid grid-cols-3 gap-[8px]">
                {[['good', 'Good'], ['damaged', 'Damaged'], ['short', 'Short']].map(([key, label]) => (
                  <div key={key}>
                    <label className={LABEL} htmlFor={`receipt-${item.id}-${key}`}>{label}</label>
                    <input id={`receipt-${item.id}-${key}`} className={INPUT} type="number" min="0" step="0.01" inputMode="decimal" value={l[key]} onChange={(ev) => set(item.id, { [key]: ev.target.value })} />
                  </div>
                ))}
              </div>
              <small role={e.sum ? 'alert' : undefined} className={`block mt-[5px] text-[11.5px] ${e.sum ? 'text-danger-text' : 'text-muted'}`}>{e.sum || `${qty(total)} of ${qty(shippedOf(item))} ${unit} accounted for`}</small>
              {server() && <small role="alert" className="block text-danger-text text-[11.5px]">{server()}</small>}
              {Number(l.damaged) > 0 && (
                <div className="mt-[8px] grid gap-[8px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[560px]:grid-cols-1">
                  <div>
                    <label className={LABEL} htmlFor={`receipt-${item.id}-damage-reason`}>Damage reason</label>
                    <input id={`receipt-${item.id}-damage-reason`} className={INPUT} value={l.damage_reason} maxLength={500} onChange={(ev) => set(item.id, { damage_reason: ev.target.value })} placeholder="What happened to them?" />
                    {(e.damage_reason || server('damage_reason')) && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{e.damage_reason || server('damage_reason')}</small>}
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`receipt-${item.id}-photo`}>Photo of the damage</label>
                    <input id={`receipt-${item.id}-photo`} className={`${INPUT} !p-[6px]`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(ev) => pickPhoto(item.id, ev.target.files?.[0] || null)} />
                    {(e.photo || server('photo')) && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{e.photo || server('photo')}</small>}
                  </div>
                </div>
              )}
              {Number(l.short) > 0 && (
                <div className="mt-[8px]">
                  <label className={LABEL} htmlFor={`receipt-${item.id}-short-reason`}>Why is it short?</label>
                  <input id={`receipt-${item.id}-short-reason`} className={INPUT} value={l.short_reason} maxLength={500} onChange={(ev) => set(item.id, { short_reason: ev.target.value })} placeholder="For example: one box missing" />
                  {(e.short_reason || server('short_reason')) && <small role="alert" className="block mt-[3px] text-danger-text text-[11.5px]">{e.short_reason || server('short_reason')}</small>}
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
    </Modal>
  );
}
