import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';
import { EmptyState, Modal, Notice } from '../ApiUi';

const NOTE_LIMIT = 255;
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * Proof of delivery by Logistics: a photo or signed slip, who received it and when. It may be
 * encoded on a later day. The branch confirms the items it received separately.
 */
export default function MarkDeliveredModal({ requestId, onClose, onDelivered }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);
  const [receivedBy, setReceivedBy] = useState('');
  const [deliveredAt, setDeliveredAt] = useState(nowLocal);
  const [note, setNote] = useState('');

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const complete = Boolean(file) && receivedBy.trim().length >= 2 && Boolean(deliveredAt);

  const confirm = async () => {
    if (!complete) return;
    setSaving(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('received_by', receivedBy.trim());
      form.append('actual_delivered_at', new Date(deliveredAt).toISOString());
      if (note.trim()) form.append('notes', note.trim());
      await api.post(`/supply-requests/${requestId}/pod`, form);
      onDelivered();
    } catch (saveError) {
      setError(firstValidationMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const footer = request ? (
    <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:text-[color:var(--sr-text)] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-[color:var(--sr-accent)] later-2:font-[600] later-2:[&:hover:not(:disabled)]:[background:var(--sr-accent-soft)] later-2:[&:hover:not(:disabled)]:border-[color:var(--sr-accent)]" onClick={confirm} disabled={saving || !complete}>
      {saving ? 'Saving…' : 'SAVE PROOF OF DELIVERY'}
    </button>
  ) : null;

  return (
    <Modal title={request ? `Proof of delivery · ${request.request_number}` : 'Proof of delivery'} onClose={onClose} size="small" footer={footer}>
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
            </dl>
          </header>

          <section className="sr-detail-section [&_label]:block [&_label]:mt-[10px] [&_label]:mb-[4px] [&_label]:text-text-secondary [&_label]:text-[0.8rem] [&_label]:font-[700] [&_input]:w-full [&_textarea]:w-full">
            <label htmlFor="pod-file">POD photo or signed slip (JPG, PNG or PDF)</label>
            <input id="pod-file" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            <label htmlFor="pod-received-by">Received by</label>
            <input id="pod-received-by" type="text" maxLength={255} value={receivedBy} onChange={(event) => setReceivedBy(event.target.value)} placeholder="Name of the person who received it" />
            <label htmlFor="pod-time">Actual delivery date and time</label>
            <input id="pod-time" type="datetime-local" value={deliveredAt} max={nowLocal()} onChange={(event) => setDeliveredAt(event.target.value)} />
            <label htmlFor="delivery-note">Note (optional)</label>
            <textarea
              id="delivery-note"
              maxLength={NOTE_LIMIT}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Where the delivery was left, or anything the branch should know."
            />
            <small className="block mt-1 text-muted text-[10px] text-right">{note.length} / {NOTE_LIMIT}</small>
          </section>
        </div>
      )}
    </Modal>
  );
}
