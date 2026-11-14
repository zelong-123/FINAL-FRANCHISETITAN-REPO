// The request detail, opening on the right: status, stepper, reasons, the next action for the
// signed-in role (others get a read-only line), details, items, fulfillment, delivery, receipt
// and discrepancy, and the audit trail.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaXmark } from 'react-icons/fa6';
import { api, fetchBlob, firstValidationMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { printDeliveryReceipt } from '../../lib/deliveryReceipt';
import { getSupplyActions, waitingLine } from '../../lib/supplyActions';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';
import { LoadingState, Notice } from '../ApiUi';
import { Callout, Chip, KV, Section, StatusChip, Stepper, UrgencyChip } from './supplyUi';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SMALL, STAGES, qty, stageIndex, branchLabel } from './supplyStyles';

const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—');
const ROLE_NAME = { admin: 'Admin', logistics: 'Logistics', franchisee: 'Branch', system: 'System' };
const TYPE_NAME = { full: 'Endorse – Full', hold: 'Hold for Restock', partial_ship_now: 'Partial – Ship Now', partial_consolidated: 'Partial – Consolidated' };
const DISCREPANCY_NAME = { accept_loss: 'Accept loss', logistics_investigation: 'For Logistics investigation', branch_rerequest: 'Branch to re-request' };
const ACTION_NAME = {
  submitted: 'Submitted', resubmitted: 'Resubmitted', draft_created: 'Draft saved', edited: 'Edited', review_started: 'Review started', returned: 'Returned for correction',
  rejected: 'Rejected', cancelled: 'Cancelled', endorsed_full: 'Endorsed – Full', fulfillment_hold: 'Hold for Restock', fulfillment_consolidated: 'Partial – Consolidated',
  fulfillment_partial_ship_now: 'Partial – Ship Now', backorder_created: 'Backorder created', resumed: 'Resumed', restock_date_updated: 'Restock date updated',
  schedule_accepted: 'Schedule accepted', date_change_requested: 'New date requested', date_change_approved: 'New date approved', date_change_rejected: 'New date rejected',
  shortage_reported: 'Shortage reported', preparing_started: 'Preparing started', dispatched: 'Dispatched', pod_encoded: 'POD encoded', receipt_confirmed: 'Receipt confirmed',
  discrepancy_opened: 'Discrepancy review', discrepancy_resolved: 'Discrepancy resolved', completed: 'Completed', migrated: 'Moved to the new workflow',
};
const STOCK_TONE = { out: 'danger', critical: 'danger', low: 'warning', ok: 'success', none: 'neutral' };

