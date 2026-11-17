import React, { useEffect, useRef, useState } from 'react';
import QualificationReview from '../components/applicants/QualificationReview.jsx';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FaCheck, FaChevronDown, FaClipboardCheck, FaClock, FaEye, FaFileCsv, FaFilePdf, FaImage, FaList, FaLock, FaPen, FaPrint, FaStore,
  FaRotateLeft, FaTableCellsLarge, FaTrashCan, FaUserCheck, FaXmark,
} from 'react-icons/fa6';
import RequirementFileDrop from '../components/RequirementFileDrop';
import LocationPicker from '../components/LocationPicker';
import { differentFromPreferred, formatLocation, locationInput, locationPlain, suggestBranchName } from '../lib/locations';
import LocationValue from '../components/LocationValue';
import {
  API_BASE_URL, api, authToken, firstValidationMessage,
} from '../lib/api';
import { downloadCsv, downloadPdf } from '../lib/export';
import FollowUpLog from '../components/FollowUpLog';
import { FollowUpChip, FollowUpDialogs, FollowUpSummary } from '../components/applicants/FollowUp';
import { FOLLOW_UP_FILTER_PREFIX, FOLLOW_UP_SECTION_ID, FOLLOW_UP_STATES, splitStatusFilter } from '../lib/followUpState';
import ApplicationDetailReport from '../components/applicants/ApplicationDetailReport';
import useRemote from '../lib/useRemote';
import {
  EmptyState,
  Field,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  StatusBadge,
} from '../components/ApiUi';
import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roleAccess';
import { formatDate, localDateInputValue, manilaDateTimeLabel, titleCase } from '../lib/format';
import { RecordFolderGrid, RecordFolderTable } from '../components/applicants/RecordFolders';
import RecordCode from '../components/RecordCode';
import { RECORD_FOLDERS } from '../lib/recordFolders';
import { loiHalves, qualificationFill } from '../lib/stepperProgress';
import { brandColor } from '../lib/brandColors';

const statuses = [
  'converted', 'qualified', 'scheduled', 'loi_submitted',
  'payment_submitted', 'for_approval', 'approved', 'rejected', 'active_franchisee',
];

// Order matters: it drives the stage stepper.
const pipelineStages = statuses.filter((item) => item !== 'rejected');

const filterBtn =
  'h-[40px] px-[14px] inline-flex items-center justify-center gap-2 border border-input-line rounded-[10px] [background:var(--input-bg)] text-text text-[13px] font-[600] cursor-pointer transition-[border-color,background] duration-150 hover:border-line-strong hover:[background:color-mix(in_srgb,_var(--input-bg)_80%,_var(--accent)_20%)] disabled:opacity-50 disabled:cursor-not-allowed';

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'franchisees', label: 'Franchisees' },
  { key: 'archived', label: 'Archive' },
  { key: 'detail', label: 'Application Detail' },
];

// Read-only report stages, in pipeline order (used by the approval receipt and
// the Application Detail report).
const REPORT_STAGES = [
  { key: 'qualification', label: '1 · Qualification' },
  { key: 'activities', label: '2 · Activities' },
  { key: 'loi', label: '3 · LOI Submission' },
  { key: 'payment', label: '4 · Payment Record' },
  { key: 'approval', label: '5 · Approval' },
];

// The four completed stages Admin may return an applicant to from For Approval.
const REVISE_STAGES = [
  { key: 'qualified', label: 'Qualified', hint: 'Redo the qualification checklist.' },
  { key: 'scheduled', label: 'Scheduled', hint: 'Adjust the scheduled activities.' },
  { key: 'loi_submitted', label: 'LOI Submitted', hint: 'Correct the LOI submission record.' },
  { key: 'payment_submitted', label: 'Payment Record', hint: 'Fix the payment report.' },
];

