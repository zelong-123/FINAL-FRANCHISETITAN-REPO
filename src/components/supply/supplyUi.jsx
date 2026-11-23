// Shared look for the Supply Requests page, drawer and modals: the app theme's own tokens and
// the same button and card classes the rest of the app uses.
import React from 'react';
import {
  FaArrowRotateLeft, FaBan, FaBoxOpen, FaBoxesPacking, FaCalendarCheck, FaCircleCheck, FaCircleXmark, FaClock,
  FaHourglassHalf, FaMagnifyingGlass, FaPaperPlane, FaPause, FaTriangleExclamation, FaTruckFast,
} from 'react-icons/fa6';
import { supplyStatusLabel } from '../../lib/supplyStatus';
import { isFinished, STAGES, stageIndex, URGENCY_TONE, urgencyLabel } from './supplyStyles';


const TONES = {
  neutral: 'text-text-secondary border-line [background:var(--surface-subtle)]',
  accent: 'text-accent-text [border-color:color-mix(in_srgb,_var(--accent)_40%,_transparent)] [background:color-mix(in_srgb,_var(--accent)_12%,_transparent)]',
  danger: 'text-danger-text [border-color:color-mix(in_srgb,_var(--danger)_40%,_transparent)] [background:color-mix(in_srgb,_var(--danger)_11%,_transparent)]',
  warning: 'text-[color:var(--warning-text)] [border-color:color-mix(in_srgb,_var(--warning)_40%,_transparent)] [background:color-mix(in_srgb,_var(--warning)_11%,_transparent)]',
  success: 'text-success-text [border-color:color-mix(in_srgb,_var(--success)_40%,_transparent)] [background:color-mix(in_srgb,_var(--success)_11%,_transparent)]',
};
export function Chip({ tone = 'neutral', children, title, borderless = false }) {
  return <span title={title} className={`inline-flex items-center gap-[5px] min-h-[22px] p-[2px_9px] ${borderless ? '' : 'border'} rounded-[999px] text-[11px] font-[720] whitespace-nowrap ${TONES[tone] || TONES.neutral}`}>{children}</span>;
}

export function UrgencyChip({ urgency }) {
  return <Chip tone={URGENCY_TONE[urgency] || 'neutral'}>{urgencyLabel(urgency)}</Chip>;
}

const STATUS_TONE = {
  returned: 'warning', on_hold: 'warning', discrepancy_review: 'danger', rejected: 'danger', cancelled: 'neutral',
  completed: 'success', completed_with_discrepancy: 'warning', dispatched: 'accent', delivered: 'accent',
};
/** One icon per stage, so the drawer's plain status reads at a glance; Preparing and Dispatched also move. */
const STATUS_ICON = {
  draft: FaHourglassHalf, submitted: FaPaperPlane, under_review: FaMagnifyingGlass, waiting_logistics: FaClock,
  scheduled: FaCalendarCheck, preparing: FaBoxesPacking, dispatched: FaTruckFast, delivered: FaBoxOpen,
  completed: FaCircleCheck, completed_with_discrepancy: FaCircleCheck, returned: FaArrowRotateLeft,
  on_hold: FaPause, discrepancy_review: FaTriangleExclamation, rejected: FaBan, cancelled: FaCircleXmark,
};
const STATUS_MOTION = { preparing: 'supply-status-icon-work', dispatched: 'supply-status-icon-roll' };
const TONE_TEXT = {
  neutral: 'text-text-secondary', accent: 'text-accent-text', danger: 'text-danger-text',
  warning: 'text-[color:var(--warning-text)]', success: 'text-success-text',
};
/** `plain` drops the chip border and fill (status + icon in its tone colour only), used in the drawer header. */
export function StatusChip({ status, plain = false }) {
  const tone = status === 'returned' ? 'warning' : (STATUS_TONE[status] || 'accent');
  const label = status === 'returned' ? 'Returned – waiting for branch' : supplyStatusLabel(status);
  if (!plain) return <Chip tone={tone} borderless={status === 'returned'}>{label}</Chip>;
  const Icon = STATUS_ICON[status] || FaCircleCheck;
  return (
    <span className={`inline-flex items-center gap-[7px] text-[14.5px] font-[720] [&>svg]:shrink-0 [&>svg]:text-[16px] ${TONE_TEXT[tone] || TONE_TEXT.neutral}`}>
      <Icon aria-hidden="true" className={STATUS_MOTION[status] || ''} />
      {label}
    </span>
  );
}


export function Stepper({ status, wide = false }) {
  const current = stageIndex(status);
  const done = isFinished(status);
  const stopped = ['rejected', 'cancelled'].includes(status);
  return (
    <div className={`flex gap-[3px] ${wide ? 'w-full' : ''}`} aria-label={`Stage ${current + 1} of ${STAGES.length}`}>
      {STAGES.map(([key, label], index) => {
        const state = done || index < current ? 'done' : index === current ? (stopped ? 'stopped' : 'current') : 'todo';
        const color = {
          done: '[background:var(--accent)]',
          current: '[background:var(--surface-strong)]',
          stopped: '[background:var(--danger)]',
          todo: '[background:var(--surface-strong)]',
        }[state];
        const live = state === 'current' ? 'supply-stepper-live' : '';
        return <i key={key} title={label} className={`block h-[5px] rounded-[3px] ${wide ? 'flex-1' : 'w-[15px]'} ${color} ${live}`} />;
      })}
    </div>
  );
}

export function Section({ title, children, aside }) {
  return (
    <section className="mt-[20px]">
      <div className="flex items-center justify-between gap-2 mb-[8px]">
        <h3 className="m-0 flex items-center gap-[8px] text-text text-[10.5px] font-[800] tracking-[.14em] uppercase before:[content:''] before:block before:w-[3px] before:h-[13px] before:rounded-[2px] before:[background:var(--accent)]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function KV({ items }) {
  return (
    <div className="grid grid-cols-2 gap-x-[24px] max-[520px]:grid-cols-1">
      {items.filter(Boolean).map(([label, value]) => (
        <div key={label} className="min-w-0 py-[10px] border-t border-line">
          <small className="block text-muted text-[13px]">{label}</small>
          <div className="mt-[2px] text-text text-[15px] font-[500] [overflow-wrap:anywhere]">{value ?? '—'}</div>
        </div>
      ))}
    </div>
  );
}

export function Callout({ tone = 'warning', children }) {
  const style = tone === 'danger'
    ? 'text-danger-text [border-color:color-mix(in_srgb,_var(--danger)_40%,_transparent)] [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)]'
    : tone === 'info'
      ? 'text-text-secondary border-line [background:var(--surface-subtle)]'
      : 'text-[color:var(--warning-text)] [border-color:color-mix(in_srgb,_var(--warning)_40%,_transparent)] [background:color-mix(in_srgb,_var(--warning)_9%,_transparent)]';
  return <div className={`mt-[12px] p-[10px_12px] border rounded-[11px] text-[12.5px] leading-[1.5] [&_b]:font-[750] ${style}`}>{children}</div>;
}


