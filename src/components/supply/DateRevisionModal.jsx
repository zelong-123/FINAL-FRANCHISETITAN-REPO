import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, firstValidationMessage } from '../../lib/api';
import { formatDate, formatNumber, titleCase } from '../../lib/format';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

/**
 * Logistics confirms a proposed delivery date. The date can only be confirmed once
 * warehouse stock covers every line, so the modal routes short stock to the warehouse page.
 */
export default function DateRevisionModal({ requestId, onClose, onConfirmed }) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const revision = request?.pending_date_revision;
  const stockCheck = request?.stock_check;
  const sufficient = Boolean(stockCheck?.sufficient);
  const stillWaiting = request?.status === 'under_review';
  const canConfirm = stillWaiting && sufficient && !saving;

  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/supply-requests/${requestId}/date-revision/confirm`);
      onConfirmed();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const goToWarehouse = () => {
    onClose();
    navigate('/inventory');
  };

  const footer = request ? (
    <>
      <button type="button" onClick={onClose} disabled={saving}>Close</button>
      <button type="button" onClick={goToWarehouse} disabled={saving}>Update Inventory Warehouse</button>
      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={confirm} disabled={!canConfirm}>
        {saving ? 'Confirming…' : 'Confirm new Date of delivery'}
      </button>
    </>
  ) : null;

  return (
    <Modal
      title={request ? `Date change · ${request.request_number}` : 'Date change'}
      onClose={onClose}
      size="wide"
      footer={footer}
    >
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && !stillWaiting && (
        <p className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)] [&.is-late]:text-[color:var(--sr-danger)]">This request is no longer waiting for a date change (status {titleCase(request.status)}).</p>
      )}

      {request && (
        <div className="sr-detail">
          <header className="sr-detail-head">
            <dl>
              <div><dt>Request ID</dt><dd>{request.request_number}</dd></div>
              <div><dt>Branch</dt><dd>{request.location?.name || '—'}</dd></div>
              <div><dt>Status</dt><dd>{titleCase(request.status)}</dd></div>
              <div><dt>Request date</dt><dd>{formatDate(request.created_at)}</dd></div>
              <div><dt>Original delivery date</dt><dd>{formatDate(request.target_delivery_date) || 'Not set'}</dd></div>
            </dl>
          </header>

          <section className="sr-detail-section">
            <strong>Proposed delivery date</strong>
            {!revision ? (
              <EmptyState label="No date change is waiting for confirmation." />
            ) : (
              <dl className="sr-detail-head">
                <div><dt>New delivery date</dt><dd>{formatDate(revision.revised_delivery_date)}</dd></div>
                <div><dt>Originally</dt><dd>{formatDate(revision.original_delivery_date) || 'Not set'}</dd></div>
                <div><dt>Note</dt><dd>{revision.note || '—'}</dd></div>
              </dl>
            )}
          </section>

          <section className="sr-detail-section">
            <strong>Warehouse stock for this request</strong>
            {!stockCheck ? (
              <EmptyState label="Stock check is not available." />
            ) : (
              <>
                {!sufficient && <p className="text-[color:var(--sr-danger,_var(--danger-text))] text-[0.85rem] leading-[1.5] mb-3">Not enough warehouse stock for the full request.</p>}
                <table className="[&_tr.is-short_td]:text-[color:var(--sr-danger,_var(--danger-text))]">
                  <thead><tr><th>Product</th><th>Required</th><th>In stock</th><th>Shortage</th></tr></thead>
                  <tbody>
                    {stockCheck.lines.map((line, index) => (
                      <tr key={`${line.product_name}-${index}`} className={line.shortage > 0 ? 'is-short' : undefined}>
                        <td>{line.product_name}</td>
                        <td>{formatNumber(line.required)}</td>
                        <td>{formatNumber(line.available)}</td>
                        <td>{line.shortage > 0 ? `Short ${formatNumber(line.shortage)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!sufficient && <p className="block mt-[2px] text-[0.85rem] text-[color:var(--sr-muted)] [&.is-late]:text-[color:var(--sr-danger)]">Stock is not sufficient for the full request.</p>}
              </>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
