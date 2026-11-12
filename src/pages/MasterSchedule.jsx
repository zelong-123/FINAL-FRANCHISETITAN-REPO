import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { FaPlus, FaRotateLeft } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import { Notice } from '../components/ApiUi';
import useRemote from '../lib/useRemote';
import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roleAccess';
import SessionForm from '../components/schedule/SessionForm';
import SessionDetail from '../components/schedule/SessionDetail';
import DropDialog from '../components/schedule/DropDialog';
import { ACTIVITY_TYPES, SESSION_STATUSES, STATUS_COLORS, activityLabel, formatSessionRange, statusLabel } from '../lib/scheduleSessions';

/*
 * Master Schedule — every Orientation / Product Tasting / Training session on
 * one calendar (Month / Week / Day). Rule-based decision support: the form and
 * the session panel ask the backend what is allowed; nothing is merged,
 * cancelled or saved without the user's click and confirmation.
 * Drag a session to reschedule it; Admin can also drop it ONTO another
 * session to merge. One evaluate-drag call colours the targets while dragging;
 * the backend decides every drop again (move / merge, same rule gate + lock).
 */
/**
 * `embedded`: rendered as the "Master Schedule" tab of Activities & Schedule
 * (/activities?view=master-schedule). Same features; only the outer page
 * frame is dropped and the heading becomes a section heading.
 */
