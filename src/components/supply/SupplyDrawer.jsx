// The request detail, opening on the right: status, stepper, reasons, the next action for the
// signed-in role (others get a read-only line), details, items, fulfillment, delivery, receipt
// and discrepancy, and the audit trail.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaXmark } from 'react-icons/fa6';
import dailyDashLogo from '../../assets/dailydash_new.png';
import godoLogo from '../../assets/godo_new.png';
import kkopiLogo from '../../assets/kkopi_new.png';
import laPastaLogo from '../../assets/lapasta_new.png';
import { api, fetchBlob, firstValidationMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { printDeliveryReceipt } from '../../lib/deliveryReceipt';
import { getSupplyActions, waitingLine } from '../../lib/supplyActions';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';
import { LoadingState, Notice } from '../ApiUi';
import { Callout, Chip, KV, Section, StatusChip, Stepper, UrgencyChip } from './supplyUi';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SMALL, STAGES, qty, stageIndex, branchLabel, urgencyLabel } from './supplyStyles';

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
const BRAND_LOGOS = [['kkopi', kkopiLogo], ['godo', godoLogo], ['dailydash', dailyDashLogo], ['lapasta', laPastaLogo]];
/** Same brand-to-logo match the branch portal uses (name or code, ignoring punctuation and case). */
const brandLogoOf = (brand) => {
  const name = `${brand?.code || ''} ${brand?.name || ''}`.toLowerCase().replace(/[^a-z]/g, '');
  return BRAND_LOGOS.find(([key]) => name.includes(key))?.[1] || null;
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

const TABLE = 'w-full min-w-[500px] [border-collapse:collapse] text-[13px] [&_th]:p-[8px_9px] [&_th]:text-left [&_th]:align-bottom [&_th]:text-muted [&_th]:text-[13px] [&_th]:font-[500] [&_td]:p-[10px_9px] [&_td]:border-t [&_td]:border-line [&_td]:text-text-secondary [&_td]:align-top';
/** The requested/available pair is the first thing Admin reads, so it gets divider lines and bold text. */
const FOCUS_COL = 'border-l border-line-strong';
const FOCUS_HEAD = `${FOCUS_COL} !text-text !font-[800]`;
const FOCUS_CELL = `${FOCUS_COL} whitespace-nowrap !text-text text-[14px] font-[750]`;
/** The stock status keeps its own colour but drops the chip border/fill so it sits on the item name's line. */
const STOCK_TEXT = {
  danger: '!text-danger-text', warning: '!text-[color:var(--warning-text)]', success: '!text-success-text', neutral: '!text-muted',
};

/**
 * Two compact tables so every column fits the drawer at desktop width: what Admin reviews
 * (branch stock, Critical and Bulk as chips under the name), then, once endorsed, the
 * endorsed, prepared and received quantities. On a phone the tables scroll sideways.
 */
function ItemsTable({ request, staff }) {
  const review = new Map((request.review_lines || []).map((l) => [Number(l.item_id), l]));
  const prepared = request.items.some((i) => i.quantity_prepared !== null && i.quantity_prepared !== undefined);
  const received = Boolean(request.branch_received_at);
  const unitOf = (item) => item.product?.unit || item.unit_snapshot || '';
  const nameOf = (item) => item.product?.name || item.product_name_snapshot;
  return (
    <>
      <div className="overflow-x-auto" data-table="review">
        <table className={TABLE}>
          <thead>
            <tr>
              <th>Item</th><th className={FOCUS_HEAD}>Requested</th>
              {staff && <><th className={FOCUS_HEAD}>Available</th><th className={FOCUS_COL}>Unavailable</th><th>Days covered</th><th>Suggested</th></>}
            </tr>
          </thead>
          <tbody>
            {request.items.map((item) => {
              const r = review.get(Number(item.id));
              const unit = unitOf(item);
              return (
                <tr key={item.id}>
                  <td className="!text-text font-[650]">
                    <span className="block uppercase">{nameOf(item)}</span>
                    {r && (
                      <span title="Branch stock" className={`mt-[2px] block text-[12px] font-[400] normal-case ${STOCK_TEXT[STOCK_TONE[r.branch_stock_status]] || STOCK_TEXT.neutral}`}>
                        Branch: {r.branch_stock_label}
                      </span>
                    )}
                    {(r?.critical || item.over_bulk) && (
                      <span className="mt-[4px] flex flex-wrap gap-[4px] font-[400]">
                        {r?.critical && <Chip tone="danger" title="Branch stock is Critical/Out, or it covers fewer days than the lead time">Critical</Chip>}
                        {item.over_bulk && <Chip tone="warning">Bulk</Chip>}
                      </span>
                    )}
                  </td>
                  <td className={FOCUS_CELL}>{qty(item.quantity_requested)} {unit}</td>
                  {staff && (
                    <>
                      <td className={FOCUS_CELL}>{r ? `${qty(r.available)} ${unit}` : '—'}</td>
                      <td className={`${FOCUS_COL} whitespace-nowrap ${r?.unavailable > 0 ? '!text-danger-text font-[750]' : r ? '!text-muted' : ''}`}>{r ? (r.unavailable > 0 ? `${qty(r.unavailable)} ${unit}` : '0') : '—'}</td>
                      <td className={r?.branch_stock_status === 'low' ? '!text-[color:var(--warning-text)] font-[600]' : ''}>{r?.days_covered ?? '—'}</td>
                      <td className={Number(r?.suggested) > 0 ? '!text-text font-[700]' : r ? '!text-muted' : ''}>{r?.suggested ?? '—'}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {received && (
        <div className="mt-[10px] overflow-x-auto" data-table="quantities">
          <table className={TABLE}>
            <thead>
              <tr><th>Item</th><th>Received good / damaged / short</th></tr>
            </thead>
            <tbody>
              {request.items.map((item) => (
                <tr key={item.id}>
                  <td className="!text-text font-[600]">{nameOf(item)}</td>
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

export default function SupplyDrawer({ requestId, role, onClose, onAction, onOpenRequest, reloadKey, busyKey = '' }) {
  const remote = useRemote(async () => (await api.get(`/supply-requests/${requestId}`)).data, [requestId, reloadKey]);
  const [error, setError] = useState('');
  const [itemsOpen, setItemsOpen] = useState(true);
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
  const brandLogo = r ? brandLogoOf(r.location?.brand) : null;
  const restockLines = (r?.items || []).filter((i) => Number(i.quantity_unavailable) > 0);

  return createPortal(
    <div className="fixed inset-0 z-140" role="presentation">
      <div className="absolute inset-0 [background:rgba(2,_5,_12,_.6)] [backdrop-filter:blur(4px)] [animation:overlayFade_.18s_ease_both]" onClick={onClose} />
      <aside role="dialog" aria-label={r ? `Request ${r.request_number}` : 'Request'} className="absolute top-0 right-0 bottom-0 w-[min(720px,_100%)] overflow-y-auto [overscroll-behavior:contain] border-l border-line-strong [background:var(--panel)] [box-shadow:var(--shadow-xl)] p-[22px] pt-[calc(22px_+_env(safe-area-inset-top,0px))] max-[520px]:p-[16px] [animation:drawerIn_.24s_cubic-bezier(.2,.8,.2,1)_both]">
        <style>{'@keyframes drawerIn{from{transform:translateX(40px);opacity:.4}to{transform:none;opacity:1}}'}</style>
        {!r && <button type="button" aria-label="Close" className="absolute top-[14px] right-[14px] w-[44px] h-[44px] grid place-items-center border-0 rounded-[10px] bg-transparent text-muted cursor-pointer hover:text-text" onClick={onClose}><FaXmark aria-hidden="true" /></button>}
        {remote.error && (
          <div className="clear-both pt-[8px]">
            <Notice type="error">{`This request could not be loaded. ${remote.error}`}</Notice>
            <button type="button" className={BTN_GHOST} onClick={() => void reload()}>Retry</button>
          </div>
        )}
        <Notice type="error">{error}</Notice>
        {!r ? (!remote.error && <div className="clear-both pt-[8px]"><LoadingState label="Loading request…" /></div>) : (
          <>
            <div className="sticky top-[-22px] z-[5] -mx-[22px] -mt-[22px] mb-[4px] px-[22px] pt-[22px] pb-[10px] [background:var(--panel)] max-[520px]:-mx-[16px] max-[520px]:px-[16px] max-[520px]:top-[-16px] max-[520px]:-mt-[16px] max-[520px]:pt-[16px]">
              <button type="button" aria-label="Close" className="absolute top-[14px] right-[14px] z-10 w-[44px] h-[44px] grid place-items-center border-0 rounded-[10px] bg-transparent text-muted cursor-pointer hover:text-text" onClick={onClose}><FaXmark aria-hidden="true" /></button>
              <div className="pr-[52px] text-muted text-[12px] [font-family:ui-monospace,monospace]">{r.request_number}</div>
              <div className="flex items-center gap-[10px]">
                <h2 className="m-[4px_0_8px] text-text text-[24px] font-[700] leading-[1.2]">{branchLabel(r.location)}</h2>
                {brandLogo && (
                  <img
                    src={brandLogo} alt={`${r.location?.brand?.name || 'Brand'} logo`}
                    className="mb-[8px] mt-[4px] h-[40px] w-auto max-w-[130px] shrink-0 object-contain object-left"
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-[10px]">
                <StatusChip status={r.status} plain />
                <span className="text-muted text-[13px]">{urgencyLabel(r.urgency)} priority</span>
                {r.reservation_incomplete && <Chip tone="warning">Reservation incomplete</Chip>}
                {r.parent && <Chip>Backorder of {r.parent.request_number}</Chip>}
              </div>
            </div>
            <div className="mt-[14px]"><Stepper status={r.status} wide /></div>
            <div className="mt-[5px] text-muted text-[11.5px]">Stage {stage + 1} of {STAGES.length} · {STAGES[stage][1]}{r.status !== STAGES[stage][0] ? ` (${supplyStatusLabel(r.status)})` : ''}</div>
            {r.overdue && <div className="mt-[12px] p-[10px_12px] rounded-[10px] [background:#2a1a24] text-[#ffb4b4] text-[13px]"><b className="font-[700]">Overdue.</b> {r.overdue_reason}</div>}
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
              {/* Primary solid button is the only filled one; Reject and Cancel are text-only danger. */}
              {!(r.owners || []).includes({ admin: 'admin', logistics: 'logistics', franchisee: 'branch' }[role]) && (
                <p className="m-[0_0_8px] text-text-secondary text-[13px]">{waitingLine(r)}{actions.length ? '' : ' Read-only for you.'}</p>
              )}
              {actions.length > 0 && (
                <div className="flex flex-wrap gap-[8px]">
                  {actions.map((a) => {
                    // The pressed button runs its loading lap until the request settles.
                    const busy = busyKey === a.key;
                    const base = a.kind === 'primary' ? BTN_PRIMARY : a.kind === 'danger' ? 'min-h-[44px] px-[10px] border-0 rounded-[10px] bg-transparent text-danger-text cursor-pointer hover:[background:color-mix(in_srgb,_var(--danger)_11%,_transparent)] disabled:opacity-50' : BTN_GHOST;
                    return (
                      <button key={`${a.key}-${a.label}`} type="button" disabled={a.disabled || (Boolean(busyKey) && !busy)} title={a.reason || undefined}
                        aria-busy={busy || undefined}
                        className={`${base} ${busy ? 'supply-action-loading' : ''}`}
                        onClick={() => onAction(a.key, r)}
                      >{a.label}</button>
                    );
                  })}
                </div>
              )}
              {actions.filter((a) => a.disabled && a.reason).map((a) => <small key={a.key} className="block mt-[6px] text-muted text-[12px]">{a.label}: {a.reason}</small>)}
            </Section>

            <Section title="Details">
              <KV items={[
                ['Target delivery', formatDate(r.target_delivery_date) || '—'],
                ['Confirmed delivery', r.confirmed_delivery_date ? formatDate(r.confirmed_delivery_date) : 'Not yet confirmed'],
                ['Branch', r.delivery_address],
                ['Contact', r.contact_number || r.location?.contact_number || 'No contact'],
                ['Requested by', r.requested_by?.full_name || '—'],
                ['Requested on', when(r.submitted_at || r.created_at)],
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

            <Section
              title="Items"
              aside={
                <button
                  type="button" className={`${BTN_GHOST} ${BTN_SMALL} !border-0 !px-[8px]`} aria-expanded={itemsOpen}
                  onClick={() => setItemsOpen((open) => !open)}
                >
                  {itemsOpen ? 'Hide items' : `Show items (${r.items.length})`}
                </button>
              }
            >
              {/* The table stays mounted so the collapse can animate; the 0fr→1fr grid trick animates height without measuring. */}
              <div
                aria-hidden={!itemsOpen}
                className={`grid [transition:grid-template-rows_.28s_ease,_opacity_.22s_ease] motion-reduce:[transition:none] ${itemsOpen ? '[grid-template-rows:1fr] opacity-100' : '[grid-template-rows:0fr] opacity-0 pointer-events-none'}`}
              >
                <div className="min-h-0 overflow-hidden"><ItemsTable request={r} staff={staff} /></div>
              </div>
            </Section>
            {r.items.some((i) => i.quantity_endorsed !== null && i.quantity_endorsed !== undefined) && (
              <Section title="Endorsed quantity">
                <ul className="m-0 p-0 [list-style:none]">
                  {r.items.map((item) => (
                    <li key={item.id} className="flex justify-between gap-[12px] py-[10px] border-t border-line">
                      <b className="text-text text-[15px] font-[600]">{item.product?.name || item.product_name_snapshot}</b>
                      <span className="text-text text-[15px] font-[500] whitespace-nowrap">{item.quantity_endorsed === null ? '—' : `${qty(item.quantity_endorsed)} ${item.product?.unit || item.unit_snapshot || ''}`}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

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

            <Section title="Activity">
              <ol className="m-0 p-0 [list-style:none]">
                {[...(r.status_history || [])].reverse().map((h, index, all) => {
                  const latest = index === 0;
                  const actor = [h.actor?.full_name, ROLE_NAME[h.actor_role] || h.actor_role].filter(Boolean).join(' · ') || '';
                  // One gradient over the whole trail: the present dot is always full colour, older ones fade.
                  const fade = latest ? 1 : Math.max(0.22, 1 - (index / Math.max(1, all.length - 1)) * 0.78);
                  return (
                    <li key={`${h.at}-${index}`} className="relative pl-[24px] pb-[16px]">
                      <span
                        aria-hidden="true" style={{ opacity: fade }}
                        className={`absolute left-0 top-[5px] w-[12px] h-[12px] rounded-[50%] [background:var(--accent)] ${latest ? '[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_20%,_transparent)]' : ''}`}
                      />
                      {index < all.length - 1 && (
                        <span aria-hidden="true" style={{ opacity: Math.max(0.3, fade) }} className="absolute left-[5px] top-[20px] bottom-0 w-[2px] [background:#1f2639]" />
                      )}
                      <div className="flex justify-between gap-[12px]">
                        <b className={`text-text text-[15px] ${latest ? 'font-[600]' : 'font-[500]'}`}>{ACTION_NAME[h.action] || supplyStatusLabel(h.to)}</b>
                        <small className="text-muted text-[13px] whitespace-nowrap">{when(h.at)}</small>
                      </div>
                      {actor && <div className="text-muted text-[13px]">{actor}</div>}
                      {h.remarks && <div className="mt-[6px] p-[8px_12px] rounded-[8px] [background:#161c2e] text-text-secondary text-[13px]">{h.remarks}</div>}
                    </li>
                  );
                })}
              </ol>
            </Section>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}
