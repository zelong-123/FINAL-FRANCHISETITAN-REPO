import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

/**
 * Start Prepare: the confirmation step before warehouse stock is deducted.
 *
 * Opening the modal changes nothing. The warehouse quantities are only deducted
 * when the Logistics user confirms here (the backend deducts in the same
 * transaction that moves the request to Preparing), and Confirm stays disabled
 * while any line is short, so stock can never go negative.
 */
export default function StartPrepareModal({ requestId, onClose, onPrepared }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const remote = useRemote(async () => {
    const [request, availability] = await Promise.all([
      api.get(`/supply-requests/${requestId}`),
      api.get(`/supply-requests/${requestId}/availability`),
    ]);
    return { request: request.data, availability: availability.data };
  }, [requestId]);

  const request = remote.data?.request;
  const availability = remote.data?.availability;
  const lines = availability?.items || [];
  const allAvailable = Boolean(availability?.all_available) && lines.length > 0;

  const confirm = async () => {
    if (!allAvailable) return;
    setSaving(true);
    setError('');
    try {
      await api.patch(`/supply-requests/${requestId}/status`, { status: 'preparing' });
      onPrepared();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const footer = request ? (
    <>
      <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={onClose} disabled={saving}>Cancel</button>
      <button
        type="button"
        className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]"
        onClick={confirm}
        disabled={saving || !allAvailable}
        title={allAvailable ? undefined : 'Warehouse stock does not cover every line yet.'}
      >
        {saving ? 'Preparing…' : 'CONFIRM & START PREPARE'}
      </button>
    </>
  ) : null;

  return (
    <Modal
      title={request ? `Start prepare ${request.request_number}` : 'Start prepare'}
      onClose={onClose}
      size="wide"
      footer={footer}
    >
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && (
        <div className="sr-detail">
          <header className="sr-detail-head">
            <dl>
              <div><dt>Request</dt><dd>{request.request_number}</dd></div>
              <div><dt>Branch</dt><dd>{request.location?.name || '—'}</dd></div>
              <div><dt>Warehouse stock</dt><dd>{availability?.warehouse?.name || 'Warehouse'}</dd></div>
            </dl>
          </header>

          <section className="sr-detail-section">
            <p className="muted-note text-muted text-[8px] leading-[1.6]">
              Confirming deducts the quantities below from the warehouse and moves the request to
              Preparing. Opening this window on its own never changes stock.
            </p>
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Required</th>
                    <th>Warehouse stock</th>
                    <th>Shortage</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.product_id} className={line.available ? undefined : 'supply-line-short'}>
                      <td>{line.product_name}</td>
                      <td>{formatNumber(line.requested)}</td>
                      <td>{formatNumber(line.warehouse_stock)}</td>
                      <td>{line.shortage > 0 ? formatNumber(line.shortage) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!allAvailable && (
              <p className="alert error" role="alert">
                Warehouse stock is short for one or more items. Confirm is disabled until the stock
                covers every line; reschedule the delivery date with Admin instead.
              </p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
