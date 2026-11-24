import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FaArrowLeft,
  FaArrowRight,
  FaCalendarCheck,
  FaCalendarDays,
  FaCalendarPlus,
  FaCheck,
  FaChevronLeft,
  FaChevronRight,
  FaInbox,
  FaPen,
  FaPlus,
  FaRotateRight,
  FaTableList,
  FaTrashCan,
  FaTriangleExclamation,
  FaUsers,
} from 'react-icons/fa6';
import { FaXmark } from 'react-icons/fa6';
import { initialsOf } from '../lib/initials';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { fromManilaInput, manilaDateTimeLabel, toManilaInput, formatDate, titleCase as baseTitleCase } from '../lib/format';
import RequirementFileDrop from '../components/RequirementFileDrop';
import { completedCount, TABLE_FOOTER, tableRows } from '../lib/activityTable';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, ProgressBar, StatusBadge } from '../components/ApiUi';
import ScheduleWindowFields from '../components/ScheduleActivityFields';
import {
  blankScheduleFields,
  buildScheduleWindow,
  resolvedHours,
  scheduleFieldsFromActivity,
} from '../lib/scheduleRules';
import { LiveScheduleCheck, SessionsPanel } from '../components/schedule/SmartSchedule';
import useAvailability from '../lib/useAvailability';
import { masterScheduleLink, monthOfDate } from '../lib/smartSchedule';
import SlidingPagination from '../components/SlidingPagination';
import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roleAccess';
import { getScheduleConfig, isWorkingDay } from '../lib/scheduleConfig';
import useScheduleConfig from '../lib/useScheduleConfig';
import MasterSchedule from './MasterSchedule';
import { activitiesView } from '../lib/navigation';

// Orientation and Product Tasting are one activity: Orientation/Tasting (stored key 'orientation').
const activityTypes = ['orientation', 'training'];
// The two tracked milestones get their own progress chart in the read panel.
const trackedTypes = ['orientation', 'training'];
/** Activity names: 'orientation' (and older 'product_tasting' rows) read as Orientation/Tasting. */
const titleCase = (value) => (value === 'orientation' || value === 'product_tasting' ? 'Orientation/Tasting' : baseTitleCase(value));
// Orientation/Tasting completion files: the same types and size as the requirement uploads.
const PROOF_ACCEPT = '.pdf,.jpg,.jpeg,.png';
const proofProblem = (file) => (!/\.(pdf|jpe?g|png)$/i.test(file.name) ? `${file.name}: PDF, JPG or PNG only.`
  : file.size > 10 * 1024 * 1024 ? `${file.name} is larger than 10 MB.` : '');

// The applicant milestone that proves each tracked activity is DONE (Sales
// Complete AND Admin Attended saved). The fixed order drives every gate.
const ACTIVITY_MILESTONE = {
  orientation: 'orientation_attended',
  training: 'training_completed',
};

// Rows per page in the Activities table (same rule as Leads & inquiries).
const PAGE_SIZE = 8;
// How many page numbers show at once in the sliding pagination window.

// Where "Back to Status" sends the user: the Applicant pipeline page (Applicant.jsx).
// Change this if your router uses a different path.
const APPLICANTS_ROUTE = '/applicants';

// Applicant pipeline lifecycle requests:
const archiveApplicantRequest = (id) => api.post(`/applicants/${id}/archive`, {});
const cancelScheduleRequest = (id) => api.delete(`/activities/${id}`);

// Starts/Duration/Venue live in components/ScheduleActivityFields.jsx so the
// Applicant modal (Phase 2) uses exactly the same whole-hour rules.

const blankForm = () => ({
  mode: 'single', // 'single' | 'multiple'
  activity_type: '',
  applicant_id: '', // single mode
  applicant_ids: [], // multiple mode
  attendee: '', // kept for participants; single mode fills it from the applicant
  join_session_id: '', // "Join existing": the session the applicant is added to
  separate_session: false, // "Create separate": a second session at the same date/time
  ...blankScheduleFields(),
});

/**
 * A long note in a table cell (e.g. Admin's return reason): kept narrow so it never stretches the
 * table, cut to two lines with Show more / Show less. Expanded, it still wraps at the same width.
 */
