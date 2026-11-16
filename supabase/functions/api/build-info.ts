// What code this function was deployed from. `npm run deploy:api` (tools/deploy-api.mjs) overwrites
// this file in its temporary deploy copy with the real values; the committed file keeps nulls, so a
// deploy made any other way reports null and the app's version banner flags it.
//   commit   - the git commit deployed
//   api_tree - the git tree hash of supabase/functions/api at that commit (the frontend build embeds
//              the same hash, so only a real API code difference shows the banner)
export const BUILD: { commit: string | null; api_tree: string | null; deployed_at: string | null } = {
  commit: null,
  api_tree: null,
  deployed_at: null,
};
