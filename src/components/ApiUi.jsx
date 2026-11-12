import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  FaCircleCheck,
  FaCircleInfo,
  FaInbox,
  FaTriangleExclamation,
  FaXmark,
} from 'react-icons/fa6';
import AppIconImg from '../assets/icon.png.png';

const noticeIcons = {
  error: FaTriangleExclamation,
  success: FaCircleCheck,
  info: FaCircleInfo,
};

export function Notice({ type = 'info', children }) {
  if (!children) return null;
  const Icon = noticeIcons[type] || FaCircleInfo;
  return (
    <div className={`flex items-start gap-[9px] m-[0_0_14px] p-[11px_13px] border border-line rounded-[12px] text-text-secondary [background:var(--surface-subtle)] text-[9px] leading-[1.55] [animation:noticeIn_.25s_ease_both] [&_svg]:flex-[0_0_auto] [&_svg]:mt-[2px] notice-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function AppLoader({ label = 'Connecting to Herald…', detail = 'Securing your workspace and synchronizing live data.' }) {
  return (
    <main className="min-h-[100vh] flex flex-col items-center justify-center gap-[22px] p-[30px] text-text [background:radial-gradient(circle_at_50%_43%,_color-mix(in_srgb,_var(--accent)_14%,_transparent),_transparent_24%),_var(--bg)] text-center [&>div:last-child]:flex [&>div:last-child]:flex-col [&>div:last-child]:gap-[7px] [&_strong]:text-[16px] [&_strong]:tracking-[-.01em] [&_span]:text-muted [&_span]:text-[11px]" role="status" aria-live="polite">
      <div className="relative w-[96px] h-[96px] grid place-items-center [&_img]:w-[56px] [&_img]:h-[56px] [&_img]:object-contain [&_img]:[animation:loaderPulse_1.8s_ease-in-out_infinite] [&_img]:[filter:drop-shadow(0_12px_25px_color-mix(in_srgb,_var(--accent)_24%,_transparent))]" aria-hidden="true">
        <span className="absolute inset-0 border border-line-strong border-t-accent border-r-accent-2 rounded-[30px] [animation:loaderOrbit_2s_linear_infinite] [&::after]:[content:''] [&::after]:absolute [&::after]:inset-[9px] [&::after]:border [&::after]:border-dashed [&::after]:border-[color:color-mix(in_srgb,_var(--accent)_30%,_transparent)] [&::after]:rounded-[23px]" />
        <img src={AppIconImg} alt="" />
      </div>
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </main>
  );
}

export function LoadingState({ label = 'Loading data…' }) {
  return (
    <div className="panel-state min-h-[210px] flex items-center justify-center gap-3 p-[26px] text-muted text-center [&>div]:flex [&>div]:flex-col [&>div]:items-start [&>div]:gap-1 [&>div]:text-left [&_strong]:text-text-secondary later:[&_strong]:text-[10px] [&_small]:text-muted [&_small]:text-[8px]" role="status" aria-live="polite">
      <span className="spinner w-[20px] h-[20px] inline-block flex-[0_0_auto] border-[2px] border-[color:color-mix(in_srgb,_var(--muted)_25%,_transparent)] border-t-accent rounded-[50%] [animation:spin_.8s_linear_infinite]" aria-hidden="true" />
      <div><strong>{label}</strong><small>Fetching the latest information</small></div>
    </div>
  );
}

export function EmptyState({ label = 'No records found.', detail = 'Try changing the filters or add a new record.' }) {
  return (
    <div className="panel-state min-h-[210px] flex items-center justify-center p-[26px] text-muted text-center flex-col later:gap-2 [&_strong]:text-text-secondary later-2:[&_strong]:text-[11px] [&_small]:max-w-[360px] [&_small]:text-muted later:[&_small]:text-[9px] [&_small]:leading-[1.5] [.branch-portal-page_&]:min-h-[180px] [.branch-portal-page_&]:m-0 [.branch-portal-page_&]:p-6 [.branch-portal-page_&]:[border:1px_dashed_color-mix(in_srgb,_var(--branch-accent)_25%,_var(--border))] [.branch-portal-page_&]:rounded-[15px] [.branch-portal-page_&]:[background:color-mix(in_srgb,_var(--branch-accent)_3%,_var(--surface-subtle))] [.branch-production-empty_&]:w-full [.branch-recent-body>&]:flex-1 later:[.branch-recent-body>&]:min-h-0 later:[.branch-recent-body>&]:border-0 later:[.branch-recent-body>&]:[background:transparent] max-[981px]:later-2:[.branch-recent-body>&]:min-h-[180px]">
      <span className="w-[48px] h-[48px] grid place-items-center mb-[3px] border border-line rounded-[16px] text-muted [background:var(--surface-subtle)] text-[18px] [.branch-portal-page_&]:text-[color:var(--branch-accent)] [.branch-portal-page_&]:border-[color:color-mix(in_srgb,_var(--branch-accent)_20%,_var(--border))] [.branch-portal-page_&]:[background:color-mix(in_srgb,_var(--branch-accent)_8%,_var(--panel))]"><FaInbox aria-hidden="true" /></span>
      <strong>{label}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function PageHeader({ actions }) {
  // Page titles now live in the breadcrumb header, so only actions are rendered here.
  if (!actions) return null;
  return (
    <header className="flex items-end justify-end gap-6 mb-[25px] [&>div:first-child]:min-w-0 [&_h1]:m-0 [&_h1]:text-text [&_h1]:text-[clamp(27px,_3.2vw,_39px)] [&_h1]:leading-[1.08] [&_h1]:tracking-[-.045em] [&_p]:max-w-[720px] [&_p]:m-[9px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.65] [.users-page_&]:flex [.users-page_&]:items-center [.users-page_&]:justify-between [.users-page_&]:gap-4 [.users-page_&]:min-h-0 [.users-page_&]:m-0 [.users-page_&]:p-0 [.users-page_&_.page-eyebrow]:hidden [.users-page_&_h1]:m-0 [.users-page_&_h1]:text-[2rem] [.users-page_&_h1]:font-[800] [.users-page_&_h1]:leading-[1.15] [.users-page_&_h1]:tracking-[-.045em] [.users-page_&_p]:m-[6px_0_0] [.users-page_&_p]:text-muted [.users-page_&_p]:text-[12px] max-[681px]:later:items-start max-[681px]:flex-col max-[681px]:later:gap-4 max-[451px]:later:[&_h1]:text-[29px] [.dashboard-page_&_.page-eyebrow]:hidden [.dashboard-page_&_p]:hidden [.dashboard-page_&]:m-[0_0_14px] [.dashboard-page_&]:p-0 [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between [.activities-page_&]:gap-4 [.activities-page_&]:m-0 [.activities-page_&]:p-0 [.activities-page_&]:min-h-0 [.activities-page_&_.page-eyebrow]:hidden [.activities-page_&_h1]:m-0 [.activities-page_&_h1]:text-[2rem] [.activities-page_&_h1]:font-[800] [.activities-page_&_h1]:leading-[1.15] [.activities-page_&_h1]:tracking-[-.045em] [.applicant-pipeline-page_&]:flex [.applicant-pipeline-page_&]:items-center [.applicant-pipeline-page_&]:justify-between [.applicant-pipeline-page_&]:gap-4 [.applicant-pipeline-page_&]:min-h-0 [.applicant-pipeline-page_&]:m-0 [.applicant-pipeline-page_&]:p-0 [.applicant-pipeline-page_&_.page-eyebrow]:hidden [.applicant-pipeline-page_&_h1]:m-0 [.applicant-pipeline-page_&_h1]:text-[2rem] [.applicant-pipeline-page_&_h1]:font-[800] [.applicant-pipeline-page_&_h1]:leading-[1.15]">
      <div className="[&>button]:min-h-[42px] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-2 [&>button]:p-[0_16px] [&>button]:border [&>button]:border-transparent [&>button]:rounded-[12px] [&>button]:text-[#fff] [&>button]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&>button]:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] [&>button]:text-[12px] [&>button]:font-[760] [&>button]:tracking-[.01em] [&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&>a]:min-h-[42px] [&>a]:inline-flex [&>a]:items-center [&>a]:justify-center [&>a]:gap-2 [&>a]:p-[0_16px] [&>a]:border [&>a]:border-transparent [&>a]:rounded-[12px] [&>a]:text-[#fff] [&>a]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&>a]:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] [&>a]:text-[12px] [&>a]:font-[760] [&>a]:tracking-[.01em] [&>a]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [&>button:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [&>a:hover]:[transform:translateY(-2px)] [&>a:hover]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&>a:hover]:[filter:saturate(1.08)] later:[&>button:active:not(:disabled)]:[transform:translateY(0)] flex flex-wrap justify-end gap-[9px] max-[681px]:w-full max-[681px]:later:[justify-content:stretch] max-[681px]:[&>button]:flex-1 max-[681px]:[&>a]:flex-1">{actions}</div>
    </header>
  );
}

export function Modal({ title, onClose, children, footer, size = 'normal' }) {
  const titleId = useId();
  const cardRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !cardRef.current) return;
      const focusable = Array.from(cardRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const firstFocusable = cardRef.current?.querySelector('input, select, textarea, button, [tabindex]:not([tabindex="-1"])');
    firstFocusable?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.();
    };
  }, []);

  // Rendered on <body> so no page wrapper (scroll container, transform, zoom) can
  // trap it: the dialog is always centred in the viewport and stays put on scroll.
  return createPortal(
    <div className="modal-backdrop fixed inset-0 z-150 grid place-items-center p-5 overflow-hidden [background:rgba(2,_5,_12,_.66)] [backdrop-filter:blur(12px)_saturate(120%)] [animation:overlayFade_.18s_ease_both] max-[451px]:later:p-[10px]" role="presentation" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className={`w-[min(720px,_100%)] max-h-[calc(100dvh_-_40px)] flex flex-col overflow-hidden border border-line-strong rounded-[20px] [background:var(--panel)] [box-shadow:var(--shadow-xl)] [animation:modalIn_.26s_cubic-bezier(.2,.8,.2,1)_both] max-[781px]:later:w-full max-[451px]:later:max-h-[calc(100dvh_-_20px)] max-[451px]:later:rounded-[17px] modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex-none min-h-[62px] flex items-center justify-between gap-3 p-[13px_17px] border-b border-b-line relative z-2 [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [backdrop-filter:blur(18px)] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[13px] [&_h2]:tracking-[-.02em]">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)]" onClick={onClose} aria-label="Close dialog"><FaXmark /></button>
        </div>
        <div className="flex-[1_1_auto] min-h-0 overflow-y-auto [overscroll-behavior:contain] p-[18px] max-[451px]:later:p-[15px]">{children}</div>
        {footer && <div className="later:[&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-2:[&_button]:border-line later-2:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-2:[&_button]:text-[9px] later-2:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] later-2:[&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex-none min-h-[62px] flex items-center gap-3 p-[13px_17px] border-b-line relative z-2 later:justify-end later:border-t later:border-t-line later:border-b-0 [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [backdrop-filter:blur(18px)] [&_.primary-button]:text-[#fff] [&_.primary-button]:border-0 [&_.primary-button]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&_.primary-button:disabled]:text-muted [&_.primary-button:disabled]:border [&_.primary-button:disabled]:border-line [&_.primary-button:disabled]:[background:var(--surface-subtle)] later:[&_.primary-button:disabled]:[box-shadow:none] [&_.primary-button:disabled]:opacity-[1] [&_.primary-button:disabled]:cursor-not-allowed later-2:[&_.primary-button:disabled]:[transform:none] [&_.danger-button:disabled]:text-muted [&_.danger-button:disabled]:border [&_.danger-button:disabled]:border-line [&_.danger-button:disabled]:[background:var(--surface-subtle)] later:[&_.danger-button:disabled]:[box-shadow:none] [&_.danger-button:disabled]:opacity-[1] [&_.danger-button:disabled]:cursor-not-allowed later-2:[&_.danger-button:disabled]:[transform:none] [&_.danger-button]:text-[#fff] [&_.danger-button]:border-0 later:[&_.danger-button]:[background:linear-gradient(135deg,_#ef596b,_#c9374a)]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Pagination({ meta, onPage }) {
  if (!meta || meta.last_page <= 1) return null;
  const firstRecord = ((meta.current_page - 1) * meta.per_page) + 1;
  const lastRecord = Math.min(meta.current_page * meta.per_page, meta.total);
  return (
    <nav className="later:[&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-2:[&_button]:border-line later-2:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-2:[&_button]:text-[9px] later-2:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] later-2:[&_button:hover:not(:disabled)]:[transform:translateY(-1px)] min-h-[58px] flex items-center justify-between gap-[14px] p-[11px_15px] border-t border-t-line text-muted text-[8px] max-[681px]:later:items-stretch max-[681px]:flex-col" aria-label="Pagination">
      <span className="pagination-summary">Showing {firstRecord}–{lastRecord} of {meta.total}</span>
      <div className="flex items-center gap-[9px] [&>span]:min-w-[100px] [&>span]:text-center max-[681px]:justify-between max-[681px]:[&_button]:flex-1">
        <button type="button" disabled={meta.current_page <= 1} onClick={() => onPage(meta.current_page - 1)}>Previous</button>
        <span>Page {meta.current_page} of {meta.last_page}</span>
        <button type="button" disabled={meta.current_page >= meta.last_page} onClick={() => onPage(meta.current_page + 1)}>Next</button>
      </div>
    </nav>
  );
}

export function StatusBadge({ value, label, tone }) {
  // `tone` keeps the colour class tied to the stored status while `label`
  // shows the tense-correct text (Scheduling vs Scheduled).
  const normalized = String(tone || value || 'unknown').toLowerCase().replaceAll('_', '-');
  return (
    <span className={`status-pill min-h-[24px] inline-flex items-center gap-[6px] p-[4px_9px] border border-line rounded-[999px] text-text-secondary [background:var(--surface-subtle)] text-[8px] font-[720] capitalize whitespace-nowrap [.readable-list_&]:text-[12px] status-${normalized}`}>
      <span className="w-[6px] h-[6px] rounded-[50%] [background:currentColor] [box-shadow:0_0_0_3px_color-mix(in_srgb,_currentColor_11%,_transparent)]" aria-hidden="true" />
      {String(label || value || 'unknown').replaceAll('_', ' ')}
    </span>
  );
}

export function ProgressBar({ percent = 0, state = 'in_progress', label, detail }) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const suffix = state === 'complete' ? 'Complete' : state === 'rejected' ? 'Rejected' : `${value}%`;
  return (
    <div className="min-w-[128px] flex flex-col">
      {(label || detail) && (
        <div className="flex items-center justify-between gap-[10px] mb-[5px] text-muted text-[8px] [&_strong]:text-text-secondary [&_strong]:font-[720]">
          {label && <strong>{label}</strong>}
          <span>{detail || suffix}</span>
        </div>
      )}
      <div
        className="h-[7px] w-full overflow-hidden rounded-[999px] [background:var(--surface-strong)]"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || 'Progress'}
      >
        <div className={`h-full rounded-[inherit] [background:linear-gradient(90deg,_var(--accent),_var(--accent-2))] [transition:width_.45s_cubic-bezier(.2,.8,.2,1)] [&.state-complete]:[background:linear-gradient(90deg,_var(--success),_var(--success-text))] later:[&.state-rejected]:[background:linear-gradient(90deg,_var(--danger),_var(--danger-text))] state-${state}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function Field({ label, children, full = false, hint, required = false }) {
  return (
    <label className={`[&_input]:min-h-[40px] [&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:min-h-[40px] [&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_textarea]:p-[9px_11px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[11px] [&_textarea]:[outline:none] [&_textarea]:text-text [&_textarea]:[background:var(--input-bg)] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_textarea::placeholder]:text-placeholder [&_input:hover]:border-line-strong [&_select:hover]:border-line-strong [&_textarea:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] later:[&_textarea:focus]:border-accent [&_textarea:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_textarea:focus]:[background:var(--input-focus-bg)] min-w-0 flex flex-col gap-[6px] [&.full]:col-span-full later:[&>span]:text-text-secondary later:[&>span]:text-[9px] [&>span]:font-[720] [&>span_b]:text-danger [&>small]:text-muted later-2:[&>small]:text-[8px] later:[&>small]:leading-[1.4] later:[&_textarea]:min-h-[100px] [&_textarea]:[resize:vertical] max-[681px]:later:[&.full]:col-[auto] [.fn-filters_&]:m-0 [.profile-form-grid_&_span]:text-[#8a94a6] [.profile-form-grid_&_span]:text-[10px] [.profile-form-grid_&_span]:font-[800] [.profile-form-grid_&_span]:tracking-[0.09em] [.profile-form-grid_&_span]:uppercase [.profile-form-grid_&_small]:text-[#7f889b] [.profile-form-grid_&_small]:text-[10px] [.ms-form_&.full]:col-span-full [.er-filters_&]:m-0 [.er-inline-form_&]:m-0 [.branch-portal-financial_&>span]:text-[9px] [&_input[readonly]]:text-muted later:[&_input[readonly]]:[background:var(--surface-subtle)] [&_input[readonly]]:cursor-not-allowed [&_input.is-locked]:text-muted [&_input.is-locked]:[background:var(--surface-subtle)] [&_input.is-locked]:cursor-not-allowed [&_input[readonly]:hover]:border-input-line [&_input.is-locked:hover]:border-input-line ${full ? ' full [.ap-grid_&]:col-span-full' : ''}`}>
      <span>{label}{required && <b aria-hidden="true"> *</b>}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
