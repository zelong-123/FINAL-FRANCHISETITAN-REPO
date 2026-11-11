import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { downloadCsv } from '../../lib/export';
import { formatDate, formatNumber, titleCase } from '../../lib/format';
import { getSupplyActions } from '../../lib/supplyActions';
import { DELIVERED_ON, supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice, StatusBadge } from '../ApiUi';

// Footer action key -> the status it moves the request into, and its button label.
const FOOTER_ACTIONS = {
  accept_schedule: { next: 'scheduled', label: 'Accept schedule' },
  resume: { next: 'resume', label: 'Resume' },
  start_preparing: { next: 'preparing', label: 'Start Prepare' },
  dispatch: { next: 'dispatched', label: 'Mark Dispatched' },
  deliver: { next: 'delivered', label: 'Encode POD' },
  reject: { next: 'rejected', label: 'Reject' },
  cancel: { next: 'cancelled', label: 'Cancel Request' },
};

/**
 * Detail for a request from endorsement onward. Forward buttons (Schedule / Prepare / Dispatch / POD)
 * render only when getSupplyActions allows them for the signed-in role and request status.
 */
export default function SupplyRequestDetailModal({ requestId, onClose, onAction }) {
  const { role } = useAuth();
  const [hidden, setHidden] = useState({});
  const [stockOpen, setStockOpen] = useState(false);

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  // Silent reload with the page's live sync: the modal stays open and keeps its toggles.
  const { reload } = remote;
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload({ silent: true });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [reload]);

  const request = remote.data;
  const groups = request?.line_groups || [];
  const branch = request?.location;
  const toggle = (key) => setHidden((current) => ({ ...current, [key]: !current[key] }));

  // Receipt totals: every line of every category group.
  const allLines = groups.flatMap((group) => group.lines || []);
  const totalUnits = allLines.reduce((sum, line) => sum + Number(line.requested || 0), 0);
  const deliveryDate = request?.effective_delivery_date || request?.target_delivery_date;

  const exportCsv = () => {
    const rows = groups.flatMap((group) => group.lines.map((line) => [
      group.category_name || 'Uncategorized',
      line.product_name,
      line.requested,
      line.unit,
    ]));
    downloadCsv(`supply-request-${request.request_number}`, ['Category', 'Product', 'Quantity', 'Unit'], rows);
  };

  const title = request ? `Request ${request.request_number}` : 'Request details';
  const allowedActions = request && onAction
    ? getSupplyActions(role, request).filter((action) => FOOTER_ACTIONS[action.key])
    : [];

  const confirmation = request?.delivery_confirmation || null;
  const showConfirmation = Boolean(confirmation) && DELIVERED_ON.includes(request?.status);

  // Reject/cancel reason: the last transition into that status that carried remarks.
  const reasonEntry = ['rejected', 'cancelled'].includes(request?.status)
    ? [...(request?.status_history || [])].reverse().find((row) => row.to === request.status && row.remarks)
    : null;

  const showFooter = Boolean(request) && (allowedActions.length > 0 || showConfirmation);
  const footer = showFooter ? (
    <div className="w-full flex items-center justify-between gap-3 flex-wrap">
      <div className="flex flex-col gap-[2px] min-w-0 text-muted text-[11px] [&_strong]:text-text-secondary [&_strong]:text-[9px] [&_strong]:tracking-[.08em] [&_strong]:uppercase">
        {showConfirmation && (
          <>
            <strong>Confirmed By</strong>
            {confirmation.confirmed_by_type === 'branch' ? (
              <span>
                Branch {branch?.name || '—'}
                {confirmation.recipient_name ? ` · ${confirmation.recipient_name}` : ''}
                {confirmation.confirmed_at ? ` · ${formatDate(confirmation.confirmed_at)}` : ''}
              </span>
            ) : (
              <span>
                Logistics
                {confirmation.note ? ` · ${confirmation.note}` : ''}
              </span>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 ml-auto">
        {allowedActions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={action.danger ? 'danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]' : 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]'}
            onClick={() => onAction(request, FOOTER_ACTIONS[action.key].next)}
          >
            {FOOTER_ACTIONS[action.key].label}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="wide"
      footer={footer}
    >
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && (
        <article className="grid gap-[14px]">
          <header className="flex items-start justify-between gap-[18px] flex-wrap p-[14px_16px] border border-line rounded-[14px] [background:linear-gradient(160deg,_color-mix(in_srgb,_var(--accent)_9%,_var(--panel)),_var(--panel)_62%)]">
            <div className="min-w-0 [&_h3]:m-[5px_0_3px] [&_h3]:text-text [&_h3]:text-[1.05rem] [&_h3]:font-[800] [&_h3]:tracking-[-.02em] [&_p]:max-w-[46ch] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[10px] [&_p]:leading-[1.55]">
              <span className="block text-accent-text text-[8px] font-[850] tracking-[.16em] uppercase">Supply request receipt</span>
              <h3>{branch?.name || 'Branch'}</h3>
              <p>{request.delivery_address || branch?.address || '—'}</p>
            </div>
            <div className="grid [justify-items:end] gap-[7px] text-right [&>div]:flex [&>div]:items-baseline [&>div]:gap-2 [&_span]:text-muted [&_span]:text-[8px] [&_span]:font-[700] [&_span]:tracking-[.08em] [&_span]:uppercase later:[&_strong]:text-text later:[&_strong]:text-[11px] [&_strong]:font-[750] [&_strong]:[font-variant-numeric:tabular-nums] [&_strong]:whitespace-nowrap max-[621px]:later:[justify-items:start] max-[621px]:later:text-left">
              <div><span>Request no.</span><strong>{request.request_number}</strong></div>
              <div><span>Date</span><strong>{formatDate(request.created_at)}</strong></div>
              <StatusBadge value={request.status} label={supplyStatusLabel(request.status)} />
            </div>
          </header>

          <dl className="grid grid-cols-[repeat(auto-fit,_minmax(130px,_1fr))] gap-2 m-0 [&>div]:p-[9px_11px] [&>div]:border [&>div]:border-line [&>div]:rounded-[10px] [&>div]:[background:var(--surface-subtle)] [&_dt]:text-muted [&_dt]:text-[7.5px] [&_dt]:font-[700] [&_dt]:tracking-[.08em] [&_dt]:uppercase [&_dd]:m-[4px_0_0] [&_dd]:text-text [&_dd]:text-[10.5px] [&_dd]:font-[720] [&_dd]:[font-variant-numeric:tabular-nums]">
            <div><dt>Branch type</dt><dd>{titleCase(branch?.type || '—')}</dd></div>
            <div><dt>Delivery date</dt><dd>{formatDate(deliveryDate) || 'Not set'}</dd></div>
            <div><dt>Line items</dt><dd>{formatNumber(allLines.length)}</dd></div>
            <div><dt>Total units</dt><dd>{formatNumber(totalUnits)}</dd></div>
          </dl>

          {reasonEntry && (
            <section className="p-[10px_12px] border border-[color:color-mix(in_srgb,_var(--danger)_26%,_var(--border))] rounded-[10px] [background:color-mix(in_srgb,_var(--danger)_7%,_transparent)] [&_strong]:block later-2:[&_strong]:text-danger-text later-2:[&_strong]:text-[8px] later:[&_strong]:font-[800] later:[&_strong]:tracking-[.07em] [&_strong]:uppercase later:[&_p]:m-[5px_0_0] later:[&_p]:text-text-secondary [&_p]:text-[10px] [&_p]:leading-[1.55] [&_small]:block [&_small]:mt-[5px] [&_small]:text-muted [&_small]:text-[8px]">
              <strong>{request.status === 'rejected' ? 'Rejected reason' : 'Cancelled reason'}</strong>
              <p>{reasonEntry.remarks}</p>
              {reasonEntry.at && <small>{formatDate(reasonEntry.at, true)}</small>}
            </section>
          )}

          <section className="overflow-hidden border border-line rounded-[12px] [background:var(--panel)]">
            <div className="grid grid-cols-[minmax(0,_1fr)_74px_74px] gap-2 p-[9px_13px] border-b border-b-line text-muted [background:var(--surface-subtle)] text-[7.5px] font-[750] tracking-[.09em] uppercase [&_span:not(:first-child)]:text-right max-[621px]:later:grid-cols-[minmax(0,_1fr)_56px_56px]" aria-hidden="true">
              <span>Item</span><span>Qty</span><span>Unit</span>
            </div>
            {!hidden.products && (
              groups.length === 0 ? <EmptyState label="No products on this request." /> : (
                groups.map((group) => (
                  <div key={group.category_id ?? 'none'} className="[&_h4]:m-0 [&_h4]:p-[9px_13px_5px] [&_h4]:text-accent-text [&_h4]:text-[7.5px] [&_h4]:font-[800] [&_h4]:tracking-[.1em] [&_h4]:uppercase">
                    <h4>{group.category_name || 'Uncategorized'}</h4>
                    {group.lines.map((line, index) => (
                      <div className="grid grid-cols-[minmax(0,_1fr)_74px_74px] gap-2 items-baseline p-[7px_13px] [border-top:1px_dashed_var(--border)] text-[10.5px] [&:first-of-type]:[border-top-style:solid] max-[621px]:later:grid-cols-[minmax(0,_1fr)_56px_56px]" key={`${line.product_name}-${index}`}>
                        <span className="text-text font-[650] [overflow-wrap:anywhere]">{line.product_name}</span>
                        <span className="text-text-secondary text-right [font-variant-numeric:tabular-nums] font-[750]">{formatNumber(line.requested)}</span>
                        <span className="text-text-secondary text-right [font-variant-numeric:tabular-nums]">{line.unit || '—'}</span>
                      </div>
                    ))}
                  </div>
                ))
              )
            )}
            <div className="flex items-center justify-between gap-3 p-[11px_13px] [border-top:2px_dashed_var(--border-strong)] [background:color-mix(in_srgb,_var(--accent)_5%,_var(--panel))] text-text text-[11px] font-[800] [font-variant-numeric:tabular-nums] [&_span:last-child]:text-accent-text">
              <span>Total</span>
              <span>{formatNumber(totalUnits)} units</span>
            </div>
          </section>

          <div className="flex justify-end gap-[6px] -mt-[4px]">
            <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={exportCsv}>Export CSV</button>
            <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={() => toggle('products')}>
              {hidden.products ? 'Show items' : 'Hide items'}
            </button>
          </div>

          <section className="overflow-hidden border border-line rounded-[12px] [background:var(--panel)]">
            <button
              type="button"
              className="w-full flex items-center justify-between gap-3 p-[10px_13px] border-0 rounded-[0] text-text [background:var(--surface-subtle)] text-[10px] font-[720] text-left cursor-pointer hover:[background:var(--hover)] [&_small]:text-muted later:[&_small]:text-[7.5px] [&_small]:font-[700] [&_small]:tracking-[.08em] [&_small]:uppercase"
              onClick={() => setStockOpen((open) => !open)}
              aria-expanded={stockOpen}
            >
              <span>Warehouse stock for this request</span>
              <small>{stockOpen ? 'Hide' : 'Show'}</small>
            </button>
            {stockOpen && (
              groups.length === 0 ? <EmptyState label="No products on this request." /> : (
                <div className="p-[6px_13px_10px]">
                  {allLines.map((line, index) => (
                    <div className="flex items-baseline justify-between gap-3 p-[7px_0] [border-top:1px_dashed_var(--border)] text-text-secondary text-[10px] first:border-t-0 later:[&_span:last-child]:text-text [&_span:last-child]:font-[700] [&_span:last-child]:[font-variant-numeric:tabular-nums] [&_span:last-child]:whitespace-nowrap [&_span.is-short]:text-danger-text" key={`stock-${line.product_name}-${index}`}>
                      <span>{line.product_name}</span>
                      <span className={Number(line.warehouse_stock) < Number(line.requested) ? 'is-short' : ''}>
                        {formatNumber(line.warehouse_stock)} in stock
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}
          </section>
        </article>
      )}
    </Modal>
  );
}
