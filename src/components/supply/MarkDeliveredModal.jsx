import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { titleCase } from '../../lib/format';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

const NOTE_LIMIT = 255;

/**
 * Confirms that a dispatched request reached the branch, confirmed by Logistics.
 * The backend records the confirmation under the token; the note is optional.
 */
export default function MarkDeliveredModal({ requestId, onClose, onDelivered }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const trimmedNote = note.trim();

  const confirm = async () => {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/supply-requests/${requestId}/status`, {
        status: 'delivered',
        ...(trimmedNote ? { remarks: trimmedNote } : {}),
      });
      onDelivered();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const footer = request ? (
    <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]" onClick={confirm} disabled={saving}>
      {saving ? 'Updating…' : 'CONFIRM DELIVERED'}
    </button>
  ) : null;

  return (
    <Modal title={request ? `Deliver ${request.request_number}` : 'Mark delivered'} onClose={onClose} size="small" footer={footer}>
      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!request && !remote.error && <EmptyState label="Loading request…" />}

      {request && (
        <div className="sr-detail">
          <header className="sr-detail-head">
            <dl>
              <div><dt>Request ID</dt><dd>{request.request_number}</dd></div>
              <div><dt>Branch</dt><dd>{request.location?.name || '—'}</dd></div>
              <div><dt>Status</dt><dd>{titleCase(request.status)}</dd></div>
            </dl>
          </header>

          <section className="sr-detail-section">
            <label htmlFor="delivery-note">Delivery note (optional)</label>
            <textarea
              id="delivery-note"
              maxLength={NOTE_LIMIT}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Where the delivery was left, who received it, or anything the branch should know."
            />
            <small className="block mt-1 text-muted text-[10px] text-right">{note.length} / {NOTE_LIMIT}</small>
          </section>
        </div>
      )}
    </Modal>
  );
}