/** A private image as a thumbnail that enlarges (like the applicant documents); PDFs open in a tab. */
function Thumb({ requestId, doc, label }) {
  const [url, setUrl] = useState(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const image = String(doc.mime_type || '').startsWith('image/');
  useEffect(() => {
    if (!image) return undefined;
    let alive = true; let made = null;
    fetchBlob(`/supply-requests/${requestId}/documents/${doc.id}/download`)
      .then((blob) => { if (!alive) return; made = URL.createObjectURL(blob); setUrl(made); })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [requestId, doc.id, image]);
  const openPdf = async () => {
    const blob = await fetchBlob(`/supply-requests/${requestId}/documents/${doc.id}/download`);
    const link = URL.createObjectURL(blob);
    window.open(link, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(link), 60000);
  };
  return (
    <>
      <button
        type="button" onClick={() => (image ? url && setOpen(true) : openPdf())} title={label || doc.original_name}
        className="w-[76px] h-[76px] grid place-items-center overflow-hidden border border-line rounded-[11px] [background:var(--surface-subtle)] cursor-zoom-in p-0 hover:border-accent"
        aria-label={`Open ${label || doc.original_name}`}
      >
        {image ? (url ? <img src={url} alt={label || doc.original_name} className="w-full h-full object-cover" /> : <small className="text-muted text-[10px]">{failed ? 'No preview' : '…'}</small>) : <small className="text-text-secondary text-[11px] font-[700]">PDF</small>}
      </button>
      {open && url && createPortal(
        <div className="fixed inset-0 z-2147483000 grid [place-content:center] gap-3 p-[40px_24px] [background:rgba(2,_5,_12,_.82)] [backdrop-filter:blur(10px)] [&_img]:max-w-[min(920px,_92vw)] [&_img]:max-h-[76vh] [&_img]:object-contain [&_img]:border [&_img]:border-line [&_img]:rounded-[14px] [&_p]:m-0 [&_p]:text-text-secondary [&_p]:text-[11.5px] [&_p]:text-center" role="dialog" aria-modal="true" aria-label={label || doc.original_name} onClick={() => setOpen(false)}>
          <button type="button" className="absolute top-[18px] right-[20px] w-[36px] h-[36px] grid place-items-center border border-line rounded-[10px] [background:var(--panel)] text-text cursor-pointer hover:border-accent" aria-label="Close preview" onClick={() => setOpen(false)}>
            <FaXmark aria-hidden="true" />
          </button>
          <img src={url} alt={label || doc.original_name} onClick={(e) => e.stopPropagation()} />
          <p>{label || doc.original_name}</p>
        </div>,
        document.body,
      )}
    </>
  );
}

const TABLE = 'w-full min-w-[500px] [border-collapse:collapse] text-[12.5px] [&_th]:p-[8px_9px] [&_th]:text-left [&_th]:align-bottom [&_th]:text-muted [&_th]:text-[10px] [&_th]:font-[750] [&_th]:tracking-[.06em] [&_th]:uppercase [&_th]:leading-[1.25] [&_th]:[background:var(--surface-subtle)] [&_td]:p-[9px] [&_td]:border-t [&_td]:border-line [&_td]:text-text-secondary [&_td]:align-top';

/**
 * Two compact tables so every column fits the drawer at desktop width: what Admin reviews
 * (branch stock, Critical and Bulk as chips under the name), then, once endorsed, the
 * endorsed, prepared and received quantities. On a phone the tables scroll sideways.
 */
function ItemsTable({ request, staff }) {
  const review = new Map((request.review_lines || []).map((l) => [Number(l.item_id), l]));
  const afterEndorse = request.items.some((i) => i.quantity_endorsed !== null && i.quantity_endorsed !== undefined);
  const prepared = request.items.some((i) => i.quantity_prepared !== null && i.quantity_prepared !== undefined);
  const received = Boolean(request.branch_received_at);
  const unitOf = (item) => item.product?.unit || item.unit_snapshot || '';
  const nameOf = (item) => item.product?.name || item.product_name_snapshot;
  return (
    <>
      <div className="overflow-x-auto border border-line rounded-[12px]" data-table="review">
        <table className={TABLE}>
          <thead>
            <tr>
              <th>Item</th><th>Requested</th>
              {staff && <><th>Available</th><th>Unavailable</th><th>Days covered</th><th>Suggested</th></>}
            </tr>
          </thead>
          <tbody>
            {request.items.map((item) => {
              const r = review.get(Number(item.id));
              const unit = unitOf(item);
              return (
                <tr key={item.id}>
                  <td className="!text-text font-[650]">
                    {nameOf(item)}
                    {(r || item.over_bulk) && (
                      <span className="mt-[4px] flex flex-wrap gap-[4px] font-[400]">
                        {r && <Chip tone={STOCK_TONE[r.branch_stock_status]} title="Branch stock">Branch: {r.branch_stock_label}</Chip>}
                        {r?.critical && <Chip tone="danger" title="Branch stock is Critical/Out, or it covers fewer days than the lead time">Critical</Chip>}
                        {item.over_bulk && <Chip tone="warning">Bulk</Chip>}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{qty(item.quantity_requested)} {unit}</td>
                  {staff && (
                    <>
                      <td className="whitespace-nowrap">{r ? `${qty(r.available)} ${unit}` : '—'}</td>
                      <td className={`whitespace-nowrap ${r?.unavailable > 0 ? '!text-danger-text font-[750]' : ''}`}>{r ? (r.unavailable > 0 ? `${qty(r.unavailable)} ${unit} ⚠` : '0') : '—'}</td>
                      <td>{r?.days_covered ?? '—'}</td>
                      <td>{r?.suggested ?? '—'}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {afterEndorse && (
        <div className="mt-[10px] overflow-x-auto border border-line rounded-[12px]" data-table="quantities">
          <table className={TABLE}>
            <thead>
              <tr><th>Item</th><th>Endorsed</th>{prepared && <th>Prepared</th>}{received && <th>Received good / damaged / short</th>}</tr>
            </thead>
            <tbody>
              {request.items.map((item) => (
                <tr key={item.id}>
                  <td className="!text-text font-[650]">{nameOf(item)}</td>
                  <td className="whitespace-nowrap">{item.quantity_endorsed === null ? '—' : `${qty(item.quantity_endorsed)} ${unitOf(item)}`}</td>
                  {prepared && <td className="whitespace-nowrap">{item.quantity_prepared === null ? '—' : `${qty(item.quantity_prepared)} ${unitOf(item)}`}</td>}
                  {received && <td>{qty(item.received_good)} / <span className={Number(item.received_damaged) ? '!text-danger-text font-[700]' : ''}>{qty(item.received_damaged)}</span> / <span className={Number(item.received_short) ? '!text-danger-text font-[700]' : ''}>{qty(item.received_short)}</span></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function SupplyDrawer({ requestId, role, onClose, onAction, onOpenRequest, reloadKey }) {
  const remote = useRemote(async () => (await api.get(`/supply-requests/${requestId}`)).data, [requestId, reloadKey]);
  const [error, setError] = useState('');
  const r = remote.data;
  const staff = role === 'admin' || role === 'logistics';

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('[role=dialog][aria-modal=true]')) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const { reload } = remote;
  useEffect(() => {
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void reload({ silent: true }); }, 10000);
    return () => window.clearInterval(interval);
  }, [reload]);

  const actions = r ? getSupplyActions(role, r) : [];
  const delivery = r?.delivery;
  const pod = delivery?.documents?.find((d) => d.type === 'proof_of_delivery' && !d.removed_at);
  const photos = (r?.documents || []).filter((d) => d.type === 'receipt_damage_photo');
  const stage = r ? stageIndex(r.status) : 0;
  const reasonOf = (action) => [...(r?.status_history || [])].reverse().find((h) => h.action === action)?.remarks;
  const print = async () => {
    try {
      const opened = await printDeliveryReceipt(async () => (await api.get(`/supply-requests/${requestId}/delivery-receipt`)).data);
      if (!opened) setError('Allow pop-ups for this site to print the Delivery Receipt.');
    } catch (e) { setError(firstValidationMessage(e)); }
  };
  const decision = r?.fulfillment_type && r.fulfillment_type !== 'full';
  const restockLines = (r?.items || []).filter((i) => Number(i.quantity_unavailable) > 0);

  return createPortal(
    <div className="fixed inset-0 z-140" role="presentation">
      <div className="absolute inset-0 [background:rgba(2,_5,_12,_.6)] [backdrop-filter:blur(4px)] [animation:overlayFade_.18s_ease_both]" onClick={onClose} />
      <aside role="dialog" aria-label={r ? `Request ${r.request_number}` : 'Request'} className="absolute top-0 right-0 bottom-0 w-[min(720px,_100%)] overflow-y-auto [overscroll-behavior:contain] border-l border-line-strong [background:var(--panel)] [box-shadow:var(--shadow-xl)] p-[22px] pt-[calc(22px_+_env(safe-area-inset-top,0px))] max-[520px]:p-[16px] [animation:drawerIn_.24s_cubic-bezier(.2,.8,.2,1)_both]">
        <style>{'@keyframes drawerIn{from{transform:translateX(40px);opacity:.4}to{transform:none;opacity:1}}'}</style>
        <button type="button" className={`${BTN_GHOST} ${BTN_SMALL} float-right`} onClick={onClose}><FaXmark aria-hidden="true" /> Close</button>
        {remote.error && (
          <div className="clear-both pt-[8px]">
            <Notice type="error">{`This request could not be loaded. ${remote.error}`}</Notice>
            <button type="button" className={BTN_GHOST} onClick={() => void reload()}>Retry</button>
          </div>
        )}
        <Notice type="error">{error}</Notice>
        {!r ? (!remote.error && <div className="clear-both pt-[8px]"><LoadingState label="Loading request…" /></div>) : (
          <>
            <div className="text-accent-text text-[11px] font-[800] tracking-[.12em] [font-family:ui-monospace,monospace]">{r.request_number}</div>
            <h2 className="m-[4px_0_6px] text-text text-[22px] leading-[1.15] tracking-[-.02em]">{branchLabel(r.location)}</h2>
            <div className="flex flex-wrap gap-[6px]">
              <StatusChip status={r.status} />
              <UrgencyChip urgency={r.urgency} />
              {r.overdue && <Chip tone="danger" title={r.overdue_reason}>Overdue</Chip>}
              {r.reservation_incomplete && <Chip tone="warning">Reservation incomplete</Chip>}
              {r.parent && <Chip>Backorder of {r.parent.request_number}</Chip>}
            </div>
            <div className="mt-[14px]"><Stepper status={r.status} wide /></div>
            <div className="mt-[5px] text-muted text-[11.5px]">Stage {stage + 1} of {STAGES.length} · {STAGES[stage][1]}{r.status !== STAGES[stage][0] ? ` (${supplyStatusLabel(r.status)})` : ''}</div>
            {r.overdue && <Callout tone="danger"><b>Overdue:</b> {r.overdue_reason}</Callout>}
            {(r.urgency_reason || r.bulk_reason) && (
              <Callout>
                {r.urgency_reason && <div><b>{r.urgency === 'critical' ? 'Critical' : 'Urgent'} reason:</b> {r.urgency_reason}</div>}
                {r.bulk_reason && <div><b>Bulk reason:</b> {r.bulk_reason}</div>}
              </Callout>
            )}
            {r.status === 'returned' && <Callout><b>Returned – waiting for branch:</b> {r.returned_reason}</Callout>}
            {r.status === 'on_hold' && <Callout><b>On hold</b> until the restock (expected {formatDate(r.expected_restock_date) || '—'}{r.restock_revision_count ? `, changed ${r.restock_revision_count}×` : ''}). {r.fulfillment_reason}</Callout>}
            {r.status === 'rejected' && <Callout tone="danger"><b>Rejected:</b> {r.rejected_reason || reasonOf('rejected')}</Callout>}
            {r.status === 'cancelled' && <Callout tone="danger"><b>Cancelled:</b> {r.cancelled_reason || reasonOf('cancelled')}</Callout>}
            {r.reservation_incomplete && ['scheduled', 'waiting_logistics', 'preparing'].includes(r.status) && <Callout><b>Reservation incomplete at migration.</b> Logistics: count the items and use Report shortage if they are short.</Callout>}
            {r.pending_date_revision?.proposed_by_role === 'logistics' && <Callout><b>Logistics asks for {formatDate(r.pending_date_revision.revised_delivery_date)}:</b> {r.pending_date_revision.reason}</Callout>}
            {r.pending_shortage_report && (
              <Callout tone="danger">
                <b>Shortage reported:</b> {r.pending_shortage_report.reason}
                <ul className="m-[4px_0_0] pl-[18px]">{(r.pending_shortage_report.items || []).map((i) => <li key={i.item_id}>{i.name}: {qty(i.actual_count)} on hand of {qty(i.to_ship)}</li>)}</ul>
              </Callout>
            )}

            <Section title={`Next action · ${(r.owners || []).map((o) => ({ admin: 'Admin', logistics: 'Logistics', branch: 'Branch' }[o])).join(' / ') || 'None'}`}>
              {!(r.owners || []).includes({ admin: 'admin', logistics: 'logistics', franchisee: 'branch' }[role]) && (
                <p className="m-[0_0_8px] text-text-secondary text-[13px]">{waitingLine(r)}{actions.length ? '' : ' Read-only for you.'}</p>
              )}
              {actions.length > 0 && (
                <div className="flex flex-wrap gap-[8px]">
                  {actions.map((a) => (
                    <button key={`${a.key}-${a.label}`} type="button" disabled={a.disabled} title={a.reason || undefined}
                      className={a.kind === 'primary' ? BTN_PRIMARY : a.kind === 'danger' ? BTN_DANGER : BTN_GHOST}
                      onClick={() => onAction(a.key, r)}
                    >{a.label}</button>
                  ))}
                </div>
              )}
              {actions.filter((a) => a.disabled && a.reason).map((a) => <small key={a.key} className="block mt-[6px] text-muted text-[12px]">{a.label}: {a.reason}</small>)}
            </Section>

            <Section title="Details">
              <KV items={[
                ['Target delivery', formatDate(r.target_delivery_date) || '—'],
                ['Confirmed delivery', r.confirmed_delivery_date ? formatDate(r.confirmed_delivery_date) : 'Not yet confirmed'],
                ['Delivery address', r.delivery_address],
                ['Contact', r.contact_number || r.location?.contact_number || '—'],
                ['Requested', `${when(r.submitted_at || r.created_at)}${r.requested_by?.full_name ? ` · ${r.requested_by.full_name}` : ''}`],
                ['Brand', r.location?.brand?.name || '—'],
              ]} />
              {(r.other_open_requests?.length > 0 || r.parent || r.backorders?.length > 0) && (
                <div className="mt-[10px] flex flex-wrap gap-[6px] items-center text-[12px] text-muted">
                  {r.parent && <>Parent: <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => onOpenRequest(r.parent.id)}>{r.parent.request_number}</button></>}
                  {r.backorders?.length > 0 && <>Backorders: {r.backorders.map((b) => <button key={b.id} type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => onOpenRequest(b.id)}>{b.request_number} · {supplyStatusLabel(b.status)}</button>)}</>}
                  {r.other_open_requests?.length > 0 && <>Other open requests of this branch: {r.other_open_requests.map((o) => <button key={o.id} type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={() => onOpenRequest(o.id)}>{o.request_number} · {supplyStatusLabel(o.status)}</button>)}</>}
                </div>
              )}
            </Section>

            <Section title="Items"><ItemsTable request={r} staff={staff} /></Section>

            {decision && (
              <Section title="Fulfillment decision">
                <KV items={[
                  ['Type', TYPE_NAME[r.fulfillment_type]],
                  ['Decided', when(r.fulfillment_decided_at)],
                  ['Reason', r.fulfillment_reason],
                  ['Expected restock', r.expected_restock_date ? `${formatDate(r.expected_restock_date)}${r.restock_revision_count ? ` (changed ${r.restock_revision_count}×)` : ''}` : '—'],
                ]} />
                {restockLines.length > 0 && (
                  <ul className="m-[8px_0_0] pl-[18px] text-text-secondary text-[12.5px]">
                    {restockLines.map((i) => <li key={i.id}>{i.product?.name || i.product_name_snapshot}: {qty(i.quantity_available)} available, {qty(i.quantity_unavailable)} unavailable · restock {formatDate(i.expected_restock_date) || '—'}</li>)}
                  </ul>
                )}
              </Section>
            )}

            {delivery?.departed_at && (
              <Section title="Delivery" aside={staff && <button type="button" className={`${BTN_GHOST} ${BTN_SMALL}`} onClick={print}>Print Delivery Receipt</button>}>
                <KV items={[
                  ['Driver', `${delivery.driver_name} · ${delivery.driver_contact}`],
                  ['Plate number', delivery.plate_number],
                  ['Departure', when(delivery.departed_at)],
                  ['ETA', when(delivery.eta_at)],
                  ['Actual delivery', delivery.actual_delivered_at ? when(delivery.actual_delivered_at) : 'POD not encoded yet'],
                  ['Received by', delivery.recipient_name || '—'],
                ]} />
                {pod && (
                  <div className="mt-[10px] flex gap-[12px] items-center">
                    <Thumb requestId={r.id} doc={pod} label={`POD ${r.request_number}`} />
                    <small className="text-muted text-[12px]">Proof of delivery · encoded {when(delivery.pod_encoded_at)}</small>
                  </div>
                )}
              </Section>
            )}

            {r.branch_received_at && (
              <Section title="Receipt and discrepancy">
                <div className="grid gap-[8px]">
                  {r.items.filter((i) => i.received_good !== null).map((item) => {
                    const itemPhotos = photos.filter((p) => Number(p.metadata?.item_id) === Number(item.id));
                    const unit = item.product?.unit || item.unit_snapshot || '';
                    return (
                      <div key={item.id} className="p-[10px_12px] border border-line rounded-[12px]">
                        <div className="flex flex-wrap justify-between gap-2">
                          <b className="text-text text-[13px]">{item.product?.name || item.product_name_snapshot}</b>
                          <span className="flex flex-wrap gap-[5px]">
                            <Chip tone="success">Good {qty(item.received_good)} {unit}</Chip>
                            <Chip tone={Number(item.received_damaged) ? 'danger' : 'neutral'}>Damaged {qty(item.received_damaged)}</Chip>
                            <Chip tone={Number(item.received_short) ? 'danger' : 'neutral'}>Short {qty(item.received_short)}</Chip>
                          </span>
                        </div>
                        {item.damage_reason && <small className="block mt-[5px] text-text-secondary text-[12px]">Damage: {item.damage_reason}</small>}
                        {item.short_reason && <small className="block mt-[3px] text-text-secondary text-[12px]">Short: {item.short_reason}</small>}
                        {itemPhotos.length > 0 && <div className="mt-[8px] flex flex-wrap gap-[8px]">{itemPhotos.map((p) => <Thumb key={p.id} requestId={r.id} doc={p} label={`Damage photo · ${item.product?.name || ''}`} />)}</div>}
                      </div>
                    );
                  })}
                </div>
                <small className="block mt-[6px] text-muted text-[12px]">Confirmed by the branch {when(r.branch_received_at)}. Only the good quantity was added to the branch stock.</small>
                {r.discrepancy_action && <Callout tone="info"><b>{DISCREPANCY_NAME[r.discrepancy_action]}:</b> {r.discrepancy_remarks}</Callout>}
              </Section>
            )}

            <Section title="Audit trail">
              <ol className="m-0 p-0 pl-[16px] ml-[5px] border-l-2 border-line [list-style:none]">
                {[...(r.status_history || [])].reverse().map((h, index) => (
                  <li key={`${h.at}-${index}`} className="relative mb-[13px] before:[content:''] before:absolute before:-left-[23px] before:top-[5px] before:w-[10px] before:h-[10px] before:rounded-[50%] before:[background:var(--accent)]">
                    <b className="block text-text text-[13px]">{ACTION_NAME[h.action] || supplyStatusLabel(h.to)}</b>
                    {h.remarks && <span className="block text-text-secondary text-[12.5px]">{h.remarks}</span>}
                    <small className="text-muted text-[11.5px]">{ROLE_NAME[h.actor_role] || h.actor_role || '—'}{h.actor?.full_name ? ` · ${h.actor.full_name}` : ''} · {when(h.at)}</small>
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}
