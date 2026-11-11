import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { Notice, Modal } from '../ApiUi';

// The server requires a reason of at least 5 characters; the form keeps a 255-character ceiling.
const REASON_LIMIT = 255;
const REASON_MIN = 5;

const COPY = {
  rejected: {
    title: 'Reject request',
    confirm: 'CONFIRM REJECT',
    warning: 'The branch will see this request as rejected.',
    success: 'Request rejected.',
  },
  cancelled: {
    title: 'Cancel request',
    confirm: 'CONFIRM CANCEL',
    warning: 'Any warehouse stock reserved for this request is released.',
    success: 'Request cancelled.',
  },
};

/** Asks for the reason the backend requires, then calls the cancel or reject action. */
export default function CancelRejectModal({ request, nextStatus, onClose, onDone }) {
  const copy = COPY[nextStatus] || COPY.cancelled;
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length >= REASON_MIN && !saving;

  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/supply-requests/${request.id}/${nextStatus === 'rejected' ? 'reject' : 'cancel'}`, { reason: trimmedReason });
      onDone();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={copy.title}
      onClose={onClose}
      size="small"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving}>Back</button>
          <button type="button" className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" onClick={confirm} disabled={!canConfirm}>
            {saving ? 'Updating…' : copy.confirm}
          </button>
        </>
      }
    >
      {error && <Notice type="error">{error}</Notice>}
      <div className="[&_p]:m-[0_0_8px] [&_label]:block [&_label]:mb-[6px] [&_label]:text-text-secondary [&_label]:text-[0.8rem] [&_label]:font-[700] [&_textarea]:w-full [&_textarea]:min-h-[84px] [&_textarea]:[resize:vertical]">
        <p><strong>{request.request_number}</strong></p>
        <p className="text-[color:var(--sr-danger,_var(--danger-text))] text-[0.85rem] leading-[1.5] mb-3">{copy.warning}</p>
        <label htmlFor="cancel-reason">Reason (required, at least {REASON_MIN} characters)</label>
        <textarea
          id="cancel-reason"
          maxLength={REASON_LIMIT}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why is this request being stopped?"
        />
        <small className="block mt-1 text-muted text-[10px] text-right">{reason.length} / {REASON_LIMIT}</small>
      </div>
    </Modal>
  );
}
