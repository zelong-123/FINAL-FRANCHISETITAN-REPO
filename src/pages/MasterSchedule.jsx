import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { FaChevronDown, FaRotateLeft } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import { Notice } from '../components/ApiUi';
import useRemote from '../lib/useRemote';
import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roleAccess';
import SessionForm from '../components/schedule/SessionForm';
import { MiniCalendar, MonthYearWheel, StatusPanel, WeekSidePanels } from '../components/schedule/MasterSchedulePanels';
import { addDays, isOutsideHours, manilaToday, mondayOf, monthOf, panelCounts, panelRange, sessionsInRange, shiftBusinessDay } from '../lib/masterScheduleDays';
import SessionDetail from '../components/schedule/SessionDetail';
import DropDialog from '../components/schedule/DropDialog';
import { ACTIVITY_TYPES, SESSION_STATUSES, STATUS_COLORS, activityLabel, formatSessionRange, statusLabel } from '../lib/scheduleSessions';

/*
 * Master Schedule — every Orientation/Tasting and Training session on
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
export default function MasterSchedule({ embedded = false, refreshKey = 0, sessionRequest = 0 }) {
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
  // Day view is the default; the chart date and the mini-calendar month are separate.
  const [viewDate, setViewDate] = useState(() => manilaToday());
  const todayDate = useMemo(() => manilaToday(), []);
  const [miniMonth, setMiniMonth] = useState(() => monthOf(manilaToday()));
  const [summary, setSummary] = useState(null);
  const [filters, setFilters] = useState({ activity_type: '', brand_id: '', handler_id: '', status: '', merge_suggested: false });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [brands, setBrands] = useState([]);
  const [handlers, setHandlers] = useState([]);
  const [form, setForm] = useState(null); // { mode, session?, applicant? }
  const detailId = searchParams.get('session');

  // "Open in Master Schedule" (Schedule activity modal → Sessions): ?date=YYYY-MM-DD shows that day.
  // The date is applied once and then dropped from the URL, so later navigation is not pulled back.
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : null;
  const [appliedDateParam, setAppliedDateParam] = useState(null);
  if (dateParam !== appliedDateParam) {
    // Adjusting state while rendering (not in an effect): React re-renders once with the new day.
    setAppliedDateParam(dateParam);
    if (dateParam) {
      setViewDate(dateParam);
      setMiniMonth(monthOf(dateParam));
    }
  }
  useEffect(() => {
    if (dateParam) setSearchParams((params) => { params.delete('date'); return params; }, { replace: true });
  }, [dateParam, setSearchParams]);

  // Reference data for the filters and the form.
  useEffect(() => {
    void (async () => {
      try {
        const [brandList, handlerList] = await Promise.all([api.get('/brands'), api.get('/schedule-sessions/handlers')]);
        setBrands(Array.isArray(brandList?.data) ? brandList.data : []);
        setHandlers(Array.isArray(handlerList?.data) ? handlerList.data : []);
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
  const sessions = useMemo(() => (Array.isArray(feed.data) ? feed.data : []), [feed.data]);
  const loadSessions = feed.reload;
  // A save made in the Schedule activity modal (Activities page) bumps refreshKey.
  const reloadRef = useRef(loadSessions);
  reloadRef.current = loadSessions;
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    void reloadRef.current();
  }, [refreshKey]);

  const outsideHours = useMemo(() => sessions.filter(isOutsideHours), [sessions]);
  const dayDate = viewDate;
  const pickDay = (date) => setViewDate(date);

  // Day is the default. The mode lives in the URL (?mode=day|week|month) so refresh and links keep it.
  const mode = ['day', 'week', 'month'].includes(searchParams.get('mode')) ? searchParams.get('mode') : 'day';
  const setMode = (next) => { setWeekSlide('ms-cal-grid-next'); setSearchParams((params) => { params.set('mode', next); return params; }); };
  const weekStart = mondayOf(dayDate);

  // Range: the displayed week in Week mode (ACTIVITIES panel), otherwise the displayed month (status panel).
  // Must come after `mode` and `weekStart` are declared (reading them earlier throws at render time).
  useEffect(() => {
    if (mode === 'week') {
      setRange({ from: `${dayDate}T00:00:00+08:00`, to: `${addDays(weekStart, 5)}T00:00:00+08:00` });
      return;
    }
    const from = `${miniMonth}-01T00:00:00+08:00`;
    const next = new Date(from);
    next.setMonth(next.getMonth() + 1);
    setRange({ from, to: next.toISOString() });
  }, [mode, dayDate, weekStart, miniMonth]);
  // Counts for the Day status panel and the Week ACTIVITIES + STATUS panels: exactly the displayed
  // range (the day, or the shown week days) with every filter. The summary endpoint answers; if it
  // is missing or fails, the counts come from the loaded list cut to the same range.
  const summaryRange = useMemo(() => (range ? panelRange(mode, dayDate, weekStart, range) : null), [mode, dayDate, weekStart, range]);
  const [summaryData, setSummaryData] = useState({ status: null, activity: null });
  useEffect(() => {
    if (!summaryRange) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.get('/schedule-sessions/summary', {
          from: summaryRange.from,
          to: summaryRange.to,
          activity_type: filters.activity_type,
          brand_id: filters.brand_id,
          handler_id: filters.handler_id,
          'status[]': filters.status,
          merge_suggested: filters.merge_suggested ? 1 : undefined,
        });
        if (!cancelled) setSummaryData({ status: response.data?.status_counts ?? null, activity: response.data?.activity_counts ?? null });
      } catch {
        if (!cancelled) setSummaryData({ status: null, activity: null });
      }
    })();
    return () => { cancelled = true; };
  }, [summaryRange, filters.activity_type, filters.brand_id, filters.handler_id, filters.status, filters.merge_suggested, refreshKey]);
  const rangeSessions = useMemo(() => sessionsInRange(sessions, summaryRange), [sessions, summaryRange]);
  // Same fallback rule for both panels (see panelCounts): summary when it answered, else the loaded list.
  const statusCounts = useMemo(() => panelCounts(summaryData.status ? { status_counts: summaryData.status } : null, rangeSessions).status, [summaryData.status, rangeSessions]);
  const activityCounts = useMemo(() => panelCounts(summaryData.activity ? { activity_counts: summaryData.activity } : null, rangeSessions).activity, [summaryData.activity, rangeSessions]);

  const [weekSlide, setWeekSlide] = useState('');
  const shiftView = (step) => {
    setWeekSlide(step > 0 ? 'ms-cal-grid-next' : 'ms-cal-grid-prev');
    if (mode === 'week') pickDay(addDays(weekStart, step * 7));
    else pickDay(shiftBusinessDay(dayDate, step));
  };

  const hasFilters = Boolean(filters.activity_type || filters.brand_id || filters.handler_id || filters.status || filters.merge_suggested);
  const resetFilters = () => setFilters({ activity_type: '', brand_id: '', handler_id: '', status: '', merge_suggested: false });

  // "Show Pinned Activity" checkboxes: a session shows on the chart only when its group is checked.
  // The Status "Completed" legend toggles the Completed checkbox, so both stay in sync.
  const PINNED_GROUPS = { completed: ['completed'], scheduled: ['pending', 'confirmed'], cancelled: ['cancelled', 'rescheduled'] };
  const [pinnedShown, setPinnedShown] = useState({ completed: false, scheduled: true, cancelled: true });
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const customRef = useRef(null);
  useEffect(() => {
    if (!customOpen) return undefined;
    const close = (event) => { if (!customRef.current?.contains(event.target)) setCustomOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [customOpen]);
  const pinnedRef = useRef(null);
  // The "Show Pinned Activity" menu closes on an outside click and on Esc.
  useEffect(() => {
    if (!pinnedOpen) return undefined;
    const close = (event) => { if (!pinnedRef.current?.contains(event.target)) setPinnedOpen(false); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPinnedOpen(false);
      pinnedRef.current?.querySelector('button')?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinnedOpen]);
  const togglePinned = (key) => setPinnedShown((current) => ({ ...current, [key]: !current[key] }));
  const chartSessions = useMemo(() => sessions.filter((session) => (
    Object.keys(PINNED_GROUPS).some((key) => pinnedShown[key] && PINNED_GROUPS[key].includes(session.status))
  )), [sessions, pinnedShown]);

  const events = useMemo(() => chartSessions.map((session) => {
    const color = STATUS_COLORS[session.status] || '#6b7488';
    return {
      id: String(session.id),
      start: session.start_at,
      end: session.end_at,
      // Dark pinned cards (EventBody); the status colour stays as the left edge accent only.
      backgroundColor: '#1f2533',
      borderColor: color,
      classNames: [`ms-event`, `is-${session.status}`],
      // Only live sessions can be dragged (reschedule; Admin may also merge).
      editable: permissions.schedule && ['pending', 'confirmed'].includes(session.status),
      extendedProps: { session },
    };
  }), [chartSessions, permissions.schedule]);

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

  // The header "Schedule session" button bumps sessionRequest to open the create form.
  useEffect(() => {
    if (sessionRequest > 0 && permissions.schedule) openForm({ mode: 'create' });
  }, [sessionRequest, permissions.schedule]);

  // Card three-dot menu: only the actions this role may take for this session's status.
  const cardMenu = (session) => {
    const live = ['pending', 'confirmed'].includes(session.status);
    const items = [{ label: 'View details', run: () => openDetail(session.id) }];
    if (live && permissions.confirm && session.status === 'pending') items.push({ label: 'Confirm', run: () => openDetail(session.id) });
    if (live && permissions.cancel) items.push({ label: 'Cancel', run: () => openDetail(session.id) });
    if (live && permissions.schedule) items.push({ label: 'Set Again', run: () => openDetail(session.id) });
    if (live && isAdmin && session.activity_type !== 'training') items.push({ label: 'Merge…', run: () => openDetail(session.id) });
    return items;
  };

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

      <div className="flex flex-wrap items-center gap-[10px_16px] mb-[14px]" role="group" aria-label="Calendar filters">
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <select value={filters.activity_type} onChange={(event) => setFilters({ ...filters, activity_type: event.target.value, brand_id: '' })} aria-label="Filter by activity">
              <option value="">All activities</option>
              {ACTIVITY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          {filters.activity_type === 'training' && (
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <span>Brand</span>
            <select value={filters.brand_id} onChange={(event) => setFilters({ ...filters, brand_id: event.target.value })} aria-label="Filter by brand">
              <option value="">All brands</option>
              {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
          </label>
          )}
          <label className="flex flex-col gap-[5px] min-w-[138px] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[750] [&>span]:tracking-[.07em] [&>span]:uppercase [&_select]:w-full [&_select]:h-[36px] [&_select]:p-[0_30px_0_10px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[9px] [&_select]:[outline:none] [&_select]:text-text-secondary [&_select]:[background-color:var(--input-bg)] [&_select]:[background-image:var(--image-1)] [&_select]:[background-repeat:no-repeat] [&_select]:[background-position:right_9px_center] [&_select]:[background-size:14px] [&_select]:[appearance:none] [&_select]:text-[12px] [&_select]:font-[550] [&_select]:[transition:border-color_.16s_ease,_background-color_.16s_ease,_box-shadow_.16s_ease,_color_.16s_ease] [&_select:hover]:border-line-strong [&_select:hover]:text-text later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_12%,_transparent)] [&_select:focus]:[background-color:var(--input-focus-bg)] max-[901px]:flex-[1_1_150px] max-[641px]:later:flex-[1_1_100%]">
            <select value={filters.handler_id} onChange={(event) => setFilters({ ...filters, handler_id: event.target.value })} aria-label="Filter by handler">
              <option value="">All handlers</option>
              {/* Filter only: admins are not listed here (the session form still uses every handler). */}
              {handlers.filter((user) => user.role !== 'admin').map((user) => <option key={user.id} value={user.id}>{user.full_name}</option>)}
            </select>
          </label>
          <div className="relative min-w-[138px]" ref={pinnedRef}>
            <button
              type="button"
              className="w-full min-h-[36px] p-[0_12px] border border-line rounded-[9px] [background:var(--input-bg,_var(--surface-subtle))] text-text text-[12px] font-[600] [outline:none] cursor-pointer hover:border-line-strong focus:border-accent inline-flex items-center justify-between gap-[10px]"
              onClick={() => setPinnedOpen((open) => !open)}
              aria-expanded={pinnedOpen}
              aria-haspopup="true"
            >
              Show Pinned Activity <FaChevronDown aria-hidden="true" className="text-[10px]" />
            </button>
            {pinnedOpen && (
              <div className="absolute left-0 top-[calc(100%_+_6px)] z-[30] min-w-[200px] grid gap-[2px] p-[8px] border border-line-strong rounded-[10px] [background:var(--panel)] [box-shadow:var(--shadow-md)]" role="group" aria-label="Show pinned activity">
                {[['completed', 'Completed'], ['scheduled', 'Scheduled'], ['cancelled', 'Cancelled']].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-[9px] p-[6px_8px] rounded-[6px] text-text text-[13px] cursor-pointer hover:[background:var(--hover)]">
                    <input type="checkbox" className="[accent-color:var(--accent)]" checked={pinnedShown[key]} onChange={() => togglePinned(key)} />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
          {isAdmin && (
            <label className="inline-flex items-center gap-[10px] h-[36px] p-[0_12px] border border-input-line rounded-[9px] [background:var(--input-bg)] text-text-secondary text-[12px] font-[600] whitespace-nowrap cursor-pointer select-none [transition:border-color_.16s_ease,_background-color_.16s_ease,_color_.16s_ease,_box-shadow_.16s_ease] hover:border-line-strong hover:[background:var(--hover)] hover:text-text has-[:checked]:border-[color:color-mix(in_srgb,_var(--accent)_55%,_transparent)] has-[:checked]:text-text has-[:checked]:[background:color-mix(in_srgb,_var(--accent)_12%,_var(--input-bg))] has-[:focus-visible]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_14%,_transparent)] [&_input]:[appearance:none] [&_input]:relative [&_input]:w-[30px] [&_input]:h-[18px] [&_input]:flex-[0_0_auto] [&_input]:m-0 [&_input]:border [&_input]:border-line-strong [&_input]:rounded-[999px] [&_input]:[background:var(--surface-strong)] [&_input]:[transition:background_.18s_ease,_border-color_.18s_ease] [&_input::after]:[content:''] [&_input::after]:absolute [&_input::after]:top-[2px] [&_input::after]:left-[2px] [&_input::after]:w-[12px] [&_input::after]:h-[12px] [&_input::after]:rounded-[50%] [&_input::after]:[background:var(--muted)] [&_input::after]:[transition:transform_.18s_ease,_background_.18s_ease] [&_input:checked]:border-[color:color-mix(in_srgb,_var(--accent)_55%,_transparent)] [&_input:checked]:[background:color-mix(in_srgb,_var(--accent)_30%,_transparent)] [&_input:checked::after]:[transform:translateX(12px)] [&_input:checked::after]:[background:var(--accent-text)]">
              <input type="checkbox" checked={filters.merge_suggested} onChange={(event) => setFilters({ ...filters, merge_suggested: event.target.checked })} />
              <span>Merge suggested only</span>
            </label>
          )}
          {hasFilters && (
            <button type="button" className="inline-flex items-center gap-[6px] min-h-[34px] p-[0_11px] border border-line rounded-[9px] [background:transparent] text-text-secondary text-[11px] font-[650] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:border-line-strong hover:[background:var(--hover)] hover:text-text" onClick={resetFilters}>
              <FaRotateLeft aria-hidden="true" /> Reset
            </button>
          )}
          <div className="inline-flex order-[-1] mr-auto gap-[2px] p-[3px] border border-[#3a4560] rounded-[12px] [background:var(--input-bg)]" role="group" aria-label="Calendar view">
            {[['month', 'Month'], ['week', 'Week'], ['day', 'Day']].map(([value, text]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`min-h-[30px] p-[6px_14px] rounded-[9px] border text-[12px] font-[650] uppercase whitespace-nowrap [transition:background_.16s_ease,_color_.16s_ease,_border-color_.16s_ease] ${mode === value ? 'border-[#3a4560] text-[#fff] [background:#252e42] [box-shadow:0_1px_2px_rgba(0,0,0,.3)]' : 'border-[#3a4560] text-[#8a94a6] [background:transparent] hover:text-[#d7ddf5] hover:[background:rgba(255,_255,_255,_.04)]'}`}
              >
                {text}
              </button>
            ))}
          </div>
      </div>

      <section className="data-panel overflow-visible [background:transparent] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] ms-calendar p-0 mb-[18px] later:hover:border-line later:hover:[box-shadow:var(--shadow-sm)]">
        {false && <div className="flex flex-wrap items-center justify-between gap-[8px_14px] p-[9px_14px] mb-[14px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] max-[641px]:later:p-[8px_10px]">
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
        </div>}
        <div className={`grid gap-[14px] max-[901px]:grid-cols-1 ${mode === 'month' ? 'grid-cols-[minmax(0,_1fr)]' : mode === 'week' ? 'grid-cols-[minmax(0,_1fr)_minmax(200px,_240px)]' : 'grid-cols-[minmax(0,_1fr)_minmax(300px,_380px)]'}`}>
        <div className="min-w-0 p-0 overflow-hidden border border-[#3a4560] rounded-[10px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)]">
        {mode !== 'day' && (
        <div className={mode === 'week' || mode === 'month' ? 'grid grid-cols-[1fr_auto_1fr] items-center gap-[8px] p-[10px_14px] mb-[8px]' : 'flex flex-wrap items-center justify-between gap-[8px] mb-[8px]'}>
          <div className={`flex items-center gap-[6px] ${mode === 'week' ? 'col-start-1 row-start-1 justify-self-start' : ''}`}>
            
            <div ref={customRef} className="relative">
              <button type="button" aria-expanded={customOpen} className="inline-flex items-center justify-center h-[34px] p-[0_14px] text-muted hover:text-text border border-[#3a4560] rounded-[8px] [background:#070A13] hover:[background:#03050a] transition-colors text-[12px] font-[650]" onClick={() => setCustomOpen((open) => !open)}>Custom</button>
              {customOpen && (
                <div className="absolute left-0 top-[40px] z-20 w-[300px] [zoom:0.85] [&_table]:table-fixed [&_td]:p-[3px_0] [&_th]:p-[4px_0]">
                  {mode === 'month' ? (
                    <MonthYearWheel month={miniMonth} todayYear={Number(todayDate.slice(0, 4))} onPick={(next) => { setMiniMonth(next); setCustomOpen(false); }} />
                  ) : (
                  <MiniCalendar
                    month={miniMonth}
                    selectedDate={dayDate}
                    todayDate={todayDate}
                    sessions={chartSessions}
                    onMonth={setMiniMonth}
                    plain
                    activeWeekStart={dayDate}
                    activeWeekEnd={addDays(weekStart, 6)}
                    onPickDate={(date) => { pickDay(date === dayDate ? weekStart : date); setMiniMonth(monthOf(date)); setCustomOpen(false); }}
                  >
                    <button type="button" className="w-full inline-flex items-center justify-center h-[30px] border-0 outline-none focus:outline-none [background:transparent] text-accent text-[12px] font-[650] hover:[background:rgba(255,_255,_255,_.06)]" onClick={() => { pickDay(todayDate); setMiniMonth(monthOf(todayDate)); setCustomOpen(false); }}>Today</button>
                  </MiniCalendar>
                  )}
                </div>
              )}
            </div>
            <button type="button" className="inline-flex items-center justify-center w-[34px] h-[34px] text-muted hover:text-text border border-[#3a4560] rounded-[8px] [background:#070A13] hover:[background:#03050a] transition-colors" aria-label={mode === 'week' ? 'Previous week' : 'Previous business day'} onClick={() => shiftView(-1)}>&lsaquo;</button>
            {mode !== 'week' && <button type="button" className="inline-flex items-center justify-center w-[34px] h-[34px] text-muted hover:text-text border border-[#3a4560] rounded-[8px] [background:#070A13] hover:[background:#03050a] transition-colors" aria-label={mode === 'week' ? 'Next week' : 'Next business day'} onClick={() => shiftView(1)}>&rsaquo;</button>}
          </div>
          {mode === 'week' && <button type="button" className="col-start-3 row-start-1 justify-self-end inline-flex items-center justify-center w-[34px] h-[34px] text-muted hover:text-text border border-[#3a4560] rounded-[8px] [background:#070A13] hover:[background:#03050a] transition-colors" aria-label="Next week" onClick={() => shiftView(1)}>&rsaquo;</button>}
          <strong className={`text-text font-[700] ${mode === 'week' || mode === 'month' ? 'col-start-2 row-start-1 justify-self-center text-[15px] uppercase tracking-[.04em]' : 'text-[13px]'}`}>
            {mode === 'month'
              ? new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${miniMonth}-01T12:00:00+08:00`))
              : mode === 'week'
              ? `${new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${dayDate}T12:00:00+08:00`))} - ${new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${addDays(weekStart, 4)}T12:00:00+08:00`))}`
              : new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${dayDate}T12:00:00+08:00`))}
          </strong>
        </div>
        )}
        <div key={`slide-${mode}-${weekStart}`} className={weekSlide}>
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={mode === 'month' ? 'dayGridMonth' : mode === 'week' ? 'timeGridWeek' : 'timeGridDay'}
          initialDate={mode === 'month' ? `${miniMonth}-01` : mode === 'week' ? dayDate : dayDate}
          visibleRange={mode === 'week' ? { start: dayDate, end: addDays(weekStart, 5) } : undefined}
          key={`${mode}-${mode === 'month' ? miniMonth : dayDate}`}
          headerToolbar={false}
          weekends={false}
          slotMinTime="09:00:00"
          slotMaxTime="18:00:00"
          slotDuration="00:30:00"
          slotLabelInterval="01:00:00"
          allDaySlot={false}
          dayHeaderContent={(arg) => {
            const weekday = arg.date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Manila' }).toUpperCase();
            if (mode === 'day') {
              const dayNumber = arg.date.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Manila' });
              return (
                <span className="ms-day-head">
                  <button type="button" aria-label="Previous business day" onClick={() => shiftView(-1)}>&lsaquo;</button>
                  <span className="ms-day-title">{weekday}<span className="ms-day-badge">{dayNumber}</span></span>
                  <button type="button" aria-label="Next business day" onClick={() => shiftView(1)}>&rsaquo;</button>
                </span>
              );
            }
            if (mode !== 'week') return weekday;
            const day = arg.date.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Manila' });
            return `${weekday} ${day}`;
          }}
          slotEventOverlap
          nowIndicator
          navLinks={mode !== 'day'}
          dayMaxEvents={mode === 'month' ? 3 : false}
          height="auto"
          events={events}
          eventClick={(info) => openDetail(info.event.id)}
          eventDurationEditable={false}
          eventDidMount={(info) => {
            if (info.isMirror) return;
            info.el.dataset.sessionId = info.event.id;
            info.el.title = eventTooltip(info.event.extendedProps.session);
            // Status accent on the left edge; the card tint stays the same.
            info.el.style.borderLeftColor = STATUS_COLORS[info.event.extendedProps.session.status] || '#6b7488';
            eventEls.current.set(info.event.id, info.el);
          }}
          eventWillUnmount={(info) => {
            if (!info.isMirror && eventEls.current.get(info.event.id) === info.el) eventEls.current.delete(info.event.id);
          }}
          eventDragStart={(info) => void onDragStart(info)}
          eventDragStop={onDragStop}
          eventDrop={onDrop}
          eventContent={(info) => <EventBody session={info.event.extendedProps.session} isAdmin={isAdmin} menu={cardMenu} short={Boolean(info.event.end) && info.event.end - info.event.start < SHORT_SESSION_MS} />}
        />
        </div>
        {outsideHours.length > 0 && (
          <p className="mt-[8px] p-[6px_10px] rounded-[9px] border border-line text-text-secondary text-[11px]">
            <strong>Outside business hours:</strong> {outsideHours.length} {outsideHours.length === 1 ? 'session' : 'sessions'} in this range (before 9 AM or after 5 PM). {outsideHours.slice(0, 3).map((s) => activityLabel(s.activity_type)).join(', ')}
          </p>
        )}
        </div>
        {mode !== 'month' && <aside className="flex flex-col gap-[12px] min-w-0 min-h-0 h-full" aria-label="Schedule side panels">
          {mode === 'week' ? <WeekSidePanels activityCounts={activityCounts} statusCounts={statusCounts} showCompleted={pinnedShown.completed} onToggleCompleted={() => togglePinned('completed')} /> : (
          <MiniCalendar
            month={miniMonth}
            selectedDate={dayDate}
            todayDate={todayDate}
            sessions={chartSessions}
            onMonth={setMiniMonth}
            onPickDate={(date) => { pickDay(date); setMiniMonth(monthOf(date)); }}
          >
            <StatusPanel counts={statusCounts} showCompleted={pinnedShown.completed} onToggleCompleted={() => togglePinned('completed')} />
          </MiniCalendar>
          )}
        </aside>}
        </div>
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
const manilaDate = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric' });
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
/** Sessions shorter than this start with the summary only; longer ones always show everything. */
const SHORT_SESSION_MS = 120 * 60 * 1000;

