/*
 * Master Schedule — display rules shared by the calendar, the session detail
 * and the schedule form. The backend (ScheduleConflictService) decides every
 * rule; nothing here blocks a save on its own except obvious missing fields.
 */

export const ACTIVITY_TYPES = [
  { value: 'orientation', label: 'Orientation' },
  { value: 'product_tasting', label: 'Product Tasting' },
  { value: 'training', label: 'Training' },
];

/** Activities whose brand must match every participant's brand preference. */
export const BRANDED_TYPES = ['product_tasting', 'training'];

/** Mirrors config/franchise.php schedule.default_duration_minutes (editable per session). */
export const DEFAULT_DURATION_MINUTES = { orientation: 120, product_tasting: 120, training: 180 };

export const SESSION_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'merged', label: 'Merged' },
];

/** Pending yellow · Confirmed green · Completed blue · Cancelled (and closed) grey. */
export const STATUS_COLORS = {
  pending: '#f4b84a',
  confirmed: '#32c997',
  completed: '#54a8ff',
  cancelled: '#6b7488',
  rescheduled: '#6b7488',
  merged: '#6b7488',
};

export const VENUE_OPTIONS = ['Main Office (In-person)', 'Virtual'];

export const NO_BRAND_PREFERENCE = 'Itakda muna ang brand preference ng applicant.';

export const activityLabel = (value) => ACTIVITY_TYPES.find((item) => item.value === value)?.label || value;
export const statusLabel = (value) => SESSION_STATUSES.find((item) => item.value === value)?.label || value;

const TZ = 'Asia/Manila';

/** "YYYY-MM-DD" + "HH:mm" (Manila) → ISO string with the +08:00 offset. */
export function manilaIso(date, time) {
  if (!date || !time) return '';
  return `${date}T${time.length === 5 ? `${time}:00` : time}+08:00`;
}

/** ISO → { date: "YYYY-MM-DD", time: "HH:mm" } in Manila time. */
export function splitManila(iso) {
  if (!iso) return { date: '', time: '' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "HH:mm" + minutes → "HH:mm" (same day; the API rejects anything past closing). */
export function addMinutes(time, minutes) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + Number(minutes || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

/** "Nov 16, 1:00–3:00 PM" in Manila time. */
export function formatSessionRange(startIso, endIso) {
  if (!startIso) return '—';
  const day = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(startIso));
  const time = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time.format(new Date(startIso))}–${endIso ? time.format(new Date(endIso)) : ''}`;
}

/**
 * Brand problems for the chosen applicants (form-side mirror of rule H6 so the
 * user sees WHO is the problem before the evaluate call comes back).
 *
 * @returns {{ missing: object[], mismatched: object[], commonBrandId: number|null }}
 */
export function brandCheck(activityType, brandId, applicants) {
  if (!BRANDED_TYPES.includes(activityType)) return { missing: [], mismatched: [], commonBrandId: null };
  const missing = applicants.filter((a) => !a.preferred_brand_id);
  const brands = [...new Set(applicants.map((a) => a.preferred_brand_id).filter(Boolean))];
  const target = brandId ? Number(brandId) : (brands.length === 1 ? brands[0] : null);
  const mismatched = target ? applicants.filter((a) => a.preferred_brand_id && a.preferred_brand_id !== target) : (brands.length > 1 ? applicants.filter((a) => a.preferred_brand_id) : []);
  return { missing, mismatched, commonBrandId: brands.length === 1 ? brands[0] : null };
}

/** The request body shared by evaluate and save. */
export function sessionPayload(form) {
  return {
    activity_type: form.activity_type,
    brand_id: BRANDED_TYPES.includes(form.activity_type) && form.brand_id ? Number(form.brand_id) : null,
    start_at: manilaIso(form.date, form.start),
    end_at: manilaIso(form.date, form.end),
    handler_id: form.handler_id ? Number(form.handler_id) : null,
    venue: form.venue || null,
    max_capacity: form.max_capacity ? Number(form.max_capacity) : null,
  };
}

/**
 * True while the scheduled DAY (Asia/Manila) has not arrived yet. Completing
 * then needs an explicit confirmation (the API requires confirm_early = true).
 * On the day itself or later: false, no extra confirmation.
 */
export function isBeforeScheduledDay(startsAt, now = new Date()) {
  if (!startsAt) return false;
  const scheduled = splitManila(startsAt).date;
  const today = splitManila(now.toISOString()).date;
  return Boolean(scheduled && today) && today < scheduled;
}

export const EARLY_COMPLETE_MESSAGE = 'Hindi pa dumarating ang araw ng scheduled activity. Gusto mo pa rin ba itong i-mark as complete?';
export const EARLY_COMPLETE_TASTING_NOTE = 'Mala-lock din nito ang brand preference ng applicant.';
