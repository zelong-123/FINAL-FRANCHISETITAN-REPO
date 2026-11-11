import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { downloadCsv, downloadPdf } from '../../lib/export';
import { formatNumber } from '../../lib/format';
import { supplyStatusLabel } from '../../lib/supplyActions';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

const EXPORT_HEADERS = ['Category', 'Product', 'Qty', 'Unit', 'Stock before', 'Deducted', 'Stock now'];

const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};
const DISPATCH_FIELDS = [
  { key: 'driver_name', label: 'Driver name', type: 'text', placeholder: 'Juan Dela Cruz' },
  { key: 'driver_contact', label: 'Driver contact (11 digits)', type: 'tel', placeholder: '09171234567' },
  { key: 'plate_number', label: 'Plate number', type: 'text', placeholder: 'ABC 1234' },
  { key: 'departed_at', label: 'Departure', type: 'datetime-local' },
  { key: 'eta_at', label: 'ETA', type: 'datetime-local' },
];

/**
 * Dispatches a request that is Preparing: driver, vehicle, departure and ETA are required, and the
 * prepared quantities (the endorsed ones) leave the warehouse now.
 */
export default function MarkDispatchedModal({ requestId, onClose, onDispatched }) {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({ driver_name: '', driver_contact: '', plate_number: '', departed_at: nowLocal(), eta_at: nowLocal() }));
  const complete = DISPATCH_FIELDS.every((field) => String(form[field.key] || '').trim());

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
      await api.post(`/supply-requests/${requestId}/dispatch`, {
        ...form,
        plate_number: form.plate_number.toUpperCase(),
        departed_at: new Date(form.departed_at).toISOString(),
        eta_at: new Date(form.eta_at).toISOString(),
      });
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
      <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]" onClick={confirm} disabled={saving || !complete}>
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
            <strong>Driver and vehicle</strong>
            <div className="grid grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] gap-[10px] mt-2 [&_label]:block [&_label]:mb-[4px] [&_label]:text-text-secondary [&_label]:text-[0.8rem] [&_label]:font-[700] [&_input]:w-full">
              {DISPATCH_FIELDS.map((field) => (
                <div key={field.key}>
                  <label htmlFor={`dispatch-${field.key}`}>{field.label}</label>
                  <input
                    id={`dispatch-${field.key}`}
                    type={field.type}
                    value={form[field.key]}
                    placeholder={field.placeholder}
                    maxLength={field.key === 'driver_contact' ? 11 : 120}
                    onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
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