export default function MasterSchedule({ embedded = false }) {
  const { role } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const permissions = useMemo(() => ({
    schedule: can(role, 'schedule_sessions.schedule'),
    confirm: can(role, 'schedule_sessions.confirm'),
    cancel: can(role, 'schedule_sessions.cancel'),
    remove: can(role, 'schedule_sessions.remove_participant'),
    merge: can(role, 'schedule_sessions.merge'),
  }), [role]);
  const isAdmin = permissions.merge;

  const [range, setRange] = useState(null);
  const [filters, setFilters] = useState({ activity_type: '', brand_id: '', handler_id: '', status: '', merge_suggested: false });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [brands, setBrands] = useState([]);
  const [handlers, setHandlers] = useState([]);
  const [form, setForm] = useState(null); // { mode, session?, applicant? }
  const detailId = searchParams.get('session');

  // Reference data for the filters and the form.
  useEffect(() => {
    void (async () => {
      try {
        const [brandList, handlerList] = await Promise.all([api.get('/brands'), api.get('/schedule-sessions/handlers')]);
        setBrands(brandList.data || []);
        setHandlers(handlerList.data || []);
      } catch (loadError) {
        setError(firstValidationMessage(loadError));
      }
    })();
  }, []);

  // Calendar feed for the visible range + filters (same data hook as the other pages).
  const feed = useRemote(async () => {
    if (!range) return [];
    const response = await api.get('/schedule-sessions', {
      from: range.from,
      to: range.to,
      activity_type: filters.activity_type,
      brand_id: filters.brand_id,
      handler_id: filters.handler_id,
      'status[]': filters.status,
      merge_suggested: filters.merge_suggested ? 1 : undefined,
    });
    return response.data || [];
  }, [range, filters]);
  const sessions = useMemo(() => feed.data || [], [feed.data]);
  const loadSessions = feed.reload;

  const hasFilters = Boolean(filters.activity_type || filters.brand_id || filters.handler_id || filters.status || filters.merge_suggested);
  const resetFilters = () => setFilters({ activity_type: '', brand_id: '', handler_id: '', status: '', merge_suggested: false });

  const events = useMemo(() => sessions.map((session) => {
    const color = STATUS_COLORS[session.status] || '#6b7488';
    return {
      id: String(session.id),
      start: session.start_at,
      end: session.end_at,
      // Tinted cards keep the calendar readable; the status colour stays as the accent.
      backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
      borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
      classNames: [`ms-event`, `is-${session.status}`],
      // Only live sessions can be dragged (reschedule; Admin may also merge).
      editable: permissions.schedule && ['pending', 'confirmed'].includes(session.status),
      extendedProps: { session },
    };
  }), [sessions, permissions.schedule]);

  // ---------------- Phase 3: drag-and-merge ----------------
  // Event elements by session id, so a drag can colour them without
  // re-rendering the calendar mid-drag.
  const eventEls = useRef(new Map());
  const drag = useRef(null);
  const [drop, setDrop] = useState(null);

  const clearHighlights = () => {
    eventEls.current.forEach((el) => {
      el.classList.remove('ms-drop-mergeable', 'ms-drop-blocked', 'ms-drop-source');
      if (el.dataset.dragTitle !== undefined) {
        el.title = el.dataset.dragTitle;
        delete el.dataset.dragTitle;
      }
    });
  };

  /** ONE evaluate-drag call per drag: green = mergeable (Admin), grey = blocked (+ reason). */
  const onDragStart = async (info) => {
    const state = { id: Number(info.event.id), session: info.event.extendedProps.session, targets: new Map(), handled: false, overId: null };
    drag.current = state;
    eventEls.current.get(info.event.id)?.classList.add('ms-drop-source');
    try {
      const response = await api.post(`/schedule-sessions/${state.id}/evaluate-drag`, { from: range.from, to: range.to });
      if (drag.current !== state) return; // the drag already ended
      (response.data?.targets || []).forEach((target) => {
        state.targets.set(target.session_id, target);
        const el = eventEls.current.get(String(target.session_id));
        if (!el) return;
        el.dataset.dragTitle = el.title || '';
        if (target.status === 'mergeable' && isAdmin) {
          el.classList.add('ms-drop-mergeable');
          el.title = 'Drop here to merge into this session';
        } else if (target.status === 'blocked') {
          el.classList.add('ms-drop-blocked');
          el.title = target.reasons.join('\n');
        }
      });
    } catch {
      // Without the preview the drop is still fully checked by the backend.
    }
  };

  /** The live session element under the pointer (not the dragged copy). */
  const sessionIdAt = (x, y, sourceId) => {
    const hit = document.elementsFromPoint(x, y)
      .map((el) => el.closest('[data-session-id]'))
      .find((el) => el && !el.classList.contains('fc-event-mirror') && el.dataset.sessionId !== String(sourceId));
    return hit ? Number(hit.dataset.sessionId) : null;
  };

  const dropOnSession = (state, targetId) => {
    const preview = state.targets.get(targetId);
    if (preview?.status === 'blocked') {
      setDrop({ kind: 'blocked', session: state.session, reasons: preview.reasons });
      return;
    }
    const target = sessions.find((row) => row.id === targetId);
    if (target) setDrop({ kind: 'merge', session: state.session, target });
  };

  /** Dropped on a time: the backend evaluates first, then the user confirms. */
  const reschedule = async (session, start, end, revert, fromSuggestion = false) => {
    try {
      const response = await api.post('/schedule-sessions/evaluate', {
        activity_type: session.activity_type,
        brand_id: session.brand_id,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        handler_id: session.handler_id,
        venue: session.venue,
        session_id: session.id,
      });
      const evaluation = response.data;
      if (evaluation.status === 'blocked') {
        revert?.();
        setDrop({ kind: 'blocked', session, reasons: evaluation.reasons, suggestions: evaluation.suggested_times });
      } else if (evaluation.status === 'warning' && !isAdmin) {
        revert?.();
        setDrop({ kind: 'blocked', session, reasons: [...evaluation.warnings, 'Pumili ng ibang oras o handler, o hilingin sa Admin.'] });
      } else {
        setDrop({ kind: 'move', session, start, end, revert, evaluation, fromSuggestion });
      }
    } catch (checkError) {
      revert?.();
      setDrop({ kind: 'blocked', session, reasons: [firstValidationMessage(checkError)] });
    }
  };

  const onDragStop = (info) => {
    const state = drag.current;
    clearHighlights();
    if (!state) return;
    state.overId = sessionIdAt(info.jsEvent.clientX, info.jsEvent.clientY, state.id);
    // eventDrop (if the time changed) runs right after this; a drop onto a
    // session at the SAME time fires no eventDrop, so it is handled here.
    window.setTimeout(() => {
      if (!state.handled && state.overId && isAdmin) dropOnSession(state, state.overId);
      if (drag.current === state) drag.current = null;
    }, 0);
  };

  const onDrop = (info) => {
    const state = drag.current;
    if (state) state.handled = true;
    if (state && isAdmin && state.overId) {
      info.revert(); // merging takes the TARGET's time
      dropOnSession(state, state.overId);
      return;
    }
    void reschedule(info.event.extendedProps.session, info.event.start, info.event.end, info.revert);
  };

  const openDetail = (id) => setSearchParams((params) => { params.set('session', String(id)); return params; });
  const closeDetail = () => setSearchParams((params) => { params.delete('session'); return params; });

  const openForm = (next) => setForm(next);

  const onSaved = (response) => {
    setForm(null);
    setNotice(response?.message || 'Saved.');
    void loadSessions();
    const saved = response?.data?.session ?? response?.data;
    if (saved?.id) openDetail(saved.id);
  };

  return (
    <div className={embedded ? "master-schedule block is-embedded" : "page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] master-schedule block"}>
      <Notice type="error">{error || feed.error}</Notice>
      <Notice type="success">{notice}</Notice>

      <div className="flex flex-wrap items-end justify-between gap-[10px_16px] mb-[14px] p-[12px_14px] border border-line rounded-[14px] [background:color-mix(in_srgb,_var(--panel)_94%,_transparent)] max-[901px]:later:items-stretch">
        <div className="flex flex-wrap items-end gap-[10px] min-w-0 max-[901px]:flex-[1_1_100%]" role="group" aria-label="Calendar filters">
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <span>Activity</span>
            <select value={filters.activity_type} onChange={(event) => setFilters({ ...filters, activity_type: event.target.value })} aria-label="Filter by activity">
              <option value="">All activities</option>
              {ACTIVITY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <span>Brand</span>
            <select value={filters.brand_id} onChange={(event) => setFilters({ ...filters, brand_id: event.target.value })} aria-label="Filter by brand">
              <option value="">All brands</option>
              {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <span>Handler</span>
            <select value={filters.handler_id} onChange={(event) => setFilters({ ...filters, handler_id: event.target.value })} aria-label="Filter by handler">
              <option value="">All handlers</option>
              {handlers.map((user) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-[10px_14px] max-[901px]:justify-between">
          {permissions.schedule && (
            <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] flex-[0_0_auto] max-[641px]:w-full" onClick={() => openForm({ mode: 'create' })}>
              <FaPlus aria-hidden="true" /> Schedule session
            </button>
          )}
          {isAdmin && (
            <label className="inline-flex items-center gap-2 text-text-secondary text-[11px] font-[600] cursor-pointer [&_input]:[appearance:none] [&_input]:relative [&_input]:w-[30px] [&_input]:h-[18px] [&_input]:flex-[0_0_auto] [&_input]:m-0 [&_input]:border [&_input]:border-line-strong [&_input]:rounded-[999px] [&_input]:[background:var(--surface-strong)] [&_input]:[transition:background_.18s_ease,_border-color_.18s_ease] [&_input::after]:[content:''] [&_input::after]:absolute [&_input::after]:top-[2px] [&_input::after]:left-[2px] [&_input::after]:w-[12px] [&_input::after]:h-[12px] [&_input::after]:rounded-[50%] [&_input::after]:[background:var(--muted)] [&_input::after]:[transition:transform_.18s_ease,_background_.18s_ease] [&_input:checked]:border-[color:color-mix(in_srgb,_var(--accent)_55%,_transparent)] [&_input:checked]:[background:color-mix(in_srgb,_var(--accent)_30%,_transparent)] [&_input:checked::after]:[transform:translateX(12px)] [&_input:checked::after]:[background:var(--accent-text)]">
              <input type="checkbox" checked={filters.merge_suggested} onChange={(event) => setFilters({ ...filters, merge_suggested: event.target.checked })} />
              <span>Merge suggested only</span>
            </label>
          )}
          {hasFilters && (
            <button type="button" className="inline-flex items-center gap-[6px] min-h-[34px] p-[0_11px] border border-line rounded-[9px] [background:transparent] text-text-secondary text-[11px] font-[650] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:border-line-strong hover:[background:var(--hover)] hover:text-text" onClick={resetFilters}>
              <FaRotateLeft aria-hidden="true" /> Reset
            </button>
          )}
        </div>
      </div>

      <section className="data-panel overflow-hidden border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] ms-calendar p-0 mb-[18px] later:hover:border-line later:hover:[box-shadow:var(--shadow-sm)]">
        <div className="flex flex-wrap items-center justify-between gap-[8px_14px] p-[9px_14px] border-b border-b-line max-[641px]:later:p-[8px_10px]">
          <div className="flex flex-wrap gap-[3px]" role="group" aria-label="Filter by status">
            <button type="button" className={`inline-flex items-center gap-[6px] min-h-[28px] p-[0_10px] border border-transparent rounded-[999px] [background:transparent] text-muted text-[11px] font-[600] [transition:color_.15s_ease,_background_.15s_ease,_border-color_.15s_ease] hover:text-text hover:[background:var(--hover)] [&.is-active]:text-text [&.is-active]:border-line-strong later:[&.is-active]:[background:var(--surface-strong)] [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-[50%] ${filters.status ? '' : ' is-active'}`} aria-pressed={!filters.status} onClick={() => setFilters({ ...filters, status: '' })}>All</button>
            {SESSION_STATUSES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`inline-flex items-center gap-[6px] min-h-[28px] p-[0_10px] border border-transparent rounded-[999px] [background:transparent] text-muted text-[11px] font-[600] [transition:color_.15s_ease,_background_.15s_ease,_border-color_.15s_ease] hover:text-text hover:[background:var(--hover)] [&.is-active]:text-text [&.is-active]:border-line-strong later:[&.is-active]:[background:var(--surface-strong)] [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-[50%] ${filters.status === item.value ? ' is-active' : ''}`}
                aria-pressed={filters.status === item.value}
                onClick={() => setFilters({ ...filters, status: filters.status === item.value ? '' : item.value })}
              >
                <i style={{ background: STATUS_COLORS[item.value] }} aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-muted text-[11px] whitespace-nowrap [&_strong]:text-text-secondary [&_strong]:text-[12px] [&_strong]:font-[700] [&_em]:not-italic max-[641px]:w-full">
            <strong>{sessions.length}</strong> {sessions.length === 1 ? 'session' : 'sessions'}
            {feed.loading && <em> · loading…</em>}
          </span>
        </div>
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day' }}
          slotMinTime="08:00:00"
          slotMaxTime="19:00:00"
          allDaySlot={false}
          nowIndicator
          navLinks
          dayMaxEvents={3}
          height="auto"
          events={events}
          eventClick={(info) => openDetail(info.event.id)}
          eventDurationEditable={false}
          eventDidMount={(info) => {
            if (info.isMirror) return;
            info.el.dataset.sessionId = info.event.id;
            info.el.title = eventTooltip(info.event.extendedProps.session);
            eventEls.current.set(info.event.id, info.el);
          }}
          eventWillUnmount={(info) => {
            if (!info.isMirror && eventEls.current.get(info.event.id) === info.el) eventEls.current.delete(info.event.id);
          }}
          eventDragStart={(info) => void onDragStart(info)}
          eventDragStop={onDragStop}
          eventDrop={onDrop}
          datesSet={(info) => setRange({ from: info.start.toISOString(), to: info.end.toISOString() })}
          eventContent={(info) => <EventBody session={info.event.extendedProps.session} isAdmin={isAdmin} />}
        />
      </section>

      {detailId && (
        <SessionDetail
          sessionId={detailId}
          can={permissions}
          onClose={closeDetail}
          onChanged={() => void loadSessions()}
          onEdit={(session) => openForm({ mode: 'edit', session })}
          onSetAgain={(session, applicant) => openForm({ mode: 'setAgain', session, applicant })}
        />
      )}
      {drop && (
        <DropDialog
          key={`${drop.kind}-${drop.session?.id}-${drop.start ? drop.start.getTime() : 0}`}
          drop={drop}
          isAdmin={isAdmin}
          onClose={() => setDrop(null)}
          onDone={(message) => { setDrop(null); setNotice(message); void loadSessions(); }}
          onPickSuggestion={(session, slot) => { setDrop(null); void reschedule(session, new Date(slot.start_at), new Date(slot.end_at), null, true); }}
        />
      )}
      {form && (
        <SessionForm
          mode={form.mode}
          session={form.session}
          applicant={form.applicant}
          brands={brands}
          handlers={handlers}
          isAdmin={isAdmin}
          onClose={() => setForm(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

/** "9:00 AM – 11:00 AM" in Manila time — the schedule's own timezone. */
const manilaTime = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
function sessionTime(startIso, endIso) {
  if (!startIso) return '';
  return `${manilaTime.format(new Date(startIso))} – ${endIso ? manilaTime.format(new Date(endIso)) : ''}`;
}

/** Hover tooltip: the whole story without opening the session. */
function eventTooltip(session) {
  return [
    `${activityLabel(session.activity_type)} · ${statusLabel(session.status)}`,
    formatSessionRange(session.start_at, session.end_at),
    session.brand?.name || (session.activity_type === 'orientation' ? 'Any brand' : 'No brand'),
    session.handler?.full_name || 'No handler',
    session.venue,
    session.occupancy,
  ].filter(Boolean).join('\n');
}

/** Time · activity · brand + "3/5 applicants" (+ "Merge" for Admin). */
function EventBody({ session, isAdmin }) {
  return (
    <div className="ms-event-body grid gap-[1px] overflow-hidden p-[4px_6px] text-text text-[11px] leading-[1.25] [&_strong]:overflow-hidden later:[&_strong]:text-text later:[&_strong]:text-[11.5px] [&_strong]:font-[700] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap">
      <span className="ms-event-time overflow-hidden text-muted text-[10px] font-[600] text-ellipsis whitespace-nowrap">{sessionTime(session.start_at, session.end_at)}</span>
      <strong>{activityLabel(session.activity_type)}</strong>
      <span className="ms-event-meta overflow-hidden text-text-secondary text-[10.5px] text-ellipsis whitespace-nowrap">
        {session.brand?.name || (session.activity_type === 'orientation' ? 'Any brand' : '—')} · {session.occupancy}
      </span>
      {isAdmin && session.merge_suggested && <em className="ms-merge-badge [justify-self:start] p-[1px_6px] rounded-[999px] [background:color-mix(in_srgb,_var(--accent-2)_85%,_transparent)] text-[#fff] text-[9px] not-italic font-[650]">Merge</em>}
    </div>
  );
}
