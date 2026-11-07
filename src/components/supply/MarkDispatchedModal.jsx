import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { downloadCsv, downloadPdf } from '../../lib/export';
import { formatNumber } from '../../lib/format';
import { supplyStatusLabel } from '../../lib/supplyActions';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

const EXPORT_HEADERS = ['Category', 'Product', 'Qty', 'Unit', 'Stock before', 'Deducted', 'Stock now'];

/**
 * Confirms that a request that is Preparing (status "preparing") has left the branch.
 * The stock table comes from the stored snapshot; the confirmer label is display-only.
 */
export default function MarkDispatchedModal({ requestId, onClose, onDispatched }) {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const groups = request?.line_groups || [];
  const snapshot = request?.stock_snapshot;
  const snapshotByProduct = new Map((snapshot || []).map((line) => [line.product_id, line]));

  // Export rows: same data as the on-screen table, no personal data.
  const exportRows = groups.flatMap((group) => group.lines.map((line) => {
    const before = snapshotByProduct.get(line.product_id);
    return [
      group.category_name || 'Uncategorized',
      line.product_name,
      formatNumber(line.requested),
      line.unit || '',
      before ? formatNumber(before.stock_before) : '',
      before ? formatNumber(before.deducted) : '',
      before ? formatNumber(before.stock_now) : '',
    ];
  }));

  const exportCsv = () => downloadCsv(`dispatch-${request.request_number}`, EXPORT_HEADERS, exportRows);
  const exportPdf = () => downloadPdf(`dispatch-${request.request_number}`, EXPORT_HEADERS, exportRows, `Dispatch ${request.request_number}`, 'Stock before preparing, deducted and now');

  const confirm = async () => {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/supply-requests/${requestId}/status`, { status: 'dispatched' });
      onDispatched();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const footer = request ? (
    <>
      <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={exportCsv}>Export CSV</button>
      <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={exportPdf}>Export PDF</button>
      <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]" onClick={confirm} disabled={saving}>
        {saving ? 'Updating…' : 'Confirm dispatched'}
      </button>
    </>
  ) : null;

  return (
    <Modal title={request ? `Dispatch ${request.request_number}` : 'Dispatch request'} onClose={onClose} size="wide" footer={footer}>
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && (
        <div className="sr-detail">
          <header className="sr-detail-head">
            <dl>
              <div><dt>Branch</dt><dd>{request.location?.name || '—'}</dd></div>
              <div><dt>Status</dt><dd>{supplyStatusLabel(request.status)}</dd></div>
              <div><dt>Confirmed by</dt><dd>{user?.full_name || 'Signed-in user'}</dd></div>
            </dl>
          </header>

          <section className="sr-detail-section">
            <strong>Stock before preparing</strong>
            {!snapshot ? (
              <EmptyState label="No snapshot recorded for this request." />
            ) : (
              <table className="[&_tr.is-short_td]:text-[color:var(--sr-danger,_var(--danger-text))]">
                <thead><tr><th>Product</th><th>Stock before preparing</th><th>Deducted</th><th>Stock now</th></tr></thead>
                <tbody>
                  {snapshot.map((line) => (
                    <tr key={line.product_id}>
                      <td>{line.product_name}</td>
                      <td>{formatNumber(line.stock_before)}</td>
                      <td>{formatNumber(line.deducted)}</td>
                      <td>{formatNumber(line.stock_now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="sr-detail-section">
            <strong>Products</strong>
            {groups.map((group) => (
              <div key={group.category_id ?? 'none'} className="sr-detail-group">
                <h4>{group.category_name || 'Uncategorized'}</h4>
                <table className="[&_tr.is-short_td]:text-[color:var(--sr-danger,_var(--danger-text))]">
                  <thead><tr><th>Product</th><th>Qty / unit</th></tr></thead>
                  <tbody>
                    {group.lines.map((line) => (
                      <tr key={line.product_id}>
                        <td>{line.product_name}</td>
                        <td>{formatNumber(line.requested)} {line.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </div>
      )}
    </Modal>
  );
}
