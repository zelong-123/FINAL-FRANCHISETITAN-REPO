import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { Field, Modal } from '../ApiUi';
import RecordCode from '../RecordCode';
import {
  ACTIVITY_TYPES, BRANDED_TYPES, DEFAULT_DURATION_MINUTES, NO_BRAND_PREFERENCE, VENUE_OPTIONS,
  activityLabel, addMinutes, brandCheck, formatSessionRange, minutesBetween, sessionPayload, splitManila,
} from '../../lib/scheduleSessions';
import { closesMinutes, lastStartMinutes, minutesLabel, opensMinutes } from '../../lib/scheduleConfig';
import useScheduleConfig from '../../lib/useScheduleConfig';

/*
 * Schedule form for the Master Schedule — create a session, edit one, or
 * Set Again for one participant. Every change runs the backend's rule check
 * (POST /schedule-sessions/evaluate, debounced); the backend checks again on
 * save. Clicking a suggested time only FILLS the form — the user still saves.
 *
 * mode: 'create' | 'edit' | 'setAgain'
 */
const DEBOUNCE_MS = 450;

function initialForm(mode, session, applicant) {
  if (mode === 'create') {
    return {
      applicant_ids: [], activity_type: 'orientation', brand_id: '', date: '', start: '', end: '',
      handler_id: '', venue: '', remarks: '', max_capacity: '',
    };
  }
  const start = splitManila(session.start_at);
  const end = splitManila(session.end_at);
  return {
    applicant_ids: mode === 'setAgain' ? [applicant.id] : [],
    activity_type: session.activity_type,
    brand_id: session.brand_id ? String(session.brand_id) : '',
    date: start.date,
    start: start.time,
    end: end.time,
    handler_id: session.handler_id ? String(session.handler_id) : '',
    venue: session.venue || '',
    remarks: mode === 'edit' ? (session.remarks || '') : '',
    max_capacity: mode === 'edit' ? String(session.max_capacity) : '',
  };
}