// ---- Pagination settings (same behavior as the Leads & inquiries table) ----
const PAGE_SIZE = 8;   // records per page
const PAGE_WINDOW = 4; // page numbers visible at a time
// Application Detail folders: a multiple of the 5- and 3-column grid widths,
// so a full page never ends on a half row on desktop or tablet.
const DETAIL_PAGE_SIZE = 15;
const DETAIL_VIEW_KEY = 'herald.applicationDetail.view';
const PIPELINE_COLUMNS_KEY = 'ft.applicants.pipeline.columns';
const PIPELINE_COLUMN_OPTIONS = [
  ['applicant_id', 'Applicant ID', true],
  ['contact', 'Contact', true],
  ['brand', 'Brand', true],
  ['applied', 'Applied', true],
  ['assigned_sales', 'Assigned Sales', true],
  ['status', 'Status', true],
];
function readPipelineColumns() {
  const defaults = Object.fromEntries(PIPELINE_COLUMN_OPTIONS.map(([key, , visible]) => [key, visible]));
  try {
    const saved = JSON.parse(window.localStorage.getItem(PIPELINE_COLUMNS_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}

const DETAIL_EMPTY = {
  active: { label: 'No active applicants.', detail: 'Applicants still moving through the pipeline appear here.' },
  approved: { label: 'No approved applicants yet.', detail: 'Every applicant that finishes the pipeline gets a permanent record here.' },
  rejected: { label: 'No rejected applicants.', detail: 'Rejected applicants keep their record here.' },
};

function readDetailView() {
  try {
    return window.localStorage.getItem(DETAIL_VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

// Show the compact progress preview for every applicant status.
const HOVER_STATUSES = statuses;

// Only these five checklist items are used to qualify an applicant.
const QUALIFICATION_ITEMS = [
  { key: 'qualification_profile_reviewed', label: 'Applicant profile reviewed' },
  { key: 'qualification_financial_capability_assessed', label: 'Financial capability assessed' },
  { key: 'qualification_initial_interview_completed', label: 'Initial interview completed' },
  { key: 'qualification_preferred_location_evaluated', label: 'Preferred location evaluated' },
  { key: 'qualification_investment_understood', label: 'Applicant understands franchise investment' },
];

// Value for <input type="datetime-local">: "YYYY-MM-DDTHH:mm" in the viewer's local time.
const toLocalInput = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const nowLocal = () => toLocalInput(new Date());

const fmtDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
};
/* ---------------- Fixed, centered dialog ----------------
 * The Update dialog used to live inside the page, so any ancestor with a
 * transform / filter / scroll container became the reference for
 * `position: fixed` and the dialog drifted away from the middle of the screen.
 *
 * This dialog is rendered through a portal straight into <body>:
 *  - the overlay is `position: fixed; inset: 0` and centers the card with flexbox,
 *  - the card has a max-height, header and footer never scroll,
 *  - ONLY `.ap-dialog-body` scrolls,
 *  - the page behind is locked while the dialog is open.
 * The wrapper keeps the `page-container` class (display: contents) so page-scoped
 * CSS rules still match, exactly like the portal used on the Inquiries page.
 */
let scrollLocks = 0;
let savedOverflow = '';
let savedPaddingRight = '';
let dialogCounter = 0;

function lockBodyScroll() {
  if (scrollLocks === 0) {
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    savedOverflow = document.body.style.overflow;
    savedPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
  }
  scrollLocks += 1;
}

function unlockBodyScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) {
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }
}

function Dialog({
  title, onClose, footer, children, size = 'large', zIndex = 2147482000, closeOnEscape = true, modalClass = '', animated = false,
}) {
  const titleId = useRef(`ap-dialog-title-${++dialogCounter}`).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') closeRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeOnEscape]);

  return createPortal(
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] modal-portal-root" style={{ display: 'contents' }}>
      <div className={`fixed inset-0 flex items-center justify-center [box-sizing:border-box] p-5 [background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)] [overscroll-behavior:contain] max-[721px]:later:p-[10px] print:[body.ap-print-report_&]:static print:[body.ap-print-report_&]:p-0 print:[body.ap-print-report_&]:[background:#fff]${animated ? ' animate-overlay-in' : ''}`} style={{ zIndex }}>
        <div
          className={`ap-dialog${animated ? ' animate-modal-pop' : ''} flex flex-col [box-sizing:border-box] w-[min(900px,_100%)] max-h-[calc(100dvh_-_40px)] overflow-hidden border border-[#2a3550] rounded-[10px] [background:#0f1626] text-[#e7ebf5] [box-shadow:0_28px_80px_rgba(2,_6,_18,_.65),_0_0_0_1px_rgba(129,_117,_255,_.05)] [&.is-medium]:w-[min(680px,_100%)] later:[&.is-small]:w-[min(460px,_100%)] max-[721px]:later:w-full max-[721px]:later:max-h-[calc(100dvh_-_20px)] print:[body.ap-print-report_&]:w-full print:[body.ap-print-report_&]:max-w-[none] print:[body.ap-print-report_&]:max-h-[none] print:[body.ap-print-report_&]:h-auto print:[body.ap-print-report_&]:border-0 print:[body.ap-print-report_&]:rounded-[0] print:[body.ap-print-report_&]:[box-shadow:none] later-3:[&.is-payment]:w-[min(1120px,_100%)] [&.is-qualification]:w-[min(1180px,_100%)] [&.is-qualification]:h-[min(820px,_calc(100dvh_-_40px))] is-${size}${modalClass ? ` ${modalClass}` : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header className="flex flex-none items-center justify-between gap-4 p-[16px_22px] border-b border-b-[#1f2842] [&_h2]:m-0 [&_h2]:text-[#f1f3fb] [&_h2]:text-[17px] [&_h2]:font-[700] [&_h2]:leading-[1.35] [&_h2]:[overflow-wrap:anywhere] max-[721px]:later:p-[13px_16px] print:[body.ap-print-report_&]:hidden">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="inline-grid flex-none place-items-center w-[32px] h-[32px] p-0 border border-transparent rounded-[8px] [background:transparent] text-[#aab4c8] text-[15px] cursor-pointer [transition:color_.15s_ease,_background_.15s_ease,_border-color_.15s_ease] later-5:hover:text-[#fff] hover:[background:#1a2133] hover:border-[#303a50] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:2px]" onClick={onClose} aria-label="Close">
              <FaXmark aria-hidden="true" />
            </button>
          </header>
          <div className="ap-dialog-body flex-[1_1_auto] min-h-0 p-[18px_22px] overflow-y-auto [overscroll-behavior:contain] [scrollbar-width:thin] [scrollbar-color:#39435b_transparent] text-[#e7ebf5] [&::-webkit-scrollbar]:w-[7px] [&::-webkit-scrollbar-thumb]:[background:#39435b] [&::-webkit-scrollbar-thumb]:rounded-[99px] max-[721px]:later:p-[14px_16px] print:[body.ap-print-report_&]:overflow-visible print:[body.ap-print-report_&]:p-0 [.ap-dialog.is-payment_&]:flex [.ap-dialog.is-payment_&]:flex-col [.ap-dialog.is-payment_&]:overflow-y-auto [.ap-dialog.is-payment_&>*]:flex-none [.ap-dialog.is-payment_&>form#update-applicant-form]:flex [.ap-dialog.is-payment_&>form#update-applicant-form]:flex-col [.ap-dialog.is-payment_&>form#update-applicant-form]:min-h-0 max-[821px]:later:[.ap-dialog.is-payment_&]:overflow-y-auto later:[.ap-dialog.is-payment_&>form#update-applicant-form]:flex-none later-2:[.ap-dialog.is-payment_&]:overflow-x-hidden">{children}</div>
          {footer && <footer className="ap-dialog-foot flex flex-none items-center justify-end gap-[10px] p-[14px_22px] border-t border-t-[#1f2842] [background:rgba(8,_12,_22,_.45)] max-[721px]:later:p-[12px_16px] max-[721px]:flex-wrap [&_.ap-modal-save]:min-h-[36px] [&_.ap-modal-save]:p-[0_16px] [&_.ap-modal-save]:rounded-[7px] [&_.ap-modal-save]:[box-shadow:none] [&_.ap-modal-save]:text-[10px] [&_.ap-modal-save]:font-[750] [&_.ap-modal-save]:tracking-[.08em] [&_.ap-modal-save]:border [&_.ap-modal-save]:border-[#5656db] [&_.ap-modal-save]:[background:linear-gradient(110deg,_#3978e8,_#7951dc)] [&_.ap-modal-save]:text-[#fff] [&_.ap-modal-save:hover:not(:disabled)]:[background:linear-gradient(110deg,_#4b88f2,_#8962e8)] [&_.ap-modal-save:hover:not(:disabled)]:[box-shadow:none] [&_.ap-modal-save:hover:not(:disabled)]:[filter:none] [&_.ap-modal-save:hover:not(:disabled)]:[transform:none] print:[body.ap-print-report_&]:hidden">{footer}</footer>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* Same size rules as the real Update modal, so the skeleton matches its width. */
function openingModalClass(stage, role) {
  if (role === 'admin' && stage === 'converted') return 'is-qualification';
  if (stage === 'payment_submitted' && (role === 'admin' || role === 'sales')) return 'is-payment';
  return '';
}

/* Skeleton placeholder shown while an applicant record loads. */
function ApplicantDetailSkeleton({ stage, isAdmin }) {
  const bar = 'ap-skeleton block rounded-[6px]';
  const isQualification = isAdmin && stage === 'converted';
  const isPayment = stage === 'payment_submitted';
  const rows = isQualification ? 4 : isPayment ? 6 : 3;
  return (
    <div className="flex flex-col gap-[14px]" role="status" aria-live="polite" aria-label="Loading applicant">
      <div className="p-[16px] border border-[#2a3041] rounded-[12px] [background:#141a28] flex flex-col gap-[12px]">
        <span className={`${bar} h-[12px] w-[30%]`} />
        <div className="flex gap-[10px]">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <span key={i} className={`${bar} h-[10px] flex-1`} />)}
        </div>
      </div>
      <div className="p-[16px] border border-[#2a3041] rounded-[12px] [background:#141a28] flex flex-col gap-[12px]">
        <span className={`${bar} h-[12px] w-[40%]`} />
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className={`${bar} h-[38px] w-full !rounded-[9px]`} />
        ))}
      </div>
      <div className="p-[16px] border border-[#2a3041] rounded-[12px] [background:#141a28] flex flex-col gap-[10px]">
        <span className={`${bar} h-[12px] w-[25%]`} />
        <span className={`${bar} h-[10px] w-[70%]`} />
        <span className={`${bar} h-[10px] w-[55%]`} />
      </div>
    </div>
  );
}

/* ---------------- Pagination ----------------
 * Same behavior as the Leads & inquiries table:
 * - hidden when there are PAGE_SIZE records or fewer,
 * - at most PAGE_WINDOW page numbers in a sliding window,
 * - record count on the left, Previous / numbers / Next on the right.
 * Data comes from the API `meta` (total, per_page, last_page, current_page).
 */
function ApplicantPagination({ meta, page, onPage, noun = 'applicants' }) {
  const total = Number(meta?.total ?? 0);
  const perPage = Number(meta?.per_page ?? PAGE_SIZE) || PAGE_SIZE;
  const last = Number(meta?.last_page ?? Math.ceil(total / perPage));
  if (!total || total <= perPage || last <= 1) return null;

  const current = Math.min(Math.max(Number(meta?.current_page ?? page), 1), last);
  const from = (current - 1) * perPage + 1;
  const to = Math.min(current * perPage, total);

  // The active page sits in the 3rd slot when possible, and the window never runs past the last page.
  const start = Math.max(1, Math.min(current - 2, last - PAGE_WINDOW + 1));
  const pages = Array.from({ length: Math.min(PAGE_WINDOW, last) }, (_, index) => start + index);

  return (
    <nav className="flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] [&_button]:[font-family:inherit] later-4:[&_button]:[font-size:inherit] later-4:[&_button]:[font-weight:inherit] [&_button]:[font-style:inherit] later-2:[&_button]:[line-height:inherit] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-number]:w-[36px] [&_.page-number]:p-0 [&_.page-number]:border-transparent [&_.page-number]:rounded-[50%] [&_.page-number]:font-[600] [&_.page-number:hover:not(.active)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-number:hover:not(.active)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-number:hover:not(.active)]:text-[#e6e9f2] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_.page-number.active]:[background:#7b88ff] [&_.page-number.active]:border-[#7b88ff] [&_.page-number.active]:text-[#fff] later-2:[&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later-2:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later-2:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Applicants pagination">
      <span className="page-count">Showing {from} to {to} of {total} {noun}</span>
      <div className="page-nav">
        <button type="button" className="page-step" onClick={() => onPage(current - 1)} disabled={current <= 1}>
          Previous
        </button>
        {pages.map((number) => (
          <button
            key={number}
            type="button"
            className={`page-number [.inquiry-pagination_&]:w-[36px] [.inquiry-pagination_&]:p-0 [.inquiry-pagination_&]:border-transparent [.inquiry-pagination_&]:rounded-[50%] [.inquiry-pagination_&]:font-[600] [.inquiry-pagination_&:hover:not(.active)]:[background:rgba(123,_136,_255,_0.1)] [.inquiry-pagination_&:hover:not(.active)]:border-[rgba(123,_136,_255,_0.35)] [.inquiry-pagination_&:hover:not(.active)]:text-[#e6e9f2] [.inquiry-pagination_&.active]:[background:#7b88ff] [.inquiry-pagination_&.active]:border-[#7b88ff] [.inquiry-pagination_&.active]:text-[#fff] ${number === current ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
            aria-label={`Page ${number}`}
            aria-current={number === current ? 'page' : undefined}
            onClick={() => onPage(number)}
          >
            {number}
          </button>
        ))}
        <button type="button" className="page-step" onClick={() => onPage(current + 1)} disabled={current >= last}>
          Next
        </button>
      </div>
    </nav>
  );
}

/* ---------------- Stepper ----------------
 * items: [{ key, label, state: 'done' | 'current' | 'waiting' | 'todo' }]
 *
 * Each step draws the connector that leads to the NEXT step (see .ap-step::after in the CSS).
 * That connector is green only when this step is completed AND progress has reached the next
 * step (the next step is completed or is the current one). Connectors after the current step,
 * or leading into steps that are still ahead, stay grey.
 *
 * The tracker is display-only: stages are moved with the single primary action button
 * below it (the API is the state machine), so steps are never clickable.
 */
function Stepper({ items, qualificationProgress = null, attendedProgress = null, loiProgress = null, scheduleHalves = null }) {
  return (
    <ol className="flex items-start [list-style:none] p-0 m-0 gap-0 max-[721px]:overflow-x-auto max-[721px]:later:pb-[5px]">
      {items.map((item, index) => {
        const next = items[index + 1];
        // The Converted -> Qualified connector follows the Qualification requirements progress.
        const fillsQualification = index === 0 && qualificationProgress != null;
        // Scheduling: two halves, Orientation/Tasting (left) and Training (right), each green once verified by Admin.
        const splitsScheduling = item.key === 'scheduled' && scheduleHalves != null;
        const fillsScheduling = !splitsScheduling && item.key === 'scheduled' && attendedProgress != null;
        // LOI Submission: two halves, the LOI (left) and the Proposed site (right), each green once verified.
        const splitsLoi = item.key === 'loi_submitted' && loiProgress != null;
        const halves = splitsLoi ? loiProgress : splitsScheduling ? scheduleHalves : null;
        const lineDone = !fillsQualification && !fillsScheduling && !halves && item.state === 'done' && Boolean(next) && next.state !== 'todo';
        const fill = fillsQualification ? qualificationProgress : fillsScheduling ? attendedProgress : null;
        const lineStyle = fill != null ? { '--qp': `${Math.round(fill * 100)}%` }
          : halves ? { '--h1': halves.left ? '#25c77a' : '#30364c', '--h2': halves.right ? '#25c77a' : '#30364c' } : undefined;
        return (
          <li
            key={item.key}
            style={lineStyle}
            className={`ap-step flex flex-col items-center gap-[6px] later:flex-[1_1_0] min-w-0 relative text-center [&:not(:last-child)::after]:[content:''] [&:not(:last-child)::after]:absolute [&:not(:last-child)::after]:top-[11px] [&:not(:last-child)::after]:left-[calc(50%_+_13px)] [&:not(:last-child)::after]:right-[calc(-50%_+_13px)] [&:not(:last-child)::after]:h-[4px] [&:not(:last-child)::after]:[background:linear-gradient(to_right,#25c77a_var(--qp,0%),#30364c_var(--qp,0%))] [&.line-done:not(:last-child)::after]:[background:#25c77a] [&.split-line:not(:last-child)::after]:[background:linear-gradient(to_right,var(--h1)_0_50%,var(--h2)_50%_100%)] later-2:[&.is-done_.ap-node]:text-[#071a12] later:[&.is-done_.ap-node]:[background:#25c77a] later-2:[&.is-done_.ap-node]:border-[#25c77a] later-3:[&.is-current_.ap-node]:text-[#fff] later-2:[&.is-current_.ap-node]:[background:#7668f6] later-3:[&.is-current_.ap-node]:border-[#8b80ff] [&.is-current_.ap-node]:[box-shadow:0_0_0_3px_rgba(118,_104,_246,_.14)] max-[721px]:later:min-w-[66px] [#update-applicant-form_&:not(:last-child)::after]:top-[10px] later-4:[&.is-pending_.ap-node]:[background:rgba(245,_158,_11,_.18)] later-5:[&.is-pending_.ap-node]:border-[#f59e0b] later-5:[&.is-pending_.ap-node]:text-[#fbbf24] is-${item.state}${lineDone ? ' line-done' : ''}${halves ? ' split-line' : ''}`}
          >
            <div className="flex relative z-1 w-full min-w-0 p-[0_3px] items-center flex-col gap-[6px] border-0 [background:transparent] text-[color:inherit] cursor-default later:[button&]:cursor-pointer later:[button&:disabled]:cursor-not-allowed later:[button&:disabled]:opacity-[.6]">
              <span className="ap-node relative z-1 place-items-center [border:1px_solid_var(--ap-border-2)] [&_svg]:m-0 later:inline-flex items-center justify-center later:w-[25px] later:h-[25px] rounded-[50%] later:[background:#20263b] later:border later:border-[#3a4261] later:text-[#9ba5bd] later:text-[10px] font-[700] [#update-applicant-form_&]:w-[23px] [#update-applicant-form_&]:h-[23px]">
                {item.state === 'done' ? <FaCheck aria-hidden="true" />
                  : item.state === 'waiting' ? (
                    <>
                      <span className="absolute inset-[-4px] rounded-[50%] pointer-events-none [will-change:transform] [animation:apRingSpin_1.2s_linear_infinite]" style={{ background: 'conic-gradient(from 0deg, rgba(37,199,122,0) 0deg, rgba(37,199,122,0.15) 150deg, #25c77a 360deg)', WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))', mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))' }} aria-hidden="true" />
                      {index + 1}
                    </>
                  )
                    : item.state === 'pending' ? <span className="font-[800] text-[13px] leading-[1]" aria-label="Pending">!</span>
                    : item.state === 'current' ? <FaClock aria-hidden="true" /> : index + 1}
              </span>
              <span className="p-[0_2px] text-center font-[700] tracking-[0.03em] uppercase max-[641px]:later:text-[0.58rem] max-w-full later:text-[#9ba5bd] later-2:text-[10px] later:leading-[1.3] [overflow-wrap:anywhere] later-2:[.ap-step.is-done_&]:text-[#45d991] later-3:[.ap-step.is-current_&]:text-[#f1f0ff] [.ap-step.is-current_&]:font-[700] max-[721px]:later-3:text-[9px] later:[#update-applicant-form_&]:text-[9px] [#update-applicant-form_&]:leading-[1.25] [#update-applicant-form_.pay-state-strip_&]:text-[9px] later-4:[.ap-step.is-pending_&]:text-[#fbbf24]">{item.label}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* The two tracked activities rendered in the schedule section. Orientation and Product
 * Tasting are one activity: Orientation/Tasting (stored key 'orientation'). */

const TRACKED_ACTIVITIES = [
  { type: 'orientation', key: 'orientation_attended', label: 'Orientation/Tasting' },
  { type: 'training', key: 'training_completed', label: 'Training' },
];

/* Badge labels for activity_state.state (API values on the left). */
const STATE_LABELS = {
  not_scheduled: 'Not scheduled',
  pending_admin: 'Pending admin confirmation',
  scheduled: 'Scheduled',
  completed: 'Completed',
  attended: 'Attended',
};

/* Last activity_state signature this viewer saw per applicant (in-memory,
 * viewer-session only — no server roundtrip): the Schedule Activity auto-scroll
 * fires exclusively when THIS value changes for that applicant. */
const lastActivitySignature = new Map();

/* A stage shows only its own content (Section 7): Schedule Activity belongs to
 * the Scheduled stage alone. From LOI Submission on the records stay in the
 * database and are shown by the read-only reports instead. */
const SCHEDULE_VISIBLE_FROM = ['scheduled'];

/* The Payment Record section belongs to the payment stage and the review
 * that follows it — never to LOI Submission. */
const PAYMENT_PANEL_FROM = ['payment_submitted', 'for_approval', 'approved', 'active_franchisee'];

/**
 * The single primary action next to "Mark as Reject": label, availability and
 * the handler key depend on the current stage and on the role permission matrix.
 * A button a role cannot use stays visible but disabled, with a short reason.
 */
function resolvePrimaryAction({ stage, allAttended, pendingActivities, loiReady, qualificationDone, qualificationMissing = [], activationMissing = [], paymentsComplete = false, hasPortalAccount, portalInvitePending = false, isAdminRole, isSalesRole }) {
  const adminOnly = 'Admin action — your role can only view this stage.';

  // Sales only gets a "View" button before the Scheduled stage: no actions yet.
  if (isSalesRole && ['converted', 'qualified'].includes(stage)) {
    return { label: 'View', enabled: false, reason: '' };
  }

  switch (stage) {
    case 'converted':
      return qualificationDone
        ? { label: 'Confirm Qualified', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'qualified' }
        : { label: 'Confirm Qualified', enabled: false, reason: qualificationMissing.length ? `Missing: ${qualificationMissing.join(', ')}.` : '', run: 'qualified' };
    case 'qualified':
      // [Set Schedule] lives inside the locked Schedule Activity section
      // (LockedScheduleSection), so the tracker area has no second button.
      return null;
    case 'scheduled':
      // Scheduled is checked only when all three activities are DONE: Sales
      // marked Complete AND Admin marked Attended and saved it. One button then
      // hands the applicant to LOI Submission.
      if (!allAttended) {
        const outstanding = pendingActivities.length
          ? pendingActivities.join(', ')
          : 'Orientation/Tasting, Training';
        return {
          label: 'Completed',
          enabled: false,
          run: 'completeActivities',
          reason: `Waiting for Sales to mark Complete and Admin to mark Attended and save: ${outstanding}.`,
        };
      }
      return { label: 'Completed', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'completeActivities' };
    case 'loi_submitted':
      // The LOI record must be verified on the field and saved before the stage
      // can move; Sales records the payment in the panel below.
      if (isSalesRole) {
        return { label: 'Payment Record', enabled: false, reason: 'Waiting for Admin to verify and complete the LOI stage.' };
      }
      // Admin: [Save LOI] / [Proceed] / [Complete] live in the LOI section itself.
      if (isAdminRole) return null;
      return loiReady
        ? { label: 'Completed', enabled: false, reason: adminOnly }
        : { label: 'Completed', enabled: false, reason: 'Waiting for Admin to verify and complete the LOI.' };
    case 'payment_submitted':
      // The Payment Record card has its own Admin-only Move to For Approval
      // button (enabled when every required payment is Verified), so the generic
      // primary button steps aside instead of competing with it.
      return null;
    case 'for_approval':
      // Approval is a footer action with a two-step confirmation, so the progress
      // tracker itself only shows progress (no action button here).
      return null;
    case 'approved':
      if (!paymentsComplete) {
        return { label: hasPortalAccount ? 'Mark as Active Franchisee' : 'Create Account', enabled: false, reason: 'Every required payment must be Verified by Admin first.' };
      }
      if (activationMissing.length) {
        return { label: hasPortalAccount ? 'Mark as Active Franchisee' : 'Create Account', enabled: false, reason: `The signed franchise agreement must be Accepted first. Missing: ${activationMissing.join(', ')}.` };
      }
      // The branch account was invited: the applicant becomes Active Franchisee when the franchisee accepts.
      if (portalInvitePending) {
        return { label: 'Resend invite', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'resendInvite', note: 'Approved – waiting for franchisee to accept invite' };
      }
      return hasPortalAccount
        ? { label: 'Mark as Active Franchisee', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'activate' }
        : { label: 'Create Account', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'createAccount' };
    case 'active_franchisee':
      return { label: 'Mark as Active Franchisee', enabled: false, reason: 'Already an active franchisee — the pipeline is complete.' };
    default:
      return null;
  }
}

/* ---------------- Hover card on the Status badge ----------------
 * Rendered through a portal into <body> with position: fixed, so table rows,
 * .table-wrap overflow, or stacking contexts can never cover it.
 */
const CARD_W = 340;
const CARD_H = 190;

function ProgressRow({ label, done, total, percent }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <div className="m-[10px_0_0]">
      <div className="flex items-center justify-between gap-[10px] mb-[6px] text-[#cbd3e4] light:text-[#3e4b64] text-[11px] leading-[1.3] [&_strong]:flex-[0_0_auto] [&_strong]:text-[#f0f2ff] light:[&_strong]:text-[#172033] [&_strong]:text-[10px] [&_strong]:font-[700] [&_strong]:[font-variant-numeric:tabular-nums] max-[721px]:later:text-[10px]">
        <span>{label}</span>
        <strong>{total ? `${done}/${total}` : `${safePercent}%`}</strong>
      </div>
      <div className="h-[6px] overflow-hidden rounded-[999px] [background:#252d40] light:[background:#e3e8f2] [box-shadow:inset_0_1px_2px_rgba(0,0,0,.22)] [&_span]:block [&_span]:h-full [&_span]:rounded-[inherit] [&_span]:[background:linear-gradient(90deg,_#6559e8,_#8a7dff)] [&_span]:[transition:width_.2s_ease]" aria-label={`${label}: ${safePercent}%`}>
        <span style={{ width: `${safePercent}%` }} />
      </div>
    </div>
  );
}

function StatusHover({ applicant, loadDetail, children }) {
  const normalizedStatus = String(applicant.status || '').toLowerCase().replace(/[\s-]+/g, '_');
  const enabled = HOVER_STATUSES.includes(normalizedStatus);
  const anchorRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const hideTimer = useRef(null);
  const requestRef = useRef(0);

  const show = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!enabled || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const cardWidth = Math.min(CARD_W, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - cardWidth / 2), window.innerWidth - cardWidth - 8);
    const below = rect.bottom + 9;
    const top = below + CARD_H > window.innerHeight - 8
      ? Math.max(8, rect.top - CARD_H - 9)
      : below;
    setPos({ left, top, arrowX: rect.left + rect.width / 2 - left, flipped: top < rect.top });

    // Show the row's existing summary immediately, then enrich it with detail API data.
    const requestId = ++requestRef.current;
    setDetailLoading(true);
    loadDetail(applicant.id)
      .then((result) => {
        if (requestRef.current === requestId) setDetail(result?.data || result);
      })
      .catch(() => {
        if (requestRef.current === requestId) setDetail(null);
      })
      .finally(() => {
        if (requestRef.current === requestId) setDetailLoading(false);
      });
  };

  const hide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPos(null), 180);
  };

  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [pos]);

  const milestones = detail?.milestones || applicant.milestones || {};
  const scheduleItems = TRACKED_ACTIVITIES;
  const qualificationCompleted = QUALIFICATION_ITEMS.filter(({ key }) => milestones[key]).length;
  const scheduleDone = scheduleItems.filter((m) => milestones[m.key]).length;
  const stageIndex = pipelineStages.indexOf(normalizedStatus);
  const stagePercent = normalizedStatus === 'active_franchisee'
    ? 100
    : normalizedStatus === 'rejected'
      ? 100
      : Math.round(((Math.max(stageIndex, 0) + (stageIndex >= 0 ? 1 : 0)) / pipelineStages.length) * 100);
  const progress = applicant.progress || {};
  const fallbackScheduleTotal = Number(progress.schedule_total || progress.activities_total || 0);
  const fallbackScheduleDone = Number(progress.schedule_completed || progress.activities_completed || 0);
  const scheduleTotal = scheduleItems.length || fallbackScheduleTotal;
  const scheduleCount = detail?.milestones || applicant.milestones ? scheduleDone : fallbackScheduleDone;

  return (
    <>
      <span
        ref={anchorRef}
        className="later:[outline-offset:3px] rounded-[999px] later:inline-flex relative items-center [cursor:help] later-2:[outline:none] focus-visible:rounded-[5px] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:3px]"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={enabled ? 0 : undefined}
        aria-haspopup="true"
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          className={`[--ap-bg:#0a0e18] [--ap-panel:#0d1220] [--ap-card:#111827] [--ap-border:#1a2133] [--ap-border-2:#1f2842] [--ap-text:#e6e9f2] [--ap-muted:#8590a8] [--ap-accent:#7b88ff] [--ap-green:#34d399] [border:1px_solid_var(--ap-border-2)] [animation:ap-pop_0.14s_ease-out] [&::before]:[border-left:1px_solid_var(--ap-border-2)] [&::before]:[border-top:1px_solid_var(--ap-border-2)] [&.flipped::before]:[transform:rotate(225deg)] motion-reduce:later:[animation:none] fixed! z-2147483000! [box-sizing:border-box] max-w-[calc(100vw_-_16px)] later:text-[#edf0fa] light:text-[#172033] later:border later:rounded-[10px] later:[box-shadow:0_18px_48px_rgba(0,_0,_0,_.55),_0_3px_12px_rgba(0,_0,_0,_.3)] light:[box-shadow:var(--shadow-md)] later:pointer-events-auto [isolation:isolate] [&::before]:[content:''] [&::before]:absolute later:[&::before]:left-[clamp(14px,_var(--arrow-x),_calc(100%_-_14px))] later:[&::before]:-top-[7px] later:[&::before]:w-[12px] later:[&::before]:h-[12px] later:[&::before]:[background:#111624] light:[&::before]:[background:#fff] later:[&::before]:border-l later:[&::before]:border-l-[#343b50] light:[&::before]:border-l-line later:[&::before]:border-t later:[&::before]:border-t-[#343b50] light:[&::before]:border-t-line later:[&::before]:[transform:translateX(-50%)_rotate(45deg)] later:[&.flipped::before]:top-auto later:[&.flipped::before]:-bottom-[7px] [&.flipped::before]:border-0 [&.flipped::before]:border-r [&.flipped::before]:border-r-[#343b50] [&.flipped::before]:border-b [&.flipped::before]:border-b-[#343b50] ap-progress-popover later-2:p-[13px_14px_12px] later-2:[background:#111827] later-2:border-[#343e55] light:[background:#fff] light:border-line [&_.ap-status-label.ap-endorsed-label]:text-[15px]! [&_.ap-status-label.ap-endorsed-label]:tracking-[normal] [&_.ap-status-label.ap-endorsed-label]:normal-case max-[721px]:later-3:p-[11px_12px] ${pos.flipped ? ' flipped' : ''}`}
          role="tooltip"
          style={{ left: pos.left, top: pos.top, width: `min(${CARD_W}px, calc(100vw - 16px))`, '--arrow-x': `${pos.arrowX}px`, zIndex: 2147483000 }}
        >
          <div className="uppercase text-[color:var(--ap-muted)] [&_small]:tracking-[0] [&_small]:normal-case flex later:items-center justify-between gap-3 later:mb-[13px] later:text-[12px] font-[700] later:tracking-[.02em] later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap [.ap-progress-popover_&]:mb-3 [.ap-progress-popover_&]:flex [.ap-progress-popover_&]:items-center [.ap-progress-popover_&]:justify-between">
            <span>Applicant progress</span>
            {(detail?.inquiry || applicant.inquiry)?.converted_from_status === 'endorsed' && <small className="ap-status-label inline-flex items-center p-[4px_7px] border border-[#353e57] rounded-[6px] [background:#1a2133] text-[#c5c9ff]! text-[10px]! [&.ap-endorsed-label]:p-0 [&.ap-endorsed-label]:border-0 [&.ap-endorsed-label]:[background:none] [&.ap-endorsed-label]:text-[color:var(--info)]! [&.ap-endorsed-label]:text-[14px]! [&.ap-endorsed-label]:font-[600] ap-endorsed-label" title="Lead source: this inquiry was endorsed before it was converted. The application stage is shown in the tracker.">Endorsed lead</small>}
          </div>
          <ProgressRow label="Application stage" done={stagePercent} total={0} percent={stagePercent} />
          <ProgressRow
            label="Applicant Qualification Assessment"
            done={qualificationCompleted}
            total={QUALIFICATION_ITEMS.length}
            percent={Math.round((qualificationCompleted / QUALIFICATION_ITEMS.length) * 100)}
          />
          <ProgressRow
            label="Schedule activity"
            done={scheduleCount}
            total={scheduleTotal}
            percent={scheduleTotal ? Math.round((scheduleCount / scheduleTotal) * 100) : 0}
          />
          {detailLoading && <p className="m-[10px_0_0] text-[#8995ad] text-[10px] leading-[1.4]">Refreshing progress details…</p>}
          {!detailLoading && !detail?.milestones && !applicant.milestones && !fallbackScheduleTotal && (
            <p className="m-[10px_0_0] text-[#8995ad] text-[10px] leading-[1.4]">Detailed milestone progress appears as activities are added.</p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ---------------- Applicant Qualification Assessment ----------------
 * The five items belong to SALES (Phase 2): Sales checks them and clicks
 * [Save Applicant], which is the only action that records a date. Admin sees the
 * same items read-only, with the last saved date and who saved it, and confirms
 * the applicant as Qualified once all five are saved.
 */
function QualificationAssessment({ draft, onToggle, readOnly = false, log = [], isSalesRole = false }) {
  const completedCount = QUALIFICATION_ITEMS.filter(({ key }) => draft.milestones[key]).length;
  // The most recent saved row per item: the audit trail is append-only, so the
  // newest row is the current state and its date/user are what Admin trusts.
  const latest = {};
  (log || []).forEach((row) => {
    if (!latest[row.assessment_key]) latest[row.assessment_key] = row;
  });

  return (
    <section className={`ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] ap-qualification-section [&.is-read-only_.ap-check]:cursor-default [&.is-read-only_.ap-check]:opacity-[.9] [&_.ap-check]:items-start [&_.ap-check]:text-left [&_.ap-check_small]:block [&_.ap-check_small]:mt-[2px] [&_.ap-check_small]:text-[11px] [&_.ap-check_small]:font-[500] [&_.ap-check_small]:opacity-[.75] ${readOnly ? ' is-read-only' : ''}`}>
      <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
        <h3>Applicant Qualification Assessment</h3>
        <small>
          {completedCount} of {QUALIFICATION_ITEMS.length} {readOnly ? 'assessed' : 'checked'}
          {' · '}
          {isSalesRole ? 'Sales fills this, then Admin confirms' : 'Filled by Sales — read only'}
        </small>
      </div>
      <div className="m-[20px_0_16px] grid later:grid-cols-[repeat(2,_minmax(0,_1fr))] later:gap-[9px] later:mt-[15px] max-[721px]:later-2:grid-cols-[1fr] [#update-applicant-form_&]:gap-[7px] [#update-applicant-form_&]:mt-[11px] max-[721px]:[#update-applicant-form_&]:grid-cols-[1fr] [#update-applicant-form_.ap-qualification-section_&]:mt-0">
        {QUALIFICATION_ITEMS.map(({ key, label }) => {
          const checked = Boolean(draft.milestones[key]);
          const saved = checked ? latest[key] : null;
          return (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-readonly={readOnly || undefined}
              disabled={readOnly}
              className={`ap-check [border:1px_solid_var(--ap-border-2)] flex items-center later:gap-[10px] min-w-0 later:p-[11px_12px] later:border later:border-[#303749] later:rounded-[11px] later:[background:#191f2e] later:text-[#d4daea] text-left later:[font-family:inherit] later:[font-weight:inherit] [font-style:inherit] later:text-[12px] later:leading-[1.4] cursor-pointer later:[transition:background_.16s_ease,_border-color_.16s_ease] later-2:hover:border-[#6258c9] later:hover:[background:#1d2335] later-3:[&.checked]:border-[rgba(37,_199,_122,_.45)] later-2:[&.checked]:[background:rgba(37,_199,_122,_.07)] [#update-applicant-form_&]:gap-2 [#update-applicant-form_&]:p-[9px_10px] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&:hover]:[background:#202a40] [&.read-only]:cursor-default [&.read-only:hover]:[background:transparent] [&.read-only:hover]:border-[rgba(226,_232,_255,_.085)] later:[#update-applicant-form_&]:border-[#252e40] later:[#update-applicant-form_&]:rounded-[7px] later:[#update-applicant-form_&]:[background:#141b29] ${checked ? ' checked [&.checklist-item]:border-[color:color-mix(in_srgb,_var(--success)_32%,_transparent)] [&.checklist-item]:[background:color-mix(in_srgb,_var(--success)_7%,_transparent)] [&.checklist-item_.checklist-box]:[background:var(--success)] [&.checklist-item_.checklist-box]:border-success [&.checklist-item_.checklist-box]:text-[#04120c] [&.checklist-item_.checklist-copy_strong]:text-text' : ''}`}
              title={saved?.checked_at
                ? `Saved ${formatDate(saved.checked_at)}${saved.checked_by ? ` by ${saved.checked_by}` : ''}`
                : undefined}
              onClick={() => { if (!readOnly) onToggle(key); }}
            >
              <span className="place-items-center [border:1px_solid_var(--ap-border-2)] [&_svg]:m-0 later:inline-flex later:flex-[0_0_17px] later:w-[17px] later:h-[17px] items-center justify-center later:border later:border-[#4a5268] rounded-[5px] later:text-[#071a12] later:[background:#0d1220] later:text-[10px] later:[.ap-check.checked_&]:border-[#25c77a] later:[.ap-check.checked_&]:[background:#25c77a]" aria-hidden="true">{checked && <FaCheck />}</span>
              <span>
                {label}
                {saved?.checked_at && (
                  <small>Saved {formatDate(saved.checked_at)}{saved.checked_by ? ` · ${saved.checked_by}` : ''}</small>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">
        {isSalesRole && !readOnly
          ? 'Tick the accomplished items, then click SAVE CHANGES. Nothing is recorded until you save — closing the form keeps the last saved record.'
          : 'Only Sales can change these five items. Admin confirms the applicant as Qualified once all five are saved.'}
      </p>
    </section>
  );
}

/* ---------------- Schedule Activity section (Phase 3) ----------------
 * Exactly three tracked rows, each with a state badge from the API's
 * activity_state (Overdue is derived on the server).
 *
 * Attended is a DRAFT tick inside this modal: it is saved ONLY by Save
 * Applicant, so closing the modal records nothing. It can be ticked only after
 * Sales marked the activity Complete, and once saved it is locked forever.
 *
 * There is deliberately no Save Record button here and no per-activity "Set
 * Again": Set Again is an applicant-level action shown in the stage area.
 */
/* ---------------- Payment Record (no billing, no computation) ----------------
 * The system only records and verifies payments made outside it. Admin sets the required
 * payments (names only); the assigned Sales user records one entry per required payment;
 * Admin verifies or rejects each entry. No amount is stored, summed or compared here.
 */
const PAY_PRIMARY = 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[10px] text-[#fff] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50 disabled:cursor-not-allowed';
const PAY_SECONDARY = 'min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-[#3a4256] rounded-[10px] [background:#121826] text-[#d6dcea] font-[650] disabled:opacity-50 disabled:cursor-not-allowed';
const PAY_DANGER = 'min-h-[38px] inline-flex items-center justify-center p-[0_16px] border border-[rgba(248,_113,_113,_.6)] rounded-[10px] [background:transparent] text-[#f87171] font-[700] disabled:opacity-50 disabled:cursor-not-allowed';
const PAY_BADGE_TONE = {
  unpaid: 'text-[#f87171] [background:rgba(248,_113,_113,_.14)]',
  not_yet_paid: 'text-[#c3cbe0] [background:#232b3d]',
  for_verification: 'text-[#fbbf24] [background:rgba(251,_191,_36,_.14)]',
  rejected: 'text-[#f87171] [background:rgba(248,_113,_113,_.14)]',
  verified: 'text-[#45d991] [background:rgba(69,_217,_145,_.14)]',
  completed: 'text-[#45d991] [background:rgba(69,_217,_145,_.14)]',
  new: 'text-[#c3cbe0] [background:#232b3d]',
};
const PAY_INPUT = 'w-full min-h-[42px] p-[0_12px] border border-[#2a3550] rounded-[10px] [background:#0b111c] text-[#e7ebf5] placeholder:text-[#64708c]';

function PayBadge({ tone, children }) {
  return <span className={`inline-flex items-center whitespace-nowrap p-[3px_11px] rounded-[999px] text-[12px] font-[700] ${PAY_BADGE_TONE[tone] || PAY_BADGE_TONE.unpaid}`}>{children}</span>;
}
function PayChip({ children }) {
  return <span className="inline-flex p-[3px_11px] rounded-[8px] [background:#1c2435] text-[#d6dcea] text-[13px] font-[600]">{children}</span>;
}

/** Receipts are fetched through the API with role checks, then opened. */
async function openReceipt(applicantId, paymentId, document) {
  const token = await authToken.get();
  const response = await fetch(`${API_BASE_URL}/applicants/${applicantId}/payments/${paymentId}/documents/${document.id}/download`, {
    headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error('The receipt could not be opened.');
  const url = URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function ReceiptLinks({ applicantId, entry, busy, onError }) {
  if (entry.receipts === null) return <span className="text-[#8f9bbd]">Private</span>;
  if (!entry.receipts?.length) return <span className="text-[#fbbf24]">Legacy - no receipt captured</span>;
  return entry.receipts.map((doc) => (
    <button key={doc.id} type="button" disabled={busy} className="p-0 border-0 [background:none] text-[#7fa8ff] text-left underline-offset-2 hover:underline [overflow-wrap:anywhere]"
      onClick={() => openReceipt(applicantId, entry.id, doc).catch((error) => onError(error.message))}>
      {doc.original_name}
    </button>
  ));
}

function EntryDetails({ applicantId, entry, busy, onError }) {
  const cells = [
    ['Date paid', formatDate(entry.payment_date)],
    ['Method', entry.payment_method_label],
    ['Reference no.', entry.reference_number || '—'],
    ['OR / AR no.', entry.or_number || '—'],
    [entry.receipts?.length > 1 ? 'Receipts' : 'Receipt', <span key="r" className="grid gap-1 justify-items-start"><ReceiptLinks applicantId={applicantId} entry={entry} busy={busy} onError={onError} /></span>],
    ['Remarks', entry.remarks || '—'],
  ];
  return (
    <dl className="grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[14px_18px] m-[14px_0_0] max-[721px]:grid-cols-[repeat(2,_minmax(0,_1fr))]">
      {cells.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[#8f9bbd] text-[11px] font-[700] tracking-[.08em] uppercase">{label}</dt>
          <dd className="m-[3px_0_0] text-[#edf0fa] text-[15px] [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditLine({ entry }) {
  const parts = [];
  if (entry.recorded_by) parts.push(`Encoded by Sales · ${entry.recorded_by}${entry.recorded_at ? ` · ${manilaDateTimeLabel(entry.recorded_at)}` : ''}`);
  if (entry.verified_by) parts.push(`Verified by Admin · ${entry.verified_by}${entry.verified_at ? ` · ${manilaDateTimeLabel(entry.verified_at)}` : ''}`);
  if (entry.rejected_by) parts.push(`Rejected by Admin · ${entry.rejected_by}${entry.rejected_at ? ` · ${manilaDateTimeLabel(entry.rejected_at)}` : ''}`);
  if (!parts.length) return null;
  return <p className="m-[12px_0_0] text-[#8f9bbd] text-[13px]">{parts.join('  |  ')}</p>;
}

function RejectedNote({ entry }) {
  if (!entry || entry.status !== 'rejected') return null;
  return (
    <p className="m-[12px_0_0] p-[9px_12px] rounded-[9px] border border-[rgba(248,_113,_113,_.35)] [background:rgba(248,_113,_113,_.08)] text-[#fca5a5] text-[13.5px]" role="status">
      Rejected by Admin{entry.rejected_by ? ` (${entry.rejected_by})` : ''}: {entry.rejected_reason || 'No reason given.'}
    </p>
  );
}

/** Sales: the entry form for one required payment (new, resubmission, or an edit while For verification). */
function PaymentEntryForm({ item, record, existing, applicantId, busy, onCancel, onSend, onError }) {
  const editingEntry = Boolean(existing && existing.status === 'for_verification');
  const start = existing
    ? { payment_date: existing.payment_date || localDateInputValue(), payment_method: existing.payment_method || 'cash', or_number: existing.or_number || '', reference_number: existing.payment_method === 'cash' ? '' : (existing.reference_number || ''), remarks: existing.remarks || '' }
    : { payment_date: localDateInputValue(), payment_method: 'cash', or_number: '', reference_number: '', remarks: '' };
  const [form, setForm] = useState(start);
  // Receipts: up to 2. Saved ones (an entry being edited, or a rejected entry being corrected) stay unless removed.
  const [newReceipts, setNewReceipts] = useState([]);
  const [savedReceipts, setSavedReceipts] = useState(() => (existing?.receipts || []).filter(Boolean));
  const maxMb = record.receipt_rule?.max_mb || 10;
  const maxFiles = record.receipt_rule?.max_files || 2;
  const acceptList = record.receipt_rule?.accept || ['pdf', 'jpg', 'jpeg', 'png'];
  const validateReceipt = (file) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!acceptList.includes(ext)) return 'The receipt must be a PDF, JPG or PNG file.';
    if (file.size > maxMb * 1024 * 1024) return `The receipt may not be larger than ${maxMb} MB.`;
    return '';
  };
  const isCash = form.payment_method === 'cash';
  const receiptCount = newReceipts.length + savedReceipts.length;
  const ready = form.payment_date && form.payment_method && form.or_number.trim()
    && (isCash || form.reference_number.trim()) && receiptCount >= 1 && receiptCount <= maxFiles;
  const send = () => {
    const body = new FormData();
    body.append('required_payment_id', String(item.id));
    for (const key of ['payment_date', 'payment_method', 'or_number', 'remarks']) if (String(form[key] || '').trim()) body.append(key, String(form[key]).trim());
    if (!isCash && form.reference_number.trim()) body.append('reference_number', form.reference_number.trim());
    // Always sent, so the API knows exactly which earlier receipts stay (empty = none).
    body.append('keep_receipt_ids', savedReceipts.map((d) => d.id).join(','));
    for (const file of newReceipts) body.append('receipt', file);
    onSend(body);
  };
  // Labels align to the top of their grid cell, so neighbouring fields share the same top edge.
  const label = 'grid gap-[6px] content-start self-start text-[#c9d0e0] text-[13.5px] font-[600]';
  return (
    <div className="mt-[14px] grid gap-[14px]">
      <div className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] items-start gap-[14px_18px] max-[721px]:grid-cols-[1fr]">
        <label className={label}>Date paid *
          <input className={PAY_INPUT} type="date" max={localDateInputValue()} value={form.payment_date} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} />
        </label>
        <label className={label}>Method *
          <select
            className={PAY_INPUT}
            value={form.payment_method}
            onChange={(e) => setForm({ ...form, payment_method: e.target.value, reference_number: e.target.value === 'cash' ? '' : form.reference_number })}
          >
            {Object.entries(record.methods || {}).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <label className={label}>{isCash ? 'Reference number (not needed for cash)' : 'Reference number *'}
          <input
            className={`${PAY_INPUT} disabled:opacity-45 disabled:cursor-not-allowed disabled:[background:#161c29]`}
            placeholder={isCash ? 'Not needed for cash' : 'e.g. 0034 8821'}
            disabled={isCash}
            aria-disabled={isCash}
            value={isCash ? '' : form.reference_number}
            onChange={(e) => setForm({ ...form, reference_number: e.target.value })}
          />
        </label>
        <label className={label}>OR / AR number *
          <input className={PAY_INPUT} placeholder="e.g. AR-0462" value={form.or_number} onChange={(e) => setForm({ ...form, or_number: e.target.value })} />
        </label>
        <div className="self-start">
          <RequirementFileDrop
            label="Receipt"
            required
            multiple
            replaceable
            max={maxFiles}
            accept={acceptList.map((ext) => `.${ext}`).join(',')}
            files={newReceipts}
            onChange={setNewReceipts}
            saved={savedReceipts}
            onSavedChange={setSavedReceipts}
            onViewSaved={(doc) => openReceipt(applicantId, existing.id, doc).catch((error) => onError(error.message))}
            validate={validateReceipt}
            disabled={busy}
            hint={`PDF, JPG or PNG, up to ${maxMb} MB each · at least 1, at most ${maxFiles} files`}
          />
        </div>
        <label className={label}>Remarks
          <textarea className={`${PAY_INPUT} h-[42px] p-[10px_12px] leading-[1.35] resize-y`} rows={1} placeholder="Optional" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-[14px] border-t border-t-[#232c40]">
        <p className="m-0 flex-[1_1_320px] text-[#8f9bbd] text-[13px]">
          After you submit, the entry goes to Admin as For verification. If Admin rejects it, the reason shows here and you can correct and resubmit.
        </p>
        <span className="flex gap-[10px]">
          <button type="button" className={PAY_SECONDARY} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={PAY_PRIMARY} disabled={busy || !ready} title={receiptCount < 1 ? 'Attach at least 1 receipt.' : ''} onClick={send}>{editingEntry ? 'Save changes' : 'Submit for verification'}</button>
        </span>
      </div>
    </div>
  );
}

/** Admin: reason + Reject / Verify payment on an entry that is For verification. */
function VerificationBox({ entry, busy, onVerify, onReject }) {
  const [reason, setReason] = useState('');
  const canReject = reason.trim().length >= 5;
  return (
    <div className="flex flex-wrap items-center gap-3 mt-[14px] pt-[14px] border-t border-t-[#232c40]">
      <label className="flex flex-[1_1_360px] items-center gap-3 text-[#8f9bbd] text-[13.5px]">
        <span className="whitespace-nowrap">Reason (required to reject)</span>
        <input className={PAY_INPUT} placeholder="e.g. Receipt unreadable" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="button" className={PAY_DANGER} disabled={busy || !canReject} title={canReject ? '' : 'Enter a reason of at least 5 characters.'} onClick={() => { onReject(entry, reason.trim()); setReason(''); }}>Reject</button>
      <button type="button" className={PAY_PRIMARY} disabled={busy} onClick={() => onVerify(entry)}>Verify payment</button>
    </div>
  );
}

/** A payment_record payload in the current (no-billing) shape. */
const isPaymentRecord = (value) => Boolean(value && Array.isArray(value.required) && typeof value.badge === 'string');

function PaymentRecordPanel({ editing, isAdminRole = false, readOnly = false, busy, onEditRequired, onSubmitEntry, onEditEntry, onVerify, onReject, onMove, onError }) {
  const embedded = isPaymentRecord(editing?.payment_record) ? editing.payment_record : null;
  // The card reads GET /payment-record itself, so a failure shows here instead of hiding every action.
  const [loaded, setLoaded] = useState({ key: null, record: null, error: '' });
  // { id, mode: 'record' | 'edit' }; { id: -1 } means "no form" after Cancel.
  const [formFor, setFormFor] = useState(null);
  const loadKey = `${editing?.id}:${editing?.updated_at ?? ''}:${JSON.stringify(editing?.payment_record?.required?.map((r) => [r.id, r.status, r.entry?.revision]) ?? null)}`;
  useEffect(() => {
    if (!editing?.id) return undefined;
    let cancelled = false;
    api.get(`/applicants/${editing.id}/payment-record`)
      .then((result) => {
        if (cancelled) return;
        if (isPaymentRecord(result?.data)) setLoaded({ key: loadKey, record: result.data, error: '' });
        else setLoaded({ key: loadKey, record: null, error: 'The server sent the Payment Record in an older format. The API may need to be redeployed; reload the page afterwards.' });
      })
      .catch((error) => { if (!cancelled) setLoaded({ key: loadKey, record: null, error: firstValidationMessage(error) || 'The Payment Record could not be loaded.' }); });
    return () => { cancelled = true; };
  }, [editing?.id, loadKey]);
  const fresh = loaded.key === loadKey ? loaded : { record: null, error: '' };
  const record = fresh.record || embedded;
  if (!record) {
    return (
      <section className="ap-section m-[0_0_17px] p-[20px_22px] border border-[#2a3041] rounded-[13px] [background:#141a28] text-[14px] text-[#c9d0e0]" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="m-0 text-[0.8rem] tracking-[0.09em] uppercase text-[#edf0fa] font-[800]">Payment Record</h3>
          <PayBadge tone="unpaid">Unpaid</PayBadge>
        </div>
        {fresh.error
          ? <p className="m-[12px_0_0] p-[10px_12px] rounded-[9px] border border-[rgba(248,_113,_113,_.35)] [background:rgba(248,_113,_113,_.08)] text-[#fca5a5]" role="alert">{fresh.error}</p>
          : <p className="m-[12px_0_0] text-[#9aa6c4]">Loading the Payment Record…</p>}
      </section>
    );
  }
  const required = record.required || [];
  const salesView = !isAdminRole;
  const nextToRecord = required.find((item) => item.can_record) || null;
  const activeForm = readOnly ? null : (formFor || (record.can_record && nextToRecord ? { id: nextToRecord.id, mode: 'record' } : null));
  const openLoi = () => fetchApplicantDocument(editing.id, record.loi_document)
    .then((blob) => { const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); window.setTimeout(() => URL.revokeObjectURL(url), 60000); })
    .catch((error) => onError(error.message));
  const send = (body, mode, entry) => {
    if (mode === 'edit') onEditEntry(entry.id, body); else onSubmitEntry(body);
    setFormFor(null);
  };

  return (
    <section className="ap-section m-[0_0_17px] p-[20px_22px] border border-[#2a3041] rounded-[13px] [background:#0C111D] text-[14px] leading-[1.5] text-[#c9d0e0]" aria-labelledby="ap-payment-record-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="ap-payment-record-title" className="m-0 text-[1rem] tracking-[0.09em] uppercase text-[#edf0fa] font-[800]">Payment Record</h3>
        <PayBadge tone={record.badge || 'unpaid'}>{record.badge_label || 'Unpaid'}</PayBadge>
      </div>
      {fresh.error && <p className="m-[10px_0_0] p-[9px_12px] rounded-[9px] border border-[rgba(248,_113,_113,_.35)] [background:rgba(248,_113,_113,_.08)] text-[#fca5a5] text-[13.5px]" role="alert">Could not refresh the Payment Record: {fresh.error}</p>}
      {salesView && <p className="m-[10px_0_0] text-[#9aa6c4]">Record payments the applicant made outside the system. Admin verifies each entry before the applicant can move forward.</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 mt-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#9aa6c4]">{salesView ? 'Required payments (set by Admin):' : 'Required payments:'}</span>
          {required.length
            ? required.map((item) => <PayChip key={item.id}>{item.name}</PayChip>)
            : <span className="text-[#fbbf24]">{record.legacy_confirmed ? 'None (confirmed under the older flow)' : 'Not set yet'}</span>}
        </div>
        {!readOnly && record.can_edit_required && (
          <button type="button" className={`${PAY_SECONDARY} text-[#a9c1ff]! hover:border-[#5b6a8f] hover:[background:#1c2435]`} disabled={busy} onClick={onEditRequired}>Edit required payments</button>
        )}
      </div>

      {(record.basis_note || record.loi_document || record.loi_file_missing) && (
        <p className="m-[10px_0_0] text-[#9aa6c4] text-[13.5px]">
          {record.basis_note && <>Package or basis: <strong className="text-[#d6dcea] font-[600]">{record.basis_note}</strong></>}
          {record.basis_note && (record.loi_document || record.loi_file_missing) && ' · '}
          {record.loi_document && (
            <button type="button" className="p-0 border-0 [background:none] text-[#7fa8ff] hover:underline" onClick={openLoi}>Open signed LOI ({record.loi_document.original_name})</button>
          )}
          {!record.loi_document && record.loi_file_missing && <span className="text-[#fbbf24]">No LOI file on record</span>}
          <span className="block text-[12px] text-[#7b86a3]">Reference only, to check the amount to collect. The system does not store or compute amounts.</span>
        </p>
      )}

      <div className="grid gap-[14px] mt-[16px]">
        {required.map((item) => {
          const entry = item.entry;
          const formHere = Boolean(activeForm && activeForm.id === item.id);
          // Sales: Verified items collapse into one locked row.
          if (salesView && item.status === 'verified' && entry) {
            return (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-[14px_18px] border border-[#252e42] rounded-[11px] [background:#111727]">
                <span className="flex flex-wrap items-baseline gap-3 min-w-0">
                  <strong className="text-[#edf0fa] text-[16px]">{item.name}</strong>
                  <span className="text-[#8f9bbd] text-[13px] [overflow-wrap:anywhere]">
                    {[formatDate(entry.payment_date), entry.payment_method_label, entry.or_number].filter(Boolean).join(' · ')}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]"><ReceiptLinks applicantId={editing.id} entry={entry} busy={busy} onError={onError} /></span>
                </span>
                <PayBadge tone="verified">Verified · locked</PayBadge>
              </div>
            );
          }
          const highlighted = formHere || (isAdminRole && entry?.reviewable && !readOnly);
          return (
            <article key={item.id} className={`p-[16px_20px] border rounded-[6px] [background:#111727] ${highlighted ? 'border-[#3b5bd9]' : 'border-[#252e42]'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong className="text-[#edf0fa] text-[17px]">{item.name}</strong>
                <span className="flex items-center gap-2">
                  {salesView && entry?.editable && !formHere && !readOnly && (
                    <button type="button" className={PAY_SECONDARY} disabled={busy} onClick={() => setFormFor({ id: item.id, mode: 'edit' })}>Edit entry</button>
                  )}
                  {salesView && item.can_record && !formHere && !readOnly && (
                    <button type="button" className={PAY_SECONDARY} disabled={busy} onClick={() => setFormFor({ id: item.id, mode: 'record' })}>{item.status === 'rejected' ? 'Correct and resubmit' : 'Record payment'}</button>
                  )}
                  <PayBadge tone={item.status}>{item.status_label}</PayBadge>
                </span>
              </div>
              {formHere && <p className="m-[6px_0_0] text-[#a9c1ff] text-[13px] font-[700]">Recording: {item.name}</p>}
              <RejectedNote entry={entry} />
              {entry && !formHere && (
                <>
                  <EntryDetails applicantId={editing.id} entry={entry} busy={busy} onError={onError} />
                  <AuditLine entry={entry} />
                </>
              )}
              {!entry && !formHere && (
                <p className="m-[10px_0_0] text-[#8f9bbd] text-[13.5px]">{salesView ? 'Not yet recorded.' : 'Waiting for Sales to record this payment.'}</p>
              )}
              {formHere && (
                <PaymentEntryForm
                  key={`${item.id}-${activeForm.mode}-${entry?.revision ?? 0}`}
                  item={item}
                  record={record}
                  existing={activeForm.mode === 'edit' || entry?.status === 'rejected' ? entry : null}
                  applicantId={editing.id}
                  onError={onError}
                  busy={busy}
                  onCancel={() => setFormFor({ id: -1, mode: 'record' })}
                  onSend={(body) => send(body, activeForm.mode, entry)}
                />
              )}
              {!readOnly && isAdminRole && entry?.reviewable && (
                <VerificationBox key={`${entry.id}-${entry.revision}`} entry={entry} busy={busy} onVerify={onVerify} onReject={onReject} />
              )}
              {!readOnly && isAdminRole && entry?.status === 'for_verification' && !entry.reviewable && (
                <p className="m-[10px_0_0] text-[#fbbf24] text-[13px]">You encoded this entry, so another Admin must verify it.</p>
              )}
              {item.history?.length > 0 && (
                <details className="mt-[12px] text-[13px] text-[#8f9bbd]">
                  <summary className="cursor-pointer">Earlier submissions ({item.history.length})</summary>
                  <ul className="m-[6px_0_0] p-[0_0_0_18px] grid gap-1">
                    {item.history.map((h) => (
                      <li key={h.id}>
                        {formatDate(h.payment_date)} · {h.payment_method_label} · OR/AR {h.or_number || '—'} · {h.status_label}
                        {h.rejected_reason ? ` — ${h.rejected_reason}` : ''}{h.rejected_by ? ` (${h.rejected_by}${h.rejected_at ? `, ${manilaDateTimeLabel(h.rejected_at)}` : ''})` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>

      {(record.earlier_entries || []).length > 0 && (
        <details className="mt-[14px] p-[12px_16px] border border-[#252e42] rounded-[11px] [background:#0f1522]">
          <summary className="cursor-pointer text-[#c9d0e0] font-[650]">Earlier entries ({record.earlier_entries.length}) — recorded before required payments, read-only</summary>
          <div className="table-wrap overflow-x-auto mt-2">
            <table className="w-full text-[13.5px]">
              <thead><tr><th>Date</th><th>Method</th><th>OR/AR no.</th><th>Reference no.</th><th>Receipt</th><th>Status</th></tr></thead>
              <tbody>
                {record.earlier_entries.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.payment_date)}</td>
                    <td>{p.payment_method_label}</td>
                    <td>{p.or_number || '—'}</td>
                    <td>{p.reference_number || '—'}</td>
                    <td><ReceiptLinks applicantId={editing.id} entry={p} busy={busy} onError={onError} /></td>
                    <td>{p.status_label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mt-[16px] p-[14px_18px] border border-dashed border-[#2a3550] rounded-[11px] [background:#0f1522]">
        <p className="m-0 flex-[1_1_320px] text-[#c9d0e0]">
          {record.required_count
            ? <><strong className="text-[#edf0fa]">{record.verified_count} of {record.required_count}</strong> required payments verified. </>
            : <><strong className="text-[#edf0fa]">No required payments set.</strong> </>}
          {readOnly ? '' : 'The applicant moves to For Approval once all required payments are Verified.'}
        </p>
        {!readOnly && isAdminRole && editing.status === 'payment_submitted' && (
          <button type="button" className={`${PAY_PRIMARY} disabled:[background:#070A13]!`} disabled={busy || !record.can_move} title={record.can_move ? 'Every required payment is Verified.' : (record.move_blocker || '')} onClick={onMove}>
            Move to For Approval
          </button>
        )}
      </div>
      {!readOnly && isAdminRole && !record.can_move && record.move_blocker && (
        <p className="m-[8px_0_0] text-[#8f9bbd] text-[12.5px]">{record.move_blocker}</p>
      )}

      {(record.history || []).length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-[#9aa6c4]">Payment Record history ({record.history.length})</summary>
          <ul className="m-[6px_0_0] p-[0_0_0_18px] grid gap-1">
            {record.history.map((h) => (
              <li key={h.id}>
                {manilaDateTimeLabel(h.changed_at)} · {h.by_name || 'System'}{h.actor_role ? ` (${titleCase(h.actor_role)})` : ''} · {h.action || titleCase(String(h.event || 'stage change').replace(/^payment_/, '').replace(/_/g, ' '))}
                {h.remarks ? ` — ${h.remarks}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Admin: choose which payments this applicant must complete. Names only — no amounts. */
function EditRequiredPaymentsModal({ applicant, record, busy, onCancel, onSave }) {
  const toRow = (item) => ({ key: `id-${item.id}`, id: item.id, name: item.name, locked: item.locked, lockLabel: item.lock_label, status: item.status });
  const [rows, setRows] = useState(() => (record.required || []).map(toRow));
  const [preset, setPreset] = useState(record.preset || '');
  const [note, setNote] = useState(record.basis_note || '');
  const nextKey = useRef(0);
  const newRow = (name = '') => { nextKey.current += 1; return { key: `new-${nextKey.current}`, id: null, name, locked: false, lockLabel: null, status: null }; };
  const applyPreset = (value) => {
    setPreset(value);
    const option = (record.preset_options || []).find((o) => o.value === value);
    if (!option || !option.items.length) return; // Custom keeps the current list
    const locked = rows.filter((r) => r.locked);
    const taken = new Set(locked.map((r) => r.name.toLowerCase()));
    const existing = new Map(rows.filter((r) => !r.locked && r.id).map((r) => [r.name.toLowerCase(), r]));
    setRows([...locked, ...option.items.filter((name) => !taken.has(name.toLowerCase())).map((name) => existing.get(name.toLowerCase()) || newRow(name))]);
  };
  const update = (key, name) => { setRows(rows.map((r) => (r.key === key ? { ...r, name } : r))); setPreset('custom'); };
  const remove = (key) => { setRows(rows.filter((r) => r.key !== key)); setPreset('custom'); };
  const moveRow = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
  };
  const names = rows.map((r) => r.name.trim().toLowerCase());
  let issue = '';
  if (rows.some((r) => !r.name.trim())) issue = 'Enter a name for every required payment, or remove the empty row.';
  else if (names.some((name, i) => names.indexOf(name) !== i)) issue = 'Each required payment must have a different name.';
  else if (rows.some((r) => /^[\d\s.,₱$-]+$/.test(r.name.trim()))) issue = 'A required payment is a name (e.g. "Reservation Fee"), not an amount.';
  const save = () => onSave({
    preset: preset || null,
    items: rows.map((r) => (r.id ? { id: r.id, name: r.name.trim() } : { name: r.name.trim() })),
    basis_note: note.trim() || null,
  });
  const subtitle = [
    applicant.full_name && <strong key="name" className="font-[700] text-[#D4AF37]">{applicant.full_name}</strong>,
    applicant.applicant_code,
    applicant.preferred_brand?.name && <strong key="brand" className="font-[700]" style={{ color: brandColor(applicant.preferred_brand.name) }}>{applicant.preferred_brand.name}</strong>,
  ].filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part]));

  return (
    <Dialog
      title="Edit required payments"
      onClose={onCancel}
      size="medium"
      zIndex={2147482500}
      animated
      footer={(
        <>
          <button type="button" className={PAY_SECONDARY} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={PAY_PRIMARY} disabled={busy || Boolean(issue)} title={issue} onClick={save}>Save required payments</button>
        </>
      )}
    >
      <p className="m-0 text-[#9aa6c4] text-[14px]">{subtitle}. Choose which payments this applicant must complete. No amounts are set or computed here.</p>
      <label className="grid gap-[6px] mt-[16px] text-[#c9d0e0] text-[13.5px] font-[600]">Payment plan
        <select className={`${PAY_INPUT} cursor-pointer transition-[border-color,box-shadow,background] duration-200 ease-out hover:border-[#4a5a80] hover:[background:#111a2b] focus:outline-none focus:border-[#5b7bd9] focus:shadow-[0_0_0_3px_rgba(91,_123,_217,_.18)]`} value={preset} onChange={(e) => applyPreset(e.target.value)}>
          <option value="">Choose a plan…</option>
          {(record.preset_options || []).map((o) => <option key={o.value} value={o.value}>{o.label}{o.items.length ? ` (${o.items.join(', ')})` : ''}</option>)}
        </select>
      </label>
      <ol className="grid gap-[10px] m-[16px_0_0] p-0 [list-style:none]">
        {rows.map((row, index) => (
          <li key={row.key} className="grid grid-cols-[22px_minmax(0,_1fr)_auto_auto] items-center gap-[10px] max-[561px]:grid-cols-[22px_minmax(0,_1fr)_auto]">
            <span className="text-[#8f9bbd] text-[14px]">{index + 1}</span>
            <input className={PAY_INPUT} value={row.name} disabled={row.locked} maxLength={80} placeholder="Payment name, e.g. 2nd Installment" aria-label={`Required payment ${index + 1}`} onChange={(e) => update(row.key, e.target.value)} />
            <span className="flex items-center gap-[6px] max-[561px]:col-start-2">
              {row.locked && <PayBadge tone={row.status === 'verified' ? 'verified' : 'for_verification'}>{row.lockLabel}</PayBadge>}
              {!row.locked && !row.id && <PayBadge tone="new">New</PayBadge>}
              <button type="button" className="w-[30px] h-[30px] border border-[#2a3550] rounded-[8px] [background:#121826] text-[#9aa6c4] transition-[background,border-color,color,transform] duration-150 ease-out enabled:hover:-translate-y-px enabled:hover:border-[#5b7bd9] enabled:hover:text-[#a9c1ff] enabled:hover:[background:#1c2640] enabled:active:translate-y-0 enabled:active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed" disabled={index === 0} aria-label="Move up" onClick={() => moveRow(index, -1)}>↑</button>
              <button type="button" className="w-[30px] h-[30px] border border-[#2a3550] rounded-[8px] [background:#121826] text-[#9aa6c4] transition-[background,border-color,color,transform] duration-150 ease-out enabled:hover:translate-y-px enabled:hover:border-[#5b7bd9] enabled:hover:text-[#a9c1ff] enabled:hover:[background:#1c2640] enabled:active:translate-y-0 enabled:active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed" disabled={index === rows.length - 1} aria-label="Move down" onClick={() => moveRow(index, 1)}>↓</button>
            </span>
            <button
              type="button"
              className={`w-[40px] h-[40px] inline-grid place-items-center rounded-[9px] border [background:#121826] transition-[background,border-color,color,transform,box-shadow] duration-150 ease-out ${row.locked ? 'border-[#2a3550] text-[#4d5872] cursor-not-allowed' : 'border-[rgba(248,_113,_113,_.6)] text-[#f87171] enabled:hover:[background:rgba(248,_113,_113,_.14)] enabled:hover:border-[#f87171] enabled:hover:shadow-[0_0_0_3px_rgba(248,_113,_113,_.14)] enabled:hover:-translate-y-px enabled:active:translate-y-0 enabled:active:scale-95'}`}
              disabled={row.locked}
              title={row.locked ? 'This payment already has an entry, so it cannot be removed.' : 'Remove'}
              aria-label={`Remove ${row.name || 'row'}`}
              onClick={() => remove(row.key)}
            >
              <FaXmark aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="mt-[14px] min-h-[42px] p-[0_18px] border border-dashed border-[#3a4660] rounded-[10px] [background:transparent] text-[#a9c1ff] font-[700]" onClick={() => { setRows([...rows, newRow()]); setPreset('custom'); }}>
        + Add required payment
      </button>
      <hr className="my-[18px] border-0 border-t border-t-[#232c40]" />
      <label className="grid gap-[6px] text-[#c9d0e0] text-[13.5px] font-[600]">Package or basis (optional, text only)
        <input className={PAY_INPUT} maxLength={500} placeholder="e.g. Package B, per signed LOI" value={note} onChange={(e) => setNote(e.target.value)} />
        <small className="text-[#8f9bbd] font-[500]">A reference note for Sales and Admin. It is not a number and is never added, compared, or reported.</small>
      </label>
      <p className="m-[16px_0_0] p-[12px_14px] border border-dashed border-[#2a3550] rounded-[10px] text-[#9aa6c4] text-[13px]">
        Payments that already have entries can&apos;t be renamed or removed. Every change is logged with your name and the date.
      </p>
      {issue && <p className="m-[10px_0_0] text-[#ff9ca3] text-[13px]" role="alert">{issue}</p>}
    </Dialog>
  );
}

const REQUIREMENT_STATUS = {
  pending: { label: 'Pending', tone: 'text-[#9aa6c4] border-[#3a4256]', color: '#9aa6c4' },
  submitted: { label: 'Submitted', tone: 'text-[#8fb4ff] border-[rgba(143,_180,_255,_.45)]', color: '#4f8dff' },
  accepted: { label: 'Accepted', tone: 'text-[#45d991] border-transparent', color: '#45d991' },
  returned: { label: 'Returned', tone: 'text-[#fbbf24] border-transparent', color: '#fbbf24' },
};

/** Requirement files are fetched through the API with role checks, then opened. */
async function openRequirementFile(applicantId, key, document) {
  const token = await authToken.get();
  const response = await fetch(`${API_BASE_URL}/applicants/${applicantId}/requirements/${key}/documents/${document.id}/download`, {
    headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error('The file could not be opened.');
  const url = URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** In-app preview of a requirement file: zoom, rotate, and full screen. Fetched as a blob, same route as the download. */
function RequirementPreview({ open, applicantId, requirementKey, doc, onClose, onError }) {
  const [src, setSrc] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  useEffect(() => {
    if (!open || !doc) return undefined;
    let url = null;
    let cancelled = false;
    (async () => {
      try {
        const token = await authToken.get();
        const response = await fetch(`${API_BASE_URL}/applicants/${applicantId}/requirements/${requirementKey}/documents/${doc.id}/download`, {
          headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (!response.ok) throw new Error('The file could not be previewed.');
        url = URL.createObjectURL(await response.blob());
        if (!cancelled) setSrc(url); else URL.revokeObjectURL(url);
      } catch (error) {
        onError(error.message);
        onClose();
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); setSrc(null); };
  }, [open, doc?.id, applicantId, requirementKey]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open || !doc) return null;
  const isPdf = (doc.mime_type || '').includes('pdf');
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center p-[20px] [background:rgba(4,6,12,0.82)]" onClick={onClose}>
      <div className="relative w-[min(1000px,_100%)] h-[min(86dvh,_100%)] grid grid-rows-[auto_1fr] gap-[10px] p-[12px] border border-[#2a3041] rounded-[13px] [background:#0c111d]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="truncate text-[#edf0fa] text-[14px]">{doc.original_name}</span>
          <span className="flex items-center gap-2">
            {!isPdf && <button type="button" className="min-h-[30px] p-[0_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[12px]" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>}
            {!isPdf && <button type="button" className="min-h-[30px] p-[0_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[12px]" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>}
            {!isPdf && <button type="button" className="min-h-[30px] p-[0_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[12px]" onClick={() => setRotate((r) => (r + 90) % 360)}>Rotate</button>}
            {src && <a href={src} download={doc.original_name} className="min-h-[30px] inline-flex items-center p-[0_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[12px] no-underline">Download</a>}
            {src && <a href={src} target="_blank" rel="noopener noreferrer" className="min-h-[30px] inline-flex items-center p-[0_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[12px] no-underline">Open full screen</a>}
            <button type="button" className="min-h-[30px] p-[0_10px] border border-[#2b344c] rounded-[8px] bg-transparent text-[#c9d0e0] text-[12px]" onClick={onClose}>Close</button>
          </span>
        </div>
        <div className="min-h-0 overflow-auto grid place-items-center">
          {!src && <span className="text-muted">Loading…</span>}
          {src && (isPdf ? <iframe title={doc.original_name} src={src} className="w-full h-full border-0" /> : <img alt={doc.original_name} src={src} className="max-w-full max-h-full transition-transform" style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }} />)}
        </div>
      </div>
    </div>
  );
}

/** Drop zone for requirement files: pick from File manager or drag and drop. Staged files can be viewed or removed before sending. */

function RequirementStatus({ status }) {
  const info = REQUIREMENT_STATUS[status] || REQUIREMENT_STATUS.pending;
  return <span className={`inline-flex p-[2px_10px] rounded-[999px] border text-[12px] font-[700] ${info.tone}`}>{info.label}</span>;
}

/**
 * Requirements of one stage: details + proof files submitted by the assigned Sales user,
 * Accepted or Returned (with a reason) by Admin. The list itself comes from the API config.
 */
/** Current residence (from the inquiry) and the preferred franchise location, which Sales or Admin may add later. */
function ApplicantLocations({ editing, canEdit, busy, onSave }) {
  const [draft, setDraft] = useState(null);
  return (
    <div className="col-span-full grid gap-[8px] p-[12px_14px] border border-[#2b344c] rounded-[11px] [background:#0c111d] text-[13px]">
      <div className="flex justify-between gap-4 flex-wrap"><span className="text-[#8f9bbd]">Current residence</span><span className="text-right text-[#e6eaf5]"><LocationValue loc={editing.residence_location} legacy={editing.address} empty="—" /></span></div>
      <div className="flex justify-between gap-4 flex-wrap items-center">
        <span className="text-[#8f9bbd]">Preferred franchise location</span>
        <span className="inline-flex items-center gap-2 text-right text-[#e6eaf5]">
          <LocationValue loc={editing.preferred_location} noneMarked={editing.no_preferred_location} empty="—" />
          {canEdit && !draft && (
            <button type="button" className="text-[12px] font-[600] text-[#8fb4ff] bg-transparent border-0 cursor-pointer hover:underline disabled:opacity-50" disabled={busy}
              onClick={() => setDraft({ ...(editing.preferred_location || {}) })}>{editing.preferred_location?.city_code ? 'Change' : 'Add'}</button>
          )}
        </span>
      </div>
      {draft && (
        <div className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[10px] max-[681px]:grid-cols-[1fr]">
          <LocationPicker value={draft} onChange={setDraft} labels={{ barangay: 'Barangay/area' }} barangayPlaceholder="Barangay/area (Optional)" />
          <span className="col-span-full flex justify-end gap-2">
            <button type="button" className="min-h-[32px] p-[0_14px] border border-[#2b344c] rounded-[8px] bg-transparent text-[#c9d0e0] text-[12px] font-[600] disabled:opacity-50" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="min-h-[32px] p-[0_14px] border border-[#3b5bdb] rounded-[8px] bg-[#1e3a8a] text-white text-[12px] font-[600] disabled:opacity-50" disabled={busy}
              onClick={async () => { await onSave({ preferred_location: locationInput(draft) }); setDraft(null); }}>Save location</button>
          </span>
          {!draft.city_code && <small className="col-span-full text-muted">No City/Municipality: saved as "No preferred location yet".</small>}
        </div>
      )}
    </div>
  );
}

function RequirementsPanel({ editing, stage, isAdminRole, isAssignedSales, busy, onSubmit, onAccept, onReturn, onReopen, onError, readOnly = false, title = null }) {
  const { user } = useAuth();
  const [editingKey, setEditingKey] = useState(null);
  const [values, setValues] = useState({});
  const [returningKey, setReturningKey] = useState(null);
  const [reason, setReason] = useState('');
  const [reviewKey, setReviewKey] = useState(null);
  const [collapsedKeys, setCollapsedKeys] = useState({});
  const [reviewNote, setReviewNote] = useState('');
  const [reopening, setReopening] = useState(false);
  const [acceptConfirm, setAcceptConfirm] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);
  const req = editing?.requirements;
  // Admin keyboard shortcuts on the Qualification review: Up/Down move, A accepts, R focuses the return note.
  useEffect(() => {
    if (!req || !isAdminRole || readOnly || stage !== 'qualification') return undefined;
    const keys = req.config.requirements.filter((def) => def.stage === 'qualification').map((def) => def.key);
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      const current = reviewKey && keys.includes(reviewKey) ? reviewKey : keys[0];
      const item = req.items.find((i) => i.key === current);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const index = keys.indexOf(current);
        setReviewKey(keys[(index + (e.key === 'ArrowDown' ? 1 : keys.length - 1)) % keys.length]);
        setReviewNote(''); setReturningKey(null); setReopening(false);
      } else if (e.key.toLowerCase() === 'a' && item?.status === 'submitted' && !busy) {
        onAccept(current, reviewNote.trim());
      } else if (e.key.toLowerCase() === 'r' && item?.status === 'submitted') {
        document.getElementById('qualification-return-note')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!req) return null;
  const stageInfo = req.config.stages[stage];
  const defs = req.config.requirements.filter((def) => def.stage === stage);
  const summary = req.summary[stage] || {};
  const itemOf = (key) => req.items.find((item) => item.key === key) || { status: 'pending', data: {} };
  const optionLabel = (field, value) => field.options?.find((o) => o.value === value)?.label || value;
  const shownValue = (field, item) => (field.type === 'location'
    ? (item.data?.[field.key]?.city_code ? formatLocation(item.data[field.key]) : (locationPlain(null, item.data?.address) || null))
    : item.data?.[field.key] ? (field.type === 'date' ? formatDate(item.data[field.key]) : optionLabel(field, item.data[field.key])) : null);
  const startEdit = (def) => {
    const item = itemOf(def.key);
    setEditingKey(def.key);
    setValues(Object.fromEntries(def.fields.map((field) => [field.key, field.type === 'location'
      ? (item.data?.[field.key]?.city_code ? item.data[field.key] : { ...(item.location_prefill || {}) })
      : (item.data?.[field.key] || '')])));
  };
  const send = (def) => {
    const body = new FormData();
    for (const field of def.fields) {
      if (field.type === 'location') {
        // Province and City/Municipality codes + the Barangay/St text (the API fills the names).
        const loc = values[field.key] || {};
        for (const key of ['province_code', 'city_code', 'barangay']) if (loc[key]) body.append(`${field.key}.${key}`, String(loc[key]).trim());
        continue;
      }
      if (values[field.key] && (!field.show_when || values[field.show_when.key] === field.show_when.value)) body.append(field.key, values[field.key]);
    }
    for (const slot of def.files) for (const file of values[`file:${slot.key}`] || []) body.append(slot.key, file);
    onSubmit(def.key, body);
    setEditingKey(null);
  };
  const accepted = defs.filter((def) => itemOf(def.key).status === 'accepted').length;
  const adminReview = isAdminRole && !readOnly && stage === 'qualification' && !summary.legacy && defs.length > 0;

  if (adminReview) {
    const activeDef = defs.find((def) => def.key === reviewKey) || defs[0];
    const activeItem = itemOf(activeDef.key);
    const canDecide = activeItem.status === 'submitted';
    const sameNote = reviewNote.trim();
    const missingCount = defs.length - accepted;
    const reviewHeader = (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">{stageInfo?.label} requirements</h3>
        <small className="text-[#9ba5bd]">{accepted} of {defs.length} accepted · {missingCount} awaiting review</small>
        <div className="w-full h-px [background:#2a3041]" />
      </div>
    );
    return (
      <section className="ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] [background:#0C111D] text-[14px] leading-[1.5] text-[#c9d0e0]">
        <RequirementPreview
          open={Boolean(previewDoc)}
          applicantId={editing.id}
          requirementKey={previewDoc?.key}
          doc={previewDoc?.doc}
          onClose={() => setPreviewDoc(null)}
          onError={onError}
        />
        <QualificationReview
          header={reviewHeader}
          items={defs.map((def) => {
            const status = REQUIREMENT_STATUS[itemOf(def.key).status];
            return { key: def.key, label: def.label, status: status ? { label: status.label, color: status.color } : null };
          })}
          selectedKey={activeDef.key}
          onSelect={(key) => { setReviewKey(key); setReviewNote(''); setReturningKey(null); setReopening(false); }}
          renderDetail={() => (
            <div className="flex flex-col">
              <div className="grid gap-[12px] content-start">
                <strong className="text-[#edf0fa]">{activeDef.label}</strong>
                <small className="text-[#8f9bbd]">Uploaded Image:</small>
                {(activeItem.files || []).length > 0 ? (
                  <ul className="m-0 p-0 [list-style:none] grid gap-[6px]">
                    {activeItem.files.map((doc) => (
                      <li key={doc.id}>
                        <span className="flex items-center gap-2">
                          <button type="button" className="flex-1 min-w-0 text-left p-[6px_10px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#e6eaf5] text-[13px] cursor-pointer hover:border-[#7b88ff] truncate" disabled={busy} onClick={() => setPreviewDoc({ doc, key: activeDef.key })}>
                            {doc.original_name}{doc.replaced_at ? ' (Replaced)' : ''}
                          </button>
                          <button type="button" className="text-[12px] font-[600] text-[#8fb4ff] bg-transparent border-0 cursor-pointer hover:underline disabled:opacity-50" disabled={busy} onClick={() => setPreviewDoc({ doc, key: activeDef.key })}>View</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <span className="text-muted">No files yet</span>}
                {activeItem.submitted_at && (
                  <div className="flex justify-between gap-4 text-[13px] border-t border-[#2b344c] pt-[10px]">
                    <span className="text-[#8f9bbd]">Submitted by {activeItem.submitted_by?.full_name || '—'} on:</span>
                    <span className="text-right font-bold text-[#e6eaf5]">{manilaDateTimeLabel(activeItem.submitted_at)}</span>
                  </div>
                )}
                {activeDef.fields.map((field) => (
                  <div key={field.key} className="flex justify-between gap-4 text-[13px]">
                    <span className="text-[#8f9bbd]">{field.label}:</span>
                    <span className="text-right font-bold text-[#e6eaf5]">{shownValue(field, activeItem) ?? '—'}</span>
                  </div>
                ))}
                {activeItem.status === 'accepted' && (
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <small className="text-[#8fe3a0]">Accepted by {activeItem.reviewed_by?.full_name || '—'} · {activeItem.reviewed_at ? manilaDateTimeLabel(activeItem.reviewed_at) : '—'}</small>
                    {!reopening && <button type="button" className="text-[12px] font-[600] text-[#8fb4ff] bg-transparent border-0 cursor-pointer hover:underline disabled:opacity-50" disabled={busy} onClick={() => { setReopening(true); setReviewNote(''); }}>Re-open</button>}
                  </span>
                )}
                {activeItem.status === 'accepted' && reopening && (
                  <span className="grid gap-2">
                    <textarea rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Why re-open this? (at least 5 characters)" />
                    <span className="flex flex-wrap justify-end gap-2">
                      <button type="button" className="min-h-[30px] p-[0_12px] border border-[#2b344c] rounded-[8px] bg-transparent text-[#c9d0e0] text-[12px] font-[600] disabled:opacity-50" disabled={busy} onClick={() => setReopening(false)}>Cancel</button>
                      <button type="button" className="min-h-[30px] p-[0_12px] border border-[rgba(251,_191,_36,_.55)] rounded-[8px] [background:#fbbf24] text-[#1a1305] text-[12px] font-[700] disabled:opacity-40 disabled:cursor-not-allowed" disabled={busy || sameNote.length < 5} onClick={() => { onReopen(activeDef.key, sameNote); setReopening(false); setReviewNote(''); }}>Re-open for review</button>
                    </span>
                  </span>
                )}
                {activeItem.status === 'returned' && <span className="text-[#fbbf24]">Return reason: {activeItem.return_reason}</span>}
              </div>
              {canDecide && (
                <div className="shrink-0 pt-[10px] mt-[10px] border-t border-[#2b344c] grid gap-[8px]">                    <textarea id="qualification-return-note" rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Note for Sales (required when returning, at least 5 characters)" />
                  <span className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="inline-flex items-center justify-center gap-[6px] min-h-[30px] p-[0_12px] border border-[rgba(251,_191,_36,_.45)] rounded-[8px] [background:rgba(251,_191,_36,_.08)] text-[#fbbf24] text-[12px] font-[700] disabled:opacity-40 disabled:cursor-not-allowed" disabled={busy || sameNote.length < 5} onClick={() => { onReturn(activeDef.key, sameNote); setReviewNote(''); }}>
                      <FaRotateLeft aria-hidden="true" /> Return to Sales
                    </button>
                    <button type="button" className="inline-flex items-center justify-center min-h-[30px] p-[0_12px] border border-transparent rounded-[8px] text-[#fff] text-[12px] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-1px)] [&:hover:not(:disabled)]:[box-shadow:0_8px_20px_color-mix(in_srgb,_var(--accent)_35%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.1)] disabled:opacity-50" disabled={busy} onClick={() => setAcceptConfirm(activeDef.key)}>Accept & next</button>
                  </span>
                </div>
              )}
            </div>
          )}
        />
      {acceptConfirm && (
        <Dialog
          title="Accept requirement?"
          onClose={() => setAcceptConfirm(null)}
          size="small"
          zIndex={2147482500}
          footer={(
            <>
              <button type="button" className="min-h-[34px] p-[0_16px] rounded-[8px] text-[12px] font-[700] tracking-[.02em] [box-shadow:none] border border-[#d45160] [background:#c2404f] text-[#fff] [&:hover:not(:disabled)]:border-[#d45160] [&:hover:not(:disabled)]:[background:#d45160]" onClick={() => setAcceptConfirm(null)}>Cancel</button>
              <button
                type="button"
                className="min-h-[34px] p-[0_16px] rounded-[8px] text-[12px] font-[700] tracking-[.02em] border border-transparent text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50"
                disabled={busy}
                onClick={() => { onAccept(acceptConfirm, sameNote); setReviewNote(''); setAcceptConfirm(null); }}
              >
                Yes, accept
              </button>
            </>
          )}
        >
          <p className="m-0 text-[14px] leading-[1.6]">
            Accept <strong>{defs.find((d) => d.key === acceptConfirm)?.label}</strong> and move to the next requirement?
          </p>
        </Dialog>
      )}
      </section>
    );
  }

  return (
    <section className="ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] text-[14px] leading-[1.5] text-[#c9d0e0]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">{title || `${stageInfo?.label} requirements`}</h3>
        <small className="text-[#9ba5bd]">{accepted} of {defs.length} accepted</small>
      </div>
      {summary.legacy && <p className="m-[8px_0_0] text-[#fbbf24]">Legacy record - requirements not captured.</p>}
      {!summary.legacy && summary.missing?.length > 0 && (
        <p className="m-[8px_0_0] text-muted">{stageInfo?.gate} needs every item Accepted. Missing: {summary.missing.join(', ')}.</p>
      )}
      {!req.files_visible && <p className="m-[8px_0_0] text-muted">Files are visible to Admin and the assigned Sales user only.</p>}
      {!summary.legacy && (
        <ul className="m-[12px_0_0] p-0 [list-style:none] grid gap-[10px]">
          {[...defs].sort((a, b) => Number(itemOf(a.key).status === 'accepted') - Number(itemOf(b.key).status === 'accepted')).map((def) => {
            const item = itemOf(def.key);
            const canEdit = !readOnly && isAssignedSales && summary.open && ['pending', 'returned'].includes(item.status);
            const canReview = !readOnly && isAdminRole && item.status === 'submitted';
            return (
              <li key={def.key} className="p-[12px_14px] border border-[#2b344c] rounded-[11px] [background:#0c111d] grid gap-[6px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[#edf0fa]">{def.label}</strong>
                  <span className="inline-flex items-center gap-[6px]">
                    <RequirementStatus status={item.status} />
                    {item.status === 'accepted' && (
                      <button type="button" aria-expanded={!collapsedKeys[def.key]} aria-label={`${collapsedKeys[def.key] ? 'Show' : 'Hide'} ${def.label}`} className="inline-flex items-center justify-center w-[26px] h-[26px] p-0 border border-[#2b344c] rounded-[7px] bg-transparent text-[#8f9bbd] cursor-pointer hover:border-[#7b88ff] hover:text-[#e6eaf5]" onClick={() => setCollapsedKeys({ ...collapsedKeys, [def.key]: !collapsedKeys[def.key] })}>
                        <FaChevronDown aria-hidden="true" className={`transition-transform duration-300 ${collapsedKeys[def.key] ? '-rotate-90' : ''}`} />
                      </button>
                    )}
                  </span>
                </div>
                <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${item.status === 'accepted' && collapsedKeys[def.key] ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
                <div className="min-h-0 overflow-hidden grid gap-[6px]">
                <small className="text-[#8f9bbd]">{def.help}</small>
                {item.status === 'pending' && !summary.open && <span className="text-muted">Not started yet</span>}
                {def.fields.some((field) => shownValue(field, item)) && (
                  <dl className="grid grid-cols-[minmax(0,_1fr)_auto] gap-[6px_16px] m-0 [&_dt]:text-[#8f9bbd] [&_dd]:m-0 [&_dd]:text-right [&_dd]:text-[#e6eaf5] [&_dd]:[overflow-wrap:anywhere]">
                    {def.fields.map((field) => (shownValue(field, item) ? (
                      <React.Fragment key={field.key}>
                        <dt>{field.label}</dt>
                        <dd>{shownValue(field, item)}</dd>
                      </React.Fragment>
                    ) : null))}
                  </dl>
                )}
                {item.location_note && <small className="text-[#fbbf24]">{item.location_note}</small>}
                {(item.files || []).length > 0 && (
                  <div className="flex justify-between items-start gap-4 flex-wrap">
                    <span className="text-[#c9d0e0]">Files:</span>
                    <span className="grid justify-items-end gap-[4px] text-right">
                      {item.files.map((doc) => (
                        <button key={doc.id} type="button" className="p-[4px_10px] border border-[#2b344c] rounded-[6px] bg-[#1a2133] text-[#e6eaf5] text-[13px] cursor-pointer hover:border-[#7b88ff]" disabled={busy} onClick={() => openRequirementFile(editing.id, def.key, doc).catch((error) => onError(error.message))}>
                          {doc.original_name}{doc.replaced_at ? ' (Replaced)' : ''}
                        </button>
                      ))}
                    </span>
                  </div>
                )}
                {item.submitted_at && (
                  <div className="flex justify-between items-start gap-4 flex-wrap text-[#8f9bbd] text-[12.5px]">
                    <span>Submitted by {item.submitted_by?.full_name || '—'} on</span>
                    <span className="text-right text-[#c9d0e0]">{manilaDateTimeLabel(item.submitted_at)}</span>
                  </div>
                )}
                {item.reviewed_at && item.status !== 'submitted' && (
                  <div className="flex justify-between items-start gap-4 flex-wrap text-[12.5px]">
                    <span className={item.status === 'accepted' ? 'text-[#8fe3a0]' : 'text-[#fbbf24]'}>{item.status === 'accepted' ? 'Accepted' : 'Returned'} by {item.reviewed_by?.full_name || '—'} on</span>
                    <span className="text-right text-[#c9d0e0]">{manilaDateTimeLabel(item.reviewed_at)}</span>
                  </div>
                )}
                {item.status === 'returned' && <span className="text-[#fbbf24]">Return reason: {item.return_reason}</span>}

                {canEdit && editingKey !== def.key && (
                  <button type="button" className="w-fit min-h-[32px] p-[0_16px] border border-[#2b344c] rounded-[8px] bg-[#070A12] text-[#e6eaf5] text-[12px] font-[600] cursor-pointer hover:border-[#7b88ff] disabled:opacity-50" disabled={busy} onClick={() => startEdit(def)}>{item.status === 'returned' ? 'Correct and resubmit' : 'Submit'}</button>
                )}
                {canEdit && (
                  <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${editingKey === def.key ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} aria-hidden={editingKey !== def.key}>
                  <div className="min-h-0 overflow-hidden">
                  <div className="grid gap-[10px] mt-1">
                    {def.fields.filter((field) => !field.show_when || values[field.show_when.key] === field.show_when.value).map((field) => (
                      field.type === 'location' ? (
                        <React.Fragment key={field.key}>
                          <LocationPicker
                            value={values[field.key] || {}}
                            onChange={(next) => setValues({ ...values, [field.key]: next })}
                            required={field.required}
                            full
                            labels={{ barangay: field.barangay_label || 'Barangay' }}
                            barangayPlaceholder={field.placeholder || 'Barangay (Optional)'}
                          />
                          {differentFromPreferred(values[field.key], item.location_prefill) && (
                            <small className="text-[#fbbf24]">{differentFromPreferred(values[field.key], item.location_prefill)}</small>
                          )}
                        </React.Fragment>
                      ) : (
                      <Field key={field.key} label={field.label} required={field.required} full>
                        {field.type === 'select' ? (
                          <select value={values[field.key] || ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}>
                            <option value="">Choose…</option>
                            {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}{field.key === 'interviewer' && o.value === user?.full_name ? ' (YOU)' : ''}</option>)}
                          </select>
                        ) : field.type === 'textarea' ? (
                          <textarea rows={3} value={values[field.key] || ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} placeholder={field.min_length ? `At least ${field.min_length} characters` : ''} />
                        ) : (
                          <input
                            type={field.type === 'date' ? 'date' : 'text'}
                            max={field.type === 'date' && field.not_future ? localDateInputValue() : undefined}
                            value={values[field.key] || ''}
                            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                          />
                        )}
                      </Field>
                      )
                    ))}
                    {def.files.map((slot) => (
                      <RequirementFileDrop
                        key={slot.key}
                        label={`${slot.label}${(item.files || []).some((d) => d.type === slot.key && !d.replaced_at) ? ' (leave empty to keep the attached file)' : ''}`}
                        required={slot.required}
                        multiple={Boolean(slot.multiple)}
                        accept={slot.accept.split(',').map((ext) => `.${ext}`).join(',')}
                        files={values[`file:${slot.key}`] || []}
                        onChange={(files) => setValues({ ...values, [`file:${slot.key}`]: files })}
                      />
                    ))}
                    <span className="flex justify-end gap-2">
                      <button type="button" className="min-h-[32px] p-[0_14px] border border-[rgba(248,113,113,0.5)] rounded-[8px] bg-transparent text-[#f87171] text-[12px] font-[600] cursor-pointer hover:bg-[rgba(248,113,113,0.08)] disabled:opacity-50" disabled={busy} onClick={() => setEditingKey(null)}>Cancel</button>
                      <button type="button" className="min-h-[32px] p-[0_14px] border border-[#3b5bdb] rounded-[8px] bg-[#1e3a8a] text-white text-[12px] font-[600] cursor-pointer hover:brightness-110 disabled:opacity-50" disabled={busy} onClick={() => send(def)}>
                        Send to Admin
                      </button>
                    </span>
                  </div>
                  </div>
                  </div>
                )}
                {canReview && returningKey !== def.key && (
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="inline-flex items-center justify-center min-h-[30px] p-[0_12px] border border-transparent rounded-[8px] text-[#fff] text-[12px] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50" disabled={busy} onClick={() => onAccept(def.key)}>Accept</button>
                    <button type="button" className="inline-flex items-center justify-center gap-[6px] min-h-[30px] p-[0_12px] border border-[rgba(251,_191,_36,_.45)] rounded-[8px] [background:rgba(251,_191,_36,_.08)] text-[#fbbf24] text-[12px] font-[700] [transition:background_.15s_ease] hover:[background:rgba(251,_191,_36,_.16)] disabled:opacity-50" disabled={busy} onClick={() => { setReturningKey(def.key); setReason(''); }}>
                      <FaRotateLeft aria-hidden="true" /> Return to Sales
                    </button>
                  </span>
                )}
                {canReview && returningKey === def.key && (
                  <span className="grid gap-2">
                    <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What Sales must correct (at least 5 characters)" />
                    <span className="flex flex-wrap justify-end gap-2">
                      <button type="button" className="inline-flex items-center justify-center min-h-[30px] p-[0_12px] border border-[#2b344c] rounded-[8px] [background:transparent] text-[#c9d0e0] text-[12px] font-[600] hover:[background:#1a2133] disabled:opacity-50" disabled={busy} onClick={() => setReturningKey(null)}>Cancel</button>
                      <button type="button" className="inline-flex items-center justify-center gap-[6px] min-h-[30px] p-[0_12px] border border-[rgba(251,_191,_36,_.55)] rounded-[8px] [background:#fbbf24] text-[#1a1305] text-[12px] font-[700] hover:[filter:brightness(1.08)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={busy || reason.trim().length < 5} onClick={() => { onReturn(def.key, reason.trim()); setReturningKey(null); }}>
                        <FaRotateLeft aria-hidden="true" /> Return with reason
                      </button>
                    </span>                  </span>
                )}
                </div>
                </div>
              </li>


            );
          })}
        </ul>
      )}
    </section>
  );
}


/** The attendance proof route is authenticated, so the file is fetched as a blob and opened. */
async function openActivityProof(activityId, document) {
  const token = await authToken.get();
  const response = await fetch(`${API_BASE_URL}/activities/${activityId}/documents/${document.id}/download`, {
    headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error('The attendance proof could not be opened.');
  const url = URL.createObjectURL(await response.blob());
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** The latest row of one activity type (rejected requests are skipped). */
function latestActivityOf(editing, type) {
  return (editing?.schedules || [])
    .filter((row) => row.activity_type === type && row.approval_status !== 'rejected')
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

/**
 * What Sales submitted for an activity (attendance, time, handler, notes, proof) — Admin
 * reads it here before marking it Attended (Verify for Orientation/Tasting) or returning it.
 * Orientation/Tasting: Admin must open every current file before Verify works (the server keeps
 * the views per file and per Admin), and cannot verify a submission they encoded.
 */
function ActivitySubmission({ activity, isAdminRole, busy, onAttended, onReturn, onError, currentUserId = null, inquiryBrandName = null }) {
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  // Files opened in this view since the page loaded (the server records them too).
  const [opened, setOpened] = useState(() => new Set());
  if (!activity || !activity.completion_submitted_at) {
    if (activity?.completed_before_schedule) {
      return <small className="inline-flex w-fit p-[2px_8px] rounded-[999px] border border-[rgba(251,_191,_36,_0.45)] text-[#fbbf24] text-[11px] font-[700]">Completed before schedule (legacy)</small>;
    }
    return null;
  }
  const proofs = activity.proof_documents || [];
  const isTasting = activity.activity_type === 'orientation';
  const newFlow = isTasting && proofs.some((doc) => doc.type === 'brand_selection');
  const reviewLabel = { submitted: 'Waiting for Admin review', returned: 'Returned to Sales', accepted: newFlow ? 'Verified' : 'Attended (accepted)' }[activity.review_status] || '';
  const canReview = isAdminRole && activity.review_status === 'submitted';
  const current = proofs.filter((doc) => !doc.replaced_at);
  const viewed = (doc) => Boolean(doc.viewed_by_me) || opened.has(doc.id);
  const unviewed = current.filter((doc) => !viewed(doc));
  const ownSubmission = currentUserId != null && Number(activity.completion_submitted_by?.id) === Number(currentUserId);
  const verifyBlocked = newFlow && (unviewed.length > 0 || ownSubmission);
  const open = (doc) => openActivityProof(activity.id, doc)
    .then(() => setOpened((set) => new Set(set).add(doc.id)))
    .catch((error) => onError(error.message));
  const fileButton = (doc) => (
    <button key={doc.id} type="button" disabled={busy} onClick={() => open(doc)} className="inline-flex items-center gap-[6px]">
      {doc.original_name}{doc.replaced_at ? ' (Replaced)' : ''}
      {newFlow && isAdminRole && !doc.replaced_at && (viewed(doc)
        ? <span className="text-[#34d399] text-[11px] font-[700]"><FaCheck aria-hidden="true" /> Viewed</span>
        : <span className="text-[#fbbf24] text-[11px] font-[700]">Not viewed</span>)}
    </button>
  );
  const group = (label, type) => {
    const list = proofs.filter((doc) => (type ? doc.type === type : true));
    return list.length ? <span className="flex flex-wrap gap-2 items-center">{label}: {list.map(fileButton)}</span> : null;
  };
  return (
    <div className="basis-full grid gap-[6px] mt-2 p-[10px_12px] border border-[#2b344c] rounded-[10px] [background:#0c111d] text-[14px] leading-[1.5] text-[#c9d0e0]">
      <div className="flex flex-wrap gap-[6px_16px]">
        <span><strong>{activity.status === 'no_show' ? 'No Show' : 'Attended'}</strong>{reviewLabel ? ` · ${reviewLabel}` : ''}</span>
        <span>Submitted by {activity.completion_submitted_by?.full_name || '—'} on {manilaDateTimeLabel(activity.completion_submitted_at)}</span>
      </div>
      {activity.status === 'no_show' ? (
        <p className="m-0">Reason: {activity.no_show_reason}</p>
      ) : (
        <>
          <span>Actual time: {manilaDateTimeLabel(activity.actual_started_at)} · Handled by {activity.handler_name || '—'}{!isTasting && activity.tasted_brand_name ? ` · Brand tasted: ${activity.tasted_brand_name}` : ''}</span>
          {isTasting && (activity.selected_brand_name || inquiryBrandName) && (
            <span>Inquired brand: <strong>{inquiryBrandName || '—'}</strong> · Selected brand: <strong>{activity.selected_brand_name || '—'}</strong></span>
          )}
          <p className="m-0">Notes: {activity.result_notes}</p>
          {newFlow ? (
            <>
              {group('Attendance proof', 'attendance_proof')}
              {group('Brand selection document', 'brand_selection')}
            </>
          ) : group('Proof', null)}
        </>
      )}
      {activity.review_status === 'returned' && <span className="text-[#fbbf24]">Returned: {activity.return_reason}</span>}
      {activity.reviewed_by?.full_name && activity.review_status !== 'submitted' && <span>{activity.review_status === 'accepted' && newFlow ? 'Verified' : 'Reviewed'} by {activity.reviewed_by.full_name} on {manilaDateTimeLabel(activity.reviewed_at)}</span>}
      {activity.review_status === 'accepted' && newFlow && <small className="text-[#8f9ab2]">Verified submissions are locked.</small>}
      {canReview && !returning && (
        <span className="flex flex-wrap gap-2 items-center">
          {activity.status === 'completed' && (
            <button
              type="button"
              className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50"
              disabled={busy || verifyBlocked}
              title={ownSubmission ? 'You encoded this submission: another Admin must verify it.' : unviewed.length && newFlow ? `Open every file first: ${unviewed.map((doc) => doc.original_name).join(', ')}` : ''}
              onClick={() => onAttended(activity)}
            >
              {newFlow ? 'Verify' : 'Mark Attended'}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { setReturning(true); setReason(''); }}>Return to Sales</button>
          {newFlow && verifyBlocked && (
            <small className="text-[#fbbf24]" role="status">
              {ownSubmission ? 'You encoded this submission: another Admin must verify it.' : `Open every file before Verify (${current.length - unviewed.length} of ${current.length} viewed).`}
            </small>
          )}
        </span>
      )}
      {canReview && returning && (
        <span className="grid gap-2">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What Sales must correct (at least 5 characters)" />
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setReturning(false)}>Cancel</button>
            <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => { onReturn(activity, reason.trim()); setReturning(false); }}>Return with reason</button>
          </span>
        </span>
      )}
    </div>
  );
}

function ScheduleSection({
  editing, draft, isAdminRole, sectionRef, onPickChecked, onOpenCalendar, onView,
  busy = false, onAttended = null, onReturn = null, onError = () => {}, currentUserId = null,
}) {
  const infoOf = (type) => editing?.activity_state?.[type] || {};
  // The Master Schedule session of each activity: the newest one the
  // applicant was not removed from (cancelled sessions are skipped).
  const sessionOf = (type) => (editing?.schedule_sessions || [])
    .filter((session) => session.activity_type === type
      && session.status !== 'cancelled'
      && !['removed', 'cancelled'].includes(session.attendance_status))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  const doneCount = TRACKED_ACTIVITIES.filter((tracked) => infoOf(tracked.type).done).length;

  return (
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#0C111D] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#0C111D] [#update-applicant-form_&]:[box-shadow:none] ap-schedule-section [&.is-locked]:opacity-[.92] [&.is-locked_h3]:inline-flex [&.is-locked_h3]:items-center [&.is-locked_h3]:gap-2" ref={sectionRef}>
      <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px] pb-[10px] border-b border-[#2a3041]">
        <h3>Schedule activity</h3>
        <small>{doneCount} of {TRACKED_ACTIVITIES.length} done</small>
      </div>
      <ul className="[.ap-schedule-section_&]:[list-style:none] [.ap-schedule-section_&]:m-[12px_0_0] [.ap-schedule-section_&]:p-[14px_0_0] [.ap-schedule-section_&]:flex [.ap-schedule-section_&]:flex-col [.ap-schedule-section_&]:gap-[10px] relative [&::before]:[content:''] [&::before]:absolute [&::before]:top-0 [&::before]:bottom-0 [&::before]:left-[161px] [&::before]:w-px [&::before]:[background:#2a3041]">
        {TRACKED_ACTIVITIES.map((tracked) => {
          const info = infoOf(tracked.type);
          const state = info.state || 'not_scheduled';
          const checked = Boolean(draft.milestones[tracked.key]);
          const saved = Boolean(info.attended) || state === 'attended';
          const latest = latestActivityOf(editing, tracked.type);
          // New completions are decided with the proof in view (Mark Attended / Return); the
          // checkbox stays only for older completions recorded without proof.
          const legacyCompletion = !latest?.completion_submitted_at;
          const canMark = !saved && state === 'completed' && legacyCompletion;
          const overdue = Boolean(info.overdue) && !saved;
          const hasLinks = state !== 'not_scheduled' && Boolean(onOpenCalendar || onView);
          return (
            <li key={tracked.type} className="ap-activity-row flex items-center gap-3 flex-wrap p-[0_0_20px] border-0 [background:none]" data-activity-type={tracked.type}>
              <span className="w-[150px] shrink-0 mr-3 pr-3 flex items-center"><span className={`p-[4px_10px] rounded-[999px] text-[10px] font-[500] tracking-[0.04em] uppercase whitespace-nowrap later-5:[&.is-not\_scheduled]:text-[color:var(--muted,_#8b93a5)] later-6:[&.is-pending\_admin]:text-[#ffc857] later-7:[&.is-scheduled]:text-[#4cc9ff] later-8:[&.is-completed]:text-[#7ddfff] later-9:[&.is-attended]:text-[#39ffb0] [&.is-attended]:[box-shadow:0_0_10px_color-mix(in_srgb,_#39ffb0_25%,_transparent)] later-10:[&.is-overdue]:text-[#ffb454] [.ap-schedule-section.is-locked_&]:opacity-[.75] is-${overdue ? 'overdue' : state}`}>{overdue ? 'Overdue' : (STATE_LABELS[state] || state)}</span></span>
              <span className="flex flex-col gap-[2px] w-[240px] shrink-0 mr-3 pr-3 later-2:[&_small]:text-[color:var(--muted,_#8b93a5)] later:[&_small]:text-[11px]">
                <strong className="text-[15px]">{tracked.label}</strong>
                {info.active && info.starts_at && <small>{fmtDateTime(info.starts_at)}{overdue ? ' · missed' : ''}</small>}
                {info.completed && !saved && <small>Sales marked Complete — waiting for Attended</small>}
                {saved && info.completed_at && <small>Sales completed {fmtDateTime(info.completed_at)}</small>}
                {checked && (
                  <small>
                    Date marked {fmtDateTime(draft.details[tracked.key]?.on)} · Marked by {draft.details[tracked.key]?.by || '—'}
                  </small>
                )}
              </span>
              {hasLinks && (
                <span className="ap-activity-links ml-auto inline-flex gap-[6px] flex-wrap">
                  {onOpenCalendar && sessionOf(tracked.type) && (
                    <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onOpenCalendar(sessionOf(tracked.type))}>
                      Open in calendar
                    </button>
                  )}
                  {onView && (
                    <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => onView(tracked.type)}>
                      View
                    </button>
                  )}
                </span>
              )}
              {isAdminRole && legacyCompletion && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-disabled={!canMark}
                  className={`ap-check${hasLinks ? '' : ' ml-auto'} shrink-0 [border:1px_solid_var(--ap-border-2)] flex items-center later:gap-[10px] min-w-0 later:p-[11px_12px] later:border later:border-[#303749] later:rounded-[11px] later:[background:#191f2e] later:text-[#d4daea] text-left later:[font-family:inherit] later:[font-weight:inherit] [font-style:inherit] later:leading-[1.4] cursor-pointer later:[transition:background_.16s_ease,_border-color_.16s_ease] later-2:hover:border-[#6258c9] later:hover:[background:#1d2335] later-3:[&.checked]:border-[rgba(37,_199,_122,_.45)] later-2:[&.checked]:[background:rgba(37,_199,_122,_.07)] [#update-applicant-form_&]:gap-2 [#update-applicant-form_&]:p-[9px_10px] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&:hover]:[background:#202a40] [&.read-only]:cursor-default [&.read-only:hover]:[background:transparent] [&.read-only:hover]:border-[rgba(226,_232,_255,_.085)] later:[#update-applicant-form_&]:border-[#252e40] later:[#update-applicant-form_&]:rounded-[7px] later:[#update-applicant-form_&]:[background:#141b29] later-2:text-[12px] disabled:cursor-not-allowed disabled:opacity-[.55] [&.is-locked]:cursor-not-allowed later:[&.is-locked]:opacity-[.8] ${checked ? ' checked [&.checklist-item]:border-[color:color-mix(in_srgb,_var(--success)_32%,_transparent)] [&.checklist-item]:[background:color-mix(in_srgb,_var(--success)_7%,_transparent)] [&.checklist-item_.checklist-box]:[background:var(--success)] [&.checklist-item_.checklist-box]:border-success [&.checklist-item_.checklist-box]:text-[#04120c] [&.checklist-item_.checklist-copy_strong]:text-text' : ''}${saved ? ' is-locked' : ''}`}
                  disabled={!canMark}
                  title={saved
                    ? 'Attended is saved and locked.'
                    : canMark
                      ? 'Mark Attended, then Save Changes to record it.'
                      : 'Sales must mark this activity Complete first.'}
                  onClick={() => onPickChecked(tracked, info)}
                >
                  <span className="place-items-center [border:1px_solid_var(--ap-border-2)] [&_svg]:m-0 later:inline-flex later:flex-[0_0_17px] later:w-[17px] later:h-[17px] items-center justify-center later:border later:border-[#4a5268] rounded-[5px] later:text-[#071a12] later:[background:#0d1220] later:text-[10px] later:[.ap-check.checked_&]:border-[#25c77a] later:[.ap-check.checked_&]:[background:#25c77a]" aria-hidden="true">{checked && <FaCheck />}</span>
                  Attended
                </button>
              )}
              {onAttended && (
                <ActivitySubmission key={`${latest?.id}-${latest?.completion_submitted_at}`} activity={latest} isAdminRole={isAdminRole} busy={busy} onAttended={onAttended} onReturn={onReturn} onError={onError} currentUserId={currentUserId} inquiryBrandName={editing?.inquiry_brand_name} />
              )}
            </li>
          );
        })}
      </ul>
      {isAdminRole && (
        <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">
          {doneCount === TRACKED_ACTIVITIES.length
            ? 'Both activities are Done — Scheduled is checked.'
            : 'Attended is recorded only when you click Save Changes.'}
        </p>
      )}
    </section>
  );
}

/**
 * A finished stage section, shown under the current work and collapsed by
 * default (show/hide). The content is the same section, read-only by stage.
 */
function DoneSection({ title, summary, children, tone = 'done', defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef(null);
  // Animate the body on every Show and Hide: the body is kept mounted so the slide runs each time.
  const toggle = (event) => {
    event.preventDefault();
    const body = bodyRef.current;
    if (open) {
      const out = body?.animate(
        [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-8px)' }],
        { duration: 220, easing: 'ease-in' },
      );
      if (out) out.onfinish = () => setOpen(false);
      else setOpen(false);
    } else {
      setOpen(true);
      requestAnimationFrame(() => {
        bodyRef.current?.animate(
          [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 300, easing: 'ease-out' },
        );
      });
    }
  };
  return (
    <details className={`ap-done-section border ${tone === 'qualification' ? 'border-[#2a3041] [background:#0C111D]' : 'border-[#293246] [background:#121827]'} rounded-[12px] [&>summary]:flex [&>summary]:items-center [&>summary]:gap-[10px] [&>summary]:p-[12px_14px] [&>summary]:cursor-pointer [&>summary]:[list-style:none] [&>summary]:text-[#e4e8f4] later:[&>summary]:text-[13px] [&>summary]:font-[700] [&>summary::-webkit-details-marker]:hidden [&>summary:focus-visible]:[outline:2px_solid_#6d8cff] [&>summary:focus-visible]:[outline-offset:2px] [&>summary:focus-visible]:rounded-[12px] [&>summary_small]:text-[#9ba5bd] [&>summary_small]:font-[500] [&.is-pending]:border-[rgba(245,_158,_11,_.45)] is-${tone}`} open={open}>
      <summary onClick={toggle}>
        <span className="inline-flex items-center gap-2 later-4:[&_svg]:text-[#4ade80] [.ap-done-section.is-pending_&_svg]:text-[#fbbf24]">
          {tone === 'pending' ? <FaClock aria-hidden="true" /> : <FaCheck aria-hidden="true" />} {title}
        </span>
        {summary && <small>{summary}</small>}
        <span className="ml-auto text-[#9ba5bd] text-[12px] font-[600] [&::after]:[content:'Show'] [.ap-done-section[open]_&::after]:[content:'Hide']" aria-hidden="true" />
      </summary>
      <div ref={bodyRef} className="p-[0_10px_10px] [&_.ap-section]:mb-0">{children}</div>
    </details>
  );
}

/**
 * Qualified stage: Schedule Activity is visible but LOCKED. [Set Schedule] is
 * a proceed button only: it moves the applicant to Scheduling and unlocks this
 * section. It asks for no date, time, handler or venue and creates nothing.
 */
function LockedScheduleSection({ isAdminRole, qualificationDone, busy, onSetSchedule }) {
  const reason = !qualificationDone
    ? 'Waiting for Sales to save all 5 assessment items.'
    : isAdminRole
      ? 'Click Set Schedule to move the applicant to Scheduling and unlock this section.'
      : 'Waiting for Admin to click Set Schedule.';
  return (
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#0C111D] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#0C111D] [#update-applicant-form_&]:[box-shadow:none] ap-schedule-section [&.is-locked]:opacity-[.92] [&.is-locked_h3]:inline-flex [&.is-locked_h3]:items-center [&.is-locked_h3]:gap-2 is-locked">
      <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
        <h3><FaLock aria-hidden="true" /> Schedule activity</h3>
        <small>Locked</small>
      </div>
      <ul className="[.ap-schedule-section_&]:[list-style:none] [.ap-schedule-section_&]:m-[12px_0_0] [.ap-schedule-section_&]:p-0 [.ap-schedule-section_&]:flex [.ap-schedule-section_&]:flex-col [.ap-schedule-section_&]:gap-[10px]">
        {TRACKED_ACTIVITIES.map((tracked) => (
          <li key={tracked.type} className="ap-activity-row flex items-center gap-3 flex-wrap p-[10px_12px] border border-[color:var(--border,_#262b36)] rounded-[12px] [background:color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)]">
            <span className="p-[4px_10px] rounded-[999px] text-[10px] font-[800] tracking-[0.04em] uppercase border border-transparent whitespace-nowrap later-5:[&.is-not\_scheduled]:text-[color:var(--muted,_#8b93a5)] [&.is-not\_scheduled]:[background:color-mix(in_srgb,_var(--muted,_#8b93a5)_14%,_transparent)] [&.is-not\_scheduled]:border-[color:color-mix(in_srgb,_var(--muted,_#8b93a5)_35%,_transparent)] later-6:[&.is-pending\_admin]:text-[#ffc857] later:[&.is-pending\_admin]:[background:color-mix(in_srgb,_#ffc857_12%,_transparent)] later:[&.is-pending\_admin]:border-[color:color-mix(in_srgb,_#ffc857_45%,_transparent)] later-7:[&.is-scheduled]:text-[#4cc9ff] later-2:[&.is-scheduled]:[background:color-mix(in_srgb,_#4cc9ff_12%,_transparent)] later-2:[&.is-scheduled]:border-[color:color-mix(in_srgb,_#4cc9ff_45%,_transparent)] later-8:[&.is-completed]:text-[#7ddfff] later-3:[&.is-completed]:[background:color-mix(in_srgb,_#4cc9ff_18%,_transparent)] later-3:[&.is-completed]:border-[color:color-mix(in_srgb,_#4cc9ff_55%,_transparent)] later-9:[&.is-attended]:text-[#39ffb0] later-4:[&.is-attended]:[background:color-mix(in_srgb,_#39ffb0_14%,_transparent)] later-4:[&.is-attended]:border-[color:color-mix(in_srgb,_#39ffb0_50%,_transparent)] [&.is-attended]:[box-shadow:0_0_10px_color-mix(in_srgb,_#39ffb0_25%,_transparent)] later-10:[&.is-overdue]:text-[#ffb454] later-5:[&.is-overdue]:[background:color-mix(in_srgb,_#ffb454_12%,_transparent)] later-5:[&.is-overdue]:border-[color:color-mix(in_srgb,_#ffb454_45%,_transparent)] [.ap-schedule-section.is-locked_&]:opacity-[.75] is-not_scheduled">Locked</span>
            <span className="flex flex-col gap-[2px] min-w-[150px] flex-1 later-2:[&_small]:text-[color:var(--muted,_#8b93a5)] later:[&_small]:text-[11px]"><strong>{tracked.label}</strong></span>
          </li>
        ))}
      </ul>
      <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">{reason}</p>
      {isAdminRole && (
        <div className="ap-actions flex flex-wrap items-center gap-[10px] mt-[14px]">
          <button
            type="button"
            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.ap-actions_&]:m-0 [.ap-actions_&:disabled]:text-[#7d879e] [.ap-actions_&:disabled]:border [.ap-actions_&:disabled]:border-[#2b344c] [.ap-actions_&:disabled]:[background:#131a29] later:[.ap-actions_&:disabled]:[box-shadow:none] [.ap-actions_&:disabled]:opacity-[1] [.ap-actions_&:disabled]:cursor-not-allowed later-2:[.ap-actions_&:disabled]:[transform:none]"
            disabled={!qualificationDone || busy}
            title={qualificationDone ? 'Move to Scheduling and unlock Schedule Activity' : reason}
            onClick={onSetSchedule}
          >
            {busy ? 'SAVING…' : 'Set Schedule'}
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------------- LOI Submission panel (Stage 3) ----------------
 * Left: the optional attachment (PDF/JPG/JPEG/PNG), stored against the
 * applicant's documents. Right: Submission date, Received by (Admin),
 * Submission type and Verification — the verification is the key that unlocks
 * the [LOI Submitted] stage button.
 */
/** Human-readable file size: 840 KB / 1.2 MB. */
const fileSizeLabel = (bytes) => {
  const size = Number(bytes) || 0;
  if (size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const isImageFile = (name, mime) => String(mime || '').startsWith('image/')
  || /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''));

const isPdfFile = (name, mime) => String(mime || '') === 'application/pdf'
  || /\.pdf$/i.test(String(name || ''));

/** The download route is authenticated, so a saved file is fetched as a blob. */
async function fetchApplicantDocument(applicantId, document) {
  const token = await authToken.get();
  const response = await fetch(`${API_BASE_URL}/applicants/${applicantId}/documents/${document.id}/download`, {
    headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error('The attached file could not be opened.');
  return response.blob();
}

/**
 * The LOI attachment slot.
 *
 * Nothing attached -> the file picker (dropzone). Attached -> the picker is
 * gone and a preview row takes its place: image thumbnail (or a PDF/file icon),
 * file name, size, [View] and [Remove]. Removing a file that is already saved
 * on the server asks first and deletes it server-side when the LOI is saved;
 * only then does the picker come back.
 */
/** The assigned Sales user, or an "Unassigned" badge (Sales cannot act until Admin assigns one). */
function AssignedSalesTag({ sales, prefix = 'Sales' }) {
  if (sales?.full_name) return <small className={`block mt-1 text-[#9aa6c4] ${prefix ? '' : 'text-[13px] font-[600]'}`}>{prefix ? `${prefix}: ` : ''}{sales.full_name}</small>;
  return (
    <small className="inline-flex items-center mt-1 p-[2px_8px] rounded-[999px] border border-[rgba(251,_191,_36,_0.45)] [background:rgba(251,_191,_36,_0.1)] text-[#fbbf24] text-[11px] font-[700]" title="Admin must assign a Sales user first.">
      Unassigned
    </small>
  );
}

/** The LOI scan in force: the latest one not marked Replaced or Removed. */
function currentLoiDocument(documents) {
  const live = (documents || []).filter((file) => file.type === 'loi' && !file.removed_at && !file.replaced_at);
  return live[live.length - 1] || null;
}

function LoiAttachment({
  draft, savedDocument, applicantId, interactive, disabled, onChange, onPreview, onError,
}) {
  const attached = draft.file
    ? { kind: 'new', name: draft.file.name, size: draft.file.size, mime: draft.file.type }
    : (!draft.removeDocument && savedDocument
      ? {
        kind: 'saved',
        id: savedDocument.id,
        name: savedDocument.original_name,
        size: savedDocument.size_bytes,
        mime: savedDocument.mime_type,
      }
      : null);
  const [thumb, setThumb] = useState(null);
  const [opening, setOpening] = useState(false);
  const image = Boolean(attached) && isImageFile(attached.name, attached.mime);

  // Thumbnail source: the picked File is local, a saved document is fetched.
  useEffect(() => {
    setThumb(null);
    if (!attached || !image) return undefined;
    if (attached.kind === 'new') {
      const url = URL.createObjectURL(draft.file);
      setThumb(url);
      return () => URL.revokeObjectURL(url);
    }
    let alive = true;
    let url = null;
    fetchApplicantDocument(applicantId, attached)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setThumb(url);
      })
      .catch(() => { if (alive) setThumb(null); });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [applicantId, attached?.kind, attached?.id, attached?.name, image]);

  if (!attached) {
    return (
      <div className="grid gap-2 [align-content:start]">
        <span className="text-[#9aa6c4] text-[10.5px] tracking-[.05em] uppercase [&_em]:text-[#7d879e] [&_em]:not-italic [&_em]:tracking-[0] [&_em]:normal-case">LOI document <em className="text-[#ff9ca3]!">*</em></span>
        <div className="grid [justify-items:center] gap-[6px] p-[16px_12px] border border-dashed border-[#3a4560] rounded-[12px] [background:#0c111d] text-center">
          <span className="grid w-[34px] h-[34px] place-items-center rounded-[9px] [background:rgba(129,_117,_255,_.14)] text-[#a89dff]" aria-hidden="true"><FaClipboardCheck /></span>
          <p className="m-0 text-[#edf0fa] text-[11px] [word-break:break-word]">No file attached</p>
          {interactive && (
            <label className="inline-flex p-[6px_10px] border border-[#353e57] rounded-[8px] [background:#1a2133] text-[#dfe3f5] text-[11px] cursor-pointer [&_input]:hidden focus-within:[outline:2px_solid_#8175ff] focus-within:[outline-offset:2px]">
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, file: e.target.files?.[0] || null })}
              />
              Browse file
            </label>
          )}
        </div>
        <span className="text-[#7d879e] text-[10px] leading-[1.4]">Required. PDF, JPG, JPEG or PNG, up to 10 MB · saved with the applicant record.</span>
      </div>
    );
  }

  const view = async () => {
    setOpening(true);
    try {
      let blob;
      if (attached.kind === 'new') blob = draft.file;
      else blob = await fetchApplicantDocument(applicantId, attached);
      const url = URL.createObjectURL(blob);
      if (isImageFile(attached.name, blob.type || attached.mime)) {
        // The lightbox owns this URL and revokes it when it closes.
        onPreview({ url, name: attached.name });
      } else {
        // PDFs open in a new tab; the blob URL lives long enough to be read.
        window.open(url, '_blank', 'noopener');
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (error) {
      onError(error.message);
    } finally {
      setOpening(false);
    }
  };

  const remove = () => {
    if (attached.kind === 'saved') {
      if (!window.confirm(`Remove "${attached.name}"? The file is never deleted: it stays in the history, marked Removed (or Replaced when you upload a new scan).`)) return;
      onChange({ ...draft, file: null, removeDocument: true });
      return;
    }
    onChange({ ...draft, file: null });
  };

  const kindLabel = isPdfFile(attached.name, attached.mime)
    ? 'PDF'
    : (image ? 'Image' : 'File');

  return (
    <div className="grid gap-2 [align-content:start]">
      <span className="text-[#9aa6c4] text-[10.5px] tracking-[.05em] uppercase [&_em]:text-[#7d879e] [&_em]:not-italic [&_em]:tracking-[0] [&_em]:normal-case">LOI document <em className="text-[#ff9ca3]!">*</em></span>
      <div className="flex items-center gap-[10px] p-[9px_10px] border border-[#2b344c] rounded-[12px] [background:#0c111d]">
        <span className={`grid w-[38px] h-[38px] flex-[0_0_auto] place-items-center overflow-hidden rounded-[9px] [background:rgba(129,_117,_255,_.14)] text-[#a89dff] text-[16px] [&.has-thumb]:[background:#131a29] [&_img]:w-full [&_img]:h-full [&_img]:object-cover ${image && thumb ? ' has-thumb' : ''}`} aria-hidden="true">
          {image && thumb
            ? <img src={thumb} alt="" />
            : (isPdfFile(attached.name, attached.mime) ? <FaFilePdf /> : <FaImage />)}
        </span>
        <span className="min-w-0 grid gap-[2px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:text-[11.5px] later:[&_strong]:font-[600] [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap later-3:[&_small]:text-[#7d879e] later-2:[&_small]:text-[10.5px]">
          <strong title={attached.name}>{attached.name}</strong>
          <small>
            {[kindLabel, fileSizeLabel(attached.size)].filter(Boolean).join(' · ')}
            {attached.kind === 'saved' ? ' · saved with the record' : ''}
          </small>
        </span>
        <div className="flex flex-[0_0_auto] gap-[6px] ml-auto">
          <button type="button" className="inline-flex items-center gap-[5px] p-[6px_9px] border border-[#353e57] rounded-[8px] [background:#1a2133] text-[#dfe3f5] text-[11px] cursor-pointer [&:hover:not(:disabled)]:border-[#8175ff] [&:hover:not(:disabled)]:text-[#fff] disabled:opacity-[.55] disabled:cursor-not-allowed" disabled={disabled || opening} onClick={() => void view()}>
            <FaEye aria-hidden="true" /> View
          </button>
          <button type="button" className="inline-flex items-center gap-[5px] p-[6px_9px] border rounded-[8px] [background:#1a2133] text-[11px] cursor-pointer disabled:opacity-[.55] disabled:cursor-not-allowed later:text-[#ff9aa4] later:border-[rgba(239,_89,_107,_.38)] later:[&:hover:not(:disabled)]:border-[#ef596b] later:[&:hover:not(:disabled)]:text-[#ffd7db]" disabled={disabled} onClick={remove}>
            <FaTrashCan aria-hidden="true" /> Remove
          </button>
        </div>
      </div>
      <span className="text-[#7d879e] text-[10px] leading-[1.4]">
        {attached.kind === 'saved'
          ? 'Saved on the server · remove it to attach a different file.'
          : 'The new file replaces the record\u2019s attachment when you save.'}
      </span>
    </div>
  );
}

function LoiPanel({
  draft, interactive, disabled, savedDocument, applicantId, receivedByName, onChange, onPreview, onError,
  status = null, actions = null, canEditDetails = interactive, canVerify = interactive,
}) {
  // The assigned Sales user records the details and uploads the scan; Admin only verifies.
  const detailsEditable = interactive && canEditDetails;
  const verifyEditable = interactive && canVerify;
  const typeLabels = { physical: 'Hard copy', digital: 'Soft copy', email: 'Email', other: 'Other' };
  const verifyLabels = { not_verified: 'Not verified', verified: 'Verified', rejected: 'Rejected' };
  // A submission can never be dated after today (the API rejects it too).
  const dateIssue = Boolean(draft.submission_date) && draft.submission_date > localDateInputValue()
    ? 'The submission date cannot be in the future.'
    : '';

  return (
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] [&_h3]:inline-flex [&_h3]:items-center [&_h3]:gap-2" aria-labelledby="ap-loi-title">
      <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
        <h3 id="ap-loi-title">
          LOI Submission
          {status === 'pending' && <span className="p-[2px_8px] rounded-[999px] text-[11px] font-[700] tracking-[.02em] [&.is-pending]:[background:rgba(245,_158,_11,_.16)] later-5:[&.is-pending]:text-[#fbbf24] [&.is-pending]:border [&.is-pending]:border-[rgba(245,_158,_11,_.4)] later:[&.is-complete]:[background:rgba(34,_197,_94,_.14)] later-6:[&.is-complete]:text-[#4ade80] [&.is-complete]:border later:[&.is-complete]:border-[rgba(34,_197,_94,_.35)] is-pending">Pending</span>}
          {status === 'complete' && <span className="p-[2px_8px] rounded-[999px] text-[11px] font-[700] tracking-[.02em] [&.is-pending]:[background:rgba(245,_158,_11,_.16)] later-5:[&.is-pending]:text-[#fbbf24] [&.is-pending]:border [&.is-pending]:border-[rgba(245,_158,_11,_.4)] later:[&.is-complete]:[background:rgba(34,_197,_94,_.14)] later-6:[&.is-complete]:text-[#4ade80] [&.is-complete]:border later:[&.is-complete]:border-[rgba(34,_197,_94,_.35)] is-complete">Complete</span>}
        </h3>
        <small>
          {!interactive ? 'Recorded submission' : 'The LOI file is required for every LOI.'}
        </small>
      </div>
      <div className="grid grid-cols-[240px_minmax(0,_1fr)] gap-4 max-[761px]:later:grid-cols-[1fr]">
        <LoiAttachment
          draft={draft}
          savedDocument={savedDocument}
          applicantId={applicantId}
          interactive={detailsEditable}
          disabled={disabled}
          onChange={onChange}
          onPreview={onPreview}
          onError={onError}
        />

        <div className="grid gap-[9px] [align-content:start]">
          <div className="grid grid-cols-[130px_minmax(0,_1fr)] items-center gap-[10px] text-[#b9c1d5] text-[11.5px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:font-[600] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full">
            <span>Submission date</span>
            {detailsEditable ? (
              <div className="grid gap-1">
                <input
                  type="date"
                  value={draft.submission_date}
                  max={localDateInputValue()}
                  disabled={disabled}
                  aria-invalid={Boolean(dateIssue)}
                  onChange={(e) => onChange({ ...draft, submission_date: e.target.value })}
                />
                {dateIssue && <small className="text-[#ff9ca3] leading-[1.35] later:text-[12px]" role="alert">{dateIssue}</small>}
              </div>
            ) : <strong>{draft.submission_date ? formatDate(draft.submission_date) : '—'}</strong>}
          </div>
          <div className="grid grid-cols-[130px_minmax(0,_1fr)] items-center gap-[10px] text-[#b9c1d5] text-[11.5px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:font-[600] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full">
            <span>Received by</span>
            <strong className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]"><FaUserCheck aria-hidden="true" /> {draft.received_by || receivedByName || 'Admin'}</strong>
          </div>
          <div className="grid grid-cols-[130px_minmax(0,_1fr)] items-center gap-[10px] text-[#b9c1d5] text-[11.5px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:font-[600] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full">
            <span>Submission type</span>
            {detailsEditable ? (
              <select
                value={draft.submission_type}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, submission_type: e.target.value })}
              >
                {/* Legacy rows keep showing "Other"; it is not offered for new entries. */}
                {draft.submission_type === 'other' && <option value="other">Other (legacy)</option>}
                <option value="physical">Hard copy</option>
                <option value="digital">Soft copy</option>
                <option value="email">Email</option>
              </select>
            ) : <strong>{typeLabels[draft.submission_type] || '—'}</strong>}
          </div>
          <div className="grid grid-cols-[130px_minmax(0,_1fr)] items-center gap-[10px] text-[#b9c1d5] text-[11.5px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:font-[600] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full">
            <span>Verification</span>
            {verifyEditable ? (
              <select
                value={draft.verification_status}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, verification_status: e.target.value })}
              >
                {/* Rejection happens only through the Reject flow; a legacy value
                    stays visible but can never be chosen again. */}
                {draft.verification_status === 'rejected' && <option value="rejected">Rejected (legacy)</option>}
                <option value="not_verified">Not verified</option>
                <option value="verified">Verified</option>
              </select>
            ) : <strong>{verifyLabels[draft.verification_status] || '—'}</strong>}
          </div>
          <div className="grid grid-cols-[130px_minmax(0,_1fr)] gap-[10px] text-[#b9c1d5] text-[11.5px] later:[&_strong]:text-[#edf0fa] later:[&_strong]:font-[600] [&_input]:w-full [&_select]:w-full [&_textarea]:w-full later:[align-items:start]">
            <span>Remarks</span>
            {interactive ? (
              <textarea
                rows={2}
                value={draft.remarks}
                disabled={disabled}
                placeholder="What was confirmed, and when"
                onChange={(e) => onChange({ ...draft, remarks: e.target.value })}
              />
            ) : <strong>{draft.remarks || '—'}</strong>}
          </div>
        </div>
      </div>
      {actions}
    </section>
  );
}

/* ---------------- For Approval receipt (Stages 1–5) ----------------
 * A receipt-style read-out of everything the applicant accumulated from
 * qualification to payment. Display only: the three Admin decisions live in
 * the action row underneath.
 */
function ApprovalReceipt({ applicant, draft }) {
  const qualification = (applicant.milestone_state || []).filter((item) => item.key.startsWith('qualification_'));
  const details = draft?.details || {};
  const activityState = applicant.activity_state || {};
  const loiDocument = (applicant.documents || []).find((file) => file.type === 'loi');
  const paymentRecord = applicant.payment_record || {};

  return (
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] later:[background:#101728]" aria-labelledby="ap-receipt-title">
      <header className="flex items-start justify-between gap-4 pb-[14px] [border-bottom:1px_dashed_#303749]">
        <div className="later-2:[&_h3]:m-[2px_0_4px] later:[&_h3]:text-[#fff] later-4:[&_h3]:text-[17px] [&_p]:m-0 later:[&_p]:text-[#9ba5bd] later:[&_p]:text-[11px]">
          <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">Applicant record</span>
          <h3 id="ap-receipt-title">{applicant.full_name}</h3>
          <p>
            {applicant.preferred_brand?.name || 'No brand'}
            {applicant.email ? ` · ${applicant.email}` : ''}
            {applicant.phone ? ` · ${applicant.phone}` : ''}
          </p>
        </div>
        <div className="grid gap-[3px] text-right [&_span]:text-[#9aa6c4] [&_span]:text-[9.5px] [&_span]:tracking-[.06em] [&_span]:uppercase later:[&_strong]:text-[#edf0fa] later-2:[&_strong]:text-[12px]">
          <span>Applied</span>
          <strong>{formatDate(applicant.application_date)}</strong>
          {/* After approval the record shows who approved it and when. */}
          {applicant.approved_at && (
            <>
              <span>Approved</span>
              <strong>{formatDate(applicant.approved_at, true)}</strong>
              <small>{applicant.approved_by || '—'}</small>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-3 mt-[14px] max-[761px]:later:grid-cols-[1fr]">
        <article className="p-3 border border-[#272f44] rounded-[10px] [background:#0c111d] [&_h4]:m-[0_0_8px] [&_h4]:text-[#9aa6c4] [&_h4]:text-[10px] [&_h4]:tracking-[.07em] [&_h4]:uppercase [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_ul]:grid [&_ul]:gap-[6px] [&_li]:flex [&_li]:justify-between [&_li]:gap-[10px] [&_li]:text-[#b9c1d5] [&_li]:text-[11px] [&_li_strong]:text-[#edf0fa] [&_li_strong]:font-[600] [&_li_strong]:text-right">
          <h4>1 · Qualification</h4>
          <ul>
            {qualification.map((item) => (
              <li key={item.key}>
                <span>{item.label}</span>
                <strong className={item.completed ? 'text-[#34d399]! font-[600]' : undefined}>
                  {item.completed ? (details[item.key]?.on ? formatDate(details[item.key].on) : 'Completed') : 'Pending'}
                </strong>
              </li>
            ))}
          </ul>
        </article>

        <article className="p-3 border border-[#272f44] rounded-[10px] [background:#0c111d] [&_h4]:m-[0_0_8px] [&_h4]:text-[#9aa6c4] [&_h4]:text-[10px] [&_h4]:tracking-[.07em] [&_h4]:uppercase [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_ul]:grid [&_ul]:gap-[6px] [&_li]:flex [&_li]:justify-between [&_li]:gap-[10px] [&_li]:text-[#b9c1d5] [&_li]:text-[11px] [&_li_strong]:text-[#edf0fa] [&_li_strong]:font-[600] [&_li_strong]:text-right">
          <h4>2 · Activities</h4>
          <ul>
            {TRACKED_ACTIVITIES.map((tracked) => {
              const state = activityState[tracked.type] || {};
              return (
                <li key={tracked.type}>
                  <span>{tracked.label}</span>
                  <strong className={state.state === 'attended' || state.state === 'completed' ? 'text-[#34d399]! font-[600]' : undefined}>
                    {state.completed_at ? `Completed ${formatDate(state.completed_at)}` : STATE_LABELS[state.state] || 'Not scheduled'}
                  </strong>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="p-3 border border-[#272f44] rounded-[10px] [background:#0c111d] [&_h4]:m-[0_0_8px] [&_h4]:text-[#9aa6c4] [&_h4]:text-[10px] [&_h4]:tracking-[.07em] [&_h4]:uppercase [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_ul]:grid [&_ul]:gap-[6px] [&_li]:flex [&_li]:justify-between [&_li]:gap-[10px] [&_li]:text-[#b9c1d5] [&_li]:text-[11px] [&_li_strong]:text-[#edf0fa] [&_li_strong]:font-[600] [&_li_strong]:text-right">
          <h4>3 · LOI Submission</h4>
          <ul>
            <li><span>Submitted</span><strong>{applicant.loi_submission_date ? formatDate(applicant.loi_submission_date) : '—'}</strong></li>
            <li><span>Received by</span><strong>{applicant.loi_received_by || '—'}</strong></li>
            <li><span>Submission</span><strong>{titleCase(applicant.loi_submission_type || '—')}</strong></li>
            <li><span>Verification</span><strong>{titleCase((applicant.loi_verification_status || '—').replaceAll('_', ' '))}</strong></li>
            <li><span>Document</span><strong>{loiDocument?.original_name || 'None attached'}</strong></li>
          </ul>
        </article>

        <article className="p-3 border border-[#272f44] rounded-[10px] [background:#0c111d] [&_h4]:m-[0_0_8px] [&_h4]:text-[#9aa6c4] [&_h4]:text-[10px] [&_h4]:tracking-[.07em] [&_h4]:uppercase [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_ul]:grid [&_ul]:gap-[6px] [&_li]:flex [&_li]:justify-between [&_li]:gap-[10px] [&_li]:text-[#b9c1d5] [&_li]:text-[11px] [&_li_strong]:text-[#edf0fa] [&_li_strong]:font-[600] [&_li_strong]:text-right">
          <h4>4 · Payment Record</h4>
          <ul>
            {(paymentRecord.required || []).map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                <strong className={item.status === 'verified' ? 'text-[#34d399]! font-[600]' : undefined}>{item.status_label}</strong>
              </li>
            ))}
            <li>
              <span>Required payments verified</span>
              <strong>{paymentRecord.required_count ? `${paymentRecord.verified_count} of ${paymentRecord.required_count}` : (paymentRecord.legacy_confirmed ? 'Confirmed (older record)' : '—')}</strong>
            </li>
          </ul>
        </article>
      </div>

      {/* The payment entries are NOT repeated here: the full Payment Record
          section below this card is the single payment history. */}
    </section>
  );
}

/* The Application Detail report lives in components/applicants/ApplicationDetailReport.jsx. */

export default function Applicants() {
  const { role, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // The active tab lives in the URL (?tab=franchisees) so the header breadcrumb can show it.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab = TABS.some((item) => item.key === requestedTab) ? requestedTab : 'pipeline';
  const setTab = (next) => setSearchParams(next === 'pipeline' ? {} : { tab: next });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [detailFolder, setDetailFolder] = useState('active');
  // Date range and the other server-side filters (Pipeline, Archive, Application Detail).
  const [filters, setFilters] = useState({ from: '', to: '', date_basis: 'applied', brand_id: '', assigned_sales_user_id: '' });
  const filterParams = Object.fromEntries(Object.entries(filters).filter(([key, value]) => value && !(key === 'date_basis' && !filters.from && !filters.to)));
  const filterKey = JSON.stringify(filterParams);
  const [exporting, setExporting] = useState(false);
  const [detailView, setDetailView] = useState(readDetailView);
  const [pipelineColumns, setPipelineColumns] = useState(readPipelineColumns);
  const [pipelineColumnsOpen, setPipelineColumnsOpen] = useState(false);
  const pipelineColumnsRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  // Blue dots cleared in this session (the server clears them on mark-seen).
  const [seenActivityDots, setSeenActivityDots] = useState(() => new Set());
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [draft, setDraft] = useState(null);
  // Snapshot of the draft as loaded; Save stays disabled until something differs from it.
  const [baseline, setBaseline] = useState(null);
  const [mark, setMark] = useState(null); // small "accomplishment record" (date marked / marked by) dialog
  // Phase 2: schedule reveal state, LOI confirmation dialog, activation form, busy flag.
  const [scheduleRevealed, setScheduleRevealed] = useState(false);
  // Phase 2: [Confirm Qualified] opens a double-confirmation dialog; the schedule
  // window in the Qualified stage stays locked until [Set Schedule] is clicked.
  const [qualifiedConfirm, setQualifiedConfirm] = useState(false);
  // Required reasons (the API refuses fewer than 5 characters).
  const [qualifiedRemarks, setQualifiedRemarks] = useState('');
  const [undoLoiForm, setUndoLoiForm] = useState(null);
  // Assigned Sales user: Admin assigns or reassigns (a reassignment needs a reason).
  const [assignForm, setAssignForm] = useState(null);
  const [salesUsers, setSalesUsers] = useState([]);
  const [loiDraft, setLoiDraft] = useState(null);
  // Lightbox payload for a previewed LOI image ({ url, name }), or null.
  const [loiLightbox, setLoiLightbox] = useState(null);
  // For Approval decisions.
  const [approveForm, setApproveForm] = useState(null);
  const [reviseForm, setReviseForm] = useState(null);
  const [rejectForm, setRejectForm] = useState(null);
  // Application Detail read-only report.
  const [report, setReport] = useState(null);
  const [activateForm, setActivateForm] = useState(null);
  const [acting, setActing] = useState(false);
  // The open follow-up dialog: { kind: 'remind' | 'log' | 'hold' | 'close', applicant }.
  const [followUpAction, setFollowUpAction] = useState(null);
  const scheduleRef = useRef(null);

  // The signed-in user, used for "Marked by". The backend names users with `full_name`.
  const authName = String(user?.full_name || user?.name || user?.email || '').trim();
  const authLabel = authName ? `${authName}${role ? ` (${titleCase(role)})` : ''}` : '';

  // Cache of applicant details used by the hover card (cleared after every save).
  const detailCache = useRef(new Map());
  const loadDetail = (id) => {
    if (!detailCache.current.has(id)) {
      const request = api.get(`/applicants/${id}`).then((result) => result.data).catch((error) => {
        detailCache.current.delete(id);
        throw error;
      });
      detailCache.current.set(id, request);
    }
    return detailCache.current.get(id);
  };

  const remote = useRemote(async () => {
    const [applicants, brands, franchisees, detail] = await Promise.all([
      tab === 'detail'
        ? Promise.resolve({ data: [], meta: null })
        : api.get('/applicants', {
          page,
          per_page: PAGE_SIZE,
          search,
          ...splitStatusFilter(status),
          ...filterParams,
          ...(tab === 'archived' ? { archived: 1 } : {}),
        }),
      api.get('/brands'),
      tab === 'franchisees'
        ? api.get('/applicants/active-franchisees', { page, per_page: PAGE_SIZE, search })
        : Promise.resolve({ data: [] }),
      tab === 'detail'
        ? api.get('/applicants/application-detail', { page, per_page: DETAIL_PAGE_SIZE, search, folder: detailFolder, status, ...filterParams })
        : Promise.resolve({ data: [], meta: null }),
    ]);

    // Rows are identified by their permanent Applicant ID (applicant_code); the
    // old row numbering (display_no) is no longer shown anywhere.
    return {
      applicants: applicants.data || [],
      meta: applicants.meta,
      brands: brands.data,
      franchisees: franchisees.data,
      franchiseeMeta: franchisees.meta || null,
      detailRows: detail.data || [],
      detailMeta: detail.meta || null,
    };
  }, [page, search, status, tab, detailFolder, filterKey]);

  // Customize Columns closes on an outside click; the selection is remembered in this browser.
  useEffect(() => {
    if (!pipelineColumnsOpen) return undefined;
    const close = (event) => {
      if (!pipelineColumnsRef.current?.contains(event.target)) setPipelineColumnsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pipelineColumnsOpen]);
  const togglePipelineColumn = (key) => {
    setPipelineColumns((current) => {
      const next = { ...current, [key]: !current[key] };
      try { window.localStorage.setItem(PIPELINE_COLUMNS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep for this visit only */ }
      return next;
    });
  };

  // Assigned Sales choices: Admin picks any Sales user; a Sales user filters to their own.
  const [salesChoices, setSalesChoices] = useState([]);
  useEffect(() => {
    if (role !== 'admin') return undefined;
    let active = true;
    api.get('/applicants/sales-users').then((result) => { if (active) setSalesChoices(result.data || []); }).catch(() => {});
    return () => { active = false; };
  }, [role]);

  /** Exports every filtered row (all pages), with the existing CSV/PDF export. */
  const exportFiltered = async (kind) => {
    setExporting(true);
    setActionError('');
    try {
      const detail = tab === 'detail';
      const path = detail ? '/applicants/application-detail' : '/applicants';
      const base = detail ? { search, folder: detailFolder, status, ...filterParams } : { search, ...splitStatusFilter(status), ...filterParams, ...(tab === 'archived' ? { archived: 1 } : {}) };
      const all = [];
      for (let p = 1; p <= 100; p += 1) {
        const result = await api.get(path, { ...base, page: p, per_page: 100 });
        all.push(...(result.data || []));
        if (!result.meta || p >= Number(result.meta.last_page || 1)) break;
      }
      const headers = ['Applicant ID', 'Name', 'Email', 'Phone', 'Brand', 'Stage', 'Days in stage', 'Overdue', 'Assigned Sales', 'Date applied', 'Approved', 'Rejected'];
      const rows = all.map((a) => [
        a.applicant_code || '', a.full_name || '', a.email || '', a.phone || '', a.preferred_brand?.name || a.brand || '',
        a.status_label || titleCase(String(a.status || '').replace(/_/g, ' ')), a.days_in_stage ?? '', a.overdue ? 'Yes' : 'No',
        a.assigned_sales?.full_name || 'Unassigned', a.application_date ? formatDate(a.application_date) : '',
        a.approved_at ? formatDate(a.approved_at) : '', a.rejected_at ? formatDate(a.rejected_at) : '',
      ]);
      const range = filters.from || filters.to ? `${filters.from || '…'} to ${filters.to || '…'} (${filters.date_basis})` : 'All dates';
      const name = `applicants-${tab}-${new Date().toISOString().slice(0, 10)}`;
      if (kind === 'pdf') downloadPdf(name, headers, rows, 'Applicants', `${range} · ${rows.length} record(s)`);
      else downloadCsv(name, headers, rows);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const canManage = ['admin', 'sales'].includes(role);
  // One role check drives the whole modal: the tracker, the checklist and every
  // stage button are Admin's, Sales gets a read-only modal + "Confirm Payment".
  const isSalesRole = role === 'sales';
  const canEditDetails = can(role, 'applicants.update');
  const isAdminRole = can(role, 'applicants.transition');
  // Only the assigned Sales user acts for an applicant (the API enforces the same).
  const isAssignedSales = isSalesRole && Boolean(editing?.assigned_sales_user_id) && Number(editing.assigned_sales_user_id) === Number(user?.id);
  // A follow-up chip leads to the applicant's Follow-up section: scroll there smoothly and highlight it.
  const [followUpFlash, setFollowUpFlash] = useState(false);
  const pendingFollowUpJump = useRef(false);
  const goToFollowUp = () => {
    const section = document.getElementById(FOLLOW_UP_SECTION_ID);
    if (!section) return false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    section.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
    setFollowUpFlash(true);
    window.setTimeout(() => setFollowUpFlash(false), 1600);
    return true;
  };
  /** From the pipeline row (or the dashboard): open the applicant, then go to its Follow-up section. */
  const openAtFollowUp = (applicant) => {
    pendingFollowUpJump.current = true;
    if (editing && Number(editing.id) === Number(applicant.id)) goToFollowUp();
    else void loadApplicant(applicant.id, applicant.status);
  };
  useEffect(() => {
    if (!pendingFollowUpJump.current || !editing) return undefined;
    const timer = window.setTimeout(() => { if (goToFollowUp()) pendingFollowUpJump.current = false; }, 120);
    return () => window.clearTimeout(timer);
  }, [editing]);

  // Save is enabled only when the draft differs from the loaded record.
  const hasChanges = Boolean(draft && baseline && JSON.stringify(draft) !== baseline);

  const closeEditor = () => {
    setEditing(null);
    setDraft(null);
    setBaseline(null);
    setMark(null);
    setEditRequiredOpen(false);
    setLoiDraft(null);
    setApproveForm(null);
    setReviseForm(null);
    setRejectForm(null);
    setQualifiedConfirm(false);
  };

  const loadApplicant = async (id, previewStatus = null) => {
    setActionError('');
    setSuccess('');
    // A freshly opened applicant starts with the schedule section hidden again:
    // it is only revealed by "Set Schedule" (or stays visible from the stage on).
    setScheduleRevealed(false);
    setApproveForm(null);
    setReviseForm(null);
    setRejectForm(null);
    setQualifiedConfirm(false);
    setOpeningId({ id, status: previewStatus });
    try {
      const detail = { data: await loadDetail(id) };
      setEditing(detail.data);
      // Opening the record counts as reading it: the signed-in user's red dot
      // for this applicant is cleared in the database, then the sidebar/header
      // dots refresh immediately. Failures never block the modal.
      void api.post('/notifications/mark-seen', { record_type: 'applicant', record_id: id })
        .then(() => window.dispatchEvent(new Event('herald:notifications-updated')))
        .catch(() => {});
      setEditRequiredOpen(false);
      setLoiDraft({
        submission_date: detail.data.loi_submission_date ? String(detail.data.loi_submission_date).slice(0, 10) : '',
        received_by: detail.data.loi_received_by || '',
        submission_type: detail.data.loi_submission_type || 'physical',
        verification_status: detail.data.loi_verification_status || 'not_verified',
        remarks: detail.data.loi_remarks || '',
        file: null,
        // TRUE once the Admin detached the saved attachment (deleted on save).
        removeDocument: false,
      });
      const loaded = {
        full_name: detail.data.full_name || '',
        email: detail.data.email || '',
        phone: detail.data.phone || '',
        address: detail.data.address || '',
        notes: detail.data.notes || '',
        status: detail.data.status,
        // Always include EVERY milestone key (false when not completed). An applicant with no
        // saved checklist would otherwise send an empty object and fail the "milestones" validation.
        milestones: Object.fromEntries(
          (detail.data.milestone_state || []).map((m) => [m.key, Boolean(detail.data.milestones?.[m.key])]),
        ),
        details: { ...(detail.data.milestone_details || {}) },
      };
      setDraft(loaded);
      setBaseline(JSON.stringify(loaded));
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setOpeningId(null);
    }
  };

  const saveApplicant = async (event) => {
    event.preventDefault();
    if (!editing || !draft) return;
    if (!draft.full_name.trim()) {
      setActionError('Full name is required.');
      return;
    }
    // Phase 2: at the Qualification stage Sales' [Save Applicant] saves the five
    // assessments only — the single action Sales has there, and the only one that
    // records a date for each item.
    if (isSalesRole && ['converted', 'qualified'].includes(draft.status)) {
      setSaving(true);
      setActionError('');
      setSuccess('');
      try {
        await api.put(`/applicants/${editing.id}/assessments`, {
          milestones: Object.fromEntries(
            QUALIFICATION_ITEMS.map(({ key }) => [key, Boolean(draft.milestones[key])]),
          ),
        });
        detailCache.current.clear();
        await loadApplicant(editing.id);
        await remote.reload();
        setSuccess('Assessments saved — Admin sees them right away.');
      } catch (error) {
        setActionError(firstValidationMessage(error));
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    setActionError('');
    setSuccess('');
    let partial = false;
    try {
      await api.put(`/applicants/${editing.id}`, {
        full_name: draft.full_name,
        email: draft.email || null,
        phone: draft.phone || null,
        address: draft.address || null,
        notes: draft.notes || null,
      });
      partial = true; // the applicant is already changed, so the list must reload even if a later step fails

      if (draft.status !== editing.status) {
        await api.patch(`/applicants/${editing.id}/status`, { status: draft.status });
      }
      await api.patch(`/applicants/${editing.id}/milestones`, {
        milestones: draft.milestones,
        milestone_details: draft.details,
      });

      // Read the applicant back and confirm that "Date marked" and "Marked by" really were stored.
      // Without this check the page would report success even if the server silently drops them.
      const fresh = (await api.get(`/applicants/${editing.id}`)).data;
      const lost = Object.keys(draft.details)
        .filter((key) => draft.milestones[key])
        .filter((key) => !(fresh?.milestone_details?.[key]?.on && fresh?.milestone_details?.[key]?.by));
      if (lost.length) {
        const labels = (editing.milestone_state || []).filter((m) => lost.includes(m.key)).map((m) => m.label);
        const error = new Error(
          `The applicant was saved, but the server did not store Date marked / Marked by for: ${(labels.length ? labels : lost).join(', ')}. `
          + 'These records are not saved yet.',
        );
        error.verification = true;
        throw error;
      }

      detailCache.current.clear();
      closeEditor();
      setSuccess('Applicant updated successfully.');
      await remote.reload();
    } catch (error) {
      setActionError(error.verification ? error.message : firstValidationMessage(error));
      if (partial) {
        detailCache.current.clear();
        await remote.reload();
      }
    } finally {
      setSaving(false);
    }
  };

  const archiveApplicant = async (applicant) => {
    setArchiveTarget(null);
    setUpdatingId(applicant.id);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/applicants/${applicant.id}/archive`);
      setSuccess(`${applicant.full_name} moved to the archive.`);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setUpdatingId(null);
    }
  };

  /* ---------- Activity review (Admin) and Brand Confirmation ---------- */
  const runRequest = async (request, message) => {
    if (!editing) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      const result = await request();
      await refreshApplicant(editing.id);
      setSuccess(result?.message || message);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };
  const [editRequiredOpen, setEditRequiredOpen] = useState(false);
  const saveRequiredPayments = (body) => runRequest(async () => { const result = await api.put(`/applicants/${editing.id}/required-payments`, body); setEditRequiredOpen(false); return result; }, 'Required payments saved.');
  const submitPaymentEntry = (body) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries`, body), 'Submitted for verification.');
  const editPaymentEntry = (id, body) => runRequest(() => api.put(`/applicants/${editing.id}/payment-entries/${id}`, body), 'Entry updated — still waiting for Admin to verify it.');
  const verifyPaymentEntry = (entry) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries/${entry.id}/verify`, { revision: entry.revision }), 'Payment verified.');
  const rejectPaymentEntry = (entry, reason) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries/${entry.id}/reject`, { reason, revision: entry.revision }), 'Payment rejected — Sales was told why.');
  const moveToForApproval = () => runRequest(() => api.post(`/applicants/${editing.id}/payments/complete`, {}), 'All required payments are Verified — the applicant is now at For Approval.');
  const logApplicantFollowUp = (body) => runRequest(() => api.post(`/applicants/${editing.id}/follow-ups`, body), 'Follow-up logged.');
  const savePreferredLocation = (body) => runRequest(() => api.put(`/applicants/${editing.id}/preferred-location`, body), 'Preferred franchise location saved.');
  const submitRequirement = (key, body) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}`, body), 'Sent to Admin for review.');
  const acceptRequirement = (key, note = '') => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}/accept`, note ? { note } : {}), 'Requirement accepted.');
  const reopenRequirement = (key, reason) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}/reopen`, { reason }), 'Requirement re-opened for review.');
  const returnRequirement = (key, reason) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}/return`, { reason }), 'Requirement returned to Sales.');
  const [loiReturn, setLoiReturn] = useState(null);
  const returnLoi = (reason) => runRequest(async () => { const result = await api.post(`/applicants/${editing.id}/loi/return`, { reason }); setLoiReturn(null); return result; }, 'LOI returned to Sales.');
  const markActivityAttended = (activity) => runRequest(() => api.post(`/activities/${activity.id}/attended`, {}), activity.activity_type === 'orientation' ? 'Orientation/Tasting verified.' : 'Marked Attended.');
  const returnActivity = (activity, reason) => runRequest(() => api.post(`/activities/${activity.id}/return`, { reason }), 'Returned to Sales.');

  /* ---------- Assigned Sales user (Admin) ---------- */
  const openAssign = async () => {
    setAssignForm({ assigned_sales_user_id: '', reason: '' });
    try {
      const result = await api.get('/applicants/sales-users');
      setSalesUsers(result.data || []);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    }
  };

  const saveAssignment = async () => {
    if (!editing || !assignForm) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      const result = await api.post(`/applicants/${editing.id}/assign-sales`, {
        assigned_sales_user_id: assignForm.assigned_sales_user_id ? Number(assignForm.assigned_sales_user_id) : null,
        reason: assignForm.reason.trim() || null,
      });
      setAssignForm(null);
      await refreshApplicant(editing.id);
      setSuccess(result.message || 'Sales assignment saved.');
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /* ---------- Phase 2: stage actions driven by the single primary button ---------- */
  const refreshApplicant = async (id) => {
    detailCache.current.clear();
    await loadApplicant(id);
    await remote.reload();
  };

  /**
   * Every stage movement goes through the backend state machine: the API answers
   * 403 for the wrong role and 422 for a skipped/unmet stage, which is surfaced
   * in the modal. The list reload keeps the table's status column in sync.
   */
  const performStageAction = async (kind, payload = null) => {
    if (!editing) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      switch (kind) {
        case 'qualified':
          // Phase 2: the double-confirmation dialog's second click is what the
          // API requires; the Qualified date is stamped by this call.
          await api.post(`/applicants/${editing.id}/confirm-qualified`, {
            confirmed: true,
            remarks: payload?.remarks || '',
          });
          setQualifiedConfirm(false);
          setQualifiedRemarks('');
          setSuccess('Applicant confirmed as Qualified — the Qualified date is saved.');
          break;
        case 'setSchedule':
          // Proceed button only: the API moves Qualified -> Scheduling and saves
          // it. No schedule or session is created; each activity is set next.
          await api.post(`/applicants/${editing.id}/set-schedule`, {});
          setSuccess('Applicant moved to Scheduling — Schedule Activity is unlocked. Set Orientation/Tasting first, then Training.');
          break;
        case 'loi':
          await api.patch(`/applicants/${editing.id}/status`, {
            status: 'loi_submitted',
            remarks: payload?.remarks || `LOI confirmed by ${authLabel}`,
            loi_submission_date: payload?.loi_submission_date || undefined,
            loi_received_by: payload?.loi_received_by || undefined,
            loi_submission_type: payload?.loi_submission_type || undefined,
            loi_verification_status: payload?.loi_verification_status || undefined,
          });
          setSuccess('LOI confirmed — the stage is now LOI Submitted.');
          break;
        case 'undoLoi':
          await api.patch(`/applicants/${editing.id}/status`, {
            status: 'scheduled',
            remarks: payload?.remarks || '',
          });
          setUndoLoiForm(null);
          setSuccess('LOI confirmation undone — back to Scheduled.');
          break;
        case 'review':
          await api.post(`/applicants/${editing.id}/review`, {
            remarks: payload?.remarks || `Reviewed by ${authLabel}`,
          });
          setSuccess('Review confirmed — Approval is now checked.');
          break;
        case 'approve':
          await api.post(`/applicants/${editing.id}/approve`, {
            remarks: payload?.remarks || `Approved by ${authLabel}`,
          });
          setSuccess('Applicant approved.');
          break;
        case 'activate':
          await api.post(`/applicants/${editing.id}/activate`, payload);
          setActivateForm(null);
          setSuccess('Applicant marked as an active franchisee.');
          break;
        default:
          break;
      }
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /* ---------- Stage 3: LOI submission panel ---------- */
  // Rules (the API enforces the same):
  //  - The LOI file is required: Sales cannot save the LOI without one.
  //  - [Complete] (the only way to Payment Record): LOI Verified with its file + submission date,
  //    AND the Proposed site Accepted by Admin. Uploading never completes the LOI.
  const loiSavedDocument = currentLoiDocument(editing?.documents);
  const loiHasImage = Boolean(loiDraft?.file) || Boolean(loiSavedDocument && !loiDraft?.removeDocument);
  const loiDateOk = Boolean(loiDraft?.submission_date) && loiDraft.submission_date <= localDateInputValue();
  const loiPending = editing?.loi_status === 'pending';
  // An older Pending LOI (already at Payment Record) is completed on the LOI alone.
  const proposedSiteStatus = editing?.requirements?.items?.find((item) => item.key === 'proposed_site')?.status || 'pending';
  const siteNeeded = editing?.status === 'loi_submitted';
  const loiCompleteIssue = !loiDraft ? 'Loading the LOI record…'
    : !loiHasImage ? 'Attach the LOI file — it is required.'
      : !loiDateOk ? 'Set the submission date (not in the future).'
        : loiDraft.verification_status !== 'verified' ? 'Mark the LOI as Verified.'
          : siteNeeded && proposedSiteStatus !== 'accepted' ? 'Verify the Proposed site (Accept it below).'
            : '';
  const loiReady = loiCompleteIssue === '';

  /** Save the LOI record (fields + new file; a removed file is deleted). Never completes it. */
  const saveLoiRecord = async () => {
    const removedDocument = loiDraft.removeDocument ? loiSavedDocument : null;
    const body = new FormData();
    if (isAdminRole) {
      // Admin only verifies: the details and the scan come from the assigned Sales user.
      body.append('verification_status', loiDraft.verification_status);
    } else {
      if (removedDocument && !loiDraft.file) {
        throw new Error('Choose the replacement scan. The old file stays in the history, marked Replaced.');
      }
      if (!loiDraft.file && !loiSavedDocument) throw new Error('Attach the LOI file (PDF, JPG or PNG). The LOI cannot be submitted without it.');
      if (loiDraft.submission_date) body.append('submission_date', loiDraft.submission_date);
      body.append('received_by', loiDraft.received_by || authLabel);
      body.append('submission_type', loiDraft.submission_type);
      if (loiDraft.file) body.append('file', loiDraft.file);
    }
    if (loiDraft.remarks.trim()) body.append('remarks', loiDraft.remarks.trim());
    await api.post(`/applicants/${editing.id}/loi`, body);
    // Admin may remove an unverified scan (it is only marked Removed). A Sales upload already
    // marks the old scan Replaced, so nothing else is sent.
    if (removedDocument && isAdminRole) {
      await api.delete(`/applicants/${editing.id}/documents/${removedDocument.id}`);
    }
  };

  /** Run one LOI action: save the record, then (optionally) Complete / Proceed. */
  const runLoiAction = async (kind) => {
    if (!editing || !loiDraft) return;
    if (kind === 'complete' && !loiReady) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await saveLoiRecord();
      if (kind === 'complete') {
        await api.post(`/applicants/${editing.id}/loi/complete`, {
          remarks: loiDraft.remarks.trim() || `LOI verified by ${authLabel}`,
        });
        setSuccess(loiPending
          ? 'LOI Complete — For Approval is no longer blocked by the LOI.'
          : 'LOI Complete — the applicant is now at Payment Record.');
      } else {
        setSuccess('LOI record saved. Uploading does not complete the LOI — click Complete when it is verified.');
      }
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };
  const completeLoiStage = () => runLoiAction('complete');

  /** The LOI action row (Admin): Save · Proceed (soft copy, LOI stage) · Complete. */
  const loiActions = (isAdminRole || isAssignedSales) && loiDraft ? (
    <div className="mt-[14px] pt-3 border-t border-t-[#293246] [&_.ap-actions]:justify-end [&_.ap-actions]:flex-wrap [&_.ap-actions]:gap-2">
      {loiPending && (
        <p className="m-[0_0_10px] p-[10px_12px] rounded-[10px] border border-[rgba(245,_158,_11,_.4)] [background:rgba(245,_158,_11,_.1)] text-[#fde3a7] text-[13px] leading-[1.5]" role="status">
          <strong>LOI Pending.</strong> {isAdminRole ? 'The assigned Sales user uploads the soft-copy scan; then mark it Verified and click Complete.' : 'Upload the soft-copy scan; Admin then verifies it and completes the LOI.'} For Approval stays blocked until then.
        </p>
      )}
      {editing?.requirements?.loi && (
        <p className="m-[0_0_10px] text-[14px] text-[#c9d0e0]">
          Scanned LOI (required for every LOI): <RequirementStatus status={editing.requirements.loi.status} />
          {editing.requirements.loi.status === 'returned' && <span className="block text-[#fbbf24]">Return reason: {editing.requirements.loi.return_reason}</span>}
        </p>
      )}
      {isAdminRole && editing?.requirements?.loi?.status === 'submitted' && (
        loiReturn === null ? (
          <button type="button" className="mb-2" disabled={acting} onClick={() => setLoiReturn('')}>Return LOI to Sales</button>
        ) : (
          <span className="grid gap-2 mb-2">
            <textarea rows={2} value={loiReturn} onChange={(e) => setLoiReturn(e.target.value)} placeholder="What Sales must correct (at least 5 characters)" />
            <span className="flex gap-2">
              <button type="button" disabled={acting} onClick={() => setLoiReturn(null)}>Cancel</button>
              <button type="button" disabled={acting || loiReturn.trim().length < 5} onClick={() => void returnLoi(loiReturn.trim())}>Return with reason</button>
            </span>
          </span>
        )
      )}
      <div className="ap-actions flex flex-wrap items-center gap-[10px] mt-[14px]">
        <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={acting} onClick={() => void runLoiAction('save')}>
          Save LOI
        </button>
        {isAdminRole && (
        <button
          type="button"
          className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
          disabled={acting || !loiReady}
          title={loiCompleteIssue || 'Mark the LOI Complete.'}
          onClick={() => void runLoiAction('complete')}
        >
          {acting ? 'SAVING…' : 'Complete'}
        </button>
        )}
      </div>
      {isAdminRole && !loiReady && <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">Complete: {loiCompleteIssue}</p>}
    </div>
  ) : null;

  /* ---------- Stage 6: For Approval decisions ---------- */

  /** Approve (with confirmation). Confirms the review checkpoint first when needed. */
  const approveApplicant = async () => {
    if (!editing || !approveForm) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      const remarks = approveForm.remarks.trim() || `Approved by ${authLabel}`;
      if (!editing.reviewed_at) {
        await api.post(`/applicants/${editing.id}/review`, { remarks });
      }
      await api.post(`/applicants/${editing.id}/approve`, { remarks });
      setApproveForm(null);
      setSuccess('Applicant approved — For Approval and Approved are now checked.');
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /** Revise: send the applicant back to one of the four completed stages. */
  const reviseApplicant = async () => {
    if (!editing || !reviseForm || !reviseForm.remarks.trim()) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/applicants/${editing.id}/revise`, {
        stage: reviseForm.stage,
        remarks: reviseForm.remarks.trim(),
      });
      const label = REVISE_STAGES.find((item) => item.key === reviseForm.stage)?.label || reviseForm.stage;
      setReviseForm(null);
      setSuccess(`Returned to ${label} for revision.`);
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /** Reject (with confirmation): the applicant is rejected and archived. */
  const rejectApplicant = async () => {
    if (!editing || !rejectForm) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.patch(`/applicants/${editing.id}/status`, {
        status: 'rejected',
        remarks: rejectForm.remarks.trim(),
      });
      setRejectForm(null);
      closeEditor();
      setSuccess(`${editing.full_name} rejected and moved to the archive.`);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /** Application Detail: load the read-only report for one approved applicant. */
  const openReport = async (id) => {
    setReport({ loading: true, data: null, error: '' });
    try {
      const result = await api.get(`/applicants/${id}/report`);
      setReport({ loading: false, data: result.data, error: '' });
    } catch (error) {
      setReport({ loading: false, data: null, error: firstValidationMessage(error) });
    }
  };

  /** Activation collects business + location, prefilled from the applicant record. */
  /** Approved, branch account invited but not accepted yet: send the invitation again. */
  const resendPortalInvite = async () => {
    if (!editing?.user?.id) return;
    setActionError('');
    setSuccess('');
    try {
      const response = await api.post(`/users/${editing.user.id}/resend-invite`);
      setSuccess(response.message || `Invite email sent to ${editing.user.email}.`);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    }
  };

  const openActivateForm = () => {
    const existing = editing?.franchisee;
    const location = existing?.locations?.[0];
    // A NEW branch is named "<Brand> <City/Municipality> – <Barangay/St>" from the verified Proposed site (editable).
    const site = editing?.requirements?.items?.find((item) => item.key === 'proposed_site');
    const siteLocation = site?.status === 'accepted' && site.data?.location?.city_code ? site.data.location : null;
    setActivateForm({
      business_name: existing?.business_name || editing?.full_name || '',
      'location.name': location?.name || suggestBranchName(editing?.preferred_brand?.name, siteLocation),
      'location.preferred_branch_type': location?.preferred_branch_type || editing?.preferred_brand?.name || '',
      'location.address': location?.address || formatLocation(siteLocation) || '',
      'location.city': location?.city || siteLocation?.city || '',
      'location.province': location?.province || siteLocation?.province || '',
      'location.region': location?.region || '',
      'location.contact_number': location?.contact_number || editing?.phone || '',
    });
    setActionError('');
  };

  const submitActivate = async (event) => {
    event.preventDefault();
    if (!activateForm) return;
    await performStageAction('activate', {
      business_name: activateForm.business_name,
      location: {
        name: activateForm['location.name'],
        preferred_branch_type: activateForm['location.preferred_branch_type'] || null,
        address: activateForm['location.address'],
        city: activateForm['location.city'] || null,
        province: activateForm['location.province'] || null,
        region: activateForm['location.region'] || null,
        contact_number: activateForm['location.contact_number'] || null,
      },
    });
  };

  /* ---------- Schedule Activity section actions (Phase 3b) ---------- */

  /**
   * "Set Schedule" / "Set Again": jump to Activities & Schedule with the
   * applicant and activity pre-selected (the page glows its create button).
   */
  const goSchedule = (activityType) => {
    if (!editing) return;
    navigate(`/activities?applicant_id=${editing.id}&activity_type=${activityType}&preselect=1`);
  };

  /** [Open in calendar]: the activity's session in Master Schedule. */
  const openSessionInCalendar = (session) => {
    if (!session?.id) return;
    navigate(`/activities?view=master-schedule&session=${session.id}`);
  };

  /** [View]: Activities & Schedule, filtered to and highlighting this applicant. */
  const viewInActivities = () => {
    if (!editing) return;
    navigate('/activities', { state: { viewApplicantId: editing.id } });
  };

  /**
   * Admin's "Attended" tick. It only writes the modal DRAFT — Save Applicant is
   * the single action that persists it (Section 3), so closing the modal records
   * nothing. Ticking is allowed only after Sales marked the activity Complete;
   * once saved, the button is disabled and the record cannot be undone.
   */
  const pickScheduleMilestone = (tracked, info) => {
    if (info?.attended || info?.state === 'attended') return;
    if (info?.state !== 'completed') return;
    const milestone = (editing?.milestone_state || []).find((m) => m.key === tracked.key)
      || { key: tracked.key, label: tracked.label };
    openMark(milestone);
  };

  /* ---------- checkbox -> accomplishment record dialog ---------- */
  const openMark = (milestone) => {
    const existing = draft.details[milestone.key];
    // An existing record keeps the person who originally marked it; a new one uses the signed-in user.
    const by = existing?.by || authLabel;
    setMark({
      milestone,
      checked: !!draft.milestones[milestone.key],
      on: existing?.on ? toLocalInput(existing.on) : nowLocal(),
      by,
      byLocked: Boolean(by), // only ask for a name if the signed-in user cannot be identified
    });
  };

  const saveMark = () => {
    if (!mark || !mark.on || !mark.by.trim()) return;
    const { key } = mark.milestone;
    setDraft((current) => ({
      ...current,
      milestones: { ...current.milestones, [key]: true },
      details: { ...current.details, [key]: { on: mark.on, by: mark.by.trim() } },
    }));
    setMark(null);
  };

  const removeMark = () => {
    const { key } = mark.milestone;
    setDraft((current) => {
      const details = { ...current.details };
      delete details[key];
      return { ...current, milestones: { ...current.milestones, [key]: false }, details };
    });
    setMark(null);
  };


  const rows = remote.data?.applicants || [];
  const franchisees = remote.data?.franchisees || [];
  const activeStatuses = tab === 'pipeline' ? statuses : [];

  const switchTab = (next) => {
    setTab(next);
    setPage(1);
    setStatus('');
  };

  const switchDetailFolder = (next) => {
    setDetailFolder(next);
    setPage(1);
  };

  const changeDetailView = (next) => {
    setDetailView(next);
    try { window.localStorage.setItem(DETAIL_VIEW_KEY, next); } catch { /* storage unavailable: keep it for this visit only */ }
  };

  // If the current page no longer exists (e.g. the only row on the last page was archived
  // or removed), move to the last valid page instead of showing an empty table.
  useEffect(() => {
    const meta = tab === 'franchisees' ? remote.data?.franchiseeMeta
      : tab === 'detail' ? remote.data?.detailMeta
        : remote.data?.meta;
    if (!meta) return;
    const last = Math.max(1, Number(meta.last_page) || 1);
    if (page > last) setPage(last);
  }, [remote.data, page, tab]);

  // Derived state for the tracker, the primary action button and the schedule section.
  const stage = draft?.status || null;
  // "Scheduled is checked" comes from the SAVED record (schedule_complete),
  // never from unsaved draft ticks: while waiting, the tracker shows 3 dots.
  const scheduleComplete = Boolean(editing?.schedule_complete);
  const reviewDone = Boolean(editing?.reviewed_at);
  // Payment Record: confirmed once Admin moved the applicant to For Approval with every
  // required payment Verified. No amounts are read or computed here.
  const paymentConfirmed = Boolean(editing?.payment_confirmed);
  const paymentsVisible = role === 'admin' || role === 'sales';
  const paymentsComplete = Boolean(editing?.payment_record?.all_verified || editing?.payment_record?.legacy_confirmed);
  // Confirm Qualified needs every Qualification requirement Accepted (older records keep their checklist).
  const qualificationSummary = editing?.requirements?.summary?.qualification;
  const qualificationDone = qualificationSummary
    ? qualificationSummary.complete || (qualificationSummary.legacy && QUALIFICATION_ITEMS.every(({ key }) => Boolean(draft?.milestones?.[key])))
    : QUALIFICATION_ITEMS.every(({ key }) => Boolean(draft?.milestones?.[key]));
  const qualificationMissing = qualificationSummary?.missing || [];
  const qualificationDefsList = (editing?.requirements?.config?.requirements || []).filter((def) => def.stage === 'qualification');
  const qualificationTotalCount = qualificationDefsList.length;
  const qualificationAcceptedCount = qualificationDefsList.filter((def) => editing.requirements.items?.find((item) => item.key === def.key)?.status === 'accepted').length;
  const activationMissing = editing?.requirements?.summary?.activation?.missing || [];
  const primary = draft
    ? resolvePrimaryAction({
      stage,
      qualificationMissing,
      allAttended: scheduleComplete,
      pendingActivities: TRACKED_ACTIVITIES
        .filter((tracked) => !editing?.activity_state?.[tracked.type]?.done)
        .map((tracked) => tracked.label),
      loiReady,
      qualificationDone,
      activationMissing,
      paymentsComplete,
      isAdminRole,
      isSalesRole,
      hasPortalAccount: Boolean(editing?.has_portal_account),
      portalInvitePending: ['invited', 'declined'].includes(editing?.user?.account_status),
    })
    : null;
  // Confirm Qualified moves to the footer (replacing SAVE CHANGES) once it is enabled.
  const footerPrimary = Boolean(primary?.enabled && primary.run === 'qualified');
  const showSchedule = Boolean(draft) && (scheduleRevealed || SCHEDULE_VISIBLE_FROM.includes(stage));

  // Applicant-level "Set Again" (Section 4): the NEXT activity step only, shown
  // when the previous step is DONE, a next step exists, and that step has no
  // active or pending schedule yet. It is never placed inside an activity.
  const nextActivity = (() => {
    const state = editing?.activity_state;
    if (!state) return null;
    const index = TRACKED_ACTIVITIES.findIndex((tracked) => !state?.[tracked.type]?.done);
    if (index < 0) return null; // both Done
    const noShowFirst = (editing?.schedules || []).some((row) => row.activity_type === TRACKED_ACTIVITIES[0].type && row.status === 'no_show');
    if (index === 0 && !noShowFirst) return null; // nothing Done yet: Set Schedule instead
    const tracked = TRACKED_ACTIVITIES[index];
    // Training waits for Orientation/Tasting verified by Admin (which also locks the brand).
    if (tracked.type === 'training' && !state?.orientation?.done) return null;
    const pendingAnywhere = TRACKED_ACTIVITIES.some((item) => state?.[item.type]?.state === 'pending_admin');
    if (state?.[tracked.type]?.active || pendingAnywhere || editing?.has_pending_schedule_update) return null;
    return tracked;
  })();

  // First schedule (Orientation): nothing is DONE yet, so Set Again does not
  // apply — the Scheduling stage offers Set Schedule for step 1 only. Later
  // steps are always reached through Set Again.
  const firstActivity = (() => {
    const state = editing?.activity_state;
    if (!state) return null;
    if (TRACKED_ACTIVITIES.findIndex((tracked) => !state?.[tracked.type]?.done) !== 0) return null;
    const tracked = TRACKED_ACTIVITIES[0];
    // After a No Show the same activity is rescheduled with Set Again.
    if ((editing?.schedules || []).some((row) => row.activity_type === tracked.type && row.status === 'no_show')) return null;
    const info = state?.[tracked.type] || {};
    if (info.active || info.scheduled || info.state !== 'not_scheduled') return null;
    return tracked;
  })();

  // Finished sections, under the current work and collapsed (show/hide):
  //   Qualified / Scheduling -> Qualification Assessment
  //   LOI Submission         -> Schedule Activity, Qualification Assessment
  //   Payment Record     -> LOI, Schedule Activity, Qualification Assessment
  const doneSectionKeys = {
    qualified: ['qualification'],
    scheduled: ['qualification'],
    loi_submitted: ['schedule', 'qualification'],
    payment_submitted: ['loi', 'schedule', 'qualification'],
  }[stage] || [];
  const doneActivityCount = TRACKED_ACTIVITIES.filter((tracked) => editing?.activity_state?.[tracked.type]?.done).length;
  const qualificationCount = QUALIFICATION_ITEMS.filter(({ key }) => draft?.milestones?.[key]).length;
  // The retired five-item checklist is history only: hidden here once every current Qualification
  // requirement has a record (it stays in Application Detail as "Older checklist (history)").
  const currentQualificationDefs = (editing?.requirements?.config?.requirements || []).filter((def) => def.stage === 'qualification');
  const hasCurrentQualification = currentQualificationDefs.length > 0 && currentQualificationDefs.every((def) => {
    const item = (editing?.requirements?.items || []).find((i) => i.key === def.key);
    return item && item.status !== 'pending';
  });
  const showOldChecklist = (editing?.assessment_log || []).length > 0 && !hasCurrentQualification;
  const doneSections = editing && draft && doneSectionKeys.length ? (
    <div className="grid gap-[10px] m-[4px_0_14px]">
      {doneSectionKeys.map((key) => {
        if (key === 'loi') {
          return loiDraft ? (
            <DoneSection
              key={key}
              title={loiPending ? 'LOI Submission · Pending' : 'LOI Submission'}
              summary={loiPending ? 'Upload the image, verify it and Complete' : titleCase(editing.loi_status || loiDraft.verification_status || 'not_verified')}
              tone={loiPending ? 'pending' : 'done'}
              defaultOpen={loiPending}
            >
              <LoiPanel
                draft={loiDraft}
                interactive={loiPending && (isAdminRole || isAssignedSales)}
                canEditDetails={isAssignedSales}
                canVerify={isAdminRole}
                disabled={!loiPending || acting}
                savedDocument={currentLoiDocument(editing.documents)}
                applicantId={editing.id}
                receivedByName={editing.loi_received_by || authLabel}
                onChange={setLoiDraft}
                onPreview={setLoiLightbox}
                onError={setActionError}
                status={editing.loi_status}
                actions={loiPending ? loiActions : null}
              />
              <RequirementsPanel editing={editing} stage="loi" title="Proposed site" readOnly busy={false} onSubmit={() => {}} onAccept={() => {}} onReturn={() => {}} onError={setActionError} />
            </DoneSection>
          ) : null;
        }
        if (key === 'schedule') {
          return (
            <DoneSection key={key} title="Schedule Activity" summary={`${doneActivityCount} of ${TRACKED_ACTIVITIES.length} done`}>
              <ScheduleSection
                editing={editing}
                draft={draft}
                isAdminRole={isAdminRole}
                onPickChecked={pickScheduleMilestone}
                onOpenCalendar={openSessionInCalendar}
                onView={viewInActivities}
                busy={acting}
                onAttended={markActivityAttended}
                currentUserId={user?.id}
                onReturn={returnActivity}
                onError={setActionError}
              />
            </DoneSection>
          );
        }
        return (
          <DoneSection key={key} title="Qualification" tone="qualification" summary={editing.requirements?.summary?.qualification?.legacy ? `Legacy checklist · ${qualificationCount} of ${QUALIFICATION_ITEMS.length} assessed` : 'Requirements accepted'}>
            <RequirementsPanel editing={editing} stage="qualification" readOnly busy={false} onSubmit={() => {}} onAccept={() => {}} onReturn={() => {}} onError={setActionError} />
            {showOldChecklist && (
              <QualificationAssessment draft={draft} log={editing.assessment_log || []} isSalesRole={isSalesRole} readOnly onToggle={() => {}} />
            )}
          </DoneSection>
        );
      })}
    </div>
  ) : null;

  // Tense of the tracker label: an ongoing stage is an action (Scheduling,
  // LOI Submission, Payment Record); a finished one is a completed action
  // (Scheduled, LOI Submitted, Payment Record).
  const paymentHandedOver = paymentConfirmed;
  const loiFinished = editing?.loi_verification_status === 'verified'
    || Boolean(editing?.loi_confirmed_at);
  const stageIsDone = (key, stageState) => {
    if (key === 'scheduled') return stageState === 'done' || scheduleComplete;
    if (key === 'loi_submitted') return stageState === 'done' || loiFinished;
    if (key === 'payment_submitted') return stageState === 'done' || paymentHandedOver;
    return stageState === 'done';
  };
  const stageLabelFor = (key, stageState) => {
    const done = stageIsDone(key, stageState);
    if (key === 'scheduled') return done ? 'Scheduled' : 'Scheduling';
    if (key === 'loi_submitted' && stageState === 'pending') return 'LOI Pending';
    if (key === 'loi_submitted') return done ? 'LOI Submitted' : 'LOI Submission';
    if (key === 'payment_submitted') return done ? 'Payment Record' : 'Payment Record';
    if (key === 'active_franchisee') return 'Active Franchise';
    return titleCase(key);
  };

  // Display-only tracker: stages are moved by the single primary button, never by
  // clicking a step. "Converted" is checked as soon as the modal opens.
  const stageItems = draft ? pipelineStages.map((stageName, index) => {
    const currentIndex = pipelineStages.indexOf(draft.status);
    let state = 'todo';
    if (currentIndex > -1 && index < currentIndex) {
      // "Payment Record" is CHECKED only when payment_confirmed is true;
      // without a verified payment the step keeps waiting. (Franchisee records
      // carry no payment fields, so their past step falls back to stage-based
      // truth.)
      state = stageName === 'payment_submitted' && paymentsVisible && !paymentConfirmed ? 'waiting' : 'done';
    } else if (index === currentIndex) {
      // Approved is a completed outcome: For Approval AND Approved both read as
      // checked as soon as Admin approves (the button then offers Create Account).
      if (stageName === 'converted' || stageName === 'active_franchisee' || (stageName === 'approved' && draft.status === 'approved')) state = 'done';
      // Phase 2.5: the Qualified icon is a green check the moment Admin confirms
      // (and stays checked from the Qualified stage on).
      else if (stageName === 'qualified') state = 'done';
      else if (stageName === 'scheduled') state = scheduleComplete ? 'done' : 'waiting';
      // LOI Submission: the same loading ring until Complete LOI moves the applicant on.
      else if (stageName === 'loi_submitted') state = 'waiting';
      else if (stageName === 'for_approval') state = reviewDone ? 'done' : 'waiting';
      // A pending payment request makes Payment Record "waiting", not checked.
      else if (stageName === 'payment_submitted') state = 'waiting';
      else state = 'current';
    }
    // The tracker calls the final stage "Active Franchise" (Section 7); it is
    // checked once the branch account exists and the status is active_franchisee.
    // Phase 3: a soft-copy LOI moved on with [Proceed] reads "LOI Pending",
    // never as a completed step, until it is completed.
    if (stageName === 'loi_submitted' && loiPending && state === 'done') state = 'pending';
    return { key: stageName, label: stageLabelFor(stageName, state), state };
  }) : [];

  // Scheduling connector: two halves, Orientation/Tasting and Training, each green once Admin
  // verified it. Sales completing an activity does not move it.
  const scheduleAttendedProgress = null;
  const scheduleHalves = editing?.activity_state
    ? { left: Boolean(editing.activity_state.orientation?.attended), right: Boolean(editing.activity_state.training?.attended) }
    : null;

  // Qualification requirements progress (accepted / total) drives the first tracker connector.
  const qualificationDefs = (editing?.requirements?.config?.requirements || []).filter((def) => def.stage === 'qualification');
  const qualificationAccepted = qualificationDefs.filter((def) => editing.requirements.items?.find((item) => item.key === def.key)?.status === 'accepted').length;
  const qualificationProgress = qualificationFill(qualificationAccepted, qualificationDefs.length);
  // LOI Submission → Payment Record: half for the LOI verified (with its file), half for the Proposed site.
  const loiProgress = draft?.status === 'loi_submitted' && editing?.requirements
    ? loiHalves({
      loiVerified: editing.requirements.loi?.status === 'accepted',
      siteVerified: editing.requirements.items?.find((item) => item.key === 'proposed_site')?.status === 'accepted',
    })
    : null;

  // Auto-scroll trigger: the applicant's activity_state signature (the tracked
  // activities) compared with the LAST one this viewer saw for that applicant.
  // A plain open with no changes never scrolls, and no scroll repeats after the
  // user scrolls manually (the effect only fires again when the signature ACTUALLY
  // changes — Sales scheduled/completed an activity, Admin confirmed one, or a
  // live-sync update while the modal is open).
  const activitySignature = editing
    ? JSON.stringify(TRACKED_ACTIVITIES.map((tracked) => editing.activity_state?.[tracked.type]?.state || 'not_scheduled'))
    : '';
  const editingId = editing?.id ?? null;
  useEffect(() => {
    // First sight of an applicant stores the baseline and never scrolls.
    if (!editingId || !activitySignature) return;
    const lastSeen = lastActivitySignature.get(editingId);
    lastActivitySignature.set(editingId, activitySignature);
    if (lastSeen === undefined || lastSeen === activitySignature || !showSchedule || !scheduleRef.current) return;
    // Scroll ONLY the dialog's inner body container — never the window, the
    // overlay or any other ancestor. The offset comes from the section's rect
    // relative to that container (closest('.ap-dialog-body'), the one scroller).
    const container = scheduleRef.current.closest('.ap-dialog-body');
    if (!container || typeof container.scrollTo !== 'function' || !scheduleRef.current.isConnected) return;
    requestAnimationFrame(() => {
      if (!scheduleRef.current?.isConnected || !container.isConnected) return;
      const top = scheduleRef.current.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - 12; // a little breathing room under the section top
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  }, [activitySignature, showSchedule, editingId]);

  /* ---------- Phase 2: Admin sees Sales' saves without a manual refresh ----------
   * The app has no socket on this page, so the Qualification stage polls the
   * saved values while the modal is open (the same polling idiom the other
   * panels use). Only Admin's read-only view is merged — Sales' unsaved ticks are
   * never overwritten. */
  const qualificationPollId = editing && isAdminRole && ['converted', 'qualified'].includes(editing.status)
    ? editing.id
    : null;
  useEffect(() => {
    if (!qualificationPollId) return undefined;
    const id = qualificationPollId;
    const timer = window.setInterval(async () => {
      try {
        const detail = (await api.get(`/applicants/${id}`)).data;
        const saved = Object.fromEntries(
          QUALIFICATION_ITEMS.map(({ key }) => [key, Boolean(detail.milestones?.[key])]),
        );
        setEditing((current) => (
          current && current.id === id
            ? { ...current, assessment_log: detail.assessment_log || [], milestones: detail.milestones }
            : current
        ));
        setDraft((current) => {
          if (!current) return current;
          const unchanged = QUALIFICATION_ITEMS.every(({ key }) => Boolean(current.milestones[key]) === saved[key]);
          return unchanged ? current : { ...current, milestones: { ...current.milestones, ...saved } };
        });
      } catch {
        // A missed poll is harmless: the next tick or a save re-reads the record.
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [qualificationPollId]);

  /* ---------- Phase 4b: notification deep link ---------- */
  // The bell routes here with that applicant's id (and optionally a tab, e.g.
  // franchisee records land on the Franchisees view): switch tab, open that
  // Update modal, then clear the location state so it never self-reopens.
  useEffect(() => {
    const focusTab = location.state?.focusTab;
    const focusId = location.state?.focusApplicantId;
    if (location.state?.focusFollowUp) pendingFollowUpJump.current = true;
    if (!focusTab && !focusId) return undefined;
    const tabQuery = focusTab && focusTab !== 'pipeline' ? `?tab=${focusTab}` : '';
    navigate(`${location.pathname}${tabQuery}`, { replace: true, state: null });
    if (focusId && !editing) void loadApplicant(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // Escape closes the Update dialog only when no smaller dialog is open on top of it.
  const updateEscapeEnabled = !mark && !editRequiredOpen && !activateForm
    && !approveForm && !reviseForm && !rejectForm;

  // Escape closes the approval/rejection confirmations (never mid-request).
  useEffect(() => {
    if (!rejectForm && !approveForm) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || acting) return;
      if (rejectForm) setRejectForm(null);
      else setApproveForm(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rejectForm, approveForm, acting]);

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] applicant-pipeline-page later-6:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later-7:[&>:empty]:hidden! [&_.unified-toolbar-container]:m-0 [&_.data-panel]:m-0 [&_.table-wrap_th]:text-[11px] [&_.table-wrap_th]:tracking-[.08em] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_td]:h-[62px] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[16px]! [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[10px]! [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[#8b93a5]! [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions]:flex [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions]:items-center [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions]:gap-2 [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions]:flex-wrap [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:min-h-[30px] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:p-[6px_11px] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:border [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:border-[#2c3549] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:rounded-[8px] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:[background:#111827] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:text-[#e7ebf5] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:[box-shadow:none] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:text-[12px] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button]:font-[600] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button:hover:not(:disabled)]:border-[#4b477d] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button:hover:not(:disabled)]:[background:#1a2133] [&_.data-panel_.table-wrap_table_tbody_tr[data-applicant-id]_.row-actions_button:hover:not(:disabled)]:text-[#f5f4ff] [&_.data-panel_.table-wrap_table_tbody_td]:text-[12px] [&_.data-panel_.table-wrap_table_tbody_td]:leading-[1.5] [&_.data-panel_.table-wrap_table_tbody_td]:pt-3 [&_.data-panel_.table-wrap_table_tbody_td]:pb-3 [&_.data-panel_.table-wrap_table_tbody_td_strong]:text-[13px] [&_.data-panel_.table-wrap_table_tbody_td_small]:text-[11px]">
      <PageHeader title="Applicant pipeline" />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>

      {tab !== 'franchisees' && (
        <div className="flex flex-wrap items-end gap-[10px] m-[0_0_14px] text-[14px] [&_label]:grid [&_label]:gap-1 [&_label]:text-muted [&_label]:text-[12px] [&_label]:font-[700] [&_input]:h-[40px] [&_select]:h-[40px] [&_input]:p-[0_10px] [&_select]:p-[0_10px] [&_input]:border [&_select]:border [&_input]:border-input-line [&_select]:border-input-line [&_input]:rounded-[10px] [&_select]:rounded-[10px] [&_input]:[background:var(--input-bg)] [&_select]:[background:var(--input-bg)] [&_input]:text-text [&_select]:text-text" aria-label="Date range and filters">
          <label>From<input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => { setPage(1); setFilters({ ...filters, from: e.target.value }); }} /></label>
          <label>To<input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => { setPage(1); setFilters({ ...filters, to: e.target.value }); }} /></label>
          <label>Date basis
            <select value={filters.date_basis} onChange={(e) => { setPage(1); setFilters({ ...filters, date_basis: e.target.value }); }}>
              <option value="applied">Date Applied</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="updated">Last Updated</option>
            </select>
          </label>
          <label>Brand
            <select value={filters.brand_id} onChange={(e) => { setPage(1); setFilters({ ...filters, brand_id: e.target.value }); }}>
              <option value="">All brands</option>
              {(remote.data?.brands || []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label>Assigned Sales
            <select value={filters.assigned_sales_user_id} onChange={(e) => { setPage(1); setFilters({ ...filters, assigned_sales_user_id: e.target.value }); }}>
              <option value="">Anyone</option>
              {role === 'sales' && user?.id && <option value={user.id}>Assigned to me</option>}
              {salesChoices.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          {(filters.from || filters.to || filters.brand_id || filters.assigned_sales_user_id) && (
            <button type="button" onClick={() => { setPage(1); setFilters({ from: '', to: '', date_basis: 'applied', brand_id: '', assigned_sales_user_id: '' }); }}>Clear filters</button>
          )}
          {tab === 'pipeline' && (
            <div className="relative" ref={pipelineColumnsRef}>
              <button
                type="button"
                className={filterBtn}
                onClick={() => setPipelineColumnsOpen((open) => !open)}
                aria-expanded={pipelineColumnsOpen}
                aria-haspopup="true"
              >
                Customize Columns <FaChevronDown aria-hidden="true" className="text-[10px]" />
              </button>
              {pipelineColumnsOpen && (
                <div className="absolute left-0 top-[calc(100%_+_6px)] z-[30] w-[220px] max-w-[calc(100vw_-_32px)] max-h-[min(280px,_calc(100dvh_-_180px))] overflow-y-auto grid gap-[2px] p-[6px] border border-line-strong rounded-[10px] [background:var(--panel)] [box-shadow:var(--shadow-md)]" role="group" aria-label="Visible applicant columns">
                  {PIPELINE_COLUMN_OPTIONS.map(([key, label]) => (
                    <label key={key} className="flex items-center gap-[9px] p-[6px_8px] rounded-[6px] text-text text-[13px] font-[500] cursor-pointer hover:[background:var(--hover)]" style={{ display: 'flex', alignItems: 'center', minHeight: 32, padding: '6px 8px', gap: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      <input type="checkbox" className="[accent-color:var(--accent)]" style={{ width: 16, height: 16, minHeight: 16, flex: '0 0 16px', margin: 0, padding: 0, borderRadius: 3, cursor: 'pointer', accentColor: 'var(--accent)' }} checked={Boolean(pipelineColumns[key])} onChange={() => togglePipelineColumn(key)} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <span className="flex gap-2 ml-auto">
            <button type="button" className={filterBtn} disabled={exporting} onClick={() => void exportFiltered('csv')}>Export CSV</button>
            <button type="button" className={filterBtn} disabled={exporting} onClick={() => void exportFiltered('pdf')}>Export PDF</button>
          </span>
        </div>
      )}

      {/* Unified toolbar: view tabs, search and the status filter share one box. */}
      <div className="unified-toolbar-container flex items-center flex-nowrap gap-[10px] w-full [box-sizing:border-box] m-0 p-[10px_14px] border border-[#252b3b] rounded-[14px] [background:#101421] light:border-line light:[background:var(--panel)] max-[721px]:later:flex-wrap max-[721px]:later:gap-2 max-[721px]:later:p-[8px_10px] max-[721px]:later:rounded-[12px] [.activities-page_&]:m-0">
        <div className="flex items-center flex-[0_1_auto] min-w-0 gap-[2px] p-1 overflow-x-auto border border-[#1f2638] rounded-[10px] [background:#0b0f19] light:border-line light:[background:var(--panel-2)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:flex-[0_0_auto] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:min-h-[34px] [&>button]:p-[7px_15px] later-2:[&>button]:border later-2:[&>button]:border-transparent later-2:[&>button]:rounded-[8px] [&>button]:[background:transparent] [&>button]:text-[#8a94a6] light:[&>button]:text-muted [&>button]:[font-family:inherit] [&>button]:[font-style:inherit] later-2:[&>button]:text-[13px] later-2:[&>button]:font-[600] later:[&>button]:leading-[1.2] [&>button]:whitespace-nowrap later:[&>button]:cursor-pointer [&>button]:[transition:background_.15s_ease,_color_.15s_ease,_border-color_.15s_ease] [&>button:hover:not(.active):not([aria-selected='true'])]:text-[#d7ddf5] light:[&>button:hover:not(.active):not([aria-selected='true'])]:text-text [&>button:hover:not(.active):not([aria-selected='true'])]:[background:rgba(255,_255,_255,_.04)] [&>button:hover:not(.active):not([aria-selected='true'])]:border-transparent [&>button.active]:[background:#252e42] light:[&>button.active]:[background:var(--active)] [&>button.active]:text-[#fff] light:[&>button.active]:text-accent-text [&>button.active]:font-[600] [&>button.active]:border-transparent [&>button.active]:[box-shadow:none] later:[&>button[aria-selected='true']]:[background:#252e42] [&>button[aria-selected='true']]:text-[#fff] [&>button[aria-selected='true']]:font-[600] [&>button[aria-selected='true']]:border-transparent [&>button[aria-selected='true']]:[box-shadow:none] later:[&>button:focus-visible]:[outline:2px_solid_#8175ff] later:[&>button:focus-visible]:[outline-offset:2px] [&>button_svg]:flex-[0_0_auto] [&>button_svg]:text-[12px] max-[721px]:later:flex-[1_1_100%]" role="tablist" aria-label="Applicant views">
          {TABS
            .filter((item) => item.key !== 'archived' || can(role, 'applicants.view_archived'))
            .filter((item) => item.key !== 'detail' || role !== 'franchisee')
            .map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={tab === item.key ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}
              onClick={() => switchTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-[1_1_160px] min-w-[120px] flex [&_input]:flex-[1_1_auto] [&_input]:w-full [&_input]:min-w-0 [&_input]:h-[44px] [&_input]:[box-sizing:border-box] [&_input]:p-[0_14px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:text-[13px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder light:[&_input]:[background:#fff] light:[&_input]:text-[#172033] [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_input]:h-[42px]">
          <input
            value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
            placeholder="Search by ID, name, email, or phone"
            aria-label="Search applicants"
          />
        </div>
        {tab !== 'franchisees' && (
          <div className="flex-[0_0_180px] flex [&_select]:w-full [&_select]:h-[44px] [&_select]:[box-sizing:border-box] [&_select]:p-[0_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:text-[13px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select:hover]:border-line-strong light:[&_select]:[background:#fff] light:[&_select]:text-[#172033] later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_select]:h-[42px]">
            <select
              value={status}
              onChange={(e) => { setPage(1); setStatus(e.target.value); }}
              aria-label="Filter applicant status"
            >
              <option value="">All statuses</option>
              {activeStatuses.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
              {tab === 'pipeline' && canManage && (
                <optgroup label="Follow-up">
                  {Object.entries(FOLLOW_UP_STATES).map(([key, meta]) => <option key={key} value={`${FOLLOW_UP_FILTER_PREFIX}${key}`}>{meta.filterLabel}</option>)}
                </optgroup>
              )}
            </select>
          </div>
        )}
      </div>

      {tab === 'franchisees' ? (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          {remote.loading ? <LoadingState /> : !franchisees.length ? (
            <EmptyState label="No active franchisees yet." detail="Approved applicants appear here once activated." />
          ) : (
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table>
                <thead>
                  <tr>
                    <th>Business</th><th>Owner</th><th>Brand</th><th>Locations</th><th>Approved</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {franchisees.map((franchisee) => (
                    <tr key={franchisee.id ?? `applicant-${franchisee.applicant_id}`}>
                      <td>
                        <strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{franchisee.business_name}</strong>
                        <small><FaStore aria-hidden="true" /> <RecordCode code={franchisee.applicant?.applicant_code} label="Applicant ID" /></small>
                      </td>

                      <td>
                        {franchisee.applicant?.full_name || '—'}
                        <small>{franchisee.applicant?.email || '—'}</small>
                      </td>
                      <td>{franchisee.applicant?.preferred_brand?.name || '—'}</td>
                      <td>{franchisee.locations?.length || 0}</td>
                      <td>{formatDate(franchisee.approval_date)}</td>
                      <td>
                        <StatusBadge value={franchisee.franchise_status} />
                        {!franchisee.has_portal_account && role === 'admin' && (
                          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => navigate('/users', { state: { createFranchiseeFor: {
                            applicantId: franchisee.applicant_id,
                            full_name: franchisee.applicant?.full_name || '',
                            email: franchisee.applicant?.email || '',
                            phone: franchisee.applicant?.phone || '',
                            preferred_brand: franchisee.applicant?.preferred_brand || null,
                            preferred_brand_id: franchisee.applicant?.preferred_brand?.id || null,
                            status: 'active_franchisee',
                          } } })}>Create Account</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ApplicantPagination meta={remote.data?.franchiseeMeta} page={page} onPage={setPage} noun="franchisees" />
        </section>
      ) : tab === 'detail' ? (
        <section className="ap-detail-panel data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          <div className="flex flex-wrap items-center justify-between gap-[10px] mb-3">
            <div className="inline-flex flex-wrap gap-1 p-[3px] border border-[#2a3041] rounded-[10px] [background:#111726] [&_button]:inline-flex [&_button]:items-center later:[&_button]:gap-[6px] later-2:[&_button]:p-[6px_11px] later-3:[&_button]:border-0 later-4:[&_button]:rounded-[7px] later-3:[&_button]:[background:transparent] later-3:[&_button]:text-[#9ba5bd] [&_button]:[font-family:inherit] later-4:[&_button]:[font-weight:inherit] [&_button]:[font-style:inherit] later-2:[&_button]:[line-height:inherit] later-5:[&_button]:text-[11.5px] later:[&_button]:cursor-pointer [&_button:hover]:text-[#fff] later-2:[&_button.active]:[background:#232b40] [&_button.active]:text-[#fff] later-3:[&_button:focus-visible]:[outline:2px_solid_#8175ff] later-3:[&_button:focus-visible]:[outline-offset:1px]" role="tablist" aria-label="Record folders">
              {RECORD_FOLDERS.map((item) => {
                const count = remote.data?.detailMeta?.folder_counts?.[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={detailFolder === item.key}
                    className={detailFolder === item.key ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}
                    onClick={() => switchDetailFolder(item.key)}
                  >
                    {item.label}
                    {count !== undefined && <span className="min-w-[20px] p-[1px_6px] rounded-[999px] [background:rgba(129,_117,_255,_.18)] text-[#c9c2ff] text-[10px] [font-variant-numeric:tabular-nums] text-center">{count}</span>}
                  </button>
                );
              })}
            </div>
            <div className="inline-flex flex-wrap gap-1 p-[3px] border border-[#2a3041] rounded-[10px] [background:#111726] [&_button]:inline-flex [&_button]:items-center later:[&_button]:gap-[6px] later-2:[&_button]:p-[6px_11px] later-3:[&_button]:border-0 later-4:[&_button]:rounded-[7px] later-3:[&_button]:[background:transparent] later-3:[&_button]:text-[#9ba5bd] [&_button]:[font-family:inherit] later-4:[&_button]:[font-weight:inherit] [&_button]:[font-style:inherit] later-2:[&_button]:[line-height:inherit] later-5:[&_button]:text-[11.5px] later:[&_button]:cursor-pointer [&_button:hover]:text-[#fff] later-2:[&_button.active]:[background:#232b40] [&_button.active]:text-[#fff] later-3:[&_button:focus-visible]:[outline:2px_solid_#8175ff] later-3:[&_button:focus-visible]:[outline-offset:1px]" role="group" aria-label="Record view">
              <button type="button" className={detailView === 'grid' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} aria-pressed={detailView === 'grid'} onClick={() => changeDetailView('grid')}>
                <FaTableCellsLarge aria-hidden="true" /> Grid
              </button>
              <button type="button" className={detailView === 'list' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} aria-pressed={detailView === 'list'} onClick={() => changeDetailView('list')}>
                <FaList aria-hidden="true" /> List
              </button>
            </div>
          </div>
          {/* A failed request is an error, never an empty folder: the empty
              state only shows after a successful, genuinely empty load. */}
          {remote.loading ? <LoadingState /> : remote.error ? (
            <EmptyState
              label="Could not load application records."
              detail="The list failed to load — see the error above, then refresh to try again."
            />
          ) : !(remote.data?.detailRows || []).length ? (
            <EmptyState {...DETAIL_EMPTY[detailFolder]} />
          ) : detailView === 'list' ? (
            <RecordFolderTable folder={detailFolder} rows={remote.data.detailRows} onOpen={(id) => void openReport(id)} />
          ) : (
            <RecordFolderGrid folder={detailFolder} rows={remote.data.detailRows} onOpen={(id) => void openReport(id)} />
          )}
          <ApplicantPagination
            meta={remote.data?.detailMeta}
            page={page}
            onPage={setPage}
            noun="records"
          />
        </section>
      ) : (
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[13px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
          {remote.loading ? <LoadingState /> : !rows.length ? (
            <EmptyState
              label={tab === 'archived' ? 'No archived applicants.' : 'No applicants match these filters.'}
              detail={tab === 'archived' ? 'Archived candidates can be restored from Admin Settings > Archive.' : 'Adjust the filters to see more applicants.'}
            />
          ) : (
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table>
                <thead>
                  <tr>
                    {pipelineColumns.applicant_id && <th className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden">Applicant ID</th>}
                    <th>Applicant</th>
                    {pipelineColumns.contact && <th>Contact</th>}
                    {pipelineColumns.brand && <th>Brand</th>}
                    {pipelineColumns.applied && <th>Applied</th>}
                    {pipelineColumns.assigned_sales && <th className="text-[12px] font-[850]">Assigned Sales</th>}
                    {pipelineColumns.status && <th>Status</th>}
                    <th>Update</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((applicant) => (
                    <tr key={applicant.id} data-applicant-id={applicant.id} onClick={tab === 'archived' ? () => navigate(`/admin-settings?tab=applicants&applicant=${applicant.id}`) : canManage ? (event) => { if (event.target.closest('button,a,input,select,textarea,label')) return; setSeenActivityDots((current) => new Set(current).add(applicant.id)); void loadApplicant(applicant.id, applicant.status); } : undefined}>
                      {/* Applicant ID only, one compact line (the source Lead ID is in the modal / full record). */}
                      {pipelineColumns.applicant_id && <td className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden record-id-col [.data-panel_.table-wrap_table_th&]:w-[1%] [.data-panel_.table-wrap_table_th&]:whitespace-nowrap [.data-panel_.table-wrap_table_td&]:w-[1%] [.data-panel_.table-wrap_table_td&]:whitespace-nowrap [.data-panel_.table-wrap_table_td&_.record-code]:[vertical-align:middle]"><RecordCode code={applicant.applicant_code} label="Applicant ID" /></td>}
                      <td>
                        {pipelineColumns.applicant_id && <span className="hidden max-[761px]:later:block max-[761px]:mb-[2px]"><RecordCode code={applicant.applicant_code} label="Applicant ID" /></span>}
                        <strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{applicant.full_name}</strong>
                      </td>
                      {pipelineColumns.contact && <td>{applicant.email || '—'}<small>{applicant.phone || '—'}</small></td>}
                      {pipelineColumns.brand && <td>{applicant.preferred_brand?.name || '—'}</td>}
                      {pipelineColumns.applied && <td>{formatDate(applicant.application_date)}</td>}
                      {pipelineColumns.assigned_sales && <td className="ap-assigned-sales"><AssignedSalesTag sales={applicant.assigned_sales} prefix="" /></td>}
                      {pipelineColumns.status && <td>
                        {tab === 'archived' ? (
                          <StatusBadge value={applicant.status} label={applicant.status_label} />
                        ) : (
                          <StatusHover applicant={applicant} loadDetail={loadDetail}>
                            <StatusBadge value={applicant.status} label={applicant.status_label} />
                          </StatusHover>
                        )}
                        {tab === 'archived' && applicant.archived_at && (
                          <small>Archived {formatDate(applicant.archived_at)}</small>
                        )}
                        {typeof applicant.days_in_stage === 'number' && (
                          <small className="block text-[#9aa6c4]">
                            {applicant.days_in_stage} day{applicant.days_in_stage === 1 ? '' : 's'} in stage
                            {applicant.follow_up ? (
                              <FollowUpChip followUp={applicant.follow_up} role={role} className="ml-[6px]" onOpen={() => openAtFollowUp(applicant)} />
                            ) : applicant.overdue && (
                              <span className="inline-flex ml-[6px] p-[1px_8px] rounded-[999px] border border-[rgba(255,_92,_102,_.6)] text-[#ff5c66] text-[11px] font-normal" title={`More than ${applicant.overdue_after_days} days in this stage`}>Overdue</span>
                            )}
                          </small>
                        )}
                      </td>}
                      <td>
                        <div className="row-actions applicant-row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative">
                          {canManage && tab === 'archived' ? (
                            <button onClick={() => navigate(`/admin-settings?tab=applicants&applicant=${applicant.id}`)}>View in Admin Settings</button>
                          ) : canManage ? (
                            <>
                              <button
                                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                                disabled={updatingId === applicant.id}
                                onMouseEnter={() => { void loadDetail(applicant.id).catch(() => {}); }}
                                onFocus={() => { void loadDetail(applicant.id).catch(() => {}); }}
                                onClick={() => { setSeenActivityDots((current) => new Set(current).add(applicant.id)); void loadApplicant(applicant.id, applicant.status); }}
                                title={role === 'admin' && applicant.has_pending_payment_request
                                  ? 'Payment request waiting for your confirmation — click to review.'
                                  : role === 'sales' && applicant.has_assessment_request
                                    ? 'Admin converted this lead — fill the qualification assessment.'
                                    : applicant.has_pending_schedule_update ? 'Schedule update waiting for review.' : undefined}
                              >
                                <FaPen /> Update
                                {((role === 'admin' && applicant.has_pending_payment_request)
                                  || (role === 'sales' && applicant.has_assessment_request)
                                  || applicant.has_pending_schedule_update) && (
                                  <span className="absolute -top-[4px] -right-[4px] w-[10px] h-[10px] rounded-[50%] [background:#ff5d7d] [box-shadow:0_0_12px_color-mix(in_srgb,_#ff5d7d_45%,_transparent),_0_0_0_2px_color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)] [animation:apDotPulse_1.6s_ease-in-out_infinite] [&.is-blue]:-left-[4px] [&.is-blue]:right-auto [&.is-blue]:[background:#3b82f6] [&.is-blue]:[box-shadow:0_0_12px_color-mix(in_srgb,_#3b82f6_50%,_transparent),_0_0_0_2px_color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)]" aria-hidden="true" />
                                )}
                                {/* Blue dot (Admin): Sales marked an activity Complete. It
                                    clears when Update opens the record (mark-seen). */}
                                {role === 'admin' && applicant.has_activity_update && !seenActivityDots.has(applicant.id) && (
                                  <span className="absolute -top-[4px] -right-[4px] w-[10px] h-[10px] rounded-[50%] [background:#ff5d7d] [box-shadow:0_0_12px_color-mix(in_srgb,_#ff5d7d_45%,_transparent),_0_0_0_2px_color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)] [animation:apDotPulse_1.6s_ease-in-out_infinite] [&.is-blue]:-left-[4px] [&.is-blue]:right-auto [&.is-blue]:[background:#3b82f6] [&.is-blue]:[box-shadow:0_0_12px_color-mix(in_srgb,_#3b82f6_50%,_transparent),_0_0_0_2px_color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)] is-blue" aria-label="Activity marked Complete by Sales" />
                                )}
                              </button>
                              {role === 'admin' && (
                                <button disabled={updatingId === applicant.id} onClick={() => setArchiveTarget(applicant)}>
                                  Archive
                                </button>
                              )}
                            </>
                          ) : '—'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ApplicantPagination meta={remote.data?.meta} page={page} onPage={setPage} />
        </section>
      )}

      {archiveTarget && (
        <Dialog
          title="Archive applicant?"
          size="small"
          onClose={() => setArchiveTarget(null)}
          footer={(
            <>
              <button
                type="button"
                className="min-h-[36px] p-[0_16px] border border-[#2a3550] rounded-[7px] [background:transparent] text-[#c5cde0] text-[12px] font-[700] cursor-pointer hover:[background:#1a2133]"
                onClick={() => setArchiveTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="min-h-[36px] p-[0_16px] border border-[#a94450] rounded-[7px] [background:rgba(127,_29,_45,_.35)] text-[#ffb3ba] text-[12px] font-[750] cursor-pointer hover:[background:rgba(127,_29,_45,_.55)]"
                onClick={() => archiveApplicant(archiveTarget)}
              >
                Archive
              </button>
            </>
          )}
        >
          <p className="m-0 text-[#c5cde0] text-[13px] leading-[1.5]">
            <strong className="text-[#f1f3fb]">{archiveTarget.full_name}</strong> will move to the Archive tab. Nothing is deleted, and you can restore them later.
          </p>
        </Dialog>
      )}

      {openingId && !editing && (
        <Dialog
          title="Opening applicant…"
          onClose={() => setOpeningId(null)}
          modalClass={openingModalClass(openingId.status, role)}
          animated
        >
          <ApplicantDetailSkeleton stage={openingId.status} isAdmin={isAdminRole} />
        </Dialog>
      )}

      {editing && draft && (
        <Dialog
          title={<span className="[&_.ap-status-label.ap-endorsed-label]:ml-4 [&_.ap-status-label.ap-endorsed-label]:[align-self:baseline] [&_.record-code]:[vertical-align:middle]">Update {editing.full_name}{editing.applicant_code && <> · <RecordCode code={editing.applicant_code} label="Applicant ID" size="md" /></>} {editing.inquiry?.converted_from_status === 'endorsed' && <small className="ap-status-label inline-flex items-center p-[4px_7px] border border-[#353e57] rounded-[6px] [background:#1a2133] text-[#c5c9ff]! text-[10px]! [&.ap-endorsed-label]:p-0 [&.ap-endorsed-label]:border-0 [&.ap-endorsed-label]:[background:none] [&.ap-endorsed-label]:text-[color:var(--info)]! [&.ap-endorsed-label]:text-[14px]! [&.ap-endorsed-label]:font-[600] ap-endorsed-label" title="Lead source: this inquiry was endorsed before it was converted. The application stage is shown in the tracker.">Endorsed lead</small>}{editing.inquiry?.converted_from_status === 'endorsed' && editing.preferred_brand?.name && <span className="ml-2 text-[14px] font-[700] uppercase">({editing.preferred_brand?.name})</span>}</span>}
          onClose={closeEditor}
          modalClass={paymentsVisible && stage === 'payment_submitted' ? 'is-payment' : (isAdminRole && stage === 'converted' ? 'is-qualification' : '')}
          closeOnEscape={updateEscapeEnabled}
          animated
          footer={(
            <>
              {/* Section 8: no Cancel beside Save Applicant — Reject sits there. */}
              {isAdminRole && editing.status !== 'active_franchisee' && draft.status !== 'rejected' && (
                <button
                  type="button"
                  className="[.ap-dialog-foot_&]:mr-auto [.ap-dialog-foot_&]:min-h-[32px] [.ap-dialog-foot_&]:p-[0_14px] [.ap-dialog-foot_&]:border [.ap-dialog-foot_&]:border-[#a94450] [.ap-dialog-foot_&]:rounded-[7px] [.ap-dialog-foot_&]:[background:transparent] [.ap-dialog-foot_&]:text-[#ff858f] [.ap-dialog-foot_&]:text-[12px] [.ap-dialog-foot_&]:font-[750] [.ap-dialog-foot_&]:tracking-[.08em] [.ap-dialog-foot_&]:[box-shadow:none] [.ap-dialog-foot_&:hover:not(:disabled)]:border-[#d45160] [.ap-dialog-foot_&:hover:not(:disabled)]:[background:rgba(127,_29,_45,_.16)] [.ap-dialog-foot_&:hover:not(:disabled)]:[box-shadow:none] [.ap-dialog-foot_&:hover:not(:disabled)]:[filter:none] [.ap-dialog-foot_&:hover:not(:disabled)]:[transform:none]"
                  disabled={acting || saving}
                  onClick={() => setRejectForm({ remarks: '' })}
                >
                  REJECT
                </button>
              )}
              {/* For Approval: the footer action is the approval itself, with a
                  two-step confirmation. Every other stage keeps Save Applicant. */}
              {isAdminRole && stage === 'for_approval' && draft.status !== 'rejected' && (
                <button
                  type="button"
                  className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] ap-modal-save"
                  disabled={acting || saving}
                  onClick={() => setApproveForm({ step: 1, remarks: '', confirmText: '' })}
                >
                  {acting ? 'APPROVING…' : 'APPROVE APPLICANT'}
                </button>
              )}
              {footerPrimary && (
                <button
                  type="button"
                  className="primary-button min-h-[42px] inline-flex items-center justify-center p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] text-[12px] font-[760] tracking-[.01em] ap-modal-save"
                  disabled={acting || saving}
                  onClick={() => setQualifiedConfirm(true)}
                >
                  {primary.label}
                </button>
              )}
              {stage !== 'for_approval' && !footerPrimary
                && (canEditDetails || (isSalesRole && ['converted', 'qualified'].includes(stage))) && (
                  <button
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] ap-modal-save"
                    form="update-applicant-form"
                    disabled={saving || acting || !hasChanges}
                  >
                    {saving ? 'SAVING…' : 'SAVE CHANGES'}
                  </button>
                )}
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <Notice type="success">{success}</Notice>
          <form id="update-applicant-form" onSubmit={saveApplicant} noValidate>
            <section className={stage === 'payment_submitted' ? 'ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#0C111D] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#0C111D] [#update-applicant-form_&]:[box-shadow:none] pay-state-strip later-3:[#update-applicant-form_&]:p-[10px_12px] later-2:[#update-applicant-form_&]:mb-2 [#update-applicant-form_&_.ap-actions]:m-[8px_0_0] [#update-applicant-form_&_.ap-actions:empty]:m-0' : 'ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#0C111D] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#0C111D] [#update-applicant-form_&]:[box-shadow:none]'}>
              <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
                <h3>Application stage</h3>
                <span className="flex flex-wrap items-center justify-end gap-[10px] text-[14px] text-[#b9c1d5]">
                  {draft.status === 'rejected' && <small className="text-[#ff888e]!">Rejected</small>}
                  {/* Who handles this applicant: only the assigned Sales user can act for it. */}
                  <span>Assigned Sales:</span>
                  {editing.assigned_sales?.full_name
                    ? <strong className="text-[#edf0fa]">{editing.assigned_sales.full_name}</strong>
                    : <AssignedSalesTag sales={null} />}
                  {isAdminRole && !['active_franchisee', 'rejected'].includes(editing.status) && !editing.archived_at && (
                    <button type="button" disabled={acting} onClick={() => void openAssign()} className="bg-transparent border-0 p-0 text-[14px] text-[#8fa0ff] hover:text-[#aeb6ff] hover:underline underline-offset-2">
                      {editing.assigned_sales_user_id ? 'Reassign' : 'Assign Sales'}
                    </button>
                  )}
                </span>
              </div>
              {isSalesRole && !isAssignedSales && (
                <small className="block mb-[10px] text-[#fbbf24]">
                  {editing.assigned_sales_user_id ? 'View only: another Sales user handles this applicant.' : 'Admin must assign a Sales user first.'}
                </small>
              )}
              {typeof editing.days_in_stage === 'number' && (
                <p className="m-[0_0_10px] text-[14px] text-[#9aa6c4]">
                  {editing.days_in_stage} day{editing.days_in_stage === 1 ? '' : 's'} in the current stage
                  {editing.follow_up ? (
                    <FollowUpChip followUp={editing.follow_up} role={role} className="ml-2" onOpen={goToFollowUp} />
                  ) : editing.overdue && <span className="ml-2 font-normal text-[#ff5c66]">Overdue (more than {editing.overdue_after_days} days)</span>}
                </p>
              )}
              {/* Display-only tracker: no click-to-check, the API owns every move. */}
              <Stepper items={stageItems} qualificationProgress={qualificationProgress} attendedProgress={scheduleAttendedProgress} loiProgress={loiProgress} scheduleHalves={scheduleHalves} />

              <div className="ap-actions flex flex-wrap items-center gap-[10px] mt-[14px]">
                {primary?.enabled && (
                  <button
                    type="button"
                    className={`primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.ap-actions_&]:m-0 [.ap-actions_&:disabled]:text-[#7d879e] [.ap-actions_&:disabled]:border [.ap-actions_&:disabled]:border-[#2b344c] [.ap-actions_&:disabled]:[background:#131a29] later:[.ap-actions_&:disabled]:[box-shadow:none] [.ap-actions_&:disabled]:opacity-[1] [.ap-actions_&:disabled]:cursor-not-allowed later-2:[.ap-actions_&:disabled]:[transform:none] ${stage === 'converted' ? ' [#update-applicant-form_&]:min-h-[34px] [#update-applicant-form_&]:p-[0_16px] [#update-applicant-form_&]:border [#update-applicant-form_&]:border-[#6861d9] [#update-applicant-form_&]:rounded-[7px] [#update-applicant-form_&]:[background:linear-gradient(135deg,_#4d65d9,_#7757d9)] [#update-applicant-form_&]:[box-shadow:none] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&]:tracking-[.04em] [#update-applicant-form_&:disabled]:border-[#32394b] [#update-applicant-form_&:disabled]:[background:#202636] [#update-applicant-form_&:disabled]:text-[#737d93] [#update-applicant-form_&:disabled]:[box-shadow:none] [#update-applicant-form_&:disabled]:opacity-[1]' : ''}`}
                    disabled={!primary.enabled || acting || saving}
                    title={primary.enabled ? undefined : primary.reason}
                    onClick={() => {
                      if (primary.run === 'createAccount') {
                        navigate('/users', { state: { createFranchiseeFor: {
                          applicantId: editing.id,
                          full_name: editing.full_name,
                          email: editing.email || '',
                          phone: editing.phone || '',
                          preferred_brand: editing.preferred_brand || null,
                          preferred_brand_id: editing.preferred_brand_id || null,
                          status: draft.status,
                        } } });
                      } else if (primary.run === 'resendInvite') void resendPortalInvite();
                      else if (primary.run === 'activate') openActivateForm();
                      else if (primary.run === 'completeActivities') void performStageAction('loi');
                      else if (primary.run === 'loiComplete') void completeLoiStage();
                      else if (primary.run === 'approve') setApproveForm({ remarks: '' });
                      // Phase 2.3: [Confirm Qualified] always asks a second time.
                      else if (primary.run === 'qualified') setQualifiedConfirm(true);
                      else void performStageAction(primary.run);
                    }}
                  >
                    {primary.label}
                  </button>
                )}
                {primary?.note && (
                  <span className="inline-flex items-center gap-[6px] p-[4px_10px] rounded-[999px] border border-[rgba(251,_146,_60,_0.4)] [background:rgba(251,_146,_60,_0.12)] text-[#fb923c] text-[11px] font-[700]" role="status">
                    {primary.note}{editing?.user?.account_status === 'declined' ? ' (declined)' : ''}
                  </span>
                )}
                {draft.status === 'loi_submitted' && isAdminRole && (
                  <button type="button" className="min-h-[34px] p-[0_12px] border border-[#3a4256] rounded-[10px] [background:#181d29] text-[#d6dcea] text-[11px] font-[700] [transition:background_.18s_ease,_border-color_.18s_ease] [&:hover:not(:disabled)]:[background:rgba(244,_184,_74,_.16)] [&:hover:not(:disabled)]:border-[rgba(244,_184,_74,_.7)]" disabled={acting} onClick={() => setUndoLoiForm({ remarks: '' })}>
                    Undo LOI
                  </button>
                )}
                {/* Set Again is an applicant-level action in the Scheduled stage
                    action area — never inside Orientation/Tasting or Training. */}
                {stage === 'scheduled' && firstActivity && isAdminRole && (
                  <button
                    type="button"
                    className="[#update-applicant-form_&]:min-h-[34px] [#update-applicant-form_&]:mt-0 [#update-applicant-form_&]:p-[0_14px] [#update-applicant-form_&]:border [#update-applicant-form_&]:border-[color:color-mix(in_srgb,_#39ffb0_45%,_transparent)] [#update-applicant-form_&]:rounded-[7px] [#update-applicant-form_&]:[background:color-mix(in_srgb,_#39ffb0_10%,_transparent)] [#update-applicant-form_&]:text-[#39ffb0] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&]:font-[700] [#update-applicant-form_&]:tracking-[.02em] [#update-applicant-form_&]:whitespace-nowrap [#update-applicant-form_&:hover:not(:disabled)]:[background:color-mix(in_srgb,_#39ffb0_18%,_transparent)]"
                    disabled={acting || saving}
                    title={`Schedule ${firstActivity.label} for this applicant`}
                    onClick={() => goSchedule(firstActivity.type)}
                  >
                    Set schedule – {firstActivity.label}
                  </button>
                )}
                {stage === 'scheduled' && nextActivity && (
                  <button
                    type="button"
                    className="[#update-applicant-form_&]:min-h-[34px] [#update-applicant-form_&]:mt-0 [#update-applicant-form_&]:p-[0_14px] [#update-applicant-form_&]:border [#update-applicant-form_&]:border-[color:color-mix(in_srgb,_#39ffb0_45%,_transparent)] [#update-applicant-form_&]:rounded-[7px] [#update-applicant-form_&]:[background:color-mix(in_srgb,_#39ffb0_10%,_transparent)] [#update-applicant-form_&]:text-[#39ffb0] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&]:font-[700] [#update-applicant-form_&]:tracking-[.02em] [#update-applicant-form_&]:whitespace-nowrap [#update-applicant-form_&:hover:not(:disabled)]:[background:color-mix(in_srgb,_#39ffb0_18%,_transparent)]"
                    disabled={acting || saving}
                    title={`Schedule the next step: ${nextActivity.label}`}
                    onClick={() => goSchedule(nextActivity.type)}
                  >
                    Set again – {nextActivity.label}
                  </button>
                )}
              </div>
              {stage === 'payment_submitted' && loiPending && (
                <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0 later-5:[&.ap-action-reason]:text-[#fbbf24]" role="status">
                  LOI Pending — For Approval is blocked until the LOI is completed (LOI section below). Payments continue as usual.
                </p>
              )}
            </section>

            {/* Current work on top. Converted: Sales fills the five items (Admin
                read-only) — once Qualified they are read-only for everyone and
                drop into the collapsed "finished" list below. */}
            {stage === 'converted' && (
              <>
                <RequirementsPanel
                  editing={editing}
                  stage="qualification"
                  isAdminRole={isAdminRole}
                  isAssignedSales={isAssignedSales}
                  busy={acting}
                  onSubmit={submitRequirement}
                  onAccept={acceptRequirement}
                  onReturn={returnRequirement}
                  onReopen={reopenRequirement}
                  onError={setActionError}
                />
                {/* The retired five-item checklist stays visible as history only. */}
                {showOldChecklist && (
                  <DoneSection title="Earlier qualification checklist (history)" summary="Replaced by the requirements above">
                    <QualificationAssessment draft={draft} log={editing.assessment_log || []} isSalesRole={isSalesRole} readOnly onToggle={() => {}} />
                  </DoneSection>
                )}
              </>
            )}

            {/* Approved: the signed franchise agreement must be Accepted before activation. */}
            {stage === 'approved' && (
              <RequirementsPanel
                editing={editing}
                stage="activation"
                isAdminRole={isAdminRole}
                isAssignedSales={isAssignedSales}
                busy={acting}
                onSubmit={submitRequirement}
                onAccept={acceptRequirement}
                onReturn={returnRequirement}
                onError={setActionError}
              />
            )}

            {/* Qualified: Schedule Activity is LOCKED until Admin's [Set Schedule]. */}
            {stage === 'qualified' && (
              <LockedScheduleSection
                isAdminRole={isAdminRole}
                qualificationDone={qualificationDone}
                busy={acting || saving}
                onSetSchedule={() => void performStageAction('setSchedule')}
              />
            )}

            {stage === 'scheduled' && (
              <>
              <ScheduleSection
                editing={editing}
                draft={draft}
                isAdminRole={isAdminRole}
                sectionRef={scheduleRef}
                onPickChecked={pickScheduleMilestone}
                onOpenCalendar={openSessionInCalendar}
                onView={viewInActivities}
                busy={acting}
                onAttended={markActivityAttended}
                currentUserId={user?.id}
                onReturn={returnActivity}
                onError={setActionError}
              />
              </>
            )}

            {/* Stage 3: LOI Submission panel. Admin verifies it on the field and
                saves it with [Completed]. */}
            {loiDraft && stage === 'loi_submitted' && (
              <LoiPanel
                draft={loiDraft}
                interactive={isAdminRole || isAssignedSales}
                canEditDetails={isAssignedSales}
                canVerify={isAdminRole}
                disabled={acting}
                savedDocument={currentLoiDocument(editing.documents)}
                applicantId={editing.id}
                receivedByName={editing.loi_received_by || authLabel}
                onChange={setLoiDraft}
                onPreview={setLoiLightbox}
                onError={setActionError}
                status={editing.loi_status}
                actions={loiActions}
              />
            )}
            {/* Proposed site: submitted next to the LOI; Complete LOI needs it Accepted. */}
            {loiDraft && stage === 'loi_submitted' && (
              <RequirementsPanel
                editing={editing}
                stage="loi"
                title="Proposed site"
                isAdminRole={isAdminRole}
                isAssignedSales={isAssignedSales}
                busy={acting}
                onSubmit={submitRequirement}
                onAccept={acceptRequirement}
                onReturn={returnRequirement}
                onReopen={reopenRequirement}
                onError={setActionError}
              />
            )}

            {stage !== 'payment_submitted' && doneSections}

            {stage !== 'payment_submitted' && !['active_franchisee', 'rejected'].includes(editing.status) && (
              <FollowUpLog
                items={editing.follow_ups || []}
                events={editing.follow_up_events || []}
                title="Follow-up"
                id={FOLLOW_UP_SECTION_ID}
                highlight={followUpFlash}
                addLabel={isAssignedSales && ['overdue', 'stalled'].includes(editing.follow_up?.state) ? 'Log contact attempt' : 'Log follow-up'}
                summary={(
                  <FollowUpSummary
                    applicant={editing}
                    role={role}
                    isAdmin={isAdminRole}
                    isAssignedSales={isAssignedSales}
                    busy={acting}
                    onAction={(kind) => {
                      if (kind === 'reassign') void openAssign();
                      else if (kind === 'release') void runRequest(() => api.post(`/applicants/${editing.id}/hold/release`), 'Hold released.');
                      else setFollowUpAction({ kind, applicant: editing });
                    }}
                  />
                )}
                canAdd={isAssignedSales && !editing.archived_at}
                busy={acting}
                onAdd={logApplicantFollowUp}
                surfaceClass="[background:#0C111D]"
              />
            )}

            {/* Stage 6: receipt-style summary of everything accumulated in 1–4. */}
            {stage === 'for_approval' && (
              <>
                <ApprovalReceipt applicant={editing} draft={draft} />
                {isAdminRole && (
                  <div className="flex flex-wrap items-center gap-2 m-[-4px_0_17px]">
                    {/* Approval itself lives in the footer (double confirmation).
                        Revise stays: it is still used to send the applicant back
                        to an earlier stage for corrections. */}
                    <button type="button" disabled={acting} onClick={() => setReviseForm({ stage: 'scheduled', remarks: '' })}>
                      Revise
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Applicant details are removed from the Payment Record stage
                (they broke that modal's responsiveness) AND from For Approval
                (the record above is the summary). Every other stage keeps it. */}
            {!['payment_submitted', 'for_approval'].includes(stage) && (
              <details className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] [&_summary]:tracking-[0.09em] [&_summary]:uppercase [&_summary]:text-[#e4e8f4] later:[&_summary]:text-[13px] [&_summary]:font-[700] [&_summary]:cursor-pointer [&[open]_summary]:mb-4 [#update-applicant-form_&_summary]:text-[12px] [.ap-dialog.is-payment_&]:mt-auto [.ap-dialog.is-payment_&[open]_.form-grid]:max-h-[38vh] [.ap-dialog.is-payment_&[open]_.form-grid]:overflow-y-auto [.ap-dialog.is-payment_&[open]_.form-grid]:[overscroll-behavior:contain] [.ap-dialog.is-payment_&[open]_.form-grid]:pr-1 [.ap-dialog.is-payment_&[open]_.form-grid::-webkit-scrollbar]:w-[6px] [.ap-dialog.is-payment_&[open]_.form-grid::-webkit-scrollbar-thumb]:[background:#39435b] [.ap-dialog.is-payment_&[open]_.form-grid::-webkit-scrollbar-thumb]:rounded-[99px]">
                <summary>Applicant details</summary>
                <div className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3">
                  <Field label="Full name" required>
                    <input value={draft.full_name} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} />
                  </Field>
                  <Field label="Email"><input type="email" value={draft.email} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
                  <Field label="Phone"><input value={draft.phone} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></Field>
                  <ApplicantLocations
                    editing={editing}
                    canEdit={(isAdminRole || isAssignedSales) && !editing.archived_at && !['active_franchisee', 'rejected'].includes(editing.status)}
                    busy={acting}
                    onSave={savePreferredLocation}
                  />
                  <Field label="Notes" full>
                    <textarea value={draft.notes} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </Field>
                </div>
              </details>
            )}

            {/* Stage 4: Payment Record. Records payments made outside the system:
                required payments (names only), one entry each, Admin verification. */}
            {paymentsVisible && stage === 'payment_submitted' && (
              <PaymentRecordPanel
                editing={editing}
                isAdminRole={isAdminRole}
                busy={acting || saving}
                onEditRequired={() => setEditRequiredOpen(true)}
                onSubmitEntry={submitPaymentEntry}
                onEditEntry={editPaymentEntry}
                onVerify={verifyPaymentEntry}
                onReject={rejectPaymentEntry}
                onMove={moveToForApproval}
                onError={setActionError}
              />
            )}
            {stage === 'payment_submitted' && !['active_franchisee', 'rejected'].includes(editing.status) && (
              <FollowUpLog
                items={editing.follow_ups || []}
                events={editing.follow_up_events || []}
                title="Follow-up"
                id={FOLLOW_UP_SECTION_ID}
                highlight={followUpFlash}
                addLabel={isAssignedSales && ['overdue', 'stalled'].includes(editing.follow_up?.state) ? 'Log contact attempt' : 'Log follow-up'}
                summary={(
                  <FollowUpSummary
                    applicant={editing}
                    role={role}
                    isAdmin={isAdminRole}
                    isAssignedSales={isAssignedSales}
                    busy={acting}
                    onAction={(kind) => {
                      if (kind === 'reassign') void openAssign();
                      else if (kind === 'release') void runRequest(() => api.post(`/applicants/${editing.id}/hold/release`), 'Hold released.');
                      else setFollowUpAction({ kind, applicant: editing });
                    }}
                  />
                )}
                canAdd={isAssignedSales && !editing.archived_at}
                busy={acting}
                onAdd={logApplicantFollowUp}
                surfaceClass="[background:#0C111D]"
              />
            )}
            {editRequiredOpen && editing?.payment_record && (
              <EditRequiredPaymentsModal
                applicant={editing}
                record={editing.payment_record}
                busy={acting}
                onCancel={() => setEditRequiredOpen(false)}
                onSave={saveRequiredPayments}
              />
            )}

            {stage === 'payment_submitted' && doneSections}

            {/* Later stages (For Approval / Approved / Active Franchise): the
                payment record is read-only. */}
            {paymentsVisible && stage !== 'payment_submitted' && PAYMENT_PANEL_FROM.includes(stage) && (
              <PaymentRecordPanel editing={editing} isAdminRole={isAdminRole} readOnly busy={false} onError={setActionError} />
            )}

          </form>

          {/* Not a <form>: a nested submit would bubble to the Update form through the React tree. */}
          {mark && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setMark(null); }}
        >
              <div className="[&_label]:grid [&_label]:gap-[6px] [&_label]:text-[0.78rem] [&_label]:font-[600] [&_label]:text-[color:var(--ap-muted)] [&_input]:[box-sizing:border-box] [&_input]:w-full later:[&_input]:p-[10px_12px] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later:[&_input]:text-[0.9rem] later:[&_input]:text-[color:var(--ap-text)] later:[&_input]:[background:var(--ap-bg)] later:[&_input]:[border:1px_solid_var(--ap-border-2)] [&_input]:rounded-[10px] [&_input:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_input:focus]:[outline-offset:1px] grid gap-[14px] [border:1px_solid_var(--ap-border-2)] later:w-[min(100%,_390px)] p-[22px] later:border later:border-[#343b50] rounded-[16px] later:[background:#111624] text-[#edf0fa] later:[box-shadow:0_22px_70px_rgba(0,0,0,.5)] later:[&_h3]:m-[0_0_18px] later-3:[&_h3]:text-[15px] [&.ap-record-card]:relative [&.ap-record-card]:w-[min(100%,_440px)] [&.ap-record-card]:max-h-[calc(100dvh_-_36px)] [&.ap-record-card]:p-0 [&.ap-record-card]:overflow-x-hidden [&.ap-record-card]:overflow-y-auto [&.ap-record-card]:border [&.ap-record-card]:border-[#2a3550] [&.ap-record-card]:rounded-[14px] [&.ap-record-card]:[background:linear-gradient(180deg,_#131b2e_0%,_#0f1626_100%)] later-5:[&.ap-record-card]:text-[#e7ebf5] [&.ap-record-card]:[box-shadow:0_24px_64px_rgba(2,_6,_18,_.6),_0_0_0_1px_rgba(129,_117,_255,_.05)] ap-record-card [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[0_0_auto_0] [&::before]:h-[2px] [&::before]:[background:linear-gradient(90deg,_#5b6cff,_#8175ff_55%,_#3b82f6)] [&::before]:opacity-[.9] later:[&:has(.ap-pay-split)]:w-[min(100%,_960px)] [&_.ap-subform-actions]:[border-top:1px_dashed_#2a3550] [&_.ap-subform-actions]:[background:rgba(8,_12,_22,_.45)] max-[481px]:[&_.ap-subform-actions]:p-[12px_16px] max-[481px]:[&_.ap-subform-actions]:flex-wrap" role="dialog" aria-modal="true" aria-labelledby="ap-rec-title">
                <header className="flex items-center gap-3 p-[20px_22px_16px] [border-bottom:1px_dashed_#2a3550] max-[481px]:later:p-[16px_16px_14px]">
                  <span className="grid flex-none place-items-center w-[36px] h-[36px] rounded-[10px] border border-[rgba(129,_117,_255,_.28)] [background:rgba(129,_117,_255,_.12)] text-[#aeb6ff] text-[15px]" aria-hidden="true"><FaClipboardCheck /></span>
                  <div className="flex-1 min-w-0 [.ap-record-card_&_h3]:m-[3px_0_0] [.ap-record-card_&_h3]:text-[#f1f3fb] [.ap-record-card_&_h3]:text-[15px] [.ap-record-card_&_h3]:leading-[1.3] [.ap-record-card_&_h3]:[overflow-wrap:anywhere]">
                    <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">Accomplishment record</span>
                    <h3 id="ap-rec-title">{mark.milestone.label}</h3>
                  </div>
                  <span className={`flex-none p-[4px_9px] border border-[#34405c] rounded-[999px] [background:#1a2336] text-[#a9b3cc] text-[10px] font-[700] tracking-[.04em] [&.is-done]:border-[rgba(37,_199,_122,_.4)] [&.is-done]:[background:rgba(37,_199,_122,_.1)] later-5:[&.is-done]:text-[#45d991] ${mark.checked ? ' is-done' : ''}`}>{mark.checked ? 'Completed' : 'Pending'}</span>
                </header>

                <dl className="m-0 p-[6px_22px] [.ap-pay-split_&]:p-0 max-[481px]:later:p-[4px_16px]">
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                    <dt>Applicant</dt>
                    <dd>{editing.full_name}</dd>
                  </div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                    <dt><label htmlFor="ap-rec-date">Date marked</label></dt>
                    <dd>
                      <input
                        id="ap-rec-date"
                        type="datetime-local"
                        autoFocus
                        value={mark.on}
                        onChange={(e) => setMark({ ...mark, on: e.target.value })}
                      />
                    </dd>
                  </div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                    <dt><label htmlFor="ap-rec-by">Marked by</label></dt>
                    <dd>
                      {mark.byLocked ? (
                        <span id="ap-rec-by" className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]"><FaUserCheck aria-hidden="true" /> {mark.by}</span>
                      ) : (
                        <input
                          id="ap-rec-by"
                          value={mark.by}
                          placeholder="Name of the person responsible"
                          onChange={(e) => setMark({ ...mark, by: e.target.value })}
                        />
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">
                  {mark.byLocked
                    ? 'Recorded under the signed-in account. It is saved when you save the applicant.'
                    : 'Your name could not be detected, so please enter who is responsible.'}
                </p>

                <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
                  {mark.checked && <button type="button" className="text-[#ff8d94]" onClick={removeMark}>Remove mark</button>}
                  <span className="flex-1" />
                  <button type="button" onClick={() => setMark(null)}>Cancel</button>
                  <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={saveMark} disabled={!mark.on || !mark.by.trim()}>Apply</button>
                </footer>
              </div>
            </div>,
            document.body,
          )}
        </Dialog>
      )}

      {/* Admin: return a turned-over payment to Sales. The note is required. */}

      {/* LOI image lightbox. The blob URL is created by the attachment row and
          revoked here when the preview closes. */}
      {loiLightbox && createPortal(
        <div className="fixed inset-0 z-2147483000 grid [place-content:center] gap-3 p-[40px_24px] [background:rgba(2,_5,_12,_.82)] [backdrop-filter:blur(10px)] [&_img]:max-w-[min(920px,_92vw)] [&_img]:max-h-[76vh] later:[&_img]:object-contain [&_img]:border [&_img]:border-[#2b344c] [&_img]:rounded-[14px] [&_img]:[background:#0c111d] [&_p]:m-0 [&_p]:text-[#b9c1d5] [&_p]:text-[11.5px] [&_p]:text-center" role="dialog" aria-modal="true" aria-label={loiLightbox.name}>
          <button
            type="button"
            className="absolute top-[18px] right-[20px] w-[36px] h-[36px] grid place-items-center border border-[#2b344c] rounded-[10px] [background:#131a29] text-[#dfe3f5] cursor-pointer hover:border-[#8175ff] later-5:hover:text-[#fff]"
            aria-label="Close preview"
            onClick={() => {
              URL.revokeObjectURL(loiLightbox.url);
              setLoiLightbox(null);
            }}
          >
            <FaXmark aria-hidden="true" />
          </button>
          <img src={loiLightbox.url} alt={loiLightbox.name} />
          <p>{loiLightbox.name}</p>
        </div>,
        document.body,
      )}

      {/* Reject confirmation — the record is archived, never deleted. */}
      {rejectForm && editing && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !acting) setRejectForm(null); }}
        >
          <div
            className="flex flex-col w-[min(440px,_100%)] max-h-[calc(100vh_-_36px)] overflow-auto border border-[#4a2b36] rounded-[14px] [background:#101725] [box-shadow:0_24px_60px_rgba(0,_0,_0,_.55)] text-[#e6eaf5]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-reject-title"
            aria-describedby="ap-reject-help"
          >
            <header className="flex items-start gap-3 p-[18px_18px_14px] border-b border-b-[#262f45]">
              <span className="grid flex-none place-items-center w-[36px] h-[36px] border border-[rgba(209,_81,_96,_.36)] rounded-[10px] [background:rgba(150,_40,_56,_.18)] text-[#ff8d94] text-[16px]" aria-hidden="true"><FaXmark /></span>
              <div className="flex-1 min-w-0 later-4:[&_h3]:m-[4px_0_0] later-3:[&_h3]:text-[#f4f6fc] later-7:[&_h3]:text-[16px] [&_h3]:leading-[1.35] [&_h3]:[overflow-wrap:anywhere]">
                <span className="block text-[#c98a92] text-[12px] font-[700] tracking-[.1em] uppercase">Confirm rejection</span>
                <h3 id="ap-reject-title">Reject {editing.full_name}?</h3>
              </div>
              <button
                type="button"
                className="grid flex-none place-items-center w-[28px] h-[28px] p-0 border border-[#2c3752] rounded-[8px] [background:transparent] text-[#9aa6c4] text-[13px] [box-shadow:none] [&:hover:not(:disabled)]:border-[#3d4a6b] [&:hover:not(:disabled)]:[background:rgba(255,_255,_255,_.04)] [&:hover:not(:disabled)]:text-[#e6eaf5] [&:hover:not(:disabled)]:[filter:none] [&:hover:not(:disabled)]:[transform:none] [&:hover:not(:disabled)]:[box-shadow:none]"
                aria-label="Close"
                disabled={acting}
                onClick={() => setRejectForm(null)}
              >
                <FaXmark aria-hidden="true" />
              </button>
            </header>

            <div className="grid gap-[14px] p-[16px_18px]">
              <dl className="grid gap-2 m-0">
                <div className="grid grid-cols-[104px_1fr] gap-[10px] [align-items:start] later-3:[&_dt]:text-[#8f99b1] later-2:[&_dt]:text-[12px] [&_dd]:m-0 later-2:[&_dd]:text-[#e2e7f4] later-2:[&_dd]:text-[12.5px] [&_dd]:leading-[1.45] max-[481px]:later:grid-cols-[1fr] max-[481px]:later:gap-[3px]">
                  <dt>Applicant</dt>
                  <dd>{editing.full_name}</dd>
                </div>
                <div className="grid grid-cols-[104px_1fr] gap-[10px] [align-items:start] later-3:[&_dt]:text-[#8f99b1] later-2:[&_dt]:text-[12px] [&_dd]:m-0 later-2:[&_dd]:text-[#e2e7f4] later-2:[&_dd]:text-[12.5px] [&_dd]:leading-[1.45] max-[481px]:later:grid-cols-[1fr] max-[481px]:later:gap-[3px]">
                  <dt>Record</dt>
                  <dd>Moves to the Archive — nothing is deleted.</dd>
                </div>
              </dl>

              <label className="relative grid gap-[6px] later-3:[&>span]:text-[#c3cbe0] later:[&>span]:text-[12px] [&>span]:font-[600] [&>span_em]:text-[#8f99b1] [&>span_em]:not-italic [&>span_em]:font-[500] [&_textarea]:w-full [&_textarea]:min-h-[84px] [&_textarea]:p-[9px_10px_22px] [&_textarea]:border [&_textarea]:border-[#2c3752] [&_textarea]:rounded-[8px] [&_textarea]:[background:#0b101c] [&_textarea]:text-[#eef1f9] [&_textarea]:[font-family:inherit] [&_textarea]:[font-weight:inherit] [&_textarea]:[font-style:inherit] [&_textarea]:text-[12.5px] [&_textarea]:leading-[1.5] [&_textarea]:[resize:vertical] [&_textarea::placeholder]:text-[#6f7b96] [&_textarea:focus]:[outline:none] [&_textarea:focus]:border-[#d45160] [&_textarea:focus]:[box-shadow:0_0_0_3px_rgba(209,_81,_96,_.18)]" htmlFor="ap-reject-remarks">
                <span>Remarks <em>(required)</em></span>
                <textarea
                  id="ap-reject-remarks"
                  autoFocus
                  rows={3}
                  maxLength={500}
                  value={rejectForm.remarks}
                  placeholder="Reason for rejecting this applicant"
                  aria-required="true"
                  onChange={(e) => setRejectForm({ ...rejectForm, remarks: e.target.value })}
                />
                <small className="absolute right-[10px] bottom-[7px] text-[#7b86a0] text-[12px]">{rejectForm.remarks.length}/500</small>
              </label>

              <p className="m-0 text-[#8f99b1] text-[12px] leading-[1.5]" id="ap-reject-help">
                The reason is kept in the status history and the audit log.
              </p>
            </div>

            <footer className="flex justify-end gap-[10px] p-[14px_18px_16px] border-t border-t-[#262f45] [background:rgba(8,_12,_22,_.5)] max-[481px]:flex-wrap">
              <button type="button" className="min-h-[34px] p-[0_16px] rounded-[8px] text-[12px] font-[700] tracking-[.02em] [box-shadow:none] border border-[#2c3752] [background:transparent] text-[#b7c0d6] [&:hover:not(:disabled)]:border-[#3d4a6b] [&:hover:not(:disabled)]:[background:rgba(255,_255,_255,_.04)] [&:hover:not(:disabled)]:text-[#eef1f9] [&:hover:not(:disabled)]:[filter:none] [&:hover:not(:disabled)]:[transform:none] [&:hover:not(:disabled)]:[box-shadow:none]" disabled={acting} onClick={() => setRejectForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="min-h-[34px] p-[0_16px] rounded-[8px] text-[12px] font-[700] tracking-[.02em] [box-shadow:none] border border-[#d45160] [background:#c2404f] text-[#fff] [&:hover:not(:disabled)]:border-[#d45160] [&:hover:not(:disabled)]:[background:#d45160] [&:hover:not(:disabled)]:[filter:none] [&:hover:not(:disabled)]:[transform:none] disabled:border-[#4a2b36] disabled:[background:#2a1a21] later-5:disabled:text-[#a4787e] disabled:cursor-not-allowed"
                disabled={acting || rejectForm.remarks.trim().length < 5}
                onClick={() => void rejectApplicant()}
              >
                {acting ? 'Rejecting…' : 'Reject applicant'}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {/* Revise — Admin picks which completed stage to return to. */}
      {reviseForm && editing && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setReviseForm(null); }}
        >
          <div className="[&_label]:grid [&_label]:gap-[6px] [&_label]:text-[0.78rem] [&_label]:font-[600] [&_label]:text-[color:var(--ap-muted)] [&_input]:[box-sizing:border-box] [&_input]:w-full later:[&_input]:p-[10px_12px] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later:[&_input]:text-[0.9rem] later:[&_input]:text-[color:var(--ap-text)] later:[&_input]:[background:var(--ap-bg)] later:[&_input]:[border:1px_solid_var(--ap-border-2)] [&_input]:rounded-[10px] [&_input:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_input:focus]:[outline-offset:1px] grid gap-[14px] [border:1px_solid_var(--ap-border-2)] later:w-[min(100%,_390px)] p-[22px] later:border later:border-[#343b50] rounded-[16px] later:[background:#111624] text-[#edf0fa] later:[box-shadow:0_22px_70px_rgba(0,0,0,.5)] later:[&_h3]:m-[0_0_18px] later-3:[&_h3]:text-[15px] [&.ap-record-card]:relative [&.ap-record-card]:w-[min(100%,_440px)] [&.ap-record-card]:max-h-[calc(100dvh_-_36px)] [&.ap-record-card]:p-0 [&.ap-record-card]:overflow-x-hidden [&.ap-record-card]:overflow-y-auto [&.ap-record-card]:border [&.ap-record-card]:border-[#2a3550] [&.ap-record-card]:rounded-[14px] [&.ap-record-card]:[background:linear-gradient(180deg,_#131b2e_0%,_#0f1626_100%)] later-5:[&.ap-record-card]:text-[#e7ebf5] [&.ap-record-card]:[box-shadow:0_24px_64px_rgba(2,_6,_18,_.6),_0_0_0_1px_rgba(129,_117,_255,_.05)] ap-record-card [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[0_0_auto_0] [&::before]:h-[2px] [&::before]:[background:linear-gradient(90deg,_#5b6cff,_#8175ff_55%,_#3b82f6)] [&::before]:opacity-[.9] later:[&:has(.ap-pay-split)]:w-[min(100%,_960px)] [&_.ap-subform-actions]:[border-top:1px_dashed_#2a3550] [&_.ap-subform-actions]:[background:rgba(8,_12,_22,_.45)] max-[481px]:[&_.ap-subform-actions]:p-[12px_16px] max-[481px]:[&_.ap-subform-actions]:flex-wrap" role="dialog" aria-modal="true" aria-labelledby="ap-revise-title">
            <header className="flex items-center gap-3 p-[20px_22px_16px] [border-bottom:1px_dashed_#2a3550] max-[481px]:later:p-[16px_16px_14px]">
              <span className="grid flex-none place-items-center w-[36px] h-[36px] rounded-[10px] border border-[rgba(129,_117,_255,_.28)] [background:rgba(129,_117,_255,_.12)] text-[#aeb6ff] text-[15px]" aria-hidden="true"><FaClipboardCheck /></span>
              <div className="flex-1 min-w-0 [.ap-record-card_&_h3]:m-[3px_0_0] [.ap-record-card_&_h3]:text-[#f1f3fb] [.ap-record-card_&_h3]:text-[15px] [.ap-record-card_&_h3]:leading-[1.3] [.ap-record-card_&_h3]:[overflow-wrap:anywhere]">
                <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">Return for revision</span>
                <h3 id="ap-revise-title">{editing.full_name}</h3>
              </div>
            </header>
            <fieldset className="m-0 p-[0_22px] border-0 grid gap-2 [&_legend]:p-[0_0_8px] [&_legend]:text-[#9aa6c4] [&_legend]:text-[10.5px] [&_legend]:tracking-[.05em] [&_legend]:uppercase">
              <legend>Which stage should be revisited?</legend>
              {REVISE_STAGES.map((item) => (
                <label key={item.key} className={`flex gap-[10px] items-start p-[9px_11px] border border-[#303749] rounded-[9px] [background:#0c111d] cursor-pointer [&.selected]:border-[#8175ff] [&.selected]:[background:rgba(129,_117,_255,_.12)] [&_input]:mt-[2px] [&_input]:[accent-color:#8175ff] [&_strong]:block later:[&_strong]:text-[#edf0fa] later-2:[&_strong]:text-[12px] later-4:[&_small]:text-[#9ba5bd] later-2:[&_small]:text-[10.5px] ${reviseForm.stage === item.key ? ' selected' : ''}`}>
                  <input
                    type="radio"
                    name="ap-revise-stage"
                    value={item.key}
                    checked={reviseForm.stage === item.key}
                    onChange={() => setReviseForm({ ...reviseForm, stage: item.key })}
                  />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <dl className="m-0 p-[6px_22px] [.ap-pay-split_&]:p-0 max-[481px]:later:p-[4px_16px]">
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                <dt><label htmlFor="ap-revise-remarks">Remarks</label></dt>
                <dd>
                  <textarea
                    id="ap-revise-remarks"
                    autoFocus
                    rows={3}
                    value={reviseForm.remarks}
                    placeholder="What needs to be corrected"
                    onChange={(e) => setReviseForm({ ...reviseForm, remarks: e.target.value })}
                  />
                </dd>
              </div>
            </dl>
            <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">Remarks are required; every earlier record stays in place.</p>
            <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
              <span className="flex-1" />
              <button type="button" onClick={() => setReviseForm(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                disabled={acting || !reviseForm.remarks.trim()}
                onClick={() => void reviseApplicant()}
              >
                Return for revision
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {/* Phase 2.3: [Confirm Qualified] double confirmation. The API refuses a
          confirm request that does not carry `confirmed: true`, so this second
          click is the only way the stage can move. */}
      {qualifiedConfirm && editing && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setQualifiedConfirm(false); }}
        >
          <div className="[&_label]:grid [&_label]:gap-[6px] [&_label]:text-[0.78rem] [&_label]:font-[600] [&_label]:text-[color:var(--ap-muted)] [&_input]:[box-sizing:border-box] [&_input]:w-full later:[&_input]:p-[10px_12px] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later:[&_input]:text-[0.9rem] later:[&_input]:text-[color:var(--ap-text)] later:[&_input]:[background:var(--ap-bg)] later:[&_input]:[border:1px_solid_var(--ap-border-2)] [&_input]:rounded-[10px] [&_input:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_input:focus]:[outline-offset:1px] grid gap-[14px] [border:1px_solid_var(--ap-border-2)] later:w-[min(100%,_390px)] p-[22px] later:border later:border-[#343b50] rounded-[16px] later:[background:#111624] text-[#edf0fa] later:[box-shadow:0_22px_70px_rgba(0,0,0,.5)] later:[&_h3]:m-[0_0_18px] later-3:[&_h3]:text-[15px] [&.ap-record-card]:relative [&.ap-record-card]:w-[min(100%,_440px)] [&.ap-record-card]:max-h-[calc(100dvh_-_36px)] [&.ap-record-card]:p-0 [&.ap-record-card]:overflow-x-hidden [&.ap-record-card]:overflow-y-auto [&.ap-record-card]:border [&.ap-record-card]:border-[#2a3550] [&.ap-record-card]:rounded-[14px] [&.ap-record-card]:[background:linear-gradient(180deg,_#131b2e_0%,_#0f1626_100%)] later-5:[&.ap-record-card]:text-[#e7ebf5] [&.ap-record-card]:[box-shadow:0_24px_64px_rgba(2,_6,_18,_.6),_0_0_0_1px_rgba(129,_117,_255,_.05)] ap-record-card [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[0_0_auto_0] [&::before]:h-[2px] [&::before]:[background:linear-gradient(90deg,_#5b6cff,_#8175ff_55%,_#3b82f6)] [&::before]:opacity-[.9] later:[&:has(.ap-pay-split)]:w-[min(100%,_960px)] [&_.ap-subform-actions]:[border-top:1px_dashed_#2a3550] [&_.ap-subform-actions]:[background:rgba(8,_12,_22,_.45)] max-[481px]:[&_.ap-subform-actions]:p-[12px_16px] max-[481px]:[&_.ap-subform-actions]:flex-wrap" role="dialog" aria-modal="true" aria-labelledby="ap-qualified-title">
            <header className="flex items-center gap-3 p-[20px_22px_16px] [border-bottom:1px_dashed_#2a3550] max-[481px]:later:p-[16px_16px_14px]">
              <span className="grid flex-none place-items-center w-[36px] h-[36px] rounded-[10px] border border-[rgba(129,_117,_255,_.28)] [background:rgba(129,_117,_255,_.12)] text-[#aeb6ff] text-[15px]" aria-hidden="true"><FaClipboardCheck /></span>
              <div className="flex-1 min-w-0 [.ap-record-card_&_h3]:m-[3px_0_0] [.ap-record-card_&_h3]:text-[#f1f3fb] [.ap-record-card_&_h3]:text-[15px] [.ap-record-card_&_h3]:leading-[1.3] [.ap-record-card_&_h3]:[overflow-wrap:anywhere]">
                <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">Confirm Qualified</span>
                <h3 id="ap-qualified-title">{editing.full_name}</h3>
              </div>
            </header>
            <dl className="m-0 p-[6px_22px] [.ap-pay-split_&]:p-0 max-[481px]:later:p-[4px_16px]">
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Requirements</dt><dd>{editing.requirements?.summary?.qualification?.legacy ? `${QUALIFICATION_ITEMS.filter(({ key }) => draft.milestones[key]).length} of ${QUALIFICATION_ITEMS.length} assessed` : `${qualificationAcceptedCount} of ${qualificationTotalCount} accepted`}</dd></div>
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Qualified date</dt><dd>{formatDate(new Date().toISOString())}</dd></div>
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Confirmed by</dt><dd className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]"><FaUserCheck aria-hidden="true" /> {authLabel}</dd></div>
            </dl>
            <label className="block p-[4px_22px_12px] max-[481px]:later:p-[4px_16px_10px]">
              <span className="text-[14px]">Remarks (required, at least 5 characters)</span>
              <textarea
                rows={3}
                value={qualifiedRemarks}
                onChange={(e) => setQualifiedRemarks(e.target.value)}
                placeholder="What was checked, and why the applicant qualifies"
                className="w-full min-h-[84px] p-[10px_12px] border border-[#2c3752] rounded-[8px] [background:#0b101c] text-[#eef1f9] text-[14px] leading-[1.5] [font-family:inherit] [resize:vertical] placeholder:text-[#6f7b96] focus:[outline:none] focus:border-[#d45160] focus:[box-shadow:0_0_0_3px_rgba(209,_81,_96,_.18)]"
              />
            </label>
            <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[13px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">Confirm this applicant as Qualified? This cannot be undone.</p>
            <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
              <span className="flex-1" />
              <button type="button" className="min-h-[34px] p-[0_16px] rounded-[8px] text-[13px] font-[700] tracking-[.02em] [box-shadow:none] border border-[#d45160] [background:#c2404f] text-[#fff] [&:hover:not(:disabled)]:border-[#d45160] [&:hover:not(:disabled)]:[background:#d45160]" onClick={() => setQualifiedConfirm(false)}>Cancel</button>
              <button type="button" className="min-h-[34px] p-[0_16px] rounded-[8px] text-[13px] font-[700] tracking-[.02em] border border-transparent text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50" onClick={() => void performStageAction('qualified', { remarks: qualifiedRemarks.trim() })} disabled={acting || qualifiedRemarks.trim().length < 5}>
                Yes, Confirm Qualified
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

      {/* Approve confirmation — Date, Role and Remarks. */}
      {approveForm && editing && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !acting) setApproveForm(null); }}
        >
          <div className="[&_label]:grid [&_label]:gap-[6px] [&_label]:text-[0.78rem] [&_label]:font-[600] [&_label]:text-[color:var(--ap-muted)] [&_input]:[box-sizing:border-box] [&_input]:w-full later:[&_input]:p-[10px_12px] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later:[&_input]:text-[0.9rem] later:[&_input]:text-[color:var(--ap-text)] later:[&_input]:[background:var(--ap-bg)] later:[&_input]:[border:1px_solid_var(--ap-border-2)] [&_input]:rounded-[10px] [&_input:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_input:focus]:[outline-offset:1px] grid gap-[14px] [border:1px_solid_var(--ap-border-2)] later:w-[min(100%,_390px)] p-[22px] later:border later:border-[#343b50] rounded-[16px] later:[background:#111624] text-[#edf0fa] later:[box-shadow:0_22px_70px_rgba(0,0,0,.5)] later:[&_h3]:m-[0_0_18px] later-3:[&_h3]:text-[15px] [&.ap-record-card]:relative [&.ap-record-card]:w-[min(100%,_440px)] [&.ap-record-card]:max-h-[calc(100dvh_-_36px)] [&.ap-record-card]:p-0 [&.ap-record-card]:overflow-x-hidden [&.ap-record-card]:overflow-y-auto [&.ap-record-card]:border [&.ap-record-card]:border-[#2a3550] [&.ap-record-card]:rounded-[14px] [&.ap-record-card]:[background:linear-gradient(180deg,_#131b2e_0%,_#0f1626_100%)] later-5:[&.ap-record-card]:text-[#e7ebf5] [&.ap-record-card]:[box-shadow:0_24px_64px_rgba(2,_6,_18,_.6),_0_0_0_1px_rgba(129,_117,_255,_.05)] ap-record-card [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[0_0_auto_0] [&::before]:h-[2px] [&::before]:[background:linear-gradient(90deg,_#5b6cff,_#8175ff_55%,_#3b82f6)] [&::before]:opacity-[.9] later:[&:has(.ap-pay-split)]:w-[min(100%,_960px)] [&_.ap-subform-actions]:[border-top:1px_dashed_#2a3550] [&_.ap-subform-actions]:[background:rgba(8,_12,_22,_.45)] max-[481px]:[&_.ap-subform-actions]:p-[12px_16px] max-[481px]:[&_.ap-subform-actions]:flex-wrap ap-approve-modal" role="dialog" aria-modal="true" aria-labelledby="ap-approve-title">
            <header className="flex items-center gap-3 p-[20px_22px_16px] [border-bottom:1px_dashed_#2a3550] max-[481px]:later:p-[16px_16px_14px]">
              <span className="grid flex-none place-items-center w-[36px] h-[36px] rounded-[10px] border border-[rgba(129,_117,_255,_.28)] [background:rgba(129,_117,_255,_.12)] text-[#aeb6ff] text-[15px]" aria-hidden="true"><FaClipboardCheck /></span>
              <div className="flex-1 min-w-0 [.ap-record-card_&_h3]:m-[3px_0_0] [.ap-record-card_&_h3]:text-[#f1f3fb] [.ap-record-card_&_h3]:text-[15px] [.ap-record-card_&_h3]:leading-[1.3] [.ap-record-card_&_h3]:[overflow-wrap:anywhere]">
                <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">
                  {approveForm.step === 2 ? 'Final confirmation · Step 2 of 2' : 'Confirm approval · Step 1 of 2'}
                </span>
                <h3 id="ap-approve-title">
                  {approveForm.step === 2 ? 'Approve this applicant for the last time?' : `Approve ${editing.full_name}?`}
                </h3>
              </div>
              <button
                type="button"
                className="grid flex-none place-items-center w-[28px] h-[28px] p-0 border border-[#2c3752] rounded-[8px] [background:transparent] text-[#9aa6c4] text-[13px] [box-shadow:none] [&:hover:not(:disabled)]:border-[#3d4a6b] [&:hover:not(:disabled)]:[background:rgba(255,_255,_255,_.04)] [&:hover:not(:disabled)]:text-[#e6eaf5] [&:hover:not(:disabled)]:[filter:none] [&:hover:not(:disabled)]:[transform:none] [&:hover:not(:disabled)]:[box-shadow:none]"
                aria-label="Close"
                disabled={acting}
                onClick={() => setApproveForm(null)}
              >
                <FaXmark aria-hidden="true" />
              </button>
            </header>

            {approveForm.step === 1 ? (
              <>
                <dl className="m-0 p-[6px_22px] [.ap-pay-split_&]:p-0 max-[481px]:later:p-[4px_16px]">
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Applicant</dt><dd>{editing.full_name}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Brand</dt><dd>{editing.preferred_brand?.name || 'No brand'}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Payments</dt><dd>{editing.payment_record?.required_count ? `${editing.payment_record.verified_count} of ${editing.payment_record.required_count} required payments verified` : (editing.payment_record?.legacy_confirmed ? 'Confirmed (older record)' : '—')}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Approved by</dt><dd className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]"><FaUserCheck aria-hidden="true" /> {authName || titleCase(role)}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                    <dt><label htmlFor="ap-approve-remarks">Remarks</label></dt>
                    <dd>
                      <textarea
                        id="ap-approve-remarks"
                        autoFocus
                        rows={3}
                        value={approveForm.remarks}
                        placeholder="Approval remarks (optional)"
                        onChange={(e) => setApproveForm({ ...approveForm, remarks: e.target.value })}
                      />
                    </dd>
                  </div>
                </dl>
                <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">
                  Approving records the date and the Admin account, moves the applicant to Approved,
                  and writes the status history and audit log entries.
                </p>
                <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
                  <button type="button" disabled={acting} onClick={() => setApproveForm(null)}>Cancel</button>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                    disabled={acting}
                    onClick={() => setApproveForm({ ...approveForm, step: 2, confirmText: '' })}
                  >
                    Continue
                  </button>
                </footer>
              </>
            ) : (
              <>
                <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">
                  This is the final step — the applicant moves to <strong>Approved</strong> and the
                  decision is recorded in the audit log.
                </p>
                <label className="grid gap-2 p-[4px_22px] later-3:[&>span]:text-[#c3cbe0] later:[&>span]:text-[12px] later:[&>span_strong]:text-[#f1f3fb] [&>span_strong]:tracking-[.06em] later-2:[&_input]:min-h-[36px] later-5:[&_input]:p-[0_10px] later-4:[&_input]:border later-4:[&_input]:border-[#2c3752] later-3:[&_input]:rounded-[8px] later-4:[&_input]:[background:#0b101c] later-4:[&_input]:text-[#eef1f9] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-5:[&_input]:text-[13px] [&_input]:tracking-[.06em] later:[&_input:focus]:[outline:none] later-3:[&_input:focus]:border-[#8175ff] later-3:[&_input:focus]:[box-shadow:0_0_0_3px_rgba(129,_117,_255,_.18)]" htmlFor="ap-approve-confirm">
                  <span>Type <strong>APPROVE</strong> to confirm</span>
                  <input
                    id="ap-approve-confirm"
                    autoFocus
                    autoComplete="off"
                    value={approveForm.confirmText}
                    onChange={(e) => setApproveForm({ ...approveForm, confirmText: e.target.value })}
                  />
                </label>
                <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
                  <button
                    type="button"
                    disabled={acting}
                    onClick={() => setApproveForm({ ...approveForm, step: 1 })}
                  >
                    Back
                  </button>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                    disabled={acting || approveForm.confirmText.trim().toUpperCase() !== 'APPROVE'}
                    onClick={() => void approveApplicant()}
                  >
                    {acting ? 'Approving…' : 'Yes, approve'}
                  </button>
                </footer>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Application Detail: read-only Full Applicant Information report. */}
      {report && <ApplicationDetailReport report={report} onClose={() => setReport(null)} />}

      {/* Undo LOI needs a reason (at least 5 characters). */}
      {undoLoiForm && editing && (
        <Dialog
          title={`Undo LOI for ${editing.full_name}`}
          onClose={() => setUndoLoiForm(null)}
          size="small"
          zIndex={2147482500}
          footer={(
            <>
              <button type="button" onClick={() => setUndoLoiForm(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]"
                disabled={acting || undoLoiForm.remarks.trim().length < 5}
                onClick={() => void performStageAction('undoLoi', { remarks: undoLoiForm.remarks.trim() })}
              >
                {acting ? 'Saving…' : 'Undo LOI'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <Field label="Reason (required, at least 5 characters)" required full>
            <textarea rows={3} value={undoLoiForm.remarks} onChange={(e) => setUndoLoiForm({ ...undoLoiForm, remarks: e.target.value })} placeholder="Why the LOI confirmation is being undone" />
          </Field>
        </Dialog>
      )}

      {assignForm && editing && (
        <Dialog
          title={editing.assigned_sales_user_id ? `Reassign Sales for ${editing.full_name}` : `Assign Sales for ${editing.full_name}`}
          onClose={() => setAssignForm(null)}
          size="small"
          zIndex={2147482500}
          animated
          footer={(
            <>
              <button type="button" className="min-h-[42px] min-w-[104px] inline-flex items-center justify-center p-[0_16px] border border-[#353e57] rounded-[12px] text-[#e7ebf5] [background:#1a2133] hover:[background:#222b42] transition-colors" onClick={() => setAssignForm(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] min-w-[104px] inline-flex items-center justify-center p-[0_16px] border border-transparent rounded-[12px] text-[#fff] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-[.55] disabled:cursor-not-allowed"
                disabled={acting || !assignForm.assigned_sales_user_id || (Boolean(editing.assigned_sales_user_id) && assignForm.reason.trim().length < 5)}
                onClick={() => void saveAssignment()}
              >
                {acting ? 'Saving…' : editing.assigned_sales_user_id ? 'Reassign' : 'Assign'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <p className="m-[0_0_12px] text-[14px] leading-[1.5]">
            Current: <strong>{editing.assigned_sales?.full_name || 'Unassigned'}</strong>
          </p>
          <Field label="Sales user" required full>
            <select value={assignForm.assigned_sales_user_id} onChange={(e) => setAssignForm({ ...assignForm, assigned_sales_user_id: e.target.value })}>
              <option value="">Choose a Sales user…</option>
              {salesUsers.filter((u) => u.id !== Number(editing.assigned_sales_user_id)).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name} · {u.open_applicants} open</option>
              ))}
            </select>
          </Field>
          <Field label={editing.assigned_sales_user_id ? 'Reason (required, at least 5 characters)' : 'Note (optional)'} required={Boolean(editing.assigned_sales_user_id)} full>
            <textarea rows={3} value={assignForm.reason} onChange={(e) => setAssignForm({ ...assignForm, reason: e.target.value })} placeholder="Why this applicant is moving to another Sales user" />
          </Field>
        </Dialog>
      )}

      {/* "Mark as Active Franchisee" needs the business + location record. */}
      <FollowUpDialogs
        action={followUpAction}
        onClose={() => setFollowUpAction(null)}
        onDone={async (message, extra = {}) => {
          const target = followUpAction?.applicant;
          setFollowUpAction(null);
          setActionError('');
          if (extra.closed && editing && target && Number(editing.id) === Number(target.id)) closeEditor();
          else if (editing && target && Number(editing.id) === Number(target.id)) { detailCache.current.clear(); await loadApplicant(editing.id); }
          await remote.reload();
          setSuccess(message);
        }}
      />
      {activateForm && editing && (
        <Dialog
          title={`Mark ${editing.full_name} as active franchisee`}
          onClose={() => setActivateForm(null)}
          size="medium"
          zIndex={2147482500}
          footer={(
            <>
              <button type="button" onClick={() => setActivateForm(null)}>Cancel</button>
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="activate-form" disabled={acting}>
                {acting ? 'Saving…' : 'Mark as Active Franchisee'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <form id="activate-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submitActivate}>
            <Field label="Business name" required full>
              <input required value={activateForm.business_name} onChange={(e) => setActivateForm({ ...activateForm, business_name: e.target.value })} />
            </Field>
            <Field label="Location name" required>
              <input required value={activateForm['location.name']} onChange={(e) => setActivateForm({ ...activateForm, 'location.name': e.target.value })} />
            </Field>
            <Field label="Preferred branch type">
              <input readOnly value={activateForm['location.preferred_branch_type']} />
            </Field>
            <Field label="Contact number">
              <input value={activateForm['location.contact_number']} onChange={(e) => setActivateForm({ ...activateForm, 'location.contact_number': e.target.value })} />
            </Field>
            <Field label="Address" required full>
              <input required value={activateForm['location.address']} onChange={(e) => setActivateForm({ ...activateForm, 'location.address': e.target.value })} />
            </Field>
            <Field label="City">
              <input value={activateForm['location.city']} onChange={(e) => setActivateForm({ ...activateForm, 'location.city': e.target.value })} />
            </Field>
            <Field label="Province">
              <input value={activateForm['location.province']} onChange={(e) => setActivateForm({ ...activateForm, 'location.province': e.target.value })} />
            </Field>
            <Field label="Region">
              <input value={activateForm['location.region']} onChange={(e) => setActivateForm({ ...activateForm, 'location.region': e.target.value })} />
            </Field>
          </form>
          <p className="m-0 italic later:text-[#9ba5bd] later:text-[12px]">
            Prefilled from the applicant record where possible — only Admin can activate, and the stage must be "Approved".
          </p>
        </Dialog>
      )}
    </div>
  );
}
