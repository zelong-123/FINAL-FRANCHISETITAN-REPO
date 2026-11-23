// What the New Request list says about a line's suggested quantity. The API sends
// suggested_quantity as a number (0 when current stock covers the 7-day requirement) or as
// null when it has no usable estimate (no usage history, or a raw material linked in another
// unit). null must never read as "already covered": that would tell the branch it is
// over-requesting when nothing was actually compared.

import { formatNumber } from './format.js';

function unavailable() {
  return {
    tone: 'neutral',
    text: 'Estimate unavailable',
    detail: 'No 7-day estimate for this item yet, so this quantity is not compared with a requirement.',
  };
}

/**
 * The notice for one request line, or null when there is nothing to say.
 * - no usable estimate → neutral "Estimate unavailable"
 * - suggestion 0 and flagged → warning "No additional quantity recommended"
 * - above the threshold → warning "More than N% above the suggestion"
 * - within the threshold → null
 */
export function estimateNotice(info, percent = 50) {
  if (!info) return null;
  const raw = info.suggested_quantity;
  if (raw === null || raw === undefined || raw === '') return unavailable();
  const suggested = Number(raw);
  if (!Number.isFinite(suggested)) return unavailable();
  if (!info.over_bulk) return null;
  if (suggested <= 0) {
    return {
      tone: 'warning',
      text: 'No additional quantity recommended',
      detail: 'Current stock already covers the estimated 7-day requirement. Additional requests require justification.',
    };
  }
  const unit = info.unit ? ` ${info.unit}` : '';
  return { tone: 'warning', text: `More than ${percent}% above the suggestion`, detail: `Suggested ${formatNumber(suggested)}${unit} for 1 week.` };
}
