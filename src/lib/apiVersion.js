// Compares the live API with the API code this frontend was built against. Both sides carry the git
// tree hash of supabase/functions/api, so a frontend-only commit never shows a warning.

export const NOTE_DISMISS_KEY = 'ft.apiVersionNote.dismissed';

/**
 * @param {string|null} appTree  the api tree hash embedded in this build (null = unknown, e.g. no git)
 * @param {object|null} health   GET /health from the live API
 * @returns {{ state: 'match'|'mismatch'|'unknown'|'unchecked', severity: 'warning'|'note'|null, message: string|null }}
 *   mismatch -> a strong warning (the live API code differs);
 *   unknown  -> a soft, dismissible note (the live API carries no deploy stamp, so it cannot be compared).
 */
export function compareApi(appTree, health) {
  if (!appTree || !health) return { state: 'unchecked', severity: null, message: null };
  if (!health.api_tree) {
    return {
      state: 'unknown',
      severity: 'note',
      message: 'The live API was deployed without npm run deploy:api, so its version cannot be checked.',
    };
  }
  if (health.api_tree === appTree) return { state: 'match', severity: null, message: null };
  const live = health.commit ? health.commit.slice(0, 7) : 'unknown';
  return {
    state: 'mismatch',
    severity: 'warning',
    message: `Live API is older than this app — tell the team. (Live API ${live}, this app expects API code ${appTree.slice(0, 7)}.)`,
  };
}

/** The note is dismissed per browser; the strong warning can never be dismissed. */
export function noteDismissed(storage) {
  try { return storage?.getItem(NOTE_DISMISS_KEY) === '1'; } catch { return false; }
}
export function dismissNote(storage) {
  try { storage?.setItem(NOTE_DISMISS_KEY, '1'); } catch { /* private mode: dismissed for this page only */ }
}
