// Compares the live API with the API code this frontend was built against. Both sides carry the git
// tree hash of supabase/functions/api, so a frontend-only commit never shows a warning.

/**
 * @param {string|null} appTree  the api tree hash embedded in this build (null = unknown, e.g. no git)
 * @param {object|null} health   GET /health from the live API
 * @returns {{ state: 'match'|'mismatch'|'unknown'|'unchecked', message: string|null }}
 */
export function compareApi(appTree, health) {
  if (!appTree || !health) return { state: 'unchecked', message: null };
  if (!health.api_tree) {
    return {
      state: 'unknown',
      message: 'Live API was deployed without npm run deploy:api — it may be older than this app. Tell the team.',
    };
  }
  if (health.api_tree === appTree) return { state: 'match', message: null };
  const live = health.commit ? health.commit.slice(0, 7) : 'unknown';
  return {
    state: 'mismatch',
    message: `Live API is older than this app — tell the team. (Live API ${live}, this app expects API code ${appTree.slice(0, 7)}.)`,
  };
}