function ClampedNote({ label, text, className = 'text-[#fbbf24]' }) {
  const [open, setOpen] = useState(false);
  const full = `${label}${text ?? ''}`;
  const long = full.length > 60;
  return (
    <span className={`grid gap-[2px] w-full max-w-[15rem] text-[12px] leading-[1.5] [overflow-wrap:anywhere] ${className}`}>
      <span className={long && !open ? 'line-clamp-2' : ''}>{full}</span>
      {long && (
        <button
          type="button"
          className="justify-self-start p-0 border-0 bg-transparent text-[#9aa6ff] text-[11.5px] font-[700] cursor-pointer hover:underline"
          aria-expanded={open}
          onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </span>
  );
}

function formatDuration(minutes) {
  const value = Number(minutes || 0);
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The label shown everywhere in the UI for an activity: its selected type. */
function activityLabel(activity) {
  return titleCase(activity?.activity_type || 'other');
}

/** "Maria, Juan" -> ['Maria', 'Juan']; empty input falls back to the applicant's own name. */
function parseAttendees(raw, fallback) {
  const list = String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (list.length) return list;
  return fallback ? [fallback] : [];
}

/** True once the person has completed every tracked milestone (Orientation/Tasting, Training). */
/** A tracked activity is DONE only when Sales completed it AND Admin saved Attended. */
function activityDone(group, type) {
  if (!ACTIVITY_MILESTONE[type]) return false;
  const milestones = group?.applicant?.milestones || {};
  return Boolean(milestones[ACTIVITY_MILESTONE[type]])
    && group.activities.some((item) => item.activity_type === type && item.status === 'completed');
}

/** All three tracked activities are DONE (Complete + Attended saved). */
function allMilestonesDone(group) {
  return trackedTypes.every((type) => activityDone(group, type));
}

/** Hide the person from the data table once both tracked activities (Orientation/Tasting and Training) are done. */
function isFullyAccomplished(group) {
  return allMilestonesDone(group);
}

/**
 * The activity Set Again may schedule for this person (Section 4): the NEXT
 * step after the latest DONE activity, and only while that step has no active
 * or pending schedule. null when Set Again must not be visible.
 */
function nextActivityTypeFor(group) {
  const index = trackedTypes.findIndex((type) => !activityDone(group, type));
  if (index < 0) return null; // all three Done
  const type = trackedTypes[index];
  // Nothing Done yet: only a No Show of the first activity is rescheduled with Set Again.
  if (index === 0 && !(group.activities || []).some((item) => item.activity_type === type && item.status === 'no_show')) return null;
  const pendingAnywhere = (group.activities || []).some((item) => item.approval_status === 'pending_admin');
  if (pendingAnywhere) return null;
  const active = (group.activities || []).some((item) => item.activity_type === type
    && ['pending', 'confirmed'].includes(item.status) && item.approval_status !== 'rejected');
  return active ? null : type;
}

function applicantIdOfGroup(group) {
  if (group?.applicant_id) return group.applicant_id;
  const match = group?.activities?.find((item) => item.applicant?.full_name === group.person);
  if (match) return match.applicant_id ?? match.applicant?.id ?? null;
  const first = group?.activities?.[0];
  return first?.applicant_id ?? first?.applicant?.id ?? null;
}

function isGroupArchived(group) {
  if (typeof group?.is_archived === 'boolean') return group.is_archived;
  const match = group?.activities?.find((item) => item.applicant?.full_name === group.person);
  if (match?.applicant?.archived_at) return true;
  return Boolean(group?.archived_at);
}

/**
 * The one activity that goes in the "Activity assigned" column: the next
 * unstarted activity for the person, else the most recent one they hold.
 * Accomplished activities stop crowding the table (see the read panel for full
 * history).
 */
function currentActivity(group) {
  const activities = group.activities.filter((item) => item.status !== 'cancelled' && item.approval_status !== 'rejected');
  const open = activities.filter((item) => ['pending', 'confirmed'].includes(item.status));
  if (open.length) {
    // The oldest ongoing activity makes missed schedules visible even if another is upcoming.
    return open.reduce((earliest, item) => (
      new Date(item.starts_at) < new Date(earliest.starts_at) ? item : earliest
    ), open[0]);
  }

  return activities[activities.length - 1] || null;
}

/** Tracks status per milestone category, e.g. "Orientation/Tasting done, Training —". */
function typeProgress(activities) {
  return trackedTypes.map((type) => {
    const held = activities.filter((item) => item.activity_type === type && item.status !== 'cancelled');
    const done = held.find((item) => item.status === 'completed');
    const pending = held.find((item) => item.status !== 'completed');
    return {
      type,
      done: Boolean(done),
      label: titleCase(type),
      detail: done ? `Completed ${formatDate(done.completed_at || done.starts_at)}` : pending ? `Scheduled ${formatDate(pending.starts_at)}` : 'Not started',
    };
  });
}


/** Adjust (Edit): the session being moved is not "busy" time for the picker. */
const sessionIdOf = (activity) => (/^session-\d+$/.test(String(activity?.session_id ?? '')) ? Number(String(activity.session_id).slice(8)) : null);
/** The activity's own day + start hour, so the picker always lets the current time be kept. */
const startSlotOf = (activity) => {
  if (!activity?.starts_at) return null;
  const at = new Date(activity.starts_at);
  const two = (value) => String(value).padStart(2, '0');
  return { date: `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`, hour: at.getHours() };
};

/**
 * Schedule / Edit form fields, in this order:
 *   1. Activity           (picked first — it decides who is eligible)
 *   2. Applicant(s)       (one applicant, or several via the mode switch)
 *   3. Starts, Duration, Venue
 *   4. People attending   (autofilled with the selected applicant, or type another name)
 *
 * `blockReason(applicant, type)` returns why a person cannot be picked for the
 * chosen activity (already done, prerequisite not done, already scheduled), or
 * '' when they are available.
 */
function ActivityFormFields({ form, setForm, applicants, highlightApplicant, blockReason, editing, onError, lockedApplicantId = null, isAdmin = false, onJoined, onOpenMaster, onReassign }) {
  const hasActivity = Boolean(form.activity_type);
  const byId = (id) => applicants?.find((item) => String(item.id) === String(id));

  // Opened from the applicant pipeline (Set Schedule / Set Again): only that
  // applicant is listed and the picker is locked.
  // Editing (Adjust) keeps the activity and applicant fixed: only date, time, duration and venue change.
  const fixedPerson = Boolean(editing) || Boolean(lockedApplicantId);
  const eligible = (applicants || []).filter((item) => !blockReason(item, form.activity_type)
    && (!lockedApplicantId || String(item.id) === String(lockedApplicantId))
    && (!editing || String(item.id) === String(form.applicant_id)));
  // Smart scheduling: the picker, the live check and the Sessions panel look at the applicant's
  // assigned Sales user and the selected activity only.
  // Adjust (editing) keeps the picker too, so the free days/hours and the occupied ones guide the
  // move; the live check and the Sessions panel stay for new schedules only. The activity being
  // adjusted is passed along so its own session is not counted as busy.
  const smartOn = hasActivity && Boolean(form.applicant_id);
  const liveOn = smartOn && !editing;
  const hours = resolvedHours(form);
  const [pickerMonth, setPickerMonth] = useState(() => monthOfDate(form.start_date));
  const availability = useAvailability(smartOn ? form.applicant_id : null, form.activity_type, pickerMonth, hours >= 1 ? hours * 60 : null,
    editing ? { activityId: editing.id, sessionId: sessionIdOf(editing) } : null);
  const applicantName = byId(form.applicant_id)?.full_name || '';
  const typeLabel = titleCase(form.activity_type || '');
  const useNext = (next) => {
    onError('');
    setPickerMonth(next.date.slice(0, 7));
    setForm((current) => ({ ...current, start_date: next.date, start_hour: Number(next.time.slice(0, 2)), start_minute: 0, join_session_id: '', separate_session: false }));
  };

  // Changing the activity can make already-picked applicants ineligible: drop them.
  const changeActivity = (type) => {
    setForm((current) => {
      const blocked = (item) => item && Boolean(blockReason(item, type));
      const next = { ...current, activity_type: type };
      const currentPerson = applicants?.find((item) => String(item.id) === String(current.applicant_id));
      if (blocked(currentPerson)) {
        next.applicant_id = '';
        if (current.attendee.trim().toLowerCase() === currentPerson.full_name.toLowerCase()) next.attendee = '';
      }
      next.applicant_ids = current.applicant_ids.filter((id) => !blocked(applicants?.find((item) => String(item.id) === String(id))));
      return next;
    });
  };

  // Single mode: the chosen applicant becomes the default attendee. A different
  // name typed by hand is left alone.
  const changeApplicant = (value) => {
    setForm((current) => {
      const previous = applicants?.find((item) => String(item.id) === String(current.applicant_id));
      const next = applicants?.find((item) => String(item.id) === String(value));
      const typed = current.attendee.trim().toLowerCase();
      const wasAuto = !typed || (previous && typed === previous.full_name.toLowerCase());
      return { ...current, applicant_id: value, attendee: wasAuto ? (next?.full_name || '') : current.attendee };
    });
  };

  const applicantHint = !(applicants || []).some((item) => item.status === 'scheduled')
    ? 'No applicants are at the Scheduling stage. Admin moves a Qualified applicant there with Set Schedule.'
    : !hasActivity
      ? 'Select an activity first. Applicants with an active schedule for it are not available.'
      : undefined;

  return (
    <>
      <Field label="Activity" required full hint="Activities go in order: Orientation/Tasting, then Training (after Admin verifies Orientation/Tasting).">
        <select
          required
          disabled={fixedPerson}
          value={form.activity_type}
          onChange={(e) => changeActivity(e.target.value)}
        >
          <option value="">Select activity</option>
          {activityTypes.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}
        </select>
      </Field>

      <Field label="Applicant" full hint={applicantHint}>
        <select
          required
          disabled={!hasActivity || fixedPerson}
          className={highlightApplicant ? 'later-2:[.activities-modal-root_select&]:border-[color:var(--act-accent,_#7b88ff)] later:[.activities-modal-root_select&]:[background-color:rgba(123,_136,_255,_0.16)] later:[.activities-modal-root_select&]:[box-shadow:0_0_0_2px_rgba(123,_136,_255,_0.45)] [.activities-modal-root_select&]:text-[color:var(--accent,_#aeb6ff)] [.activities-modal-root_select&]:font-[650] [.activities-modal-root_select&]:[animation:applicant-select-blink_0.8s_ease-in-out_4] motion-reduce:later:[.activities-modal-root_select&]:[animation:none]' : undefined}
          value={form.applicant_id}
          onChange={(e) => changeApplicant(e.target.value)}
        >
          <option value="">{hasActivity ? 'Select applicant' : 'Select an activity first'}</option>
          {eligible.map((applicant) => <option key={applicant.id} value={applicant.id}>{applicant.full_name}</option>)}
        </select>
      </Field>
      {smartOn && availability.data?.handler && (
        <small className="col-span-full -mt-[6px] text-muted text-[11.5px]">
          Showing {availability.data.handler.full_name}&apos;s {typeLabel} sessions only (the applicant&apos;s assigned Sales user).
        </small>
      )}

      <ScheduleWindowFields
        form={form}
        setForm={setForm}
        onError={onError}
        smart={{ locked: !form.applicant_id, availability, month: pickerMonth, setMonth: setPickerMonth, activityLabel: typeLabel, keepSlot: startSlotOf(editing) }}
      />

      {liveOn && (
        <LiveScheduleCheck
          form={form}
          hours={hours}
          applicantId={form.applicant_id}
          applicantName={applicantName}
          activityType={form.activity_type}
          activityLabel={typeLabel}
          availability={availability}
          isAdmin={isAdmin}
          onUseNext={useNext}
          onJoined={onJoined}
          onReassign={() => onReassign(form.applicant_id)}
        />
      )}

      {liveOn && (
        <SessionsPanel
          applicantId={form.applicant_id}
          applicantName={applicantName}
          activityType={form.activity_type}
          activityLabel={typeLabel}
          onJoined={onJoined}
          onOpenMaster={onOpenMaster}
        />
      )}
    </>
  );
}

export default function Activities() {
  const { role } = useAuth();
  // Loads the one scheduling window (working days/hours) and re-renders when it arrives.
  useScheduleConfig();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [highlightApplicant, setHighlightApplicant] = useState(false);
  const [lockedApplicantId, setLockedApplicantId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [completing, setCompleting] = useState(null);
  // Early completion: the scheduled day (Manila) has not arrived — ask first.
  // [View] from the Update modal: filter + highlight one applicant's schedule.
  const [pendingView, setPendingView] = useState(null);
  const [viewFocus, setViewFocus] = useState(null);
  // The Complete form: attendance + proof, or a No Show with its reason.
  const [completeForm, setCompleteForm] = useState(null);
  // A ticking clock: Complete unlocks by itself once the scheduled start time arrives.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const [archiving, setArchiving] = useState(null); // group being archived
  const [deleting, setDeleting] = useState(null); // group whose ongoing schedule will be cancelled
  // 'table' (data panel) | 'master' (Master Schedule).
  // The view lives in the URL (?view=master-schedule), so refresh
  // and direct links work. Master Schedule (sessions) is Admin + Sales only;
  // any other role asking for it falls back to the table.
  const [searchParams, setSearchParams] = useSearchParams();
  const canMasterSchedule = can(role, 'schedule_sessions.view');
  const view = activitiesView(searchParams.get('view'), role);
  const setView = (next) => setSearchParams((params) => {
    if (next === 'table') params.delete('view');
    else params.set('view', next === 'master' ? 'master-schedule' : next);
    // The session id belongs to the Master Schedule tab only.
    if (next !== 'master') params.delete('session');
    return params;
  });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [activityFilter, setActivityFilter] = useState('');
  // Off by default: fully done people (both activities done) leave the table; on brings them back.
  const [showCompleted, setShowCompleted] = useState(false);
  // Page for the "All activities" list inside the read panel (8 rows per page).
  const [activityPage, setActivityPage] = useState(1);

  // Read panel (slides from the right, same style as Leads & inquiries).
  const [selectedKey, setSelectedKey] = useState(null);
  const location = useLocation();

  // Notification deep link: open the schedule drawer for the activity's person, then clear the state.
  useEffect(() => {
    const focusActivityId = location.state?.focusActivityId;
    if (!focusActivityId) return;
    const match = currentGroups.find((group) => group.activities.some((item) => String(item.id) === String(focusActivityId)));
    navigate(location.pathname, { replace: true, state: null });
    if (match) setSelectedKey(match.person);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Opening a person's schedule drawer marks that record's activities as seen
  // for the signed-in user, so the red dot clears in the database and stays
  // cleared after a refresh.
  useEffect(() => {
    if (!selectedKey) return;
    const group = currentGroups.find((item) => item.person === selectedKey);
    const ids = [...new Set((group?.activities || []).map((item) => item.id).filter(Boolean))];
    if (!ids.length) return;
    void Promise.all(ids.map((id) => api.post('/notifications/mark-seen', {
      record_type: 'activity', record_id: id,
    }).catch(() => null)))
      .then(() => window.dispatchEvent(new Event('herald:notifications-updated')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);
  const lastSelected = useRef(null);

  // Phase 3b: glowing "Schedule Activity" button after arriving from the
  // Update modal's Set Schedule (stops when clicked or after creation).
  const [scheduleGlow, setScheduleGlow] = useState(false);
  // Bumped after a save so the embedded Master Schedule reloads its data.
  const [masterRefreshKey, setMasterRefreshKey] = useState(0);
  // Bumped by the header "Schedule session" button; the Master Schedule opens its session form.
  const [sessionRequest, setSessionRequest] = useState(0);
  const preselectHandled = useRef(false);

  const remote = useRemote(async () => {
    const [groups, table, applicants, brands] = await Promise.all([
      // Full history: the read panel, calendar and deep links still need people
      // who already finished both tracked activities.
      api.get('/activities/grouped', { include_completed: 1 }),
      // Data panel list: the backend already excludes completed applicants.
      api.get('/activities/grouped'),
      ['admin', 'sales'].includes(role) ? api.get('/applicants', { per_page: 100 }) : Promise.resolve({ data: [] }),
      role === 'sales' ? api.get('/brands').catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
    ]);
    return { groups: groups.data, tableGroups: table.data, applicants: applicants.data, brands: brands.data || [] };
  }, [role]);

  const groups = useMemo(() => remote.data?.groups || [], [remote.data?.groups]);
  const applicants = useMemo(() => (remote.data?.applicants || []).filter((applicant) => applicant.status !== 'converted'), [remote.data?.applicants]);

  // Every person (used by the calendar and the read panel: full history).
  const currentGroups = useMemo(() => groups.map((group) => ({ ...group, current: currentActivity(group) })), [groups]);

  // Rows the backend returned for the Data panel. Completed applicants are
  // already absent here, so counts and pagination never include hidden rows.
  const tableSource = useMemo(
    () => tableRows({ tableGroups: remote.data?.tableGroups || [], allGroups: remote.data?.groups || [], showCompleted, isArchived: isGroupArchived })
      .map((group) => ({ ...group, current: currentActivity(group) })),
    [remote.data?.tableGroups, remote.data?.groups, showCompleted],
  );
  const hiddenCompleted = useMemo(
    () => completedCount({ tableGroups: remote.data?.tableGroups || [], allGroups: remote.data?.groups || [], isArchived: isGroupArchived }),
    [remote.data?.tableGroups, remote.data?.groups],
  );

  // People shown in the "Schedule per person" table.
  // - Archived applicants leave this table right away (they live in the
  //   Applicant pipeline's Archive section and Admin settings, and can be restored there).
  // - Someone who finished both tracked activities is already filtered by
  //   the backend, so new completions disappear on the next reload.
  const tableGroups = useMemo(
    () => tableSource.filter((group) => !isGroupArchived(group)
      && group.person.toLowerCase().includes(search.toLowerCase())
      && (!activityFilter || group.activities.some((activity) => activity.activity_type === activityFilter))),
    [tableSource, search, activityFilter],
  );

  // [View] from the Update modal (Admin and Sales): remember the applicant,
  // clear the router state, then filter + highlight once the data is loaded.
  useEffect(() => {
    const applicantId = location.state?.viewApplicantId;
    if (!applicantId) return;
    setPendingView(String(applicantId));
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    if (!pendingView || remote.loading) return;
    const group = currentGroups.find((item) => String(applicantIdOfGroup(item)) === pendingView);
    setPendingView(null);
    if (!group) {
      setActionError('This applicant has no schedule in Activities & Schedule yet.');
      return;
    }
    // [View] lands on /activities without ?view, i.e. the table view.
    setActivityFilter('');
    setPage(1);
    setSearch(group.person);
    setViewFocus(group.person);
    // All three Done: the person left the data table, so open the read panel.
    if (!tableSource.some((item) => item.person === group.person)) setSelectedKey(group.person);
  }, [pendingView, remote.loading, currentGroups, tableSource]);

  // Which applicant already has an active schedule for each activity.
  const completedKeys = useMemo(() => {
    const set = new Set();
    groups.forEach((group) => {
      group.activities.forEach((activity) => {
        if (!['pending', 'confirmed'].includes(activity.status) || activity.approval_status === 'rejected') return;
        const id = activity.applicant_id ?? activity.applicant?.id;
        if (id != null) set.add(`id:${id}|${activity.activity_type}`);
        const name = activity.applicant?.full_name || group.person;
        if (name) set.add(`name:${String(name).toLowerCase()}|${activity.activity_type}`);
      });
    });
    return set;
  }, [groups]);

  // Section 5.2 — who may be picked for the selected activity. Returns the
  // reason the applicant is unavailable, or '' when they can be scheduled:
  //  - the activity is already DONE for them,
  //  - the prerequisite activity is not DONE yet (no skipping), or
  //  - they already hold an active/pending schedule for it.
  // The applicant of the activity being edited is never blocked.
  const blockReason = (applicant, type) => {
    if (!applicant || !type || type === 'other') return '';
    if (editing && String(editing.applicant_id) === String(applicant.id)) return '';
    // Only Scheduling-stage applicants can be booked: Admin's [Set Schedule]
    // moves a Qualified applicant there first (the API enforces the same).
    if (applicant.status !== 'scheduled') return 'Not at Scheduling stage';
    if (completedKeys.has(`id:${applicant.id}|${type}`)
      || completedKeys.has(`name:${String(applicant.full_name).toLowerCase()}|${type}`)) {
      return 'Already scheduled';
    }

    const milestones = applicant.milestones || {};
    const isDone = (tracked) => Boolean(ACTIVITY_MILESTONE[tracked] && milestones[ACTIVITY_MILESTONE[tracked]]);
    if (isDone(type)) return 'Already done';

    const index = trackedTypes.indexOf(type);
    if (index > 0 && !isDone(trackedTypes[index - 1])) {
      return `Finish ${titleCase(trackedTypes[index - 1])} first`;
    }

    return '';
  };

  // ---------- Pagination (table view) ----------
  const totalRecords = tableGroups.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pagedGroups = tableGroups.slice(startIndex, startIndex + PAGE_SIZE);
  const tableMeta = {
    current_page: safePage,
    last_page: totalPages,
    per_page: PAGE_SIZE,
    total: totalRecords,
    from: startIndex + 1,
    to: Math.min(startIndex + PAGE_SIZE, totalRecords),
  };

  // If archiving / updating removes the last page, move to a valid one.
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const selectedGroup = selectedKey ? currentGroups.find((group) => group.person === selectedKey) || null : null;
  const shownGroup = selectedGroup || lastSelected.current;
  const closeDetails = () => setSelectedKey(null);

  const shown = shownGroup;
  if (selectedGroup) lastSelected.current = selectedGroup;

  // "All activities" in the read panel pages at 8 rows, like the schedule table:
  // the pager only appears once the person has more than 8 activities.
  const drawerActivities = shown?.activities || [];
  const activityPages = Math.max(1, Math.ceil(drawerActivities.length / PAGE_SIZE));
  const activityPageSafe = Math.min(activityPage, activityPages);
  const pagedActivities = drawerActivities.slice((activityPageSafe - 1) * PAGE_SIZE, activityPageSafe * PAGE_SIZE);
  const activityMeta = {
    current_page: activityPageSafe,
    last_page: activityPages,
    per_page: PAGE_SIZE,
    total: drawerActivities.length,
    from: (activityPageSafe - 1) * PAGE_SIZE + 1,
    to: Math.min(activityPageSafe * PAGE_SIZE, drawerActivities.length),
  };

  // A different person always starts on the first page of their activities.
  useEffect(() => {
    setActivityPage(1);
  }, [selectedKey]);

  // When the selected person finishes everything and leaves the table, close the read panel.
  useEffect(() => {
    if (view !== 'table' || !selectedKey) return;
    if (!currentGroups.some((group) => group.person === selectedKey && !isGroupArchived(group) && !isFullyAccomplished(group))) setSelectedKey(null);
  }, [currentGroups, selectedKey, view]);

  const canManage = ['admin', 'sales'].includes(role);
  // "Complete" in this table is a Sales-only action; the API returns 403 for Admin.
  const canComplete = can(role, 'activities.complete');
  // Approve / Reject pending (Sales-created) schedules is Admin-only.
  const canApprove = can(role, 'activities.approve');
  // Archiving from Activities shares the Applicants archive gate (Admin only).
  const canArchive = can(role, 'applicants.archive');
  const canDelete = role === 'admin';

  // Arriving from the Update modal's "Set Schedule": pre-select the applicant
  // and activity in a fresh create form, glow the header button, clean the URL.
  useEffect(() => {
    if (preselectHandled.current || !applicants.length) return;
    const params = new URLSearchParams(window.location.search);
    const applicantId = params.get('applicant_id');
    const activityType = params.get('activity_type');
    if (!applicantId) return;
    preselectHandled.current = true;
    navigate('/activities', { replace: true });
    if (!canManage) return;
    const person = applicants.find((item) => String(item.id) === String(applicantId));
    setActionError('');
    setSuccess('');
    setEditing(null);
    setForm({
      ...blankForm(),
      activity_type: activityType || '',
      applicant_id: String(applicantId),
      attendee: person?.full_name || '',
    });
    setHighlightApplicant(Boolean(person));
    setLockedApplicantId(person ? String(person.id) : null);
    setShowCreate(true);
    setScheduleGlow(true);
  }, [applicants, canManage, navigate]);

  /**
   * Opens the Schedule activity modal.
   * - `startDate`: pre-fills the start (calendar day click).
   * - `applicant`: { id, name } pre-selects that person ("Set Again") and
   *   makes the Applicant dropdown blink, then stay highlighted.
   */
  const openCreate = (startDate = null, applicant = null, activityType = '') => {
    setActionError('');
    setSuccess('');
    setEditing(null);
    setForm({
      ...blankForm(),
      activity_type: activityType || '',
      applicant_id: applicant ? String(applicant.id ?? '') : '',
      attendee: applicant?.name || '',
      ...(startDate ? { start_date: toDateInput(startDate) } : {}),
    });
    setHighlightApplicant(Boolean(applicant));
    setLockedApplicantId(applicant && applicant.id ? String(applicant.id) : null);
    setShowCreate(true);
  };

  // "Set Again": the applicant-level action that schedules the NEXT step — same
  // modal as Schedule activity, with the applicant AND the next activity
  // already chosen.
  const setAgain = (group, type) => {
    const applicantId = applicantIdOfGroup(group) ?? '';
    const name = group.activities.find((item) => item.applicant?.full_name)?.applicant?.full_name
      || applicants.find((item) => String(item.id) === String(applicantId))?.full_name
      || group.person;
    openCreate(null, { id: applicantId, name }, type);
  };

  const closeForm = () => {
    setShowCreate(false);
    setEditing(null);
    setHighlightApplicant(false);
    setLockedApplicantId(null);
  };

  // Sessions panel / live check: "Join this session" added the applicant (participant API).
  const joinedSession = async (message) => {
    closeForm();
    setScheduleGlow(false);
    setSuccess(message);
    await remote.reload();
    setMasterRefreshKey((key) => key + 1);
  };

  // "Open in Master Schedule": Day view on that date with the session open; nothing is scheduled.
  const openInMasterSchedule = (row) => {
    closeForm();
    navigate(masterScheduleLink(row));
  };

  // "Reassign Sales" (Admin): the existing Reassign flow lives in the applicant's Update modal.
  const reassignSales = (applicantId) => {
    closeForm();
    navigate(APPLICANTS_ROUTE, { state: { focusApplicantId: Number(applicantId) } });
  };

  const openEdit = (activity) => {
    setActionError('');
    setSuccess('');
    setHighlightApplicant(false);
    setLockedApplicantId(null);
    setEditing(activity);
    const name = activity.applicant?.full_name
      || applicants.find((item) => String(item.id) === String(activity.applicant_id))?.full_name
      || '';
    setForm({
      ...blankForm(),
      ...scheduleFieldsFromActivity({ ...activity, duration_minutes: activity.duration_minutes || diffMinutes(activity) }),
      applicant_id: String(activity.applicant_id ?? ''),
      activity_type: activity.activity_type || '',
      attendee: (activity.participants || []).join(', ') || name,
    });
  };

  const submitActivity = async (event) => {
    event.preventDefault();
    if (!form.activity_type) {
      setActionError('Select an activity.');
      return;
    }
    const multi = !editing && form.mode === 'multiple' && !lockedApplicantId;
    const ids = multi ? form.applicant_ids : [form.applicant_id].filter(Boolean);
    if (!ids.length) {
      setActionError(multi ? 'Select at least one applicant.' : 'Select an applicant.');
      return;
    }
    // Whole-hour window (whole hours, 9 AM–5 PM starts, never past 6 PM).
    let window;
    try {
      window = buildScheduleWindow(form);
    } catch (error) {
      setActionError(error.message);
      return;
    }

    setSaving(true);
    setActionError('');
    setSuccess('');

    // The title is generated from the selected activity (the table shows the
    // activity type, not this string). The date keeps it unique when the same
    // activity is set again for the same person.
    const buildPayload = (applicant, applicantId, participants) => ({
      applicant_id: Number(applicantId),
      activity_type: form.activity_type,
      title: `${titleCase(form.activity_type)} — ${applicant?.full_name || 'Applicant'} (${window.starts_at.slice(0, 10)})`,
      starts_at: window.starts_at,
      duration_minutes: window.duration_minutes,
      venue: form.venue || null,
      meeting_link: form.meeting_link?.trim() || null,
      participants,
      // Session choice: joining the existing session at this date/time, or a
      // separate one created beside it (same date/time, own capacity).
      session_id: form.join_session_id || null,
      // Never for Training (H4 refuses an overlapping Training).
      separate_session: form.activity_type !== 'training' && Boolean(form.separate_session),
    });

    try {
      if (editing) {
        const applicant = applicants.find((item) => String(item.id) === String(ids[0]));
        await api.put(`/activities/${editing.id}`, buildPayload(applicant, ids[0], parseAttendees(form.attendee, applicant?.full_name)));
        setSuccess(role === 'sales' ? 'Adjustment requested; awaiting Admin approval.' : 'Activity updated successfully.');
        closeForm();
        await remote.reload();
        setMasterRefreshKey((key) => key + 1);
        return;
      }

      // One schedule per selected applicant.
      const failed = [];
      for (const id of ids) {
        const applicant = applicants.find((item) => String(item.id) === String(id));
        const participants = multi
          ? [applicant?.full_name].filter(Boolean)
          : parseAttendees(form.attendee, applicant?.full_name);
        try {
          await api.post('/activities', buildPayload(applicant, id, participants));
        } catch (error) {
          failed.push({ id: String(id), name: applicant?.full_name || `#${id}`, message: firstValidationMessage(error) });
        }
      }

      const created = ids.length - failed.length;
      await remote.reload();
      setMasterRefreshKey((key) => key + 1);
      setScheduleGlow(false); // the schedule was created: the glow stops

      if (failed.length) {
        // Keep the modal open with only the applicants that failed.
        setForm((current) => ({ ...current, applicant_ids: failed.map((item) => item.id) }));
        setActionError(failed.map((item) => `${item.name}: ${item.message}`).join(' · '));
        if (created) setSuccess(`${created} ${created === 1 ? 'activity' : 'activities'} scheduled.`);
        return;
      }

      setSuccess(created === 1 ? 'Activity scheduled successfully.' : `${created} activities scheduled successfully.`);
      closeForm();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const completeActivity = async (event) => {
    event.preventDefault();
    if (!completing) return;
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      const body = new FormData();
      body.append('attended', completeForm.attended);
      if (completeForm.attended === 'yes') {
        body.append('actual_started_at', fromManilaInput(completeForm.actual_started_at));
        body.append('handler_name', completeForm.handler_name.trim());
        body.append('result_notes', completeForm.result_notes.trim());
        if (completing.activity_type === 'orientation') {
          completeForm.attendance.forEach((file) => body.append('attendance', file));
          completeForm.brand_docs.forEach((file) => body.append('brand_document', file));
          body.append('selected_brand_id', completeForm.selected_brand_id);
          body.append('keep_document_ids', completeForm.saved.map((doc) => doc.id).join(','));
        } else if (completeForm.proof) body.append('proof', completeForm.proof);
      } else {
        body.append('no_show_reason', completeForm.no_show_reason.trim());
      }
      const result = await api.post(`/activities/${completing.id}/complete`, body);
      setCompleting(null);
      setCompleteForm(null);
      setSuccess(result.message || 'Activity completed — waiting for Admin to review the proof.');
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  /** Admin decides on a pending (Sales-created) schedule: approve or reject. */
  const decideOnActivity = async (activity, decision) => {
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/activities/${activity.id}/${decision}`);
      setSuccess(decision === 'approve'
        ? 'Activity approved — Sales can now record its result.'
        : 'Activity rejected.');
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmArchive = async () => {
    if (!archiving) return;
    const id = applicantIdOfGroup(archiving);
    if (id == null) {
      setActionError('This applicant could not be identified.');
      return;
    }
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      const response = await archiveApplicantRequest(id);
      if (selectedKey === archiving.person) setSelectedKey(null);
      setSuccess(response?.message || `${archiving.person} was archived and removed from this table.`);
      setArchiving(null);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const handleViewInAdminSettings = (group) => {
    const id = applicantIdOfGroup(group);
    if (id == null) {
      setActionError('This applicant could not be identified.');
      return;
    }
    setActionError('');
    setSuccess('');
    // Restore happens only in Admin Settings > Archive.
    navigate(`/admin-settings?tab=applicants&applicant=${id}`);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const activity = deleting.current;
    if (!activity) {
      setActionError('There is no ongoing schedule to cancel.');
      return;
    }
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      const response = await cancelScheduleRequest(activity.id);
      setSuccess(response?.message || 'Schedule cancelled.');
      setDeleting(null);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const currentKey = selectedGroup?.person || null;

  // The read panel is anchored to a table row, so close it when leaving the table view.
  const changeView = (next) => {
    if (next !== 'table' && next !== view) setSelectedKey(null);
    setView(next);
  };

  // Keeps the curved pointer level with the selected row while the panel is open,
  // and keeps the panel flush under the real header (no gap, no overlap).
  const drawerRef = useRef(null);
  const prevSelectedRef = useRef(null);
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return undefined;
    if (!selectedKey) {
      prevSelectedRef.current = null;
      return undefined;
    }

    const place = () => {
      // Measure the real header's bottom edge (border included) instead of a fixed height.
      // The drawer is portaled to <body>, so this viewport value is exactly its `top`.
      const header = document.querySelector('.herald-header');
      const topEdge = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
      drawer.style.setProperty('--drawer-top', `${topEdge}px`);
      const row = document.querySelector(`tr[data-activity-person="${CSS.escape(selectedKey)}"]`);
      if (!row) {
        drawer.style.setProperty('--pointer-opacity', '0');
        return;
      }
      const rowRect = row.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const centerInViewport = rowRect.top + rowRect.height / 2;
      const visible = centerInViewport >= topEdge + 24 && centerInViewport <= window.innerHeight - 30;
      drawer.style.setProperty('--pointer-y', `${centerInViewport - drawerRect.top}px`);
      drawer.style.setProperty('--pointer-opacity', visible ? '1' : '0');
    };

    const switching = prevSelectedRef.current !== null && prevSelectedRef.current !== selectedKey;
    prevSelectedRef.current = selectedKey;
    drawer.classList.toggle('pointer-animate', switching);
    place();
    const timer = switching ? setTimeout(() => drawer.classList.remove('pointer-animate'), 450) : 0;

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (observer) observer.observe(document.body);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (observer) observer.disconnect();
    };
  }, [selectedKey, remote.data, view, safePage]);

  useEffect(() => {
    if (!selectedKey) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !showCreate && !editing && !completing && !archiving && !deleting) setSelectedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedKey, showCreate, editing, completing, archiving, deleting]);

  const applicantName = shown?.activities?.[0]?.applicant?.full_name || shown?.person || 'Applicant';
  const progress = shown ? typeProgress(shown.activities) : [];
  const progressDone = progress.filter((item) => item.done).length;

  return (
    <div className="page-container w-full m-[0_auto] p-[clamp(10px,_1.2vw,_16px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] activities-page [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.data-panel]:rounded-[var(--act-radius-panel)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] later-4:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-5:[&>:empty]:hidden! [&_.data-panel]:m-0 [&_.duration-presets]:flex [&_.duration-presets]:flex-wrap [&_.duration-presets]:gap-2 [&_.duration-preset]:inline-flex [&_.duration-preset]:items-center [&_.duration-preset]:gap-[6px] [&_.duration-preset]:p-[7px_14px] [&_.duration-preset]:rounded-[var(--act-radius-cell)] [&_.duration-preset]:[border:1px_solid_var(--act-line)] [&_.duration-preset]:[background:transparent] [&_.duration-preset]:text-[color:inherit] [&_.duration-preset]:text-[13px] [&_.duration-preset]:font-[600] [&_.duration-preset]:cursor-pointer [&_.duration-preset]:[transition:background_0.15s_ease,_border-color_0.15s_ease] [&_.duration-preset:hover]:border-[color:var(--act-accent)] [&_.duration-preset.active]:[background:rgba(123,_136,_255,_0.16)] [&_.duration-preset.active]:border-[color:var(--act-accent)] [&_.duration-preset.active]:text-[color:var(--accent,_#aeb6ff)] max-[721px]:later:[--act-pad:16px] [&_tr.is-archived]:opacity-[0.88] [&_tr.is-archived:hover]:opacity-[1] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]!">
      <PageHeader title="Activities & schedules" />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>

      {/* Unified toolbar: the view tabs, the search field and the activity filter
          all live inside one bordered box (same structure as Applicant pipeline). */}
      <div className="unified-toolbar-container flex items-center flex-nowrap gap-[10px] w-full [box-sizing:border-box] m-0 p-[10px_14px] border border-[#252b3b] rounded-[14px] [background:#101421] light:border-line light:[background:var(--panel)] max-[721px]:later:flex-wrap max-[721px]:later:gap-2 max-[721px]:later:p-[8px_10px] max-[721px]:later:rounded-[12px] [.activities-page_&]:m-0">
        <div className="flex items-center flex-[0_1_auto] min-w-0 gap-[2px] p-1 overflow-x-auto border border-[#1f2638] rounded-[10px] [background:#0b0f19] light:border-line light:[background:var(--panel-2)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:flex-[0_0_auto] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:min-h-[34px] [&>button]:p-[7px_15px] later-2:[&>button]:border later-2:[&>button]:border-transparent later-2:[&>button]:rounded-[8px] [&>button]:[background:transparent] [&>button]:text-[#8a94a6] light:[&>button]:text-muted [&>button]:[font-family:inherit] [&>button]:[font-style:inherit] later-2:[&>button]:text-[13px] later-2:[&>button]:font-[600] later:[&>button]:leading-[1.2] [&>button]:whitespace-nowrap later:[&>button]:cursor-pointer [&>button]:[transition:background_.15s_ease,_color_.15s_ease,_border-color_.15s_ease] [&>button:hover:not(.active):not([aria-selected='true'])]:text-[#d7ddf5] light:[&>button:hover:not(.active):not([aria-selected='true'])]:text-text [&>button:hover:not(.active):not([aria-selected='true'])]:[background:rgba(255,_255,_255,_.04)] [&>button:hover:not(.active):not([aria-selected='true'])]:border-transparent [&>button.active]:[background:#252e42] light:[&>button.active]:[background:var(--active)] [&>button.active]:text-[#fff] light:[&>button.active]:text-accent-text [&>button.active]:font-[600] [&>button.active]:border-transparent [&>button.active]:[box-shadow:none] later:[&>button[aria-selected='true']]:[background:#252e42] light:[&>button[aria-selected='true']]:[background:var(--active)] [&>button[aria-selected='true']]:text-[#fff] light:[&>button[aria-selected='true']]:text-accent-text [&>button[aria-selected='true']]:font-[600] [&>button[aria-selected='true']]:border-transparent [&>button[aria-selected='true']]:[box-shadow:none] later:[&>button:focus-visible]:[outline:2px_solid_#8175ff] later:[&>button:focus-visible]:[outline-offset:2px] [&>button_svg]:flex-[0_0_auto] [&>button_svg]:text-[12px] max-[721px]:later:flex-[1_1_100%]" role="group" aria-label="Schedule view">
          <button type="button" className={view === 'table' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} onClick={() => changeView('table')} aria-pressed={view === 'table'}>
            <FaTableList aria-hidden="true" /> Table
          </button>
          {canMasterSchedule && (
            <button type="button" className={view === 'master' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} onClick={() => changeView('master')} aria-pressed={view === 'master'}>
              <FaCalendarCheck aria-hidden="true" /> Master Schedule
            </button>
          )}
        </div>

        {view === 'table' && (
          <>
            <div className="flex-[1_1_160px] min-w-[120px] flex [&_input]:flex-[1_1_auto] [&_input]:w-full [&_input]:min-w-0 [&_input]:h-[44px] [&_input]:[box-sizing:border-box] [&_input]:p-[0_14px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:text-[13px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_input]:h-[42px]">
              <input value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search applicants" aria-label="Search applicants" />
            </div>
            <div className="flex-[0_0_180px] flex [&_select]:w-full [&_select]:h-[44px] [&_select]:[box-sizing:border-box] [&_select]:p-[0_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:text-[13px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select:hover]:border-line-strong later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_select]:h-[42px]">
              <select value={activityFilter} onChange={(event) => { setPage(1); setActivityFilter(event.target.value); }} aria-label="Filter activity">
                <option value="">All activities</option>
                {trackedTypes.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}
              </select>
            </div>
            <label className="inline-flex items-center gap-2 flex-none whitespace-nowrap text-[13px] text-muted cursor-pointer" title="People with both activities done are hidden from this table">
              <input type="checkbox" checked={showCompleted} onChange={(event) => { setPage(1); setShowCompleted(event.target.checked); }} />
              Show completed{hiddenCompleted ? ` (${hiddenCompleted})` : ''}
            </label>
          </>
        )}

        {canManage && (
          <button
            type="button"
            className={`primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.unified-toolbar-container_&]:flex-[0_0_auto] [.unified-toolbar-container_&]:ml-auto [.unified-toolbar-container_&]:inline-flex [.unified-toolbar-container_&]:items-center [.unified-toolbar-container_&]:justify-center [.unified-toolbar-container_&]:gap-2 [.unified-toolbar-container_&]:h-[44px] [.unified-toolbar-container_&]:min-h-[44px] [.unified-toolbar-container_&]:p-[0_18px] [.unified-toolbar-container_&]:rounded-[10px] [.unified-toolbar-container_&]:text-[13px] [.unified-toolbar-container_&]:font-[700] max-[721px]:later:[.unified-toolbar-container_&]:flex-[1_1_100%] ${scheduleGlow ? ' text-[#39ffb0]! border-[#39ffb0]! [animation:schedule-rotate-glow_1.4s_linear_infinite]' : ''}`}
            onClick={() => { setScheduleGlow(false); openCreate(); }}
          >
            <FaCalendarPlus aria-hidden="true" /> Schedule activity
          </button>
        )}
        {view === 'master' && can(role, 'schedule_sessions.schedule') && (
          <button
            type="button"
            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] flex-[0_0_auto] max-[721px]:w-full"
            onClick={() => setSessionRequest((count) => count + 1)}
          >
            <FaPlus aria-hidden="true" /> Schedule session
          </button>
        )}
      </div>

      {view === 'table' && viewFocus && (
        <div className="flex items-center justify-between gap-3 m-[0_0_10px] p-[10px_14px] border border-[rgba(96,_165,_250,_.45)] rounded-[10px] [background:rgba(59,_130,_246,_.12)] text-[#dbe7ff] text-[13px]" role="status">
          <span>Showing the schedule of <strong>{viewFocus}</strong></span>
          <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => { setViewFocus(null); setSearch(''); setPage(1); }}>
            Show all
          </button>
        </div>
      )}

      {view === 'table' && (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          {remote.loading ? <LoadingState /> : !tableGroups.length ? (
            <EmptyState label="No activities are scheduled." detail="Create an activity to coordinate the next applicant touchpoint." />
          ) : (
            <>
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table>
                <thead>
                  <tr>
                    <th>Person</th><th>Activity assigned</th><th>Date assigned</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedGroups.map((group) => {
                    const activity = group.current;
                    const overdue = activity?.is_missed;
                    const accomplished = activity?.status === 'completed';
                    const finishedAll = allMilestonesDone(group);
                    const setAgainType = nextActivityTypeFor(group);
                    const applicantId = applicantIdOfGroup(group);
                    const isArchived = isGroupArchived(group);
                    // Full text for hover + screen readers even when the fixed-size
                    // badge clips its label or date.
                    const chipText = activity
                      ? `${activityLabel(activity)}${overdue ? ' · Overdue: applicant did not attend' : ''} · ${formatDate(activity.starts_at, true)} · ${formatDuration(activity.duration_minutes)}`
                      : '';
                    return (
                      <tr
                        key={group.person}
                        data-activity-person={group.person}
                        className={`inquiry-row [tr&]:cursor-pointer [tr&]:[transition:background-color_0.2s_ease] [tr&:hover]:[background:rgba(123,_136,_255,_0.06)] [tr&:focus-visible]:[outline:2px_solid_#7b88ff] [tr&:focus-visible]:[outline-offset:-2px] later:[tr&.is-selected]:[background:rgba(123,_136,_255,_0.1)] [tr&.is-selected]:[box-shadow:inset_3px_0_0_#7b88ff] [.data-panel_.table-wrap_table_tbody_tr&_td]:[vertical-align:middle]! [.data-panel_.table-wrap_table_tbody_tr&_td]:pt-4! [.data-panel_.table-wrap_table_tbody_tr&_td]:pb-4! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:text-[1.025rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:font-[600]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:text-[0.8rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:font-[500]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:mt-[2px]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:text-[0.825rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:font-[400]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:leading-[1.35]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:text-[0.78rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:font-[500]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:mt-[3px]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(3)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(3)]:font-[350]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(4)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(4)]:font-[350]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(5)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(5)]:font-[350]! [.archive-mode_tr&]:[user-select:none] later-2:[tr&.is-picked]:[background:rgba(123,_136,_255,_0.14)] [tr&.is-picked]:[box-shadow:inset_3px_0_0_#7b88ff] [&.is-view-focus>td]:[background:rgba(59,_130,_246,_.14)] [&.is-view-focus>td:first-child]:[box-shadow:inset_3px_0_0_#60a5fa] ${currentKey === group.person ? ' is-selected' : ''}${viewFocus === group.person ? ' is-view-focus' : ''}${isArchived ? ' is-archived' : ''}`}
                        tabIndex={0}
                        onClick={() => setSelectedKey((current) => (current === group.person ? null : group.person))}
                        onKeyDown={(event) => { if (event.key === 'Enter') setSelectedKey(group.person); }}
                      >
                        <td>
                          <span className="flex flex-col gap-[2px] [&_strong]:text-text [&_strong]:text-[10px] [&_small]:text-muted [&_small]:text-[8px] [.activities-page_&]:flex [.activities-page_&]:flex-col [.activities-page_&]:gap-[2px] [.activities-page_&_strong]:text-[color:var(--text,_inherit)] [.activities-page_&_strong]:text-[15px] [.activities-page_&_strong]:font-[650] [.activities-page_&_strong]:leading-[1.3] [.activities-page_&_small]:text-[color:var(--muted,_#8590a8)] later:[.activities-page_&_small]:text-[12.5px]">
                            <span className="[.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:gap-2 [.activities-page_&]:flex-wrap">
                              <strong>{group.person}</strong>
                              {isArchived && <span className="[.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:p-[2px_7px] [.activities-page_&]:rounded-[4px] [.activities-page_&]:text-[10.5px] [.activities-page_&]:font-[750] [.activities-page_&]:uppercase [.activities-page_&]:tracking-[0.05em] [.activities-page_&]:[background:rgba(245,_158,_11,_0.15)] [.activities-page_&]:text-[#fbbf24] [.activities-page_&]:border [.activities-page_&]:border-[rgba(245,_158,_11,_0.35)]">Archived</span>}
                            </span>
                            <small>{group.total} {group.total === 1 ? 'activity' : 'activities'}</small>
                          </span>
                        </td>
                        <td>
                          {activity ? (
                            <span
                              className={`inline-flex items-center gap-[5px] p-[4px_9px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[8px] [&.is-completed]:text-success-text [&.is-completed]:border-[color:color-mix(in_srgb,_var(--success)_28%,_transparent)] [&.is-completed]:[background:color-mix(in_srgb,_var(--success)_8%,_transparent)] later:[&.is-overdue]:text-danger-text later:[&.is-overdue]:border-[color:color-mix(in_srgb,_var(--danger)_28%,_transparent)] later:[&.is-overdue]:[background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] [.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:[box-sizing:border-box] [.activities-page_&]:border-0! [.activities-page_&]:[background:transparent]! [.activities-page_&]:gap-[6px] [.activities-page_&]:w-[224px] [.activities-page_&]:h-[32px] [.activities-page_&]:p-[0_10px] [.activities-page_&]:rounded-[9999px] [.activities-page_&]:border later-2:[.activities-page_&]:border-[#394259] later-2:[.activities-page_&]:[background:#101421] [.activities-page_&]:text-[14px] [.activities-page_&]:leading-[1] [.activities-page_&]:whitespace-nowrap [.activities-page_&]:overflow-hidden [.activities-page_&>svg]:flex-[0_0_auto] later:[.activities-page_&>svg]:w-[12px] later:[.activities-page_&>svg]:h-[12px] [.activities-page_&_small]:flex-[0_1_auto] [.activities-page_&_small]:min-w-0 [.activities-page_&_small]:max-w-[52%] later:[.activities-page_&_small]:m-0 [.activities-page_&_small]:overflow-hidden [.activities-page_&_small]:pl-[6px] [.activities-page_&_small]:border-l [.activities-page_&_small]:border-l-[color:color-mix(in_srgb,_currentColor_28%,_transparent)] [.activities-page_&_small]:text-[color:var(--muted,_#8590a8)] later-2:[.activities-page_&_small]:text-[10px] later-2:[.activities-page_&_small]:font-[500] [.activities-page_&_small]:text-ellipsis [.activities-page_&_small]:whitespace-nowrap [.activities-page_&.is-completed]:border-[rgba(34,_197,_94,_0.55)] [.activities-page_&.is-completed]:[background:#101421] [.activities-page_&.is-completed]:text-[#22c55e] [.activities-page_&.is-completed_small]:text-[#7fd6a2] [.activities-page_&.is-overdue]:w-[252px] later:[.activities-page_&.is-overdue]:border-[rgba(244,_63,_94,_0.55)] [.activities-page_&.is-overdue]:[background:#101421] later:[.activities-page_&.is-overdue]:text-[#f43f5e] later:[.activities-page_&.is-overdue_small]:text-[#f3a0ae] ${accomplished ? ' is-completed' : ''}${overdue ? ' is-overdue' : ''}`}
                              title={chipText}
                              aria-label={chipText}
                            >
                              {accomplished ? <FaCheck aria-hidden="true" /> : overdue ? <FaTriangleExclamation aria-hidden="true" /> : <FaCalendarDays aria-hidden="true" />}
                              <span className="[.activities-page_&]:flex-[1_1_auto] [.activities-page_&]:min-w-0 [.activities-page_&]:overflow-hidden [.activities-page_&]:text-ellipsis [.activities-page_&]:whitespace-nowrap">{activityLabel(activity)}</span>
                              {overdue && <small>Applicant did not attend the schedule</small>}
                            </span>
                          ) : (
                            <span className="muted-note text-muted text-[8px] leading-[1.6]">Nothing scheduled</span>
                          )}
                        </td>
                        <td className="pr-8!">
                          {activity ? (
                            <span className="[.activities-page_&]:text-[color:var(--text,_inherit)] [.activities-page_&]:text-[14px]">{formatDate(activity.starts_at)}</span>
                          ) : null}
                        </td>
                        <td onClick={(event) => event.stopPropagation()}>
                          <div className="row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative">
                            {/* Main actions: Back to Status / Set Again / Edit / Complete (unchanged behaviour) */}
                            <div className="[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:gap-2 [.dashboard-page_&]:flex-wrap [.dashboard-page_&]:flex-[1_1_auto] [.dashboard-page_&]:min-w-0 [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:gap-2 [.activities-page_&]:flex-wrap [.activities-page_&]:flex-[1_1_auto] [.activities-page_&]:min-w-0">
                              {canManage && activity && !isArchived && (
                                accomplished ? (
                                  // Completed by Sales. Until Admin marks Attended and
                                  // saves it, nobody gets an action (Section 3).
                                  setAgainType ? (
                                    // Set Again is applicant-level: it schedules the NEXT
                                    // step (never a repeat of this activity).
                                    <button
                                      type="button"
                                      className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.activities-page_.row-actions_&]:inline-flex [.activities-page_.row-actions_&]:items-center [.activities-page_.row-actions_&]:gap-2 [.activities-page_.row-actions_&]:whitespace-nowrap"
                                      onClick={() => setAgain(group, setAgainType)}
                                      title={`Schedule the next step: ${titleCase(setAgainType)}`}
                                    >
                                      <FaRotateRight aria-hidden="true" /> Set again – {titleCase(setAgainType)}
                                    </button>
                                  ) : finishedAll ? (
                                    // Orientation/Tasting and Training are both done:
                                    // no more scheduling, go back to the applicant pipeline.
                                    <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.activities-page_.row-actions_&]:inline-flex [.activities-page_.row-actions_&]:items-center [.activities-page_.row-actions_&]:gap-2 [.activities-page_.row-actions_&]:whitespace-nowrap" onClick={() => navigate(APPLICANTS_ROUTE)}>
                                      <FaArrowLeft aria-hidden="true" /> Back to Status
                                    </button>
                                  ) : (
                                    <span className="muted-note text-muted text-[8px] leading-[1.6]">Waiting for Admin to save Attended</span>
                                  )
                                ) : (
                                  <>
                                    <button type="button" className="inline-flex items-center gap-[6px] h-[32px] px-[12px] rounded-[10px] border border-[#394259] [background:transparent] text-[#d5dbec] text-[12px] font-[600] whitespace-nowrap cursor-pointer hover:border-[#7b88ff] hover:text-[#fff]" onClick={() => openEdit(activity)}><FaPen aria-hidden="true" /> Adjust</button>
                                    {canComplete && !activity.is_missed && activity.approval_status !== 'pending_admin' && activity.approval_status !== 'rejected' && !['cancelled', 'no_show'].includes(activity.status) && (
                                      <button
                                        type="button"
                                        disabled={nowMs < new Date(activity.starts_at).getTime()}
                                        className={`inline-flex items-center justify-center h-[32px] px-[16px] rounded-[10px] border text-[12px] font-[700] tracking-[.06em] uppercase whitespace-nowrap [background:#101421] disabled:cursor-not-allowed ${nowMs < new Date(activity.starts_at).getTime() ? 'border-[#394259] text-[#fff]' : 'border-[#4f8f4a] text-[#86c76b]'}`}
                                        title={nowMs < new Date(activity.starts_at).getTime() ? `Available on ${manilaDateTimeLabel(activity.starts_at)}` : 'Mark Complete'}
                                        aria-label="Mark Complete"
                                        onClick={() => {
                                          setActionError('');
                                          setCompleting(activity);
                                          setCompleteForm({
                                            attended: 'yes',
                                            actual_started_at: toManilaInput(activity.starts_at),
                                            handler_name: activity.assigned_to?.full_name || '',
                                            result_notes: '',
                                            no_show_reason: '',
                                            proof: null,
                                            attendance: [],
                                            brand_docs: [],
                                            saved: [],
                                            selected_brand_id: '',
                                          });
                                          // A returned Orientation/Tasting: the files already sent can be kept.
                                          if (activity.activity_type === 'orientation' && activity.review_status === 'returned') {
                                            api.get(`/activities/${activity.id}`).then((res) => {
                                              const current = (res.data?.proof_documents || []).filter((doc) => !doc.replaced_at);
                                              setCompleteForm((f) => (f ? { ...f, saved: current, selected_brand_id: res.data?.selected_brand_id ? String(res.data.selected_brand_id) : f.selected_brand_id } : f));
                                            }).catch(() => {});
                                          }
                                        }}
                                      >
                                        Complete
                                      </button>
                                    )}
                                    {canComplete && activity.approval_status === 'immediate' && ['pending', 'confirmed'].includes(activity.status) && nowMs < new Date(activity.starts_at).getTime() && (
                                      <span className="muted-note text-muted text-[12px] leading-[1.6]">Available on {manilaDateTimeLabel(activity.starts_at)}</span>
                                    )}
                                    {activity.review_status === 'returned' && (
                                      <ClampedNote label="Returned by Admin: " text={activity.return_reason} />
                                    )}
                                  </>
                                )
                              )}
                              {!canManage && activity && (
                                <span className="muted-note text-muted text-[8px] leading-[1.6]">{formatDate(activity.starts_at, true)}</span>
                              )}
                            </div>

                            {/* Approval state of the current activity: Sales sees
                                the badge only; Admin decides (approve / reject). */}
                            {activity && !isArchived && activity.approval_status && activity.approval_status !== 'immediate' && (
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <span className={`p-[4px_10px] rounded-[999px] text-[10px] font-[800] tracking-[0.04em] uppercase border border-transparent whitespace-nowrap later-5:[&.is-pending]:text-[#ffc857] [&.is-pending]:[background:color-mix(in_srgb,_#ffc857_12%,_transparent)] [&.is-pending]:border-[color:color-mix(in_srgb,_#ffc857_45%,_transparent)] later-6:[&.is-rejected]:text-[#ff4d6d] later:[&.is-rejected]:[background:color-mix(in_srgb,_#ff4d6d_12%,_transparent)] later:[&.is-rejected]:border-[color:color-mix(in_srgb,_#ff4d6d_50%,_transparent)] ${activity.approval_status === 'pending_admin' ? 'is-pending' : 'is-rejected'}`}>
                                  {activity.approval_status === 'pending_admin' ? 'Pending admin confirmation' : 'Rejected'}
                                </span>
                                {canApprove && activity.proposed_changes?.starts_at && <span>Requested: {formatDate(activity.proposed_changes.starts_at, true)}</span>}
                                {canApprove && activity.approval_status === 'pending_admin' && (
                                  <>
                                    <button type="button" className="p-[6px_12px] border border-[color:color-mix(in_srgb,_#39ffb0_55%,_transparent)] rounded-[10px] text-[#39ffb0] [background:color-mix(in_srgb,_#39ffb0_8%,_transparent)] text-[12px] font-[750] cursor-pointer [&:hover:not(:disabled)]:[background:color-mix(in_srgb,_#39ffb0_16%,_transparent)] [&:hover:not(:disabled)]:[box-shadow:0_0_12px_color-mix(in_srgb,_#39ffb0_35%,_transparent)]" disabled={saving} onClick={() => void decideOnActivity(activity, 'approve')}>
                                      Approve
                                    </button>
                                    <button type="button" className="p-[6px_12px] border border-[color:color-mix(in_srgb,_#ff4d6d_55%,_transparent)] rounded-[10px] text-[#ff4d6d] [background:color-mix(in_srgb,_#ff4d6d_8%,_transparent)] text-[12px] font-[750] cursor-pointer [&:hover:not(:disabled)]:[background:color-mix(in_srgb,_#ff4d6d_16%,_transparent)] [&:hover:not(:disabled)]:[box-shadow:0_0_12px_color-mix(in_srgb,_#ff4d6d_35%,_transparent)]" disabled={saving} onClick={() => void decideOnActivity(activity, 'reject')}>
                                      Reject
                                    </button>
                                  </>
                                )}
                              </div>
                            )}

                            {/* Fixed-position Archive / Restore / Delete, always at the right side of the cell */}
                            {canArchive && applicantId && group.applicant_status !== 'active_franchisee' && (
                              <div className={`[.dashboard-page_&]:flex [.dashboard-page_&]:items-center [.dashboard-page_&]:justify-end [.dashboard-page_&]:gap-2 [.dashboard-page_&]:flex-none [.dashboard-page_&]:ml-auto [.dashboard-page_&]:pr-[6px] [.dashboard-page_&.has-delete]:min-w-[80px] [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-end [.activities-page_&]:gap-2 [.activities-page_&]:flex-none [.activities-page_&]:ml-auto [.activities-page_&]:pr-[6px] [.activities-page_&.has-delete]:min-w-[80px] ${canDelete ? ' has-delete' : ''}`}>
                                {isArchived ? (
                                  <button
                                    type="button"
                                    className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] view-admin-settings-button"
                                    title={`View ${group.person} in Admin Settings`}
                                    aria-label={`View ${group.person} in Admin Settings`}
                                    disabled={saving}
                                    onClick={() => handleViewInAdminSettings(group)}
                                  >
                                    <FaArrowRight aria-hidden="true" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] archive-applicant-button"
                                    title={`Archive ${group.person}`}
                                    aria-label={`Archive ${group.person}`}
                                    disabled={saving}
                                    onClick={() => { setActionError(''); setArchiving(group); }}
                                  >
                                    <FaInbox aria-hidden="true" />
                                  </button>
                                )}
                                {canDelete && ['pending', 'confirmed'].includes(group.current?.status) && group.current?.approval_status !== 'rejected' && (
                                  <button type="button" className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] later:[.activities-page_.row-actions_&:disabled]:opacity-[0.35] [.activities-page_.row-actions_&:disabled]:cursor-not-allowed [.activities-page_.row-actions_&:disabled]:pointer-events-none later:[.activities-page_.row-actions_&.is-disabled]:opacity-[0.35] [.activities-page_.row-actions_&.is-disabled]:cursor-not-allowed [.activities-page_.row-actions_&.is-disabled]:pointer-events-none" title="Cancel schedule" aria-label={`Cancel schedule for ${group.person}`} disabled={saving} onClick={() => { setActionError(''); setDeleting(group); }}>
                                    <FaTrashCan aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalRecords > PAGE_SIZE && <SlidingPagination meta={tableMeta} onPage={setPage} />}
            </>
          )}
        </section>
      )}

      {/* Master Schedule tab: the full session calendar (views, filters, session
          panel, form, live rule check, drag-and-merge, role actions). */}
      {view === 'master' && <MasterSchedule embedded refreshKey={masterRefreshKey} sessionRequest={sessionRequest} />}


      {(showCreate || editing) && createPortal(
        <div className="activities-page [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.data-panel]:rounded-[var(--act-radius-panel)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] later-4:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-5:[&>:empty]:hidden! [&_.data-panel]:m-0 [&_.duration-presets]:flex [&_.duration-presets]:flex-wrap [&_.duration-presets]:gap-2 [&_.duration-preset]:inline-flex [&_.duration-preset]:items-center [&_.duration-preset]:gap-[6px] [&_.duration-preset]:p-[7px_14px] [&_.duration-preset]:rounded-[var(--act-radius-cell)] [&_.duration-preset]:[border:1px_solid_var(--act-line)] [&_.duration-preset]:[background:transparent] [&_.duration-preset]:text-[color:inherit] [&_.duration-preset]:text-[13px] [&_.duration-preset]:font-[600] [&_.duration-preset]:cursor-pointer [&_.duration-preset]:[transition:background_0.15s_ease,_border-color_0.15s_ease] [&_.duration-preset:hover]:border-[color:var(--act-accent)] [&_.duration-preset.active]:[background:rgba(123,_136,_255,_0.16)] [&_.duration-preset.active]:border-[color:var(--act-accent)] [&_.duration-preset.active]:text-[color:var(--accent,_#aeb6ff)] max-[721px]:later:[--act-pad:16px] [&_tr.is-archived]:opacity-[0.88] [&_tr.is-archived:hover]:opacity-[1] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]! activities-modal-root contents [&_.danger-button]:[background:#dc2626] [&_.danger-button]:border-[#b91c1c] [&_.danger-button]:text-[#fff] [&_.danger-button:hover:not(:disabled)]:[filter:brightness(1.08)]">
        <Modal
          title={editing ? `Edit ${activityLabel(editing)}` : 'Schedule activity'}
          onClose={closeForm}
          footer={(
            <>
              <button onClick={closeForm}>Cancel</button>
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="activity-form" disabled={saving || !applicants.length}>
                {saving ? 'Saving…' : editing ? (role === 'sales' ? 'Request adjustment' : 'Save activity') : 'Schedule activity'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <form id="activity-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submitActivity}>
            <ActivityFormFields
              form={form}
              setForm={setForm}
              applicants={applicants}
              highlightApplicant={highlightApplicant}
              lockedApplicantId={editing ? null : lockedApplicantId}
              blockReason={blockReason}
              editing={editing}
              onError={setActionError}
              isAdmin={role === 'admin'}
              onJoined={joinedSession}
              onOpenMaster={openInMasterSchedule}
              onReassign={reassignSales}
            />
          </form>
        </Modal>
        </div>,
        document.body,
      )}

      {completing && createPortal(
        <div className="activities-page [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.data-panel]:rounded-[var(--act-radius-panel)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] later-4:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-5:[&>:empty]:hidden! [&_.data-panel]:m-0 [&_.duration-presets]:flex [&_.duration-presets]:flex-wrap [&_.duration-presets]:gap-2 [&_.duration-preset]:inline-flex [&_.duration-preset]:items-center [&_.duration-preset]:gap-[6px] [&_.duration-preset]:p-[7px_14px] [&_.duration-preset]:rounded-[var(--act-radius-cell)] [&_.duration-preset]:[border:1px_solid_var(--act-line)] [&_.duration-preset]:[background:transparent] [&_.duration-preset]:text-[color:inherit] [&_.duration-preset]:text-[13px] [&_.duration-preset]:font-[600] [&_.duration-preset]:cursor-pointer [&_.duration-preset]:[transition:background_0.15s_ease,_border-color_0.15s_ease] [&_.duration-preset:hover]:border-[color:var(--act-accent)] [&_.duration-preset.active]:[background:rgba(123,_136,_255,_0.16)] [&_.duration-preset.active]:border-[color:var(--act-accent)] [&_.duration-preset.active]:text-[color:var(--accent,_#aeb6ff)] max-[721px]:later:[--act-pad:16px] [&_tr.is-archived]:opacity-[0.88] [&_tr.is-archived:hover]:opacity-[1] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]! activities-modal-root contents [&_.danger-button]:[background:#dc2626] [&_.danger-button]:border-[#b91c1c] [&_.danger-button]:text-[#fff] [&_.danger-button:hover:not(:disabled)]:[filter:brightness(1.08)]">
        <Modal
          title={`Complete “${activityLabel(completing)}”`}
          onClose={() => { setCompleting(null); setCompleteForm(null); }}
          size="small"
          footer={(
            <>
              <button onClick={() => setCompleting(null)}>Cancel</button>
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="complete-activity-form" disabled={saving}>
                {saving ? 'Saving…' : completeForm?.attended === 'no' ? 'Mark No Show' : 'Submit for Admin review'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          {completeForm && (
          <form id="complete-activity-form" onSubmit={completeActivity} className="grid gap-[12px] [&_label]:text-[14px]">
            <p className="m-0 text-[14px] text-muted">Scheduled start: {manilaDateTimeLabel(completing.starts_at)}</p>
            <Field label="Did the applicant attend?" full required>
              <select value={completeForm.attended} onChange={(e) => setCompleteForm({ ...completeForm, attended: e.target.value })}>
                <option value="yes">Yes, the applicant attended</option>
                <option value="no">No — mark as No Show</option>
              </select>
            </Field>
            {completeForm.attended === 'yes' ? (
              <>
                <Field label="Actual date and time" full required hint="Not before the scheduled start and not in the future.">
                  <input
                    type="datetime-local"
                    required
                    value={completeForm.actual_started_at}
                    min={toManilaInput(completing.starts_at)}
                    max={toManilaInput(nowMs)}
                    onChange={(e) => setCompleteForm({ ...completeForm, actual_started_at: e.target.value })}
                  />
                </Field>
                <Field label="Handled by" full required>
                  <input required value={completeForm.handler_name} onChange={(e) => setCompleteForm({ ...completeForm, handler_name: e.target.value })} placeholder="Who ran the activity" />
                </Field>
                <Field label="Notes" full required hint="At least 10 characters: attendance, feedback, next steps.">
                  <textarea required minLength="10" value={completeForm.result_notes} onChange={(e) => setCompleteForm({ ...completeForm, result_notes: e.target.value })} placeholder="What happened during the activity." />
                </Field>
                {completing.activity_type === 'orientation' ? (
                  <>
                    <RequirementFileDrop
                      label="Attendance proof (1–10 files)"
                      required
                      multiple
                      replaceable
                      max={10}
                      accept={PROOF_ACCEPT}
                      validate={proofProblem}
                      hint="Sign-in sheet or photos of the session. PDF, JPG or PNG, up to 10 MB each."
                      files={completeForm.attendance}
                      onChange={(files) => setCompleteForm((f) => ({ ...f, attendance: files }))}
                      saved={completeForm.saved.filter((doc) => doc.type === 'attendance_proof')}
                      onSavedChange={(kept) => setCompleteForm((f) => ({ ...f, saved: [...f.saved.filter((doc) => doc.type !== 'attendance_proof'), ...kept] }))}
                    />
                    <RequirementFileDrop
                      label="Brand selection document (1–2 files)"
                      required
                      multiple
                      replaceable
                      max={2}
                      accept={PROOF_ACCEPT}
                      validate={proofProblem}
                      hint="The signed brand selection form. PDF, JPG or PNG, up to 10 MB each."
                      files={completeForm.brand_docs}
                      onChange={(files) => setCompleteForm((f) => ({ ...f, brand_docs: files }))}
                      saved={completeForm.saved.filter((doc) => doc.type === 'brand_selection')}
                      onSavedChange={(kept) => setCompleteForm((f) => ({ ...f, saved: [...f.saved.filter((doc) => doc.type !== 'brand_selection'), ...kept] }))}
                    />
                    <Field label="Selected brand" full required hint="Admin sets the applicant's brand to this one when verifying.">
                      <select required value={completeForm.selected_brand_id} onChange={(e) => setCompleteForm({ ...completeForm, selected_brand_id: e.target.value })}>
                        <option value="">Choose the brand…</option>
                        {(remote.data?.brands || []).map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
                      </select>
                    </Field>
                  </>
                ) : (
                  <Field label="Attendance proof" full required hint="Sign-in sheet or photo (PDF, JPG or PNG).">
                    <input type="file" required accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setCompleteForm({ ...completeForm, proof: e.target.files?.[0] || null })} />
                  </Field>
                )}
              </>
            ) : (
              <Field label="No Show reason" full required hint="At least 5 characters. Use Set Again afterwards to reschedule this activity.">
                <textarea required minLength="5" value={completeForm.no_show_reason} onChange={(e) => setCompleteForm({ ...completeForm, no_show_reason: e.target.value })} placeholder="Why the applicant did not attend." />
              </Field>
            )}
          </form>
          )}
        </Modal>
        </div>,
        document.body,
      )}

      {archiving && createPortal(
        <div className="activities-page [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.data-panel]:rounded-[var(--act-radius-panel)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] later-4:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-5:[&>:empty]:hidden! [&_.data-panel]:m-0 [&_.duration-presets]:flex [&_.duration-presets]:flex-wrap [&_.duration-presets]:gap-2 [&_.duration-preset]:inline-flex [&_.duration-preset]:items-center [&_.duration-preset]:gap-[6px] [&_.duration-preset]:p-[7px_14px] [&_.duration-preset]:rounded-[var(--act-radius-cell)] [&_.duration-preset]:[border:1px_solid_var(--act-line)] [&_.duration-preset]:[background:transparent] [&_.duration-preset]:text-[color:inherit] [&_.duration-preset]:text-[13px] [&_.duration-preset]:font-[600] [&_.duration-preset]:cursor-pointer [&_.duration-preset]:[transition:background_0.15s_ease,_border-color_0.15s_ease] [&_.duration-preset:hover]:border-[color:var(--act-accent)] [&_.duration-preset.active]:[background:rgba(123,_136,_255,_0.16)] [&_.duration-preset.active]:border-[color:var(--act-accent)] [&_.duration-preset.active]:text-[color:var(--accent,_#aeb6ff)] max-[721px]:later:[--act-pad:16px] [&_tr.is-archived]:opacity-[0.88] [&_tr.is-archived:hover]:opacity-[1] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]! activities-modal-root contents [&_.danger-button]:[background:#dc2626] [&_.danger-button]:border-[#b91c1c] [&_.danger-button]:text-[#fff] [&_.danger-button:hover:not(:disabled)]:[filter:brightness(1.08)]">
        <Modal
          title="Archive applicant"
          onClose={() => setArchiving(null)}
          size="small"
          footer={(
            <>
              <button onClick={() => setArchiving(null)}>Cancel</button>
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.activities-modal-root_&]:[background:#2563eb] [.activities-modal-root_&]:border-[#1d4ed8] [.activities-modal-root_&]:text-[#fff] [.activities-modal-root_&:hover:not(:disabled)]:[background:#1d4ed8]" onClick={confirmArchive} disabled={saving}>
                {saving ? 'Archiving…' : 'Archive'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <p className="[.activities-modal-root_&]:m-0 [.activities-modal-root_&]:text-[14px] [.activities-modal-root_&]:leading-[1.55]">
            Archive <strong>{archiving.person}</strong>? The applicant record will be retained in the database, but removed from active operational schedules. It can be restored from Admin Settings &gt; Archive.
          </p>
        </Modal>
        </div>,
        document.body,
      )}

      {deleting && createPortal(
        <div className="activities-page [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.data-panel]:rounded-[var(--act-radius-panel)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] later-4:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-5:[&>:empty]:hidden! [&_.data-panel]:m-0 [&_.duration-presets]:flex [&_.duration-presets]:flex-wrap [&_.duration-presets]:gap-2 [&_.duration-preset]:inline-flex [&_.duration-preset]:items-center [&_.duration-preset]:gap-[6px] [&_.duration-preset]:p-[7px_14px] [&_.duration-preset]:rounded-[var(--act-radius-cell)] [&_.duration-preset]:[border:1px_solid_var(--act-line)] [&_.duration-preset]:[background:transparent] [&_.duration-preset]:text-[color:inherit] [&_.duration-preset]:text-[13px] [&_.duration-preset]:font-[600] [&_.duration-preset]:cursor-pointer [&_.duration-preset]:[transition:background_0.15s_ease,_border-color_0.15s_ease] [&_.duration-preset:hover]:border-[color:var(--act-accent)] [&_.duration-preset.active]:[background:rgba(123,_136,_255,_0.16)] [&_.duration-preset.active]:border-[color:var(--act-accent)] [&_.duration-preset.active]:text-[color:var(--accent,_#aeb6ff)] max-[721px]:later:[--act-pad:16px] [&_tr.is-archived]:opacity-[0.88] [&_tr.is-archived:hover]:opacity-[1] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]! activities-modal-root contents [&_.danger-button]:[background:#dc2626] [&_.danger-button]:border-[#b91c1c] [&_.danger-button]:text-[#fff] [&_.danger-button:hover:not(:disabled)]:[filter:brightness(1.08)]">
        <Modal
          title="Cancel schedule"
          onClose={() => setDeleting(null)}
          size="small"
          footer={(
            <>
              <button onClick={() => setDeleting(null)}>Cancel</button>
              <button className="primary-button [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)] [.activities-modal-root_&]:[background:#dc2626] [.activities-modal-root_&]:border-[#b91c1c] [.activities-modal-root_&]:text-[#fff] [.activities-modal-root_&:hover:not(:disabled)]:[background:#b91c1c]" onClick={confirmDelete} disabled={saving}>
                {saving ? 'Cancelling…' : 'Cancel schedule'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <div className="permanent-delete-content">
            <p className="[.activities-modal-root_&]:m-0 [.activities-modal-root_&]:text-[14px] [.activities-modal-root_&]:leading-[1.55] [.activities-modal-root_&]:font-[600] [.activities-modal-root_&]:text-[color:var(--text,_#fff)]">
              Cancel the ongoing schedule for <strong>{deleting.person}</strong>?
            </p>
            <div className="[.activities-modal-root_&]:flex [.activities-modal-root_&]:gap-[10px] [.activities-modal-root_&]:items-start [.activities-modal-root_&]:mt-[14px] [.activities-modal-root_&]:p-[12px_14px] [.activities-modal-root_&]:rounded-[var(--act-radius-cell)] [.activities-modal-root_&]:[background:rgba(239,_68,_68,_0.12)] [.activities-modal-root_&]:border [.activities-modal-root_&]:border-[rgba(239,_68,_68,_0.35)] [.activities-modal-root_&]:text-[#fca5a5] [.activities-modal-root_&]:text-[13px] [.activities-modal-root_&]:leading-[1.5] later:[.activities-modal-root_&_svg]:shrink-[0] later-2:[.activities-modal-root_&_svg]:mt-[2px] later:[.activities-modal-root_&_svg]:text-[#ef4444] [.activities-modal-root_&_svg]:text-[16px]">
              <FaTriangleExclamation aria-hidden="true" />
              <span>
                Completed activities are retained. Applicants with completed activities remain scheduled; otherwise they return to Qualified.
              </span>
            </div>
          </div>
        </Modal>
        </div>,
        document.body,
      )}

      {/* Read panel: same slide-from-right behavior as Leads & inquiries.
          Rendered through a portal into <body> so `position: fixed` is measured against
          the viewport (an ancestor with transform/animation would otherwise shift it down
          by the header height a second time). `--drawer-top` = the real header's bottom
          edge, so the panel sits flush under the header: not over it, not under it.
          The wrapper keeps the .activities-page scope + --act-* tokens the drawer styles use. */}
      {createPortal(
        <div className="activities-page contents [--act-radius-panel:10px] [--act-radius-control:8px] [--act-radius-cell:6px] [--act-pad:22px] [--act-line:var(--border,_#262f45)] [--act-cell:var(--surface-subtle,_rgba(255,_255,_255,_0.03))] [--act-accent:var(--accent,_#7b88ff)] [&_.muted-note]:text-[color:var(--muted,_#8590a8)] [&_.muted-note]:text-[12px] [&_.drawer-archive-btn]:[background:rgba(59,_130,_246,_0.14)] [&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.4)] [&_.drawer-archive-btn]:text-[#60a5fa] [&_.drawer-archive-btn:hover:not(:disabled)]:[background:rgba(59,_130,_246,_0.26)] [&_.drawer-archive-btn:hover:not(:disabled)]:text-[#93c5fd] motion-reduce:[&_*]:[transition:none]!">
      <aside
        ref={drawerRef}
        className={`inquiry-drawer [--drawer-bg:#0a0e18] [--drawer-border:#1a2133] [--drawer-text:#e6e9f2] [--drawer-muted:#8590a8] [--drawer-accent:#7b88ff] [--drawer-accent-2:#38bdf8] fixed top-[var(--drawer-top,_var(--header-height,_76px))] right-0 bottom-0 z-40 w-[min(440px,_100vw)] flex flex-col [background:radial-gradient(circle_at_100%_0%,_color-mix(in_srgb,_var(--drawer-accent)_16%,_transparent),_transparent_22%),_radial-gradient(circle_at_100%_100%,_color-mix(in_srgb,_var(--drawer-accent-2)_10%,_transparent),_transparent_20%),_var(--drawer-bg)] text-[color:var(--drawer-text)] [border-left:1px_solid_var(--drawer-border)] [box-shadow:-24px_0_48px_rgba(0,_0,_0,_0.35)] [transform:translate3d(100%,_0,_0)] [visibility:hidden] [will-change:transform] [transition:transform_0.5s_cubic-bezier(0.32,_0.72,_0,_1),_visibility_0s_linear_0.5s] [&.open]:[transform:translate3d(0,_0,_0)] [&.open]:[visibility:visible] [&.open]:[transition-delay:0s] motion-reduce:later:[transition:none] ${selectedGroup ? ' open' : ''}`}
        aria-label="Applicant schedule details"
        aria-hidden={!selectedGroup}
      >
        <span className="drawer-pointer absolute -left-[15px] top-[calc(var(--pointer-y,_0px)_-_24px)] w-[16px] h-[48px] opacity-[var(--pointer-opacity,_0)] pointer-events-none [transition:opacity_0.2s_ease] [.inquiry-drawer.pointer-animate_&]:[transition:top_0.4s_cubic-bezier(0.32,_0.72,_0,_1),_opacity_0.2s_ease] [&_svg]:block [&_svg]:overflow-visible max-[521px]:hidden motion-reduce:later:[.inquiry-drawer.pointer-animate_&]:[transition:none]" aria-hidden="true">
          <svg width="16" height="48" viewBox="0 0 16 48">
            <path className="[.drawer-pointer_&]:[fill:var(--drawer-bg)]" d="M15.5 0 C15.5 10 1.5 10 1.5 24 C1.5 38 15.5 38 15.5 48 L16 48 L16 0 Z" />
            <path className="[.drawer-pointer_&]:[fill:none] [.drawer-pointer_&]:[stroke:var(--drawer-border)] [.drawer-pointer_&]:[stroke-width:1]" d="M15.5 0 C15.5 10 1.5 10 1.5 24 C1.5 38 15.5 38 15.5 48" />
          </svg>
        </span>
        {shown && (
          <>
            <header className="flex-none flex items-center gap-4 p-[24px_20px_20px_28px] [border-bottom:1px_solid_var(--drawer-border)] [background:linear-gradient(180deg,_rgba(123,_136,_255,_0.08),_transparent)] [&_h2]:m-0 later:[&_h2]:text-[1.2rem] [&_h2]:leading-[1.25] [&_h2]:[overflow-wrap:anywhere] later:[&_p]:m-[4px_0_0] later:[&_p]:text-[0.85rem] later:[&_p]:text-[color:var(--drawer-muted)] max-[521px]:later:p-[18px_14px_16px_18px] max-[521px]:later:gap-3 act-drawer-head [.activities-page_.inquiry-drawer_&]:relative [.activities-page_.inquiry-drawer_&]:items-start [.activities-page_.inquiry-drawer_&]:p-[12px_56px_16px_22px] [.activities-page_.inquiry-drawer_&_.drawer-avatar]:w-[56px] [.activities-page_.inquiry-drawer_&_.drawer-avatar]:h-[56px] later:[.activities-page_.inquiry-drawer_&_h2]:text-[22px] [.activities-page_.inquiry-drawer_&_h2]:font-[800] [.activities-page_.inquiry-drawer_&_p]:m-[4px_0_0] [.activities-page_.inquiry-drawer_&_p]:text-[color:var(--drawer-muted)] [.activities-page_.inquiry-drawer_&_p]:text-[13px] [.activities-page_.inquiry-drawer_&_.drawer-schedule-btn]:[background:var(--drawer-accent)] [.activities-page_.inquiry-drawer_&_.drawer-schedule-btn]:border-[color:var(--drawer-accent)] [.activities-page_.inquiry-drawer_&_.drawer-schedule-btn]:text-[#fff] [.activities-page_.inquiry-drawer_&_.drawer-archive-btn]:[background:transparent] [.activities-page_.inquiry-drawer_&_.drawer-archive-btn]:border-[rgba(59,_130,_246,_0.6)] [.activities-page_.inquiry-drawer_&_.drawer-archive-btn]:text-[#60a5fa]">
              <span className="drawer-avatar flex-none w-[54px] h-[54px] grid place-items-center rounded-[50%] font-[700] text-[1.05rem] text-[#d4d9ff] [background:radial-gradient(circle_at_25%_20%,_color-mix(in_srgb,_var(--drawer-accent)_45%,_transparent),_transparent_70%),_color-mix(in_srgb,_var(--drawer-accent-2)_12%,_transparent)] border border-[rgba(123,_136,_255,_0.45)] [box-shadow:0_0_0_4px_rgba(123,_136,_255,_0.08),_0_6px_18px_rgba(123,_136,_255,_0.18)]" aria-hidden="true">{initialsOf(applicantName)}</span>
              <div className="min-w-0 flex-[1_1_auto]">
                <div className="[.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:gap-[10px] [.activities-page_&]:flex-wrap">
                  <h2>{applicantName}</h2>
                  {isGroupArchived(shown) && <span className="[.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:p-[2px_7px] [.activities-page_&]:rounded-[4px] [.activities-page_&]:text-[10.5px] [.activities-page_&]:font-[750] [.activities-page_&]:uppercase [.activities-page_&]:tracking-[0.05em] [.activities-page_&]:[background:rgba(245,_158,_11,_0.15)] [.activities-page_&]:text-[#fbbf24] [.activities-page_&]:border [.activities-page_&]:border-[rgba(245,_158,_11,_0.35)]">Archived</span>}
                </div>
                <p>{shown.total} scheduled {shown.total === 1 ? 'activity' : 'activities'} · {progressDone}/{trackedTypes.length} milestones done</p>
                <div className="[.activities-page_.inquiry-drawer_.act-drawer-head_&]:mt-3 [.activities-page_&]:flex [.activities-page_&]:gap-2 [.activities-page_&]:flex-wrap [.activities-page_&]:mt-[10px]">
                  {role === 'admin' && applicantIdOfGroup(shown) && shown.applicant_status !== 'active_franchisee' && isGroupArchived(shown) && (
                    <button
                      type="button"
                      className="[.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:gap-[6px] [.activities-page_&]:p-[6px_12px] [.activities-page_&]:text-[12.5px] [.activities-page_&]:font-[650] [.activities-page_&]:rounded-[var(--act-radius-cell)] [.activities-page_&]:cursor-pointer [.activities-page_&]:[transition:all_0.15s_ease] [.activities-page_&]:border [.activities-page_&]:[background:rgba(16,_185,_129,_0.12)] later:[.activities-page_&]:border-[rgba(16,_185,_129,_0.35)] [.activities-page_&]:text-[#34d399] [.activities-page_&:hover:not(:disabled)]:[background:rgba(16,_185,_129,_0.22)] [.activities-page_&:hover:not(:disabled)]:text-[#6ee7b7]"
                      disabled={saving}
                      onClick={() => handleViewInAdminSettings(shown)}
                    >
                      View in Admin Settings
                    </button>
                  )}
                  {canDelete && !isGroupArchived(shown) && shown.applicant_status !== 'active_franchisee' && ['pending', 'confirmed'].includes(shown.current?.status) && shown.current?.approval_status !== 'rejected' && (
                    <button type="button" className="[.activities-page_&]:inline-flex [.activities-page_&]:items-center [.activities-page_&]:gap-[6px] [.activities-page_&]:p-[6px_12px] [.activities-page_&]:text-[12.5px] [.activities-page_&]:font-[650] [.activities-page_&]:rounded-[var(--act-radius-cell)] [.activities-page_&]:cursor-pointer [.activities-page_&]:[transition:all_0.15s_ease] [.activities-page_&]:border [.activities-page_.inquiry-drawer_.act-drawer-head_&]:[background:transparent] [.activities-page_.inquiry-drawer_.act-drawer-head_&]:border-[rgba(239,_68,_68,_0.6)] [.activities-page_.inquiry-drawer_.act-drawer-head_&]:text-[#f87171] [.activities-page_&]:[background:rgba(239,_68,_68,_0.12)] later:[.activities-page_&]:border-[rgba(239,_68,_68,_0.35)] [.activities-page_&]:text-[#f87171] later:[.activities-page_&:hover:not(:disabled)]:[background:rgba(239,_68,_68,_0.22)] later:[.activities-page_&:hover:not(:disabled)]:text-[#fca5a5] [.activities-page_&:disabled]:opacity-[0.35] [.activities-page_&:disabled]:cursor-not-allowed [.activities-page_&.is-disabled]:opacity-[0.35] [.activities-page_&.is-disabled]:cursor-not-allowed" disabled={saving} onClick={() => { setActionError(''); setDeleting(shown); }}>
                      Cancel Schedule
                    </button>
                  )}
                </div>
              </div>
              <button type="button" className="drawer-toggle [.activities-page_.inquiry-drawer_&]:absolute [.activities-page_.inquiry-drawer_&]:top-[14px] [.activities-page_.inquiry-drawer_&]:right-[14px] [.activities-page_.inquiry-drawer_&]:left-auto [.activities-page_.inquiry-drawer_&]:z-2 flex-none w-[34px] h-[34px] grid place-items-center p-0 rounded-[8px] [border:1px_solid_var(--drawer-border)] [background:transparent] text-[color:var(--drawer-muted)] cursor-pointer [transition:color_0.2s_ease,_border-color_0.2s_ease,_background-color_0.2s_ease] [&_svg]:m-0 hover:text-[color:var(--drawer-text)] hover:border-[color:var(--drawer-accent)] hover:[background:rgba(123,_136,_255,_0.08)] focus-visible:[outline:2px_solid_var(--drawer-accent)] focus-visible:[outline-offset:2px]" onClick={closeDetails} aria-label="Close details" title="Close (Esc)">
                <FaXmark aria-hidden="true" />
              </button>
            </header>
            <div className="drawer-body flex-[1_1_auto] min-h-0 overflow-y-auto [overscroll-behavior:contain] p-[8px_28px_32px] [&_section]:p-[20px_0_6px] [&_section+section]:[border-top:1px_solid_var(--drawer-border)] [&_h3]:m-[0_0_14px] [&_h3]:text-[0.74rem] [&_h3]:font-[700] [&_h3]:tracking-[0.09em] [&_h3]:uppercase [&_h3]:text-[color:var(--drawer-muted)] [&_dl]:m-0 max-[521px]:later:pl-[18px] max-[521px]:later:pr-[18px]">
              <section>
                <h3>Schedule progress</h3>
                <ProgressBar percent={Math.round((progressDone / trackedTypes.length) * 100)} state={progressDone === trackedTypes.length ? 'complete' : 'in_progress'} label="Activity milestones" detail={`${progressDone}/${trackedTypes.length}`} />
                <ul className="drawer-progress-list [.activities-page_&]:[list-style:none] [.activities-page_&]:m-[12px_0_0] [.activities-page_&]:p-0 [.activities-page_&]:flex [.activities-page_&]:flex-col [.activities-page_&]:gap-[10px] later:[.activities-page_&_li]:flex [.activities-page_&_li]:items-center later:[.activities-page_&_li]:gap-[10px] [.activities-page_&_li_span:last-child]:flex [.activities-page_&_li_span:last-child]:flex-col [.activities-page_&_li_span:last-child]:min-w-0 later:[.activities-page_&_small]:text-[color:var(--drawer-muted,_#8590a8)] [.activities-page_&_li.is-done_strong]:text-[#22c55e]">
                  {progress.map((item) => (
                    <li key={item.type} className={item.done ? 'is-done' : ''}>
                      <span className="[.activities-page_&]:inline-grid [.activities-page_&]:place-items-center [.activities-page_&]:w-[28px] [.activities-page_&]:h-[28px] [.activities-page_&]:rounded-[50%] [.activities-page_&]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.activities-page_&]:text-[12px] [.activities-page_&]:shrink-[0] [.activities-page_.drawer-progress-list_li.is-done_&]:[background:rgba(34,_197,_94,_0.15)] [.activities-page_.drawer-progress-list_li.is-done_&]:border-[rgba(34,_197,_94,_0.4)] [.activities-page_.drawer-progress-list_li.is-done_&]:text-[#22c55e]">{item.done ? <FaCheck aria-hidden="true" /> : <FaCalendarDays aria-hidden="true" />}</span>
                      <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>All activities</h3>
                <ul className="[.activities-page_&]:[list-style:none] [.activities-page_&]:m-0 [.activities-page_&]:p-0 [.activities-page_&]:flex [.activities-page_&]:flex-col [.activities-page_&]:gap-[10px] [.activities-page_&_li]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.activities-page_&_li]:rounded-[var(--act-radius-cell)] [.activities-page_&_li]:p-[10px_12px] later:[.activities-page_&_li]:flex [.activities-page_&_li]:flex-col later-2:[.activities-page_&_li]:gap-1 later:[.activities-page_&_small]:text-[color:var(--drawer-muted,_#8590a8)] later-2:[.activities-page_&_p]:m-[4px_0_0] later-2:[.activities-page_&_p]:text-[12px] later:[.activities-page_&_p]:text-[color:var(--drawer-muted,_#8590a8)]">
                  {pagedActivities.map((activity) => (
                    <li key={activity.id}>
                      <div className="[.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between [.activities-page_&]:gap-2">
                        <strong>{activityLabel(activity)}</strong>
                        <StatusBadge value={activity.approval_status === 'rejected' ? 'Rejected' : activity.is_missed || activity.status === 'no_show' ? 'Did Not Attended' : activity.status === 'cancelled' ? 'Cancelled' : activity.status === 'completed' ? 'Completed' : activity.status} />
                      </div>
                      <small>{formatDate(activity.starts_at, true)} · {formatDuration(activity.duration_minutes)}{activity.venue ? ` · ${activity.venue}` : ''}</small>
                      {activity.result_notes && <p>{activity.result_notes}</p>}
                      {activity.status === 'no_show' && activity.no_show_reason && <p>No Show: {activity.no_show_reason}</p>}
                      {activity.completed_before_schedule && (
                        <span className="inline-flex w-fit p-[2px_8px] rounded-[999px] border border-[rgba(251,_191,_36,_0.45)] text-[#fbbf24] text-[11px] font-[700]">Completed before schedule (legacy)</span>
                      )}
                      {activity.review_status === 'submitted' && <small>Waiting for Admin to review the proof</small>}
                      {activity.review_status === 'returned' && <ClampedNote label="Returned by Admin: " text={activity.return_reason} />}
                      {role === 'admin' && ['pending', 'confirmed'].includes(activity.status) && activity.approval_status !== 'rejected' && <div className="row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative">
                        <button type="button" onClick={() => openEdit(activity)}>Adjust</button>
                        <button type="button" onClick={() => setDeleting({ ...shown, current: activity })}>Cancel schedule</button>
                      </div>}
                      {role === 'sales' && ['pending', 'confirmed'].includes(activity.status) && activity.approval_status !== 'rejected' && <button type="button" className="inline-flex items-center justify-center gap-[6px] h-[32px] px-[12px] mt-[8px] rounded-[10px] border border-[#394259] [background:transparent] text-[#d5dbec] text-[12px] font-[600] cursor-pointer hover:border-[#7b88ff] hover:text-[#fff]" onClick={() => openEdit(activity)}><FaPen aria-hidden="true" /> Adjust</button>}
                    </li>
                  ))}
                </ul>
                {drawerActivities.length > PAGE_SIZE && (
                  <SlidingPagination meta={activityMeta} onPage={setActivityPage} />
                )}
              </section>
              <section>
                <h3>Attendees</h3>
                <div className="[.activities-page_&]:flex [.activities-page_&]:items-start [.activities-page_&]:gap-[10px] [.activities-page_&]:text-[13px] later:[.activities-page_&_svg]:mt-[3px] [.activities-page_&_svg]:text-[color:var(--drawer-muted,_#8590a8)]">
                  <FaUsers aria-hidden="true" />
                  <span>{[...new Set(shown.activities.flatMap((activity) => {
                    const names = [...(activity.participants || [])];
                    if (activity.assigned_to?.full_name) names.push(activity.assigned_to.full_name);
                    return names;
                  }))].join(', ') || 'Applicant only'}</span>
                </div>
              </section>
            </div>
          </>
        )}
      </aside>
        </div>,
        document.body,
      )}

      {view === 'table' && (
        <p className="muted-note text-muted text-[8px] leading-[1.6] [.activities-page_&]:mt-[14px]">
          <FaUsers aria-hidden="true" /> {TABLE_FOOTER}
        </p>
      )}
    </div>
  );
}

function diffMinutes(activity) {
  const start = new Date(activity.starts_at).getTime();
  const end = new Date(activity.ends_at).getTime();
  const minutes = Math.round((end - start) / 60000);
  return minutes > 0 ? minutes : 60;
}

function toDateInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
