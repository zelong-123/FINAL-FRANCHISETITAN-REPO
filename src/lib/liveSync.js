// Reloads a shared page when another user changes its data (was backend/public/live-sync.js).
// Waits while a dialog is open, so nobody loses what they are typing.
import { api, authToken } from './api';

const AREAS = {
  inventory: 'inventory_version',
  'supply-requests': 'supply_request_version',
  applicants: 'applicant_version',
  activities: 'activity_version',
};

function showBadge() {
  if (document.getElementById('herald-live-update')) return;
  const badge = document.createElement('div');
  badge.id = 'herald-live-update';
  badge.className = 'fixed right-[18px] bottom-[18px] z-[99999] rounded-full bg-[#147a4a] px-3.5 py-[11px] text-[13px] font-bold text-white shadow-[0_12px_30px_rgba(0,0,0,.22)]';
  badge.textContent = 'New shared data received · refreshing';
  document.body.appendChild(badge);
}

export function startLiveSync() {
  let baseline = null;
  let pendingReload = false;
  let running = false;

  const versionKey = () => AREAS[window.location.pathname.replace(/\/+$/, '').split('/').pop()];

  async function check() {
    const key = versionKey();
    if (!key || !authToken.latest() || running || document.visibilityState !== 'visible') return;
    running = true;
    try {
      const { data } = await api.get('/sync-status', undefined, { timeout: 10000 });
      if (baseline && String(data[key] ?? '') !== String(baseline[key] ?? '')) pendingReload = true;
      baseline = data;
      if (pendingReload && !document.querySelector('[role="dialog"], .modal-backdrop, .modal-overlay')) {
        showBadge();
        window.setTimeout(() => window.location.reload(), 350);
      }
    } catch {
      // The page's own requests surface server errors when the user acts.
    } finally {
      running = false;
    }
  }

  window.setInterval(check, 2500);
  window.addEventListener('focus', check);
  window.addEventListener('popstate', () => { baseline = null; pendingReload = false; });
}
