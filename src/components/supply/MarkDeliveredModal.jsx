import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FaBoxOpen,
  FaCheck,
  FaChevronLeft,
  FaChevronRight,
  FaCircleCheck,
  FaClock,
  FaCloudArrowUp,
  FaEye,
  FaFilePdf,
  FaRegCalendarDays,
  FaTrashCan,
  FaTriangleExclamation,
  FaUser,
  FaXmark,
} from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import useRemote from '../../lib/useRemote';

const NOTE_LIMIT = 255;
const NOTE_WARN_AT = 220;
const ACCEPT = 'image/jpeg,image/png,application/pdf';
const ALLOWED = ['image/jpeg', 'image/png', 'application/pdf'];
const CLOSE_MS = 180;

const pad2 = (value) => String(value).padStart(2, '0');

const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const allowedFile = (file) => Boolean(file) && (ALLOWED.includes(file.type) || /\.(jpe?g|png|pdf)$/i.test(file.name || ''));

const fileKind = (file) => {
  if (!file) return '';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'PDF';
  const type = file.type.split('/')[1] || file.name.split('.').pop() || '';
  return type.toUpperCase().replace('JPEG', 'JPG');
};

const fileSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const humanTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const parseLocal = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
};

const toLocalValue = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

const displayDateTime = (date) => {
  if (!date) return '';
  const hours = date.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}  ${h12}:${pad2(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ROW_H = 30;

// Same input recipe the shared `Field` uses, so the POD form matches every other form in the app.
const FIELD = 'w-full h-[42px] rounded-[9px] border border-input-line px-[11px] text-text text-[13.5px] [background:var(--input-bg)] [color-scheme:dark] light:[color-scheme:light] [transition:border-color_.12s_ease,_box-shadow_.12s_ease,_background_.12s_ease] placeholder:text-placeholder hover:border-line-strong focus:border-accent focus:outline-none focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] focus:[background:var(--input-focus-bg)] disabled:opacity-[.6] disabled:cursor-not-allowed';
const SURFACE = '[background:var(--input-bg)]';
const LABEL = 'flex items-center justify-between gap-[10px] mb-[6px] text-text-secondary text-[12.5px] font-[650]';
const TAG = 'flex-none text-[10.5px] font-[720] uppercase tracking-[.08em] text-muted';
const GHOST = 'inline-flex items-center justify-center gap-[7px] min-h-[42px] px-[14px] rounded-[9px] border border-line text-text-secondary text-[13px] font-[680] cursor-pointer [background:transparent] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed';

/**
 * Proof of delivery (Logistics) — photo/slip, receiver and the actual delivery time.
 * Re-encoded on the same day or later. Saving still goes through the existing
 * `POST /supply-requests/:id/pod` multipart route: the API stores the file, writes the
 * delivery and moves the request to `delivered`. Nothing here talks to Storage directly.
 */
export default function MarkDeliveredModal({ requestId, onClose, onDelivered }) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [thumbReady, setThumbReady] = useState(false);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [receivedBy, setReceivedBy] = useState('');
  const [deliveredAt, setDeliveredAt] = useState(nowLocal);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [shake, setShake] = useState({ file: 0, received: 0, time: 0 });

  const titleId = useId();
  const subtitleId = useId();
  const errorId = useId();
  const panelRef = useRef(null);
  const fileInputRef = useRef(null);
  const viewerCloseRef = useRef(null);
  const closeRef = useRef(onClose);
  const deliveredRef = useRef(onDelivered);
  const stateRef = useRef({ saving, saved, closing, viewing });
  const previewRef = useRef('');
  const timers = useRef([]);

  useEffect(() => {
    closeRef.current = onClose;
    deliveredRef.current = onDelivered;
  }, [onClose, onDelivered]);

  useEffect(() => {
    stateRef.current = { saving, saved, closing, viewing };
  }, [saving, saved, closing, viewing]);

  const remote = useRemote(async () => {
    const response = await api.get(`/supply-requests/${requestId}`);
    return response.data;
  }, [requestId]);

  const request = remote.data;
  const complete = Boolean(file) && receivedBy.trim().length >= 2 && Boolean(deliveredAt);
  const missing = [
    !file && 'POD photo or slip',
    receivedBy.trim().length < 2 && 'who received it',
    !deliveredAt && 'the delivery date and time',
  ].filter(Boolean);
  const missingText = `Still needed: ${missing.join(', ')}.`;

  const later = (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
    return id;
  };

  // The thumbnail URL lives in a ref so it is revoked exactly once: on replace, on remove, or on close.
  const setPreview = (url) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreviewUrl(url);
  };

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  useEffect(() => () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  const requestClose = () => {
    if (stateRef.current.closing || stateRef.current.saving || stateRef.current.saved) return;
    setClosing(true);
    later(() => closeRef.current?.(), CLOSE_MS);
  };

  const requestCloseRef = useRef(requestClose);
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });

  // Scroll lock, focus trap, Escape and focus return.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';

    const focusables = () => Array.from(panelRef.current?.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []);

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (stateRef.current.viewing) {
          setViewing(false);
          return;
        }
        requestCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    const focusTimer = window.setTimeout(() => fileInputRef.current?.focus(), 80);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  const bump = (field) => setShake((current) => ({ ...current, [field]: current[field] + 1 }));

  const selectFile = (picked) => {
    if (!picked) return;
    if (!allowedFile(picked)) {
      setFileError('That file type is not accepted. Attach a JPG, PNG or PDF.');
      bump('file');
      return;
    }
    setFileError('');
    setThumbReady(false);
    setRemoving(false);
    setPreview(URL.createObjectURL(picked));
    setFile(picked);
  };

  const removeFile = () => {
    if (removing) return;
    setRemoving(true);
    setViewing(false);
    later(() => {
      setPreview('');
      setFile(null);
      setRemoving(false);
      setThumbReady(false);
    }, 200);
  };

  const confirm = async () => {
    if (!complete || saving || saved) return;
    setSaving(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('received_by', receivedBy.trim());
      form.append('actual_delivered_at', new Date(deliveredAt).toISOString());
      if (note.trim()) form.append('notes', note.trim());
      await api.post(`/supply-requests/${requestId}/pod`, form);
      setSaving(false);
      setSaved(true);
      // Let the drawn check land, then play the exit before the parent closes and refreshes.
      later(() => {
        setClosing(true);
        later(() => deliveredRef.current?.(), CLOSE_MS);
      }, 650);
    } catch (saveError) {
      setSaving(false);
      setError(firstValidationMessage(saveError));
      const fields = saveError?.errors || {};
      if (fields.file) bump('file');
      if (fields.received_by) bump('received');
      if (fields.actual_delivered_at) bump('time');
    }
  };

  const saveEnabled = complete && !saving && !saved;

  return createPortal(
    <div
      className={`pod-overlay fixed inset-0 [z-index:1000] grid place-items-center p-[20px] overflow-hidden [background:rgba(2,_5,_12,_.66)] [backdrop-filter:blur(12px)_saturate(120%)] max-[520px]:p-[10px] ${closing ? 'pod-closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        // The date/time popup is portalled to <body> but still bubbles through this tree.
        if (event.target?.closest?.('[data-pod-picker]')) return;
        requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        className={`pod-panel relative w-[min(600px,_100%)] max-h-[calc(100dvh_-_40px)] flex flex-col overflow-hidden border border-line-strong rounded-[10px] [background:var(--panel)] [box-shadow:var(--shadow-xl)] max-[520px]:max-h-[calc(100dvh_-_20px)] ${closing ? 'pod-closing' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex-none flex items-center justify-between gap-[12px] p-[13px_16px] border-b border-b-line [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)]">
          <div className="flex items-center gap-[10px] min-w-0">
            <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[8px] border border-line text-accent-text text-[15px] [background:color-mix(in_srgb,_var(--accent)_11%,_transparent)]" aria-hidden="true">
              <FaBoxOpen />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="m-0 text-text text-[16px] font-[730] leading-[1.25] tracking-[-.01em]">Proof of delivery</h2>
              <p id={subtitleId} className="m-[2px_0_0] text-muted text-[11.5px] leading-[1.4]">Attach the signed slip or photo and record who received it.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close proof of delivery"
            className="grid h-[44px] w-[44px] flex-none place-items-center border border-transparent rounded-[9px] text-text-secondary text-[15px] cursor-pointer [background:transparent] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text hover:border-line hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed"
            disabled={saving || saved || closing}
          >
            <FaXmark aria-hidden="true" />
          </button>
        </header>

        <div className="flex-[1_1_auto] min-h-0 overflow-y-auto [overscroll-behavior:contain] p-[14px_16px] grid gap-[13px]">
          {remote.error && (
            <div className="flex items-start gap-[9px] p-[10px_12px] rounded-[9px] border text-[12.5px] leading-[1.55] notice-error" role="alert">
              <FaTriangleExclamation aria-hidden="true" className="flex-[0_0_auto] mt-[2px]" />
              <span>{remote.error}</span>
            </div>
          )}

          {!request && !remote.error && (
            <div className="flex items-center gap-[10px] p-[12px_2px] text-muted text-[12.5px]" role="status" aria-live="polite">
              <span className="spinner inline-block h-[16px] w-[16px] rounded-[50%] border-[2px] border-[color:color-mix(in_srgb,_var(--muted)_25%,_transparent)] border-t-accent [animation:spin_.8s_linear_infinite]" aria-hidden="true" />
              Loading request…
            </div>
          )}

          {request && (
            <>
              <div className={`grid grid-cols-[1fr_1.4fr_auto] items-center gap-x-[14px] gap-y-[8px] p-[10px_12px] border border-line rounded-[9px] ${SURFACE} max-[520px]:grid-cols-1`}>
                <div className="min-w-0">
                  <div className="text-muted text-[10px] font-[720] uppercase tracking-[.09em]">Request ID</div>
                  <div className="mt-[1px] text-text text-[13px] font-[700] [font-family:ui-monospace,monospace] truncate">{request.request_number}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-muted text-[10px] font-[720] uppercase tracking-[.09em]">Branch</div>
                  <div className="mt-[1px] text-text text-[13px] font-[620] truncate">{request.location?.name || '—'}</div>
                </div>
                <div className="flex items-center gap-[7px] max-[520px]:justify-start">
                  <span className="text-muted text-[10px] font-[720] uppercase tracking-[.09em] max-[520px]:inline">Status</span>
                  <span className={`status-pill status-${String(request.status || '').toLowerCase().replaceAll('_', '-')} inline-flex items-center gap-[6px] min-h-[24px] px-[9px] border rounded-full text-[11.5px] font-[680] whitespace-nowrap`}>
                    <span className="h-[6px] w-[6px] rounded-full [background:currentColor] [box-shadow:0_0_0_3px_color-mix(in_srgb,_currentColor_12%,_transparent)]" aria-hidden="true" />
                    {supplyStatusLabel(request.status)}
                  </span>
                </div>
              </div>

              {/* POD file */}
              <div key={`file-${shake.file}`} className={shake.file ? 'pod-shake' : undefined}>
                <div className={LABEL}>
                  <span id="pod-file-label">POD photo or signed slip</span>
                  <span className="flex-none text-muted text-[11px] font-[600]">
                    <b className={`${TAG} mr-[6px]`} aria-hidden="true">Required</b>
                    JPG, PNG or PDF
                  </span>
                </div>

                {(!file || removing) && (
                  <label
                    className={`relative flex items-center gap-[12px] p-[12px_13px] border border-dashed rounded-[9px] cursor-pointer text-left [transition:border-color_.15s_ease,_background_.15s_ease,_transform_.15s_ease] hover:border-accent hover:[background:color-mix(in_srgb,_var(--accent)_5%,_var(--input-bg))] focus-within:border-accent focus-within:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] ${dragging ? 'border-accent [background:color-mix(in_srgb,_var(--accent)_9%,_var(--input-bg))] [transform:scale(1.01)]' : fileError ? 'border-[color:var(--danger)]' : 'border-line-strong'} ${SURFACE} ${file ? 'pod-file-out' : 'pod-drop-in'}`}
                    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      selectFile(event.dataTransfer?.files?.[0] || null);
                    }}
                  >
                    <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[8px] text-accent-text text-[15px] [background:color-mix(in_srgb,_var(--accent)_11%,_transparent)]" aria-hidden="true">
                      <FaCloudArrowUp />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-text text-[13px] font-[620]">
                        Drag a file here, or <span className="text-accent-text underline underline-offset-2">browse</span>
                      </span>
                      <span className="mt-[1px] block text-muted text-[11px] leading-[1.4]">On a phone, you can take a photo of the signed slip directly.</span>
                    </span>
                    <input
                      ref={fileInputRef}
                      id="pod-file"
                      type="file"
                      accept={ACCEPT}
                      aria-labelledby="pod-file-label"
                      aria-describedby={fileError ? errorId : undefined}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      onChange={(event) => {
                        const picked = event.target.files?.[0] || null;
                        event.target.value = '';
                        selectFile(picked);
                      }}
                    />
                  </label>
                )}

                {file && !removing && (
                  <div className={`pod-file-in flex items-center gap-[11px] p-[9px_11px] border border-line-strong rounded-[9px] ${SURFACE}`}>
                    <button
                      type="button"
                      onClick={() => setViewing(true)}
                      aria-label={`View ${file.name}`}
                      className="group grid h-[48px] w-[48px] flex-none place-items-center overflow-hidden rounded-[6px] border border-line text-muted text-[19px] cursor-pointer [background:var(--panel-2)] [transition:border-color_.15s_ease] hover:border-accent focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    >
                      {previewUrl && fileKind(file) !== 'PDF' ? (
                        <img
                          src={previewUrl}
                          alt=""
                          className={`h-full w-full object-cover ${thumbReady ? 'pod-thumb' : 'opacity-0'}`}
                          onLoad={() => setThumbReady(true)}
                        />
                      ) : (
                        <FaFilePdf aria-hidden="true" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-text text-[13px] font-[650] truncate" title={file.name}>{file.name}</div>
                      <div className="mt-[1px] text-muted text-[11px]">{fileKind(file)} · {fileSize(file.size)}</div>
                      <div className="mt-[2px] flex items-center gap-[5px] text-[11px] font-[650] text-[color:var(--success-text)]">
                        <FaCircleCheck aria-hidden="true" /> Ready to attach
                      </div>
                    </div>
                    <button type="button" onClick={() => setViewing(true)} className={`${GHOST} min-h-[38px] px-[11px] text-[12px]`} aria-label={`View ${file.name}`}>
                      <FaEye aria-hidden="true" /> View
                    </button>
                    <button type="button" onClick={removeFile} className={`${GHOST} min-h-[38px] px-[11px] text-[12px]`} aria-label={`Remove ${file.name}`}>
                      <FaTrashCan aria-hidden="true" /> Remove
                    </button>
                  </div>
                )}

                {fileError && (
                  <div id={errorId} className="flex items-start gap-[7px] mt-[6px] text-[color:var(--danger-text)] text-[11.5px] leading-[1.45] [animation:podErrorIn_.2s_ease_both]" role="alert">
                    <FaTriangleExclamation aria-hidden="true" className="flex-[0_0_auto] mt-[1px]" />
                    <span>{fileError}</span>
                  </div>
                )}
              </div>

              {/* Receiver + actual delivery time — one row, one size, one colour */}
              <div className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[12px] max-[520px]:grid-cols-1">
                <div key={`received-${shake.received}`} className={`min-w-0 ${shake.received ? 'pod-shake' : undefined}`}>
                  <div className={LABEL}>
                    <label htmlFor="pod-received-by">Received by</label>
                    <span className={TAG} aria-hidden="true">Required</span>
                  </div>
                  <div className="relative">
                    <FaUser aria-hidden="true" className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-muted text-[12px]" />
                    <input
                      id="pod-received-by"
                      type="text"
                      className={`${FIELD} pl-[32px]`}
                      maxLength={255}
                      value={receivedBy}
                      onChange={(event) => setReceivedBy(event.target.value.replace(/[^\p{L}\s]/gu, ''))}
                      placeholder="Full name of the receiver"
                      autoComplete="name"
                      aria-required="true"
                      disabled={saving || saved}
                    />
                  </div>
                </div>

                <div key={`time-${shake.time}`} className={`min-w-0 ${shake.time ? 'pod-shake' : undefined}`}>
                  <div className={LABEL}>
                    <label htmlFor="pod-time">Actual delivery date and time</label>
                    <span className={TAG} aria-hidden="true">Required</span>
                  </div>
                  <PodDateTimePicker
                    id="pod-time"
                    value={deliveredAt}
                    onChange={setDeliveredAt}
                    disabled={saving || saved}
                    ariaDescribedBy={shake.time ? errorId : undefined}
                  />
                  <div className="mt-[4px] flex items-center justify-between gap-[8px]">
                    <small className="min-w-0 truncate text-muted text-[11px] leading-[1.4]">
                      {deliveredAt ? `Actually delivered ${humanTime(deliveredAt)}` : 'Set when the delivery really arrived.'}
                    </small>
                    <button
                      type="button"
                      onClick={() => setDeliveredAt(nowLocal())}
                      disabled={saving || saved}
                      className="inline-flex flex-none items-center gap-[4px] p-0 border-0 text-accent-text text-[11px] font-[650] cursor-pointer [background:transparent] underline underline-offset-2 [transition:color_.12s_ease] hover:text-text focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.5] disabled:cursor-not-allowed"
                    >
                      <FaClock aria-hidden="true" /> Use current time
                    </button>
                  </div>
                </div>
              </div>

              {/* Note */}
              <div>
                <div className={LABEL}>
                  <label htmlFor="delivery-note">Note</label>
                  <span className={TAG}>Optional</span>
                </div>
                <textarea
                  id="delivery-note"
                  className={`${FIELD} h-auto min-h-[76px] py-[9px] leading-[1.45] [resize:vertical]`}
                  maxLength={NOTE_LIMIT}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Where the delivery was left, or anything the branch should know."
                  disabled={saving || saved}
                />
                <div className="mt-[3px] flex justify-end">
                  <small className={`text-[10.5px] tabular-nums ${note.length >= NOTE_WARN_AT ? 'text-[color:var(--warning-text)] font-[650]' : 'text-muted'}`}>
                    {note.length} / {NOTE_LIMIT}
                  </small>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-[9px] p-[10px_12px] rounded-[9px] border text-[12.5px] leading-[1.55] notice-error [animation:podErrorIn_.2s_ease_both]" role="alert">
                  <FaTriangleExclamation aria-hidden="true" className="flex-[0_0_auto] mt-[2px]" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex-none flex items-center justify-between gap-[12px] p-[11px_16px] border-t border-t-line [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] max-[560px]:flex-col max-[560px]:items-stretch">
          <SwapHint missingText={missingText} complete={complete} saved={saved} />
          <div className="flex items-center gap-[8px] max-[560px]:justify-stretch">
            <button type="button" onClick={requestClose} className={`${GHOST} max-[560px]:flex-1`} disabled={saving || saved || closing}>
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!saveEnabled}
              aria-busy={saving}
              className={`inline-flex items-center justify-center gap-[7px] min-h-[42px] px-[15px] border rounded-[9px] text-[13px] font-[700] whitespace-nowrap [transition:background_.2s_ease,_color_.2s_ease,_transform_.2s_ease,_box-shadow_.2s_ease,_opacity_.2s_ease] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] max-[560px]:flex-1 ${saveEnabled ? 'border-transparent text-[#fff] cursor-pointer [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_10px_22px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] hover:-translate-y-px hover:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] active:scale-[0.98]' : 'border-line text-muted cursor-not-allowed [background:var(--surface-subtle)]'}`}
            >
              {saved ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="pod-check h-[15px] w-[15px]" aria-hidden="true">
                    <path d="M4 12.5l5 5L20 6.5" pathLength="1" />
                  </svg>
                  Saved
                </>
              ) : saving ? (
                <>
                  <span className="spinner inline-block h-[14px] w-[14px] rounded-[50%] border-[2px] border-[color:rgba(255,_255,_255,_.35)] border-t-white [animation:spin_.7s_linear_infinite]" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <FaCheck aria-hidden="true" /> Save proof of delivery
                </>
              )}
            </button>
          </div>
        </footer>

        {/* Attachment viewer: same blob the form will upload, shown before saving. */}
        {viewing && file && previewUrl && (
          <div
            className="absolute inset-0 z-[5] flex flex-col gap-[10px] p-[12px] [background:color-mix(in_srgb,_var(--panel)_97%,_transparent)] [backdrop-filter:blur(8px)] [animation:podFadeIn_.18s_ease_both]"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview of ${file.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex flex-none items-center justify-between gap-[10px]">
              <div className="min-w-0">
                <div className="truncate text-text text-[13px] font-[680]">{file.name}</div>
                <div className="text-muted text-[11px]">{fileKind(file)} · {fileSize(file.size)}</div>
              </div>
              <div className="flex flex-none items-center gap-[6px]">
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${GHOST} min-h-[36px] px-[11px] text-[12px] no-underline`}
                >
                  Open in new tab
                </a>
                <button
                  ref={viewerCloseRef}
                  type="button"
                  onClick={() => setViewing(false)}
                  aria-label="Close preview"
                  className="grid h-[36px] w-[36px] place-items-center border border-line rounded-[9px] text-text-secondary text-[14px] cursor-pointer [background:transparent] hover:text-text hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                >
                  <FaXmark aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="flex-[1_1_auto] min-h-0 grid place-items-center overflow-hidden rounded-[8px] border border-line [background:rgba(0,_0,_0,_.28)]">
              {fileKind(file) === 'PDF' ? (
                <iframe src={previewUrl} title={`Preview of ${file.name}`} className="h-full w-full border-0 [background:#fff]" />
              ) : (
                <img src={previewUrl} alt={`Preview of ${file.name}`} className="max-h-full max-w-full object-contain" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Footer hint: the incomplete line slides up and fades out while the complete line rises in. */
function SwapHint({ missingText, complete, saved }) {
  return (
    <div className="grid min-h-[34px] min-w-0 items-center max-[560px]:min-h-0" aria-live="polite">
      <span
        aria-hidden={complete}
        className={`col-start-1 row-start-1 flex items-center gap-[6px] text-[11.5px] leading-[1.4] text-muted [transition:opacity_.2s_ease,_transform_.2s_ease] motion-reduce:[transition:opacity_.15s_ease] ${complete ? 'pointer-events-none opacity-0 [transform:translateY(-6px)]' : 'opacity-100 [transform:none]'}`}
      >
        <FaTriangleExclamation aria-hidden="true" className="flex-none text-[color:var(--warning-text)]" />
        <span key={missingText} className="pod-hint-in">{missingText}</span>
      </span>
      <span
        aria-hidden={!complete}
        className={`col-start-1 row-start-1 flex items-center gap-[6px] text-[11.5px] leading-[1.4] [transition:opacity_.2s_ease,_transform_.2s_ease] motion-reduce:[transition:opacity_.15s_ease] ${complete ? 'text-[color:var(--success-text)] font-[650] opacity-100 [transform:none]' : 'pointer-events-none opacity-0 [transform:translateY(6px)]'}`}
      >
        <FaCircleCheck aria-hidden="true" className="flex-none" />
        {saved ? 'Proof of delivery saved.' : 'All required details are filled in'}
      </span>
    </div>
  );
}

// Day/time cells must not pick up the app's global button fills.
const CELL_RESET = 'appearance-none! min-h-0! shadow-none! border-0!';

/**
 * Date + time field with the app's own #070A13 calendar popup and scroll columns,
 * because the native datetime-local panel cannot be recoloured by CSS.
 */
function PodDateTimePicker({ id, value, onChange, disabled, ariaDescribedBy }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = parseLocal(value) || new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const buttonRef = useRef(null);
  const popupRef = useRef(null);
  const hourColRef = useRef(null);
  const minuteColRef = useRef(null);

  const selected = parseLocal(value);
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 330;
    const height = 348;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < height && rect.top > spaceBelow;
    setAnchor(above
      ? { left, bottom: window.innerHeight - rect.top + 6 }
      : { left, top: rect.bottom + 6 });
  };

  useEffect(() => {
    if (!open) return undefined;
    place();
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const reposition = () => place();
    // Capture phase so Escape closes only the popup, never the whole dialog.
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, value]);

  // Bring the current hour/minute into view inside the scroll columns.
  useEffect(() => {
    if (!open) return;
    const base = parseLocal(value) || new Date();
    const h12 = base.getHours() % 12 === 0 ? 12 : base.getHours() % 12;
    if (hourColRef.current) hourColRef.current.scrollTop = Math.max(0, (h12 - 1) * ROW_H - ROW_H);
    if (minuteColRef.current) minuteColRef.current.scrollTop = Math.max(0, (base.getMinutes() - 2) * ROW_H);
  }, [open, value]);

  const commit = (date) => {
    const cap = new Date();
    onChange(toLocalValue(date > cap ? cap : date));
  };

  const pickDay = (date) => {
    const base = selected ? new Date(selected) : new Date();
    base.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    commit(base);
  };

  const setHour = (h12) => {
    const base = selected ? new Date(selected) : new Date();
    const meridiem = base.getHours() < 12 ? 'AM' : 'PM';
    base.setHours((h12 % 12) + (meridiem === 'PM' ? 12 : 0));
    commit(base);
  };

  const setMinute = (minute) => {
    const base = selected ? new Date(selected) : new Date();
    base.setMinutes(minute);
    commit(base);
  };

  const setMeridiem = (next) => {
    const base = selected ? new Date(selected) : new Date();
    const hours = base.getHours();
    base.setHours(next === 'PM' ? (hours % 12) + 12 : hours % 12);
    commit(base);
  };

  const hour24 = selected ? selected.getHours() : now.getHours();
  const minuteValue = selected ? selected.getMinutes() : now.getMinutes();
  const h12Value = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiemValue = hour24 < 12 ? 'AM' : 'PM';
  const selectedDayKey = selected ? `${selected.getFullYear()}-${pad2(selected.getMonth() + 1)}-${pad2(selected.getDate())}` : '';

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;

  const hourBlocked = (h12) => selectedDayKey === todayKey && (h12 % 12) + (meridiemValue === 'PM' ? 12 : 0) > now.getHours();
  const minuteBlocked = (minute) => selectedDayKey === todayKey && hour24 >= now.getHours() && minute > now.getMinutes();

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={ariaDescribedBy}
        onClick={() => {
          if (!open) {
            const base = parseLocal(value) || new Date();
            setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
          }
          setOpen((current) => !current);
        }}
        className={`${FIELD} flex items-center justify-between gap-[8px] text-left cursor-pointer`}
      >
        <span className={`truncate tabular-nums ${selected ? '' : 'text-placeholder'}`}>
          {selected ? displayDateTime(selected) : 'mm/dd/yyyy  --:-- --'}
        </span>
        <FaRegCalendarDays aria-hidden="true" className="flex-none text-muted text-[12.5px]" />
      </button>

      {open && anchor && createPortal(
        <div
          ref={popupRef}
          data-pod-picker="true"
          role="dialog"
          aria-label="Choose delivery date and time"
          style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
          className="fixed z-[1300] w-[330px] max-w-[calc(100vw_-_16px)] p-[9px] border border-[#1B2437] rounded-[8px] [background:#070A13] [box-shadow:0_18px_44px_rgba(3,7,18,.6)] light:border-line light:[background:var(--panel)] light:[box-shadow:var(--shadow-md)]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="grid grid-cols-[1fr_96px] gap-[8px]">
            <div>
              <div className="flex items-center justify-between gap-[6px] mb-[6px]">
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => setViewMonth(new Date(year, month - 1, 1))}
                  className={`${CELL_RESET} grid h-[26px] w-[26px] place-items-center rounded-[6px] p-0! text-[#A9B4C8]! [background:transparent]! cursor-pointer [transition:color_.15s_ease,_background_.15s_ease] hover:text-white! hover:[background:#141C2D]! light:text-muted light:hover:text-text light:hover:[background:var(--hover)]!`}
                >
                  <FaChevronLeft aria-hidden="true" className="text-[11px]" />
                </button>
                <strong className="text-[12.5px] font-[720] tracking-[-.01em] text-[#EEF2FA] light:text-text">
                  {MONTH_NAMES[month]} {year}
                </strong>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() => setViewMonth(new Date(year, month + 1, 1))}
                  className={`${CELL_RESET} grid h-[26px] w-[26px] place-items-center rounded-[6px] p-0! text-[#A9B4C8]! [background:transparent]! cursor-pointer [transition:color_.15s_ease,_background_.15s_ease] hover:text-white! hover:[background:#141C2D]! light:text-muted light:hover:text-text light:hover:[background:var(--hover)]!`}
                >
                  <FaChevronRight aria-hidden="true" className="text-[11px]" />
                </button>
              </div>

              <div className="grid grid-cols-7 mb-[2px]">
                {WEEKDAY_NAMES.map((label) => (
                  <span key={label} className="grid h-[22px] place-items-center text-[9.5px] font-[800] tracking-[.04em] text-[#7B879C] light:text-muted">{label.toUpperCase()}</span>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-[1px]">
                {Array.from({ length: cellCount }, (_, index) => {
                  const date = new Date(year, month, 1 - offset + index);
                  if (date.getMonth() !== month) return <span key={`blank-${index}`} aria-hidden="true" className="h-[28px]" />;
                  const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
                  const isSelected = key === selectedDayKey;
                  const isFuture = key > todayKey;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={isFuture}
                      aria-pressed={isSelected}
                      aria-current={key === todayKey ? 'date' : undefined}
                      onClick={() => pickDay(date)}
                      className={`${CELL_RESET} grid h-[28px] w-full place-items-center rounded-[6px] p-0! text-[13px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${isSelected ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! font-[560]! hover:[background:#141C2D]! light:text-text! light:hover:[background:var(--hover)]!'} ${isFuture ? 'opacity-[.28]! cursor-not-allowed!' : ''} ${key === todayKey && !isSelected ? 'text-[#9DB2FF]! light:text-accent-text!' : ''}`}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between gap-[8px] pt-[6px] mt-[4px] border-t border-[#1B2437] light:border-line">
                <button
                  type="button"
                  onClick={() => {
                    const base = new Date();
                    onChange(toLocalValue(base));
                  }}
                  className={`${CELL_RESET} p-0! text-[11.5px]! font-[680]! text-[#8FA8FF]! [background:transparent]! cursor-pointer hover:text-[#B4C6FF]! light:text-accent-text`}
                >
                  Now
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    buttonRef.current?.focus();
                  }}
                  className={`${CELL_RESET} p-0! text-[11.5px]! font-[680]! text-[#A9B4C8]! [background:transparent]! cursor-pointer hover:text-white! light:text-muted light:hover:text-text`}
                >
                  Done
                </button>
              </div>
            </div>

            {/* Time: hour / minute scroll columns, like the native picker but in the app's own navy. */}
            <div className="grid grid-cols-[1fr_1fr_38px] gap-[2px] pt-[2px] border-l border-[#1B2437] pl-[6px] light:border-line">
              <div role="listbox" aria-label="Hour" ref={hourColRef} className="h-[224px] overflow-y-auto [scrollbar-width:thin]">
                {Array.from({ length: 12 }, (_, index) => index + 1).map((h12) => (
                  <button
                    key={h12}
                    type="button"
                    role="option"
                    aria-selected={h12 === h12Value}
                    disabled={hourBlocked(h12)}
                    onClick={() => setHour(h12)}
                    className={`${CELL_RESET} grid h-[28px] w-full place-items-center rounded-[6px] p-0! text-[13px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${h12 === h12Value ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]! light:text-text! light:hover:[background:var(--hover)]!'} ${hourBlocked(h12) ? 'opacity-[.25]! cursor-not-allowed!' : ''}`}
                  >
                    {pad2(h12)}
                  </button>
                ))}
              </div>
              <div role="listbox" aria-label="Minute" ref={minuteColRef} className="h-[224px] overflow-y-auto [scrollbar-width:thin]">
                {Array.from({ length: 60 }, (_, index) => index).map((minute) => (
                  <button
                    key={minute}
                    type="button"
                    role="option"
                    aria-selected={minute === minuteValue}
                    disabled={minuteBlocked(minute)}
                    onClick={() => setMinute(minute)}
                    className={`${CELL_RESET} grid h-[28px] w-full place-items-center rounded-[6px] p-0! text-[13px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${minute === minuteValue ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]! light:text-text! light:hover:[background:var(--hover)]!'} ${minuteBlocked(minute) ? 'opacity-[.25]! cursor-not-allowed!' : ''}`}
                  >
                    {pad2(minute)}
                  </button>
                ))}
              </div>
              <div role="listbox" aria-label="AM or PM" className="h-[224px] overflow-y-auto [scrollbar-width:thin]">
                {['AM', 'PM'].map((label) => (
                  <button
                    key={label}
                    type="button"
                    role="option"
                    aria-selected={label === meridiemValue}
                    onClick={() => setMeridiem(label)}
                    className={`${CELL_RESET} grid h-[28px] w-full place-items-center rounded-[6px] p-0! text-[12.5px] font-[650] cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${label === meridiemValue ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]! light:text-text! light:hover:[background:var(--hover)]!'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