export default function SessionForm({ mode = 'create', session = null, applicant = null, brands = [], handlers = [], isAdmin, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(mode, session, applicant));
  // The one scheduling window (same values as the API save check and suggestions).
  const window_ = useScheduleConfig();
  const durationFor = (type) => window_.default_duration_minutes?.[type] || DEFAULT_DURATION_MINUTES[type] || 120;
  const defaultDuration = durationFor(form.activity_type);
  const [endTouched, setEndTouched] = useState(mode !== 'create');
  const [search, setSearch] = useState('');
  // Server-side applicant search (debounced): every eligible applicant can be
  // found by Applicant ID, name, email or phone — not just a first page.
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [picked, setPicked] = useState({}); // id → row, kept when it leaves the results
  const searchNo = useRef(0);
  const [rawEvaluation, setEvaluation] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [overrideRemarks, setOverrideRemarks] = useState('');
  const [fromSuggestion, setFromSuggestion] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // Merge targets seen for this booking; saving another time later = "declined".
  const seenMergeTargets = useRef(new Set());
  const requestNo = useRef(0);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const branded = BRANDED_TYPES.includes(form.activity_type);

  const chosen = useMemo(() => {
    if (mode === 'setAgain') return [applicant];
    if (mode === 'edit') return (session?.active_participants || []).map((row) => row.applicant).filter(Boolean);
    return form.applicant_ids.map((id) => picked[id]).filter(Boolean);
  }, [mode, applicant, session, picked, form.applicant_ids]);

  useEffect(() => {
    if (mode !== 'create') return undefined;
    const ticket = ++searchNo.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError('');
      try {
        const response = await api.get('/applicants', { search: search.trim(), eligible_for_scheduling: 1, per_page: 20 });
        if (ticket === searchNo.current) setResults(response.data || []);
      } catch (error) {
        if (ticket === searchNo.current) setSearchError(firstValidationMessage(error));
      } finally {
        if (ticket === searchNo.current) setSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [mode, search]);

  const togglePick = (row) => {
    const isPicked = form.applicant_ids.includes(row.id);
    setPicked((current) => ({ ...current, [row.id]: row }));
    set({ applicant_ids: isPicked ? form.applicant_ids.filter((id) => id !== row.id) : [...form.applicant_ids, row.id] });
  };
  const brands_ = brandCheck(form.activity_type, form.brand_id, chosen);

  // Brand auto-fill from the applicants' shared preference (tasting/training).
  useEffect(() => {
    if (mode === 'create' && branded && !form.brand_id && brands_.commonBrandId) {
      set({ brand_id: String(brands_.commonBrandId) });
    }
  }, [mode, branded, form.brand_id, brands_.commonBrandId]);

  // End time follows the default duration until the user edits it.
  useEffect(() => {
    if (!endTouched && form.start) set({ end: addMinutes(form.start, defaultDuration) });
  }, [form.start, defaultDuration, endTouched]);

  const ready = Boolean(form.date && form.start && form.end && minutesBetween(form.start, form.end) > 0
    && (mode !== 'create' || form.applicant_ids.length > 0));

  // Live rule check (debounced). Stale answers are ignored.
  useEffect(() => {
    if (!ready) return undefined;
    const ticket = ++requestNo.current;
    const timer = window.setTimeout(async () => {
      setChecking(true);
      setCheckError('');
      try {
        const body = { ...sessionPayload(form) };
        if (mode === 'create') body.applicant_ids = form.applicant_ids;
        if (mode === 'edit') body.session_id = session.id;
        if (mode === 'setAgain') { body.applicant_ids = [applicant.id]; body.set_again_session_id = session.id; delete body.max_capacity; }
        const response = await api.post('/schedule-sessions/evaluate', body);
        if (ticket !== requestNo.current) return;
        setEvaluation(response.data);
        (response.data.merge_targets || []).forEach((target) => seenMergeTargets.current.add(target.session_id));
      } catch (error) {
        if (ticket === requestNo.current) { setEvaluation(null); setCheckError(firstValidationMessage(error)); }
      } finally {
        if (ticket === requestNo.current) setChecking(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, form.applicant_ids, form.activity_type, form.brand_id, form.date, form.start, form.end, form.handler_id, form.venue, form.max_capacity]);

  // An unfinished form shows no verdict (the last one may be for other inputs).
  const evaluation = ready ? rawEvaluation : null;
  const status = evaluation?.status;
  const brandBlocked = branded && (brands_.missing.length > 0 || brands_.mismatched.length > 0);
  const mergeTargets = evaluation?.merge_targets || [];

  const save = async (decision = {}) => {
    setSaving(true);
    setSaveError('');
    const declined = status !== 'mergeable' ? [...seenMergeTargets.current] : [];
    const body = {
      ...sessionPayload(form),
      remarks: form.remarks || null,
      override_remarks: overrideRemarks.trim() || null,
      from_suggestion: fromSuggestion || undefined,
      declined_merge_session_ids: declined.length ? declined : undefined,
      ...decision,
    };
    try {
      let response;
      if (mode === 'create') {
        response = await api.post('/schedule-sessions', { ...body, applicant_ids: form.applicant_ids });
      } else if (mode === 'edit') {
        response = await api.put(`/schedule-sessions/${session.id}`, body);
      } else {
        delete body.max_capacity;
        response = await api.post(`/schedule-sessions/${session.id}/participants/${applicant.id}/set-again`, body);
      }
      onSaved?.(response);
    } catch (error) {
      // A refusal carries the backend's own evaluation: show it as-is.
      if (error instanceof ApiError && error.payload?.evaluation) setEvaluation(error.payload.evaluation);
      setSaveError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const applySuggestion = (slot) => {
    const start = splitManila(slot.start_at);
    const end = splitManila(slot.end_at);
    setEndTouched(true);
    setFromSuggestion(true);
    set({ date: start.date, start: start.time, end: end.time });
  };
  const editTime = (patch) => { setFromSuggestion(false); set(patch); };

  const title = mode === 'create' ? 'Schedule a session'
    : mode === 'edit' ? `Edit ${activityLabel(session.activity_type)} session`
      : `Set Again — ${applicant.full_name}`;

  // ---- Save area: what the user may do, by status and role ----
  const baseDisabled = saving || checking || !ready || !evaluation || brandBlocked;
  let actions;
  if (status === 'mergeable') {
    actions = (
      <>
        {isAdmin && mode === 'create' && mergeTargets.map((target) => (
          <button key={target.session_id} type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={baseDisabled}
            onClick={() => void save({ join_session_id: target.session_id })}>
            Add to existing session · {target.time}
          </button>
        ))}
        <button type="button" className={isAdmin && mode === 'create' ? 'ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]' : 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]'}
          disabled={baseDisabled || !evaluation.separate_allowed || (evaluation.warnings?.length > 0 && (!isAdmin || !overrideRemarks.trim()))}
          title={evaluation.separate_allowed ? undefined : (evaluation.separate_blockers || []).join(' ')}
          onClick={() => void save({ create_separate: true })}>
          {isAdmin ? 'Create separate session' : 'Create separate session (Pending — Admin will review)'}
        </button>
      </>
    );
  } else {
    const warningBlocked = status === 'warning' && (!isAdmin || !overrideRemarks.trim());
    actions = (
      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={baseDisabled || status === 'blocked' || warningBlocked}
        onClick={() => void save()}>
        {saving ? 'Saving…' : mode === 'create' ? (isAdmin ? 'Save session' : 'Save (Pending — Admin will review)') : 'Save changes'}
      </button>
    );
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="wide"
      footer={(
        <div className="flex flex-wrap gap-2 justify-end w-full">
          <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={onClose}>Close</button>
          {actions}
        </div>
      )}
    >
      <div className="ms-form grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[12px_14px] later-2:[&_.full]:col-span-full max-[681px]:later:grid-cols-[minmax(0,_1fr)]">
        {mode === 'create' ? (
          <Field label="Applicants" full required hint="Only Qualified or Scheduling applicants are listed.">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by ID, name, email, or phone" aria-label="Search applicants" />
            {chosen.length > 0 && (
              <p className="m-[6px_0_0] text-text-secondary text-[11.5px]">Selected: {chosen.map((row) => row.full_name).join(', ')}</p>
            )}
            <ul className="grid max-h-[210px] m-[6px_0_0] p-1 overflow-auto border border-input-line rounded-[9px] [background:var(--input-bg)] [list-style:none] [&_label]:grid [&_label]:grid-cols-[auto_1fr_auto] [&_label]:items-center [&_label]:gap-[2px_8px] [&_label]:p-[6px_8px] [&_label]:rounded-[7px] [&_label]:cursor-pointer [&_label:hover]:[background:var(--hover)] [&_label.is-picked]:[background:var(--active)] [&_small]:col-[2_/_-1] [&_small]:text-muted [&_small]:text-[11px]" role="listbox" aria-multiselectable="true" aria-busy={searching}>
              {searchError && <li className="text-muted text-[12px]">{searchError}</li>}
              {!searchError && results.length === 0 && <li className="text-muted text-[12px]">{searching ? 'Searching…' : 'No eligible applicants match.'}</li>}
              {results.map((row) => {
                const isPicked = form.applicant_ids.includes(row.id);
                return (
                  <li key={row.id}>
                    <label className={isPicked ? 'is-picked' : ''}>
                      <input type="checkbox" checked={isPicked} onChange={() => togglePick(row)} />
                      <span className="text-text">{row.full_name}</span>
                      <RecordCode code={row.applicant_code} label="Applicant ID" copyable={false} />
                      <small>{row.preferred_brand?.name || 'No brand preference'}{row.phone ? ` · ${row.phone}` : ''}</small>
                    </label>
                  </li>
                );
              })}
            </ul>
          </Field>
        ) : (
          <div className="[&_span]:text-muted [&_span]:text-[11px] [&_p]:m-[2px_0_0] [&_p]:text-text full [.ap-grid_&]:col-span-full">
            <span>{mode === 'setAgain' ? 'Applicant (leaves the group, gets a new session)' : 'Participants'}</span>
            <p>{chosen.map((row) => row.full_name).join(', ') || '—'}</p>
          </div>
        )}

        {/* Brand problems, named per applicant (H6). */}
        {branded && (brands_.missing.length > 0 || brands_.mismatched.length > 0) && (
          <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-blocked full [.ap-grid_&]:col-span-full" role="alert">
            {brands_.missing.map((row) => (
              <p key={`m-${row.id}`}>
                <strong>{row.full_name}:</strong> {NO_BRAND_PREFERENCE}{' '}
                <Link to="/applicants" state={{ focusApplicantId: row.id }}>Set it on the applicant →</Link>
              </p>
            ))}
            {brands_.mismatched.length > 0 && (
              <p>
                <strong>Brand preferences do not match{form.brand_id ? ' the session brand' : ''}:</strong>{' '}
                {brands_.mismatched.map((row) => `${row.full_name} (${row.preferred_brand?.name || '—'})`).join(', ')}
              </p>
            )}
          </div>
        )}

        <Field label="Activity" required>
          <select value={form.activity_type} disabled={mode !== 'create'}
            onChange={(event) => set({ activity_type: event.target.value, brand_id: BRANDED_TYPES.includes(event.target.value) ? form.brand_id : '' })}>
            {ACTIVITY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </Field>
        <Field label="Brand" required={branded} hint={branded ? 'Must match every applicant’s brand preference.' : 'Orientation is not brand-specific.'}>
          <select value={form.brand_id} disabled={!branded || mode === 'setAgain'} onChange={(event) => set({ brand_id: event.target.value })}>
            <option value="">{branded ? 'Select brand' : '— Not needed —'}</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </Field>
        <Field label="Date" required>
          <input type="date" value={form.date} onChange={(event) => editTime({ date: event.target.value })} />
        </Field>
        <Field label="Start time" required hint={`${window_.days_label}, ${minutesLabel(opensMinutes())}–${minutesLabel(lastStartMinutes())}, on :00 or :30.`}>
          <input type="time" step="1800" min={window_.opens_at} max={window_.last_start} value={form.start} onChange={(event) => editTime({ start: event.target.value })} />
        </Field>
        <Field label="End time" required hint={`Default ${durationFor(form.activity_type) / 60} h — editable (whole hours), ends by ${minutesLabel(closesMinutes())}.`}>
          <input type="time" step="1800" min={window_.opens_at} max={window_.closes_at} value={form.end} onChange={(event) => { setEndTouched(true); editTime({ end: event.target.value }); }} />
        </Field>
        <Field label="Handler">
          <select value={form.handler_id} onChange={(event) => set({ handler_id: event.target.value })}>
            <option value="">No handler</option>
            {handlers.map((user) => <option key={user.id} value={user.id}>{user.full_name}{user.role ? ` (${user.role})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Venue">
          <select value={form.venue} onChange={(event) => set({ venue: event.target.value })}>
            <option value="">Not set</option>
            {VENUE_OPTIONS.map((venue) => <option key={venue} value={venue}>{venue}</option>)}
          </select>
        </Field>
        {mode !== 'setAgain' && (
          <Field label="Max capacity" hint="Leave empty for the activity default.">
            <input type="number" min="1" value={form.max_capacity} onChange={(event) => set({ max_capacity: event.target.value })} />
          </Field>
        )}
        <Field label="Remarks" full>
          <textarea rows={2} value={form.remarks} onChange={(event) => set({ remarks: event.target.value })} />
        </Field>

        {/* ---- Live rule check ---- */}
        <section className="grid gap-2 full [.ap-grid_&]:col-span-full" aria-live="polite">
          {!ready ? (
            <p className="text-muted text-[12px]">Pick {mode === 'create' ? 'applicants, ' : ''}a date and a time to check the schedule.</p>
          ) : checking && !evaluation ? (
            <p className="text-muted text-[12px]">Checking the schedule…</p>
          ) : checkError ? (
            <p className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-blocked">{checkError}</p>
          ) : evaluation ? (
            <EvaluationView
              evaluation={evaluation}
              isAdmin={isAdmin}
              overrideRemarks={overrideRemarks}
              setOverrideRemarks={setOverrideRemarks}
              onSuggestion={applySuggestion}
              checking={checking}
            />
          ) : null}
          {saveError && <p className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-blocked" role="alert">{saveError}</p>}
        </section>
      </div>
    </Modal>
  );
}

function EvaluationView({ evaluation, isAdmin, overrideRemarks, setOverrideRemarks, onSuggestion, checking }) {
  const { status, reasons = [], warnings = [], merge_targets: targets = [], suggested_times: slots = [] } = evaluation;

  return (
    <div className={`grid gap-2 [&.is-stale]:opacity-[.6] is-${status}${checking ? ' is-stale' : ''}`}>
      {status === 'ok' && <p className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-ok">No conflicts — this time is free.</p>}

      {status === 'blocked' && (
        <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-blocked">
          <strong>Hindi puwede ang oras na ito:</strong>
          <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </div>
      )}

      {status === 'mergeable' && (
        <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-merge">
          <strong>May overlapping session na puwedeng pagsamahin:</strong>
          <ul>
            {targets.map((target) => (
              <li key={target.session_id}>
                {formatSessionRange(target.start_at, target.end_at)} · {target.brand || 'Any brand'} · {target.handler || 'No handler'} · {target.occupancy} — {target.why}
              </li>
            ))}
          </ul>
          {!isAdmin && <p className="text-muted text-[12px]">Admin lang ang puwedeng mag-merge. You can save a separate session (Admin will review it) or pick another time.</p>}
          {!evaluation.separate_allowed && (evaluation.separate_blockers || []).map((reason) => <p key={reason} className="text-muted text-[12px]">Separate session: {reason}</p>)}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-warning">
          <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          {isAdmin ? (
            <label className="grid gap-1 mt-2 text-text-secondary text-[11.5px] [&_textarea]:w-full">
              <span>Override remarks (required to save)</span>
              <textarea rows={2} value={overrideRemarks} onChange={(event) => setOverrideRemarks(event.target.value)} />
            </label>
          ) : (
            <p>Pumili ng ibang oras o handler, o hilingin sa Admin.</p>
          )}
        </div>
      )}

      {slots.length > 0 && status !== 'ok' && (
        <div className="grid gap-[6px] text-muted text-[11.5px] [&_div]:flex [&_div]:flex-wrap [&_div]:gap-[6px]">
          <span>Suggested times (click to fill the form — it does not save):</span>
          <div>{slots.map((slot) => (
            <button key={slot.start_at} type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => onSuggestion(slot)}>{slot.label}</button>
          ))}</div>
        </div>
      )}
    </div>
  );
}