function EventBody({ session, isAdmin, menu, short }) {
  const taken = session.participant_count ?? 0;
  const capacity = session.max_capacity ?? 5;
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsed = short && !expanded;
  const items = menu ? menu(session) : [];
  return (
    <div className="ms-event-body relative grid content-start gap-[6px] min-w-0 p-[12px_14px] rounded-[16px] text-[#f5f7fb] text-[11px] leading-[1.25] [background:#0a0e18] border border-[#2a3d5c] [&_strong]:overflow-hidden [&_strong]:font-[800] [&_strong]:text-[12px] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:uppercase">
      <span className="flex items-center justify-between gap-[6px] pr-[18px] text-[#c9d1e0] text-[10px] font-[600] whitespace-nowrap overflow-hidden">
        <span className="ms-event-time overflow-hidden text-ellipsis">{sessionTime(session.start_at, session.end_at)}</span>
        <span className="shrink-0">{session.start_at ? manilaDate.format(new Date(session.start_at)).split(' ').slice(-2).join(' ').toUpperCase() : ''}</span>
      </span>
      {session.status === 'cancelled' ? (
        <span className="flex items-center gap-[6px] min-w-0">
          <strong className="line-through decoration-[1.5px] text-[#8a94a6]">{activityLabel(session.activity_type)}</strong>
          <em className="ms-cancelled-chip shrink-0 p-[1px_7px] rounded-[999px] border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.14)] text-[#fca5a5] text-[9px] not-italic font-[700]">Cancelled</em>
        </span>
      ) : <strong>{activityLabel(session.activity_type)}</strong>}
      <span className="ms-event-meta overflow-hidden text-[#c9d1e0] text-[10.5px] text-ellipsis whitespace-nowrap">
        {session.brand?.name || (session.activity_type === 'orientation' ? 'Any Brand' : 'No brand')} - {taken}/{capacity}
      </span>
      <div className={`grid min-h-0 transition-[grid-template-rows,opacity] duration-300 ease-out ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
      <div className="grid content-start gap-[6px] min-h-0 overflow-hidden">
      <span className="overflow-hidden text-[#8a94a6] text-[10px] text-ellipsis whitespace-nowrap">Handler({session.handler?.full_name || 'No handler'})</span>
      <span className="ms-card-divider mt-[12px] border-t border-[#2a3d5c]" aria-hidden="true" />
      <span className="ms-applicant-row flex flex-nowrap gap-[8px] pt-[10px]" aria-label={`${taken} of ${capacity} applicants`}>
        {Array.from({ length: capacity }, (_, index) => {
          const applicant = session.active_participants?.[index]?.applicant;
          const initials = applicant?.full_name ? applicant.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() : '';
          return (
            <i key={index} className={`grid place-items-center shrink-0 w-[36px] h-[36px] rounded-[50%] text-[13px] font-[700] not-italic ${initials ? 'bg-[#3d4f8a] text-[#f5f7fb]' : 'border border-[#2a3d5c] bg-[#0d1322]'}`} aria-hidden="true">{initials}</i>
          );
        })}
      </span>
      </div>
      </div>
      {short && (
        <button type="button" className="ms-card-collapse absolute top-[30px] right-[4px] w-[20px] h-[20px] p-0 [border:0] [box-shadow:none] [background:transparent] text-[#8a94a6] text-[10px] leading-none hover:text-[#f5f7fb]" aria-label={collapsed ? 'Show details' : 'Hide details'} aria-expanded={!collapsed} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }} onMouseDown={(event) => event.stopPropagation()}>{collapsed ? '▼' : '▲'}</button>
      )}
      {items.length > 0 && (
        <button type="button" className="ms-card-menu-button absolute top-[6px] right-[4px] w-[30px] h-[30px] grid grid-flow-row place-content-center justify-items-center gap-[3px] rounded-[8px] [background:#1a2236] hover:[background:rgba(255,255,255,0.12)]" aria-label="Session actions" aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }} onMouseDown={(event) => event.stopPropagation()}><i className="w-[4px] h-[4px] rounded-[50%] bg-[#c9d1e0]" /><i className="w-[4px] h-[4px] rounded-[50%] bg-[#c9d1e0]" /><i className="w-[4px] h-[4px] rounded-[50%] bg-[#c9d1e0]" /></button>
      )}
      {items.length > 0 && (
        <ul className={`ms-card-menu absolute top-[42px] right-[4px] z-[5] grid gap-[6px] min-w-[150px] p-[6px] rounded-[12px] border border-[#3a4560] [background:#161c2b] shadow-[0_10px_24px_rgba(0,0,0,0.45)] [list-style:none] m-0 origin-top-right transition-[opacity,transform] duration-200 ease-out ${menuOpen ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'}`} role="menu" aria-hidden={!menuOpen} onMouseDown={(event) => event.stopPropagation()}>
          {items.map((item) => (
            <li key={item.label} role="none">
              <button type="button" role="menuitem" className="w-full text-left p-[9px_12px] rounded-[8px] border-0 [background:#222a3c] text-[#f5f7fb] text-[12px] font-[600] hover:[background:#2e3750]" onClick={(event) => { event.stopPropagation(); setMenuOpen(false); item.run(); }}>{item.label}</button>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && session.merge_suggested && <em className="ms-merge-badge [justify-self:start] p-[1px_6px] rounded-[999px] [background:color-mix(in_srgb,_var(--accent-2)_85%,_transparent)] text-[#fff] text-[9px] not-italic font-[650]">Merge</em>}
    </div>
  );
}
