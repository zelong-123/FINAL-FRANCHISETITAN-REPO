export const titleCase = (value = '') => String(value)
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

function toDisplayDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

export function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = toDisplayDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function formatNumber(value, maximumFractionDigits = 0) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(number);
}

export function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const MANILA_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** "Nov 11, 2026, 10:30 AM" in Manila time (the same wording the API uses). */
export function manilaDateTimeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : MANILA_LABEL.format(date);
}

/** A datetime-local input value (YYYY-MM-DDTHH:mm) for the given moment, in Manila time. */
export function toManilaInput(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}

/** A datetime-local value read as Manila time, as an ISO string with the +08:00 offset. */
export const fromManilaInput = (value) => (value ? `${value}:00+08:00` : '');
