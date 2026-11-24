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
      <button type="button" className="inline-flex items-center justify-center min-h-[42px] p-[0_16px] border border-[#2b344c] rounded-[12px] bg-transparent text-[#c7cfe2] text-[13px] font-[700] cursor-pointer hover:[background:rgba(255,_255,_255,_.05)] disabled:opacity-40 disabled:cursor-not-allowed" onClick={onClose} disabled={saving}>Close</button>
      <button type="button" className="inline-flex items-center justify-center min-h-[42px] p-[0_16px] border border-[rgba(248,_113,_113,_.45)] rounded-[12px] [background:rgba(248,_113,_113,_.08)] text-[#fca5a5] text-[13px] font-[700] cursor-pointer hover:[background:rgba(248,_113,_113,_.16)] disabled:opacity-40 disabled:cursor-not-allowed" onClick={() => decide(false)} disabled={saving || !waiting || reason.trim().length < REASON_MIN} title={reason.trim().length < REASON_MIN ? 'Write the reason for rejecting first.' : ''}>Reject new date</button>
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
        <div className="grid gap-[16px]">
          <dl className="grid grid-cols-2 gap-[10px] m-0 max-[480px]:grid-cols-1">
            {[
              ['Request ID', request.request_number],
              ['Branch', request.location?.name || '—'],
              ['Status', supplyStatusLabel(request.status)],
              ['Current delivery date', formatDate(request.effective_delivery_date) || 'Not set'],
            ].map(([label, value]) => (
              <div key={label} className="grid gap-[3px] p-[10px_12px] border border-[#263049] rounded-[10px] [background:rgba(255,_255,_255,_.02)] min-w-0">
                <dt className="m-0 text-[#8f9bbd] text-[10.5px] font-[700] tracking-[.08em] uppercase">{label}</dt>
                <dd className="m-0 text-[#edf0fa] text-[14px] font-[600] [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>

          <section className="grid gap-[12px] p-[14px] border border-[rgba(129,_117,_255,_.35)] rounded-[12px] [background:rgba(129,_117,_255,_.06)]">
            <strong className="text-[#c9c3ff] text-[11px] font-[800] tracking-[.1em] uppercase">Requested by Logistics</strong>
            {!waiting ? (
              <EmptyState label="No date change is waiting for a decision." />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-[10px] text-[15px] font-[700]">
                  <span className="text-[#98a2b8] line-through decoration-[1.5px]">{formatDate(request.effective_delivery_date) || 'Not set'}</span>
                  <span className="text-[#8f9bbd]" aria-hidden="true">→</span>
                  <span className="p-[4px_10px] rounded-[8px] [background:rgba(52,_211,_153,_.12)] text-[#6ee7b7]">{formatDate(revision.revised_delivery_date)}</span>
                </div>
                <div className="grid gap-[4px]">
                  <span className="text-[#8f9bbd] text-[10.5px] font-[700] tracking-[.08em] uppercase">Reason</span>
                  <p className="m-0 p-[10px_12px] border-l-[3px] border-[#8175ff] rounded-[6px] [background:rgba(8,_12,_22,_.45)] text-[#e6ebf5] text-[13.5px] leading-[1.5]">{revision.reason || revision.note || '—'}</p>
                </div>
              </>
            )}
          </section>

          {waiting && (
            <div className="grid gap-[6px]">
              <label htmlFor="date-decision-reason" className="text-[#c7cfe2] text-[12.5px] font-[700]">Reason for rejecting <span className="text-[#8f9bbd] font-[500]">(required only to reject, at least {REASON_MIN} characters)</span></label>
              <textarea
                id="date-decision-reason"
                rows={3}
                maxLength={255}
                className="w-full min-h-[84px] p-[10px_12px] border border-[#303749] rounded-[10px] [background:#0c111d] text-[#e6ebf5] text-[13px] leading-[1.5] resize-y focus:outline-none focus:border-[#8175ff]"
                placeholder="Why the original date must stay"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
