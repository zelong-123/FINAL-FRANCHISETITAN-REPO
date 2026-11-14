// Class names and small helpers shared by the Supply Requests page, drawer and modals (the app theme's tokens).

export const BTN_PRIMARY = "primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[11px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_10px_24px_color-mix(in_srgb,_var(--accent)_18%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-1px)] disabled:opacity-[.45] disabled:cursor-not-allowed disabled:[box-shadow:none]";

export const BTN_GHOST = 'ghost-button min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-line-strong rounded-[11px] text-text-secondary [background:transparent] text-[12px] font-[680] cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:border-accent [&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] disabled:opacity-[.45] disabled:cursor-not-allowed';

export const BTN_DANGER = 'min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border rounded-[11px] [border-color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] text-danger-text [background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] text-[12px] font-[700] cursor-pointer hover:[background:color-mix(in_srgb,_var(--danger)_16%,_transparent)] disabled:opacity-[.45] disabled:cursor-not-allowed';

export const BTN_SMALL = '!min-h-[32px] !p-[0_11px] !text-[11.5px]';

export const PANEL = 'border border-line rounded-[18px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)]';

export const INPUT = 'min-h-[40px] w-full p-[8px_11px] border border-input-line rounded-[11px] [outline:none] text-text [background:var(--input-bg)] text-[13px] [transition:border-color_.16s_ease] focus:border-accent';
/** Same look, sized to its content: for one-line toolbars. */
export const TOOL = 'min-h-[40px] p-[8px_11px] border border-input-line rounded-[11px] [outline:none] text-text [background:var(--input-bg)] text-[13px] [transition:border-color_.16s_ease] focus:border-accent';

export const LABEL = 'block mb-[5px] text-text-secondary text-[11.5px] font-[700]';

export const URGENCY_TONE = { critical: 'danger', urgent: 'warning', normal: 'neutral' };

export const urgencyLabel = (u) => ({ critical: 'Critical', urgent: 'Urgent', normal: 'Normal' }[u] || 'Normal');

/** The eight main stages; side statuses sit on the stage they interrupt. */
export const STAGES = [
  ['submitted', 'Submitted'], ['under_review', 'Admin review'], ['waiting_logistics', 'Logistics confirm'], ['scheduled', 'Scheduled'],
  ['preparing', 'Preparing'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['completed', 'Completed'],
];
const SIDE_STAGE = { draft: 0, returned: 1, on_hold: 2, discrepancy_review: 6, completed_with_discrepancy: 7, rejected: 1, cancelled: 1 };
export function stageIndex(status) {
  const main = STAGES.findIndex(([key]) => key === status);
  return main >= 0 ? main : (SIDE_STAGE[status] ?? 0);
}
export const isFinished = (status) => ['completed', 'completed_with_discrepancy'].includes(status);

/** "Waiting: Admin / Logistics / Branch" from the API's owners list. */
export function waitingText(owners = []) {
  if (!owners.length) return 'Closed';
  return `Waiting: ${owners.map((o) => ({ admin: 'Admin', logistics: 'Logistics', branch: 'Branch' }[o] || o)).join(' / ')}`;
}

export const qty = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

/** "Branch · City", without repeating a city the branch name already contains. */
export function branchLabel(location) {
  const name = String(location?.name || '').trim();
  const city = String(location?.city || '').trim();
  if (!name) return city || '—';
  if (!city) return name;
  const fold = (v) => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return fold(name).includes(fold(city)) ? name : `${name} · ${city}`;
}
