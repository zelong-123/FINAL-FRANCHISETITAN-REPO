import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

const REASON_MIN = 5;

/**
 * Admin answers a new delivery date that Logistics asked for: approve (the request is scheduled
 * on that date) or reject with a reason (the original date stays).
 */
export default function DateRevisionModal({ requestId, onClose, onConfirmed }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const revision = request?.pending_date_revision;
  const waiting = Boolean(revision) && revision.proposed_by_role === 'logistics';

  const decide = async (approve) => {
    if (!waiting) return;
    if (!approve && reason.trim().length < REASON_MIN) {
      setError(`Enter a reason of at least ${REASON_MIN} characters to reject the new date.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post(`/supply-requests/${requestId}/date-change/decide`, { approve, reason: reason.trim() || null });
      onConfirmed();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const footer = request ? (
    <>
      <button type="button" onClick={onClose} disabled={saving}>Close</button>
      <button type="button" onClick={() => decide(false)} disabled={saving || !waiting}>Reject new date</button>
      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => decide(true)} disabled={saving || !waiting}>
        {saving ? 'Saving…' : 'Approve new date'}
      </button>
    </>
  ) : null;

  return (
    <Modal title={request ? `Date change · ${request.request_number}` : 'Date change'} onClose={onClose} size="small" footer={footer}>
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && (
        <div className="sr-detail">
          <header className="sr-detail-head">
            <dl>
              <div><dt>Request ID</dt><dd>{request.request_number}</dd></div>
              <div><dt>Branch</dt><dd>{request.location?.name || '—'}</dd></div>
              <div><dt>Status</dt><dd>{supplyStatusLabel(request.status)}</dd></div>
              <div><dt>Current delivery date</dt><dd>{formatDate(request.effective_delivery_date) || 'Not set'}</dd></div>
            </dl>
          </header>

          <section className="sr-detail-section [&_label]:block [&_label]:mt-[10px] [&_label]:mb-[4px] [&_label]:text-text-secondary [&_label]:text-[0.8rem] [&_label]:font-[700] [&_textarea]:w-full">
            <strong>Requested by Logistics</strong>
            {!waiting ? (
              <EmptyState label="No date change is waiting for a decision." />
            ) : (
              <dl className="sr-detail-head">
                <div><dt>New delivery date</dt><dd>{formatDate(revision.revised_delivery_date)}</dd></div>
                <div><dt>Reason</dt><dd>{revision.reason || revision.note || '—'}</dd></div>
              </dl>
            )}
            <label htmlFor="date-decision-reason">Reason (required to reject)</label>
            <textarea id="date-decision-reason" maxLength={255} value={reason} onChange={(event) => setReason(event.target.value)} />
          </section>
        </div>
      )}
    </Modal>
  );
}
