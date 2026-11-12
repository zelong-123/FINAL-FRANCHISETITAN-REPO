import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  FaCheck, FaClipboardCheck, FaClock, FaEye, FaFileCsv, FaFilePdf, FaImage, FaList, FaLock, FaPen, FaPrint, FaStore,
  FaRotateLeft, FaTableCellsLarge, FaTrashCan, FaUserCheck, FaXmark,
} from 'react-icons/fa6';
import {
  API_BASE_URL, api, authToken, firstValidationMessage,
} from '../lib/api';
import { downloadCsv, downloadPdf } from '../lib/export';
import FollowUpLog from '../components/FollowUpLog';
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
import { currentMinimum, downpaymentBase, entryRuleIssue, minDownpayment } from '../lib/installments';

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
const money = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value) || 0);
// Payment Record money rule: peso sign, thousands separators, cents only
// when the amount is not a whole peso (₱500,000 not ₱500,000.00).
const moneyExact = (value) => {
  const amount = Number(value) || 0;
  const whole = Math.abs(amount % 1) < 0.005;
  const formatted = new Intl.NumberFormat('en-PH', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
  return `₱${formatted}`;
};

/** Compact money for the header chip: ₱50k / ₱120k. */
const moneyShort = (value) => {
  const amount = Number(value) || 0;
  return amount >= 1000 ? `₱${Math.round(amount / 1000)}k` : `₱${amount}`;
};

// Payment Record product rules (the API enforces the same limits).
// The Admin's ORIGINAL Total required (before discount) — mirrors the backend
// ceiling in PaymentStageService::MAX_TOTAL_CENTS.
const MAX_TOTAL_REQUIRED = 500000;
const MAX_PAYMENT_AMOUNT = 999999;
const PAYMENT_TYPE_OPTIONS = [
  { value: 'downpayment', label: 'Downpayment' },
  { value: 'installment_payment', label: 'Installment Payment' },
  { value: 'full_payment', label: 'Full Payment' },
];
/** Values older records were saved with, shown under their current label. */
const LEGACY_PAYMENT_TYPE_MAP = {
  initial_franchise_fee: 'installment_payment',
  installment: 'installment_payment',
  fully_paid: 'full_payment',
};
const PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'gcash', label: 'GCash' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other' },
];
const paymentTypeLabel = (value) => {
  const canonical = LEGACY_PAYMENT_TYPE_MAP[value] || value;
  return PAYMENT_TYPE_OPTIONS.find((option) => option.value === canonical)?.label
    || titleCase(String(value || 'payment'));
};
const paymentMethodLabel = (value) => {
  if (!value) return '—';
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === value)?.label
    || titleCase(String(value).replaceAll('_', ' '));
};

const DISCOUNT_PRESETS = [50, 40, 30, 20, 10];

/** Raw digits of a money input (thousands separators are display only). */
const amountInputValue = (value) => String(value ?? '').replace(/,/g, '').trim();

/**
 * Clean money input: digits and at most one decimal point, grouped with
 * thousands separators as the Admin types. No minus sign, no spinner arrows,
 * `inputMode="decimal"` on the element gives mobile a numeric keypad.
 */
const formatAmountInput = (value) => {
  const cleaned = String(value ?? '').replace(/[^\d.]/g, '');
  const [wholePart, ...rest] = cleaned.split('.');
  const decimals = rest.length ? `.${rest.join('').slice(0, 2)}` : '';
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  if (whole === '' && decimals === '') return '';
  return `${(whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals}`;
};

/** The Admin's Total required (the ORIGINAL amount, before the discount). */
const totalRequiredError = (value) => {
  const raw = amountInputValue(value);
  if (raw === '') return 'Enter the Total required.';
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'Numbers only — letters are not allowed.';
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return 'The Total required must be greater than ₱0.';
  if (amount > MAX_TOTAL_REQUIRED) return `The Total required cannot exceed ${moneyExact(MAX_TOTAL_REQUIRED)}.`;
  return '';
};

/** Custom discount: whole numbers 1 to 100 only (decimals, 0 and 101+ rejected). */
const customDiscountError = (value) => {
  const raw = String(value ?? '').trim();
  if (raw === '') return 'Enter the discount percentage.';
  if (!/^\d+$/.test(raw)) return 'Whole numbers only — type a percentage from 1 to 100.';
  const percent = Number(raw);
  if (percent < 1 || percent > 100) return 'The discount must be a whole number from 1 to 100.';
  return '';
};

/** Percentage the dropdown currently represents (0 = no discount). */
const discountPercentFor = (choice, custom) => {
  if (!choice || choice === 'none') return 0;
  if (choice === 'custom') return customDiscountError(custom) ? 0 : Number(custom);
  return Number(choice) || 0;
};

/**
 * Same rule as the server, in integer centavos: the final amount is always
 * derived from the ORIGINAL amount, never from a previous final, so a discount
 * never compounds.
 */
const discountedAmount = (value, percent) => {
  const raw = amountInputValue(value);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 0;
  const cents = Math.round(Number(raw) * 100);
  return Math.round((cents * (100 - percent)) / 100) / 100;
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
  title, onClose, footer, children, size = 'large', zIndex = 2147482000, closeOnEscape = true, modalClass = '',
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
      <div className="fixed inset-0 flex items-center justify-center [box-sizing:border-box] p-5 [background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)] [overscroll-behavior:contain] max-[721px]:later:p-[10px] print:[body.ap-print-report_&]:static print:[body.ap-print-report_&]:p-0 print:[body.ap-print-report_&]:[background:#fff]" style={{ zIndex }}>
        <div
          className={`ap-dialog flex flex-col [box-sizing:border-box] w-[min(900px,_100%)] max-h-[calc(100dvh_-_40px)] overflow-hidden border border-[#2a3550] rounded-[10px] [background:#0f1626] text-[#e7ebf5] [box-shadow:0_28px_80px_rgba(2,_6,_18,_.65),_0_0_0_1px_rgba(129,_117,_255,_.05)] [&.is-medium]:w-[min(680px,_100%)] later:[&.is-small]:w-[min(460px,_100%)] max-[721px]:later:w-full max-[721px]:later:max-h-[calc(100dvh_-_20px)] print:[body.ap-print-report_&]:w-full print:[body.ap-print-report_&]:max-w-[none] print:[body.ap-print-report_&]:max-h-[none] print:[body.ap-print-report_&]:h-auto print:[body.ap-print-report_&]:border-0 print:[body.ap-print-report_&]:rounded-[0] print:[body.ap-print-report_&]:[box-shadow:none] later-3:[&.is-payment]:w-[min(1120px,_100%)] is-${size}${modalClass ? ` ${modalClass}` : ''}`}
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
function Stepper({ items }) {
  return (
    <ol className="flex items-start [list-style:none] p-0 m-0 gap-0 max-[721px]:overflow-x-auto max-[721px]:later:pb-[5px]">
      {items.map((item, index) => {
        const next = items[index + 1];
        const lineDone = item.state === 'done' && Boolean(next) && next.state !== 'todo';
        return (
          <li
            key={item.key}
            className={`ap-step flex flex-col items-center gap-[6px] [&::before]:[content:''] [&::before]:absolute [&::before]:top-[10px] [&::before]:right-[50%] [&::before]:w-full [&::before]:h-[2px] [&::before]:[background:var(--ap-border-2)] [&:first-child::before]:hidden [&.line-done::before]:[background:var(--ap-green)] later:flex-[1_1_0] min-w-0 relative text-center [&:not(:last-child)::after]:[content:''] [&:not(:last-child)::after]:absolute [&:not(:last-child)::after]:top-[12px] [&:not(:last-child)::after]:left-[calc(50%_+_13px)] [&:not(:last-child)::after]:right-[calc(-50%_+_13px)] [&:not(:last-child)::after]:h-[2px] [&:not(:last-child)::after]:[background:#30364c] [&.line-done:not(:last-child)::after]:[background:#25c77a] later-2:[&.is-done_.ap-node]:text-[#071a12] later:[&.is-done_.ap-node]:[background:#25c77a] later-2:[&.is-done_.ap-node]:border-[#25c77a] later-3:[&.is-current_.ap-node]:text-[#fff] later-2:[&.is-current_.ap-node]:[background:#7668f6] later-3:[&.is-current_.ap-node]:border-[#8b80ff] [&.is-current_.ap-node]:[box-shadow:0_0_0_3px_rgba(118,_104,_246,_.14)] max-[721px]:later:min-w-[66px] [#update-applicant-form_&:not(:last-child)::after]:top-[11px] later-4:[&.is-waiting_.ap-node]:text-[#ffd284] later-3:[&.is-waiting_.ap-node]:[background:rgba(244,_184,_74,_.12)] later-4:[&.is-waiting_.ap-node]:border-[rgba(244,_184,_74,_.55)] later-4:[&.is-pending_.ap-node]:[background:rgba(245,_158,_11,_.18)] later-5:[&.is-pending_.ap-node]:border-[#f59e0b] later-5:[&.is-pending_.ap-node]:text-[#fbbf24] is-${item.state}${lineDone ? ' line-done' : ''}`}
          >
            <div className="flex relative z-1 w-full min-w-0 p-[0_3px] items-center flex-col gap-[6px] border-0 [background:transparent] text-[color:inherit] cursor-default later:[button&]:cursor-pointer later:[button&:disabled]:cursor-not-allowed later:[button&:disabled]:opacity-[.6]">
              <span className="ap-node relative z-1 place-items-center [border:1px_solid_var(--ap-border-2)] [&_svg]:m-0 later:inline-flex items-center justify-center later:w-[25px] later:h-[25px] rounded-[50%] later:[background:#20263b] later:border later:border-[#3a4261] later:text-[#9ba5bd] later:text-[10px] font-[700] [#update-applicant-form_&]:w-[23px] [#update-applicant-form_&]:h-[23px]">
                {item.state === 'done' ? <FaCheck aria-hidden="true" />
                  : item.state === 'waiting' ? (
                    <span className="inline-flex items-center justify-center gap-[3px] [&_i]:w-[5px] [&_i]:h-[5px] [&_i]:rounded-[50%] [&_i]:[background:#f4b84a] [&_i]:[animation:apDotBounce_1.1s_ease-in-out_infinite] [&_i:nth-child(2)]:[animation-delay:.15s] later:[&_i:nth-child(3)]:[animation-delay:.3s]" role="img" aria-label="Waiting">
                      <i /><i /><i />
                    </span>
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

/* Exactly the three tracked activities rendered in the schedule section.
 * The "other" type is never shown here and gates nothing. */
/* LOI soft copy (Soft copy / Email): [Complete] needs the image; [Proceed] exists. */
const LOI_SOFT_TYPES = ['digital', 'email'];

const TRACKED_ACTIVITIES = [
  { type: 'orientation', key: 'orientation_attended', label: 'Orientation' },
  { type: 'product_tasting', key: 'product_tasting_attended', label: 'Product Tasting' },
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
function resolvePrimaryAction({ stage, allAttended, pendingActivities, loiReady, qualificationDone, qualificationMissing = [], activationMissing = [], paymentPercent, hasPortalAccount, isAdminRole, isSalesRole }) {
  const adminOnly = 'Admin action — your role can only view this stage.';

  // Sales only gets a "View" button before the Scheduled stage: no actions yet.
  if (isSalesRole && ['converted', 'qualified'].includes(stage)) {
    return { label: 'View', enabled: false, reason: 'Sales can view this applicant until the Scheduled stage.' };
  }

  switch (stage) {
    case 'converted':
      return qualificationDone
        ? { label: 'Confirm Qualified', enabled: isAdminRole, reason: isAdminRole ? '' : adminOnly, run: 'qualified' }
        : { label: 'Confirm Qualified', enabled: false, reason: qualificationMissing.length ? `Every Qualification requirement must be Accepted first. Missing: ${qualificationMissing.join(', ')}.` : 'Every Qualification requirement must be Accepted first.', run: 'qualified' };
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
          : 'Orientation, Product Tasting, Training';
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
      // The Payment Record stage renders its own buttons in the same spot
      // (Turn over to Admin / Confirm payment + Return to Sales), so the generic
      // primary button steps aside instead of competing with them.
      return null;
    case 'for_approval':
      // Approval is a footer action with a two-step confirmation, so the progress
      // tracker itself only shows progress (no action button here).
      return null;
    case 'approved':
      if (Number(paymentPercent) < 100) {
        return { label: hasPortalAccount ? 'Mark as Active Franchisee' : 'Create Account', enabled: false, reason: `At least 100% verified payment is required; current progress is ${Number(paymentPercent) || 0}%.` };
      }
      if (activationMissing.length) {
        return { label: hasPortalAccount ? 'Mark as Active Franchisee' : 'Create Account', enabled: false, reason: `The signed franchise agreement must be Accepted first. Missing: ${activationMissing.join(', ')}.` };
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
      <div className="flex items-center justify-between gap-[10px] mb-[6px] text-[#cbd3e4] text-[11px] leading-[1.3] [&_strong]:flex-[0_0_auto] [&_strong]:text-[#f0f2ff] [&_strong]:text-[10px] [&_strong]:font-[700] [&_strong]:[font-variant-numeric:tabular-nums] max-[721px]:later:text-[10px]">
        <span>{label}</span>
        <strong>{total ? `${done}/${total}` : `${safePercent}%`}</strong>
      </div>
      <div className="h-[6px] overflow-hidden rounded-[999px] [background:#252d40] [box-shadow:inset_0_1px_2px_rgba(0,0,0,.22)] [&_span]:block [&_span]:h-full [&_span]:rounded-[inherit] [&_span]:[background:linear-gradient(90deg,_#6559e8,_#8a7dff)] [&_span]:[transition:width_.2s_ease]" aria-label={`${label}: ${safePercent}%`}>
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
  const keepOpen = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
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
          className={`[--ap-bg:#0a0e18] [--ap-panel:#0d1220] [--ap-card:#111827] [--ap-border:#1a2133] [--ap-border-2:#1f2842] [--ap-text:#e6e9f2] [--ap-muted:#8590a8] [--ap-accent:#7b88ff] [--ap-green:#34d399] [border:1px_solid_var(--ap-border-2)] [animation:ap-pop_0.14s_ease-out] [&::before]:[border-left:1px_solid_var(--ap-border-2)] [&::before]:[border-top:1px_solid_var(--ap-border-2)] [&.flipped::before]:[transform:rotate(225deg)] motion-reduce:later:[animation:none] fixed! z-2147483000! [box-sizing:border-box] max-w-[calc(100vw_-_16px)] later:text-[#edf0fa] later:border later:rounded-[10px] later:[box-shadow:0_18px_48px_rgba(0,_0,_0,_.55),_0_3px_12px_rgba(0,_0,_0,_.3)] later:pointer-events-auto [isolation:isolate] [&::before]:[content:''] [&::before]:absolute later:[&::before]:left-[clamp(14px,_var(--arrow-x),_calc(100%_-_14px))] later:[&::before]:-top-[7px] later:[&::before]:w-[12px] later:[&::before]:h-[12px] later:[&::before]:[background:#111624] later:[&::before]:border-l later:[&::before]:border-l-[#343b50] later:[&::before]:border-t later:[&::before]:border-t-[#343b50] later:[&::before]:[transform:translateX(-50%)_rotate(45deg)] later:[&.flipped::before]:top-auto later:[&.flipped::before]:-bottom-[7px] [&.flipped::before]:border-0 [&.flipped::before]:border-r [&.flipped::before]:border-r-[#343b50] [&.flipped::before]:border-b [&.flipped::before]:border-b-[#343b50] ap-progress-popover later-2:p-[13px_14px_12px] later-2:[background:#111827] later-2:border-[#343e55] [&_.ap-status-label.ap-endorsed-label]:text-[15px]! [&_.ap-status-label.ap-endorsed-label]:tracking-[normal] [&_.ap-status-label.ap-endorsed-label]:normal-case max-[721px]:later-3:p-[11px_12px] ${pos.flipped ? ' flipped' : ''}`}
          role="tooltip"
          onMouseEnter={keepOpen}
          onMouseLeave={hide}
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
          ? 'Tick the accomplished items, then click SAVE APPLICANT. Nothing is recorded until you save — closing the form keeps the last saved record.'
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
const PAY_STATUS_TONE = { unpaid: 'text-[#9aa6c4] border-[#3a4256]', partially_paid: 'text-[#8fb4ff] border-[rgba(143,_180,_255,_.45)]', fully_paid: 'text-[#45d991] border-[rgba(69,_217,_145,_.45)]' };
const ENTRY_TONE = { pending: 'text-[#8fb4ff]', verified: 'text-[#45d991]', returned: 'text-[#fbbf24]' };
const peso = (value) => (value === null || value === undefined ? '—' : `₱${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

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

/**
 * Payment Record: records payments that already happened outside the system (no billing).
 * Admin enters the Agreed Package Amount; the assigned Sales user records each payment with
 * its OR/AR number, reference number and receipt; Admin verifies or returns each entry.
 */
function PaymentRecordPanel({ editing, readOnly = false, busy, onSetAmount, onSubmitEntry, onVerify, onReturn, onError }) {
  const record = editing?.payment_record;
  const [amountForm, setAmountForm] = useState(null);
  const [entryForm, setEntryForm] = useState(null);
  const [fileError, setFileError] = useState('');
  const [returning, setReturning] = useState(null);
  const [reason, setReason] = useState('');
  if (!record) return null;
  const maxBytes = (record.receipt_rule?.max_mb || 10) * 1024 * 1024;
  const accept = (record.receipt_rule?.accept || ['pdf', 'jpg', 'jpeg', 'png']).map((ext) => `.${ext}`).join(',');
  const pickReceipt = (file) => {
    setFileError('');
    if (!file) { setEntryForm({ ...entryForm, receipt: null }); return; }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!(record.receipt_rule?.accept || []).includes(ext)) { setFileError('The receipt must be a PDF, JPG or PNG file.'); setEntryForm({ ...entryForm, receipt: null }); return; }
    if (file.size > maxBytes) { setFileError(`The receipt may not be larger than ${record.receipt_rule.max_mb} MB.`); setEntryForm({ ...entryForm, receipt: null }); return; }
    setEntryForm({ ...entryForm, receipt: file });
  };
  const needsReference = entryForm && entryForm.payment_method !== 'cash';
  const entryReady = entryForm && entryForm.payment_date && Number(entryForm.amount) > 0 && entryForm.payment_method && entryForm.or_number.trim()
    && (!needsReference || entryForm.reference_number.trim()) && entryForm.receipt;
  const sendEntry = () => {
    const body = new FormData();
    for (const key of ['payment_date', 'amount', 'payment_method', 'or_number', 'reference_number', 'remarks']) if (String(entryForm[key] || '').trim()) body.append(key, String(entryForm[key]).trim());
    body.append('receipt', entryForm.receipt);
    onSubmitEntry(body);
    setEntryForm(null);
  };
  const changing = record.agreed_amount !== null;
  const amountReady = amountForm && Number(amountForm.agreed_amount) > 0 && (!changing || !record.has_entries || amountForm.reason.trim().length >= 5);

  return (
    <section className="ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] text-[14px] leading-[1.5] text-[#c9d0e0]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">Payment Record</h3>
        <span className={`inline-flex p-[2px_10px] rounded-[999px] border text-[12px] font-[700] ${PAY_STATUS_TONE[record.status] || PAY_STATUS_TONE.unpaid}`}>{record.status_label}</span>
      </div>
      <p className="m-[6px_0_0] text-[#8f9bbd]">Records payments made outside the system. No billing or computation: the status comes only from Verified entries.</p>
      <dl className="grid grid-cols-[minmax(150px,_220px)_minmax(0,_1fr)] gap-[6px_12px] m-[12px_0_0] [&_dt]:text-[#8f9bbd] [&_dd]:m-0">
        <dt>Agreed Package Amount</dt><dd><strong className="text-[#edf0fa]">{peso(record.agreed_amount)}</strong>{record.package_name ? ` · ${record.package_name}` : ''}{record.source ? ` · from ${record.source}` : ''}</dd>
        <dt>Verified</dt><dd>{peso(record.verified_amount)}</dd>
        <dt>Waiting for review</dt><dd>{peso(record.pending_amount)}</dd>
        <dt>Remaining</dt><dd>{peso(record.remaining_amount)}</dd>
        {record.legacy_discount && (
          <><dt>Earlier discount (read-only)</dt><dd>{record.legacy_discount.discount_percent}% off {peso(record.legacy_discount.original_amount)}{record.legacy_discount.promo_name ? ` · ${record.legacy_discount.promo_name}` : ''}</dd></>
        )}
      </dl>
      {record.locked && <p className="m-[8px_0_0] text-[#45d991]">{record.locked}</p>}
      {record.pending_sales_report && <p className="m-[8px_0_0] text-[#fbbf24]">An older Sales Report is still waiting for Admin: apply or return it below before new payments are recorded.</p>}

      {!readOnly && record.can_set_amount && !amountForm && (
        <button type="button" className="mt-3" disabled={busy} onClick={() => setAmountForm({ agreed_amount: record.agreed_amount ?? '', package_name: record.package_name ?? '', source: record.source ?? '', reason: '' })}>
          {changing ? 'Change Agreed Package Amount' : 'Set Agreed Package Amount'}
        </button>
      )}
      {!readOnly && amountForm && (
        <div className="grid gap-[10px] mt-3">
          <Field label="Agreed Package Amount (₱)" required><input type="number" min="1" step="0.01" value={amountForm.agreed_amount} onChange={(e) => setAmountForm({ ...amountForm, agreed_amount: e.target.value })} /></Field>
          <Field label="Package name"><input value={amountForm.package_name} onChange={(e) => setAmountForm({ ...amountForm, package_name: e.target.value })} /></Field>
          <Field label="Taken from" hint="e.g. Signed LOI, Package B price list"><input value={amountForm.source} onChange={(e) => setAmountForm({ ...amountForm, source: e.target.value })} /></Field>
          {changing && record.has_entries && (
            <Field label="Reason for the change (required, at least 5 characters)" required full>
              <textarea rows={2} value={amountForm.reason} onChange={(e) => setAmountForm({ ...amountForm, reason: e.target.value })} />
            </Field>
          )}
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setAmountForm(null)}>Cancel</button>
            <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy || !amountReady} onClick={() => { onSetAmount({ ...amountForm, agreed_amount: Number(amountForm.agreed_amount) }); setAmountForm(null); }}>
              Save amount
            </button>
          </span>
        </div>
      )}

      <div className="table-wrap overflow-x-auto mt-3">
        <table className="w-full text-[14px]">
          <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>OR/AR no.</th><th>Reference no.</th><th>Receipt</th><th>Status</th></tr></thead>
          <tbody>
            {!record.entries.length && <tr><td colSpan={7} className="text-muted">No payments recorded yet.</td></tr>}
            {record.entries.map((p) => (
              <React.Fragment key={p.id}>
                <tr>
                  <td>{formatDate(p.payment_date)}</td>
                  <td>{peso(p.amount)}</td>
                  <td>{p.payment_method_label}</td>
                  <td>{p.or_number || '—'}</td>
                  <td>{p.reference_number || '—'}</td>
                  <td>
                    {p.legacy_no_receipt ? <small className="text-[#fbbf24]">Legacy - no receipt captured</small>
                      : p.receipts === null ? <small className="text-muted">Private</small>
                        : p.receipts.map((doc) => (
                          <button key={doc.id} type="button" disabled={busy} onClick={() => openReceipt(editing.id, p.id, doc).catch((error) => onError(error.message))}>{doc.original_name}</button>
                        ))}
                  </td>
                  <td>
                    <strong className={ENTRY_TONE[p.status] || ''}>{p.status_label}</strong>
                    <small className="block">By {p.recorded_by || '—'}{p.recorded_at ? ` · ${manilaDateTimeLabel(p.recorded_at)}` : ''}</small>
                    {p.verified_by && <small className="block">Verified by {p.verified_by} · {manilaDateTimeLabel(p.verified_at)}</small>}
                    {p.status === 'returned' && <small className="block text-[#fbbf24]">Returned by {p.returned_by}: {p.returned_reason}</small>}
                  </td>
                </tr>
                {!readOnly && p.reviewable && (
                  <tr>
                    <td colSpan={7}>
                      {returning === p.id ? (
                        <span className="grid gap-2">
                          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What Sales must correct (at least 5 characters)" />
                          <span className="flex gap-2">
                            <button type="button" disabled={busy} onClick={() => setReturning(null)}>Cancel</button>
                            <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => { onReturn(p.id, reason.trim()); setReturning(null); }}>Return with reason</button>
                          </span>
                        </span>
                      ) : (
                        <span className="flex gap-2">
                          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[34px] inline-flex items-center justify-center gap-2 p-[0_12px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy} onClick={() => onVerify(p.id)}>Verify</button>
                          <button type="button" disabled={busy} onClick={() => { setReturning(p.id); setReason(''); }}>Return to Sales</button>
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {!readOnly && record.can_add_entry && !entryForm && (
        <button type="button" className="mt-3" disabled={busy} onClick={() => { setFileError(''); setEntryForm({ payment_date: localDateInputValue(), amount: '', payment_method: 'cash', or_number: '', reference_number: '', remarks: '', receipt: null }); }}>
          Add payment entry
        </button>
      )}
      {!readOnly && entryForm && (
        <div className="grid gap-[10px] mt-3">
          <Field label="Date paid" required><input type="date" max={localDateInputValue()} value={entryForm.payment_date} onChange={(e) => setEntryForm({ ...entryForm, payment_date: e.target.value })} /></Field>
          <Field label="Amount (₱)" required><input type="number" min="0.01" step="0.01" value={entryForm.amount} onChange={(e) => setEntryForm({ ...entryForm, amount: e.target.value })} /></Field>
          <Field label="Method" required>
            <select value={entryForm.payment_method} onChange={(e) => setEntryForm({ ...entryForm, payment_method: e.target.value })}>
              {Object.entries(record.methods || {}).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <Field label="OR / AR number" required><input value={entryForm.or_number} onChange={(e) => setEntryForm({ ...entryForm, or_number: e.target.value })} /></Field>
          <Field label={needsReference ? 'Reference number' : 'Reference number (not needed for cash)'} required={needsReference}>
            <input value={entryForm.reference_number} onChange={(e) => setEntryForm({ ...entryForm, reference_number: e.target.value })} />
          </Field>
          <Field label="Receipt" required full hint={`PDF, JPG or PNG, up to ${record.receipt_rule?.max_mb || 10} MB.`}>
            <input type="file" accept={accept} onChange={(e) => pickReceipt(e.target.files?.[0] || null)} />
          </Field>
          {fileError && <p className="m-0 text-[#ff9ca3]" role="alert">{fileError}</p>}
          <Field label="Remarks" full><textarea rows={2} value={entryForm.remarks} onChange={(e) => setEntryForm({ ...entryForm, remarks: e.target.value })} /></Field>
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setEntryForm(null)}>Cancel</button>
            <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy || !entryReady} onClick={sendEntry}>
              Send to Admin
            </button>
          </span>
        </div>
      )}

      {(record.history || []).length > 0 && (
        <details className="mt-3">
          <summary>Payment Record history ({record.history.length})</summary>
          <ul className="m-[6px_0_0] p-[0_0_0_18px] grid gap-1">
            {record.history.map((h) => (
              <li key={h.id}>
                {manilaDateTimeLabel(h.changed_at)} · {h.by_name || 'System'}{h.actor_role ? ` (${titleCase(h.actor_role)})` : ''} · {titleCase(String(h.event || 'stage change').replace(/^payment_/, '').replace(/_/g, ' '))}
                {h.remarks ? ` — ${h.remarks}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const REQUIREMENT_STATUS = {
  pending: { label: 'Pending', tone: 'text-[#9aa6c4] border-[#3a4256]' },
  submitted: { label: 'Submitted', tone: 'text-[#8fb4ff] border-[rgba(143,_180,_255,_.45)]' },
  accepted: { label: 'Accepted', tone: 'text-[#45d991] border-[rgba(69,_217,_145,_.45)]' },
  returned: { label: 'Returned', tone: 'text-[#fbbf24] border-[rgba(251,_191,_36,_.45)]' },
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

function RequirementStatus({ status }) {
  const info = REQUIREMENT_STATUS[status] || REQUIREMENT_STATUS.pending;
  return <span className={`inline-flex p-[2px_10px] rounded-[999px] border text-[12px] font-[700] ${info.tone}`}>{info.label}</span>;
}

/**
 * Requirements of one stage: details + proof files submitted by the assigned Sales user,
 * Accepted or Returned (with a reason) by Admin. The list itself comes from the API config.
 */
function RequirementsPanel({ editing, stage, isAdminRole, isAssignedSales, busy, onSubmit, onAccept, onReturn, onError, readOnly = false }) {
  const [editingKey, setEditingKey] = useState(null);
  const [values, setValues] = useState({});
  const [returningKey, setReturningKey] = useState(null);
  const [reason, setReason] = useState('');
  const req = editing?.requirements;
  if (!req) return null;
  const stageInfo = req.config.stages[stage];
  const defs = req.config.requirements.filter((def) => def.stage === stage);
  const summary = req.summary[stage] || {};
  const itemOf = (key) => req.items.find((item) => item.key === key) || { status: 'pending', data: {} };
  const optionLabel = (field, value) => field.options?.find((o) => o.value === value)?.label || value;
  const startEdit = (def) => {
    const item = itemOf(def.key);
    setEditingKey(def.key);
    setValues(Object.fromEntries(def.fields.map((field) => [field.key, item.data?.[field.key] || ''])));
  };
  const send = (def) => {
    const body = new FormData();
    for (const field of def.fields) if (values[field.key]) body.append(field.key, values[field.key]);
    for (const slot of def.files) for (const file of values[`file:${slot.key}`] || []) body.append(slot.key, file);
    onSubmit(def.key, body);
    setEditingKey(null);
  };
  const accepted = defs.filter((def) => itemOf(def.key).status === 'accepted').length;

  return (
    <section className="ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] text-[14px] leading-[1.5] text-[#c9d0e0]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">{stageInfo?.label} requirements</h3>
        <small className="text-[#9ba5bd]">{accepted} of {defs.length} accepted</small>
      </div>
      {summary.legacy && <p className="m-[8px_0_0] text-[#fbbf24]">Legacy record - requirements not captured.</p>}
      {!summary.legacy && summary.missing?.length > 0 && (
        <p className="m-[8px_0_0] text-muted">{stageInfo?.gate} needs every item Accepted. Missing: {summary.missing.join(', ')}.</p>
      )}
      {!req.files_visible && <p className="m-[8px_0_0] text-muted">Files are visible to Admin and the assigned Sales user only.</p>}
      {!summary.legacy && (
        <ul className="m-[12px_0_0] p-0 [list-style:none] grid gap-[10px]">
          {defs.map((def) => {
            const item = itemOf(def.key);
            const canEdit = !readOnly && isAssignedSales && summary.open && ['pending', 'returned'].includes(item.status);
            const canReview = !readOnly && isAdminRole && item.status === 'submitted';
            return (
              <li key={def.key} className="p-[12px_14px] border border-[#2b344c] rounded-[11px] [background:#0c111d] grid gap-[6px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[#edf0fa]">{def.label}</strong>
                  <RequirementStatus status={item.status} />
                </div>
                <small className="text-[#8f9bbd]">{def.help}</small>
                {item.status === 'pending' && !summary.open && <span className="text-muted">Not started yet</span>}
                {def.fields.some((field) => item.data?.[field.key]) && (
                  <dl className="grid grid-cols-[minmax(140px,_200px)_minmax(0,_1fr)] gap-[4px_12px] m-0 [&_dt]:text-[#8f9bbd] [&_dd]:m-0">
                    {def.fields.map((field) => (item.data?.[field.key] ? (
                      <React.Fragment key={field.key}>
                        <dt>{field.label}</dt>
                        <dd>{field.type === 'date' ? formatDate(item.data[field.key]) : optionLabel(field, item.data[field.key])}</dd>
                      </React.Fragment>
                    ) : null))}
                  </dl>
                )}
                {(item.files || []).length > 0 && (
                  <span className="flex flex-wrap gap-2 items-center">
                    Files:
                    {item.files.map((doc) => (
                      <button key={doc.id} type="button" disabled={busy} onClick={() => openRequirementFile(editing.id, def.key, doc).catch((error) => onError(error.message))}>
                        {doc.original_name}{doc.replaced_at ? ' (Replaced)' : ''}
                      </button>
                    ))}
                  </span>
                )}
                {item.submitted_at && <small>Submitted by {item.submitted_by?.full_name || '—'} on {manilaDateTimeLabel(item.submitted_at)}</small>}
                {item.reviewed_at && item.status !== 'submitted' && (
                  <small>{item.status === 'accepted' ? 'Accepted' : 'Returned'} by {item.reviewed_by?.full_name || '—'} on {manilaDateTimeLabel(item.reviewed_at)}</small>
                )}
                {item.status === 'returned' && <span className="text-[#fbbf24]">Return reason: {item.return_reason}</span>}

                {canEdit && editingKey !== def.key && (
                  <button type="button" className="w-fit" disabled={busy} onClick={() => startEdit(def)}>{item.status === 'returned' ? 'Correct and resubmit' : 'Submit'}</button>
                )}
                {canEdit && editingKey === def.key && (
                  <div className="grid gap-[10px] mt-1">
                    {def.fields.map((field) => (
                      <Field key={field.key} label={field.label} required={field.required} full>
                        {field.type === 'select' ? (
                          <select value={values[field.key] || ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}>
                            <option value="">Choose…</option>
                            {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
                    ))}
                    {def.files.map((slot) => (
                      <Field key={slot.key} label={`${slot.label}${(item.files || []).some((d) => d.type === slot.key && !d.replaced_at) ? ' (leave empty to keep the attached file)' : ''}`} required={slot.required} full>
                        <input
                          type="file"
                          multiple={Boolean(slot.multiple)}
                          accept={slot.accept.split(',').map((ext) => `.${ext}`).join(',')}
                          onChange={(e) => setValues({ ...values, [`file:${slot.key}`]: [...(e.target.files || [])] })}
                        />
                      </Field>
                    ))}
                    <span className="flex gap-2">
                      <button type="button" disabled={busy} onClick={() => setEditingKey(null)}>Cancel</button>
                      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy} onClick={() => send(def)}>
                        Send to Admin
                      </button>
                    </span>
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
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const BRAND_METHOD_LABELS = { in_person: 'In person', call: 'Call', message: 'Message', written: 'Written' };

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
 * reads it here before marking Attended or returning it with a reason.
 */
function ActivitySubmission({ activity, isAdminRole, busy, onAttended, onReturn, onError }) {
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  if (!activity || !activity.completion_submitted_at) {
    if (activity?.completed_before_schedule) {
      return <small className="inline-flex w-fit p-[2px_8px] rounded-[999px] border border-[rgba(251,_191,_36,_0.45)] text-[#fbbf24] text-[11px] font-[700]">Completed before schedule (legacy)</small>;
    }
    return null;
  }
  const proofs = activity.proof_documents || [];
  const reviewLabel = { submitted: 'Waiting for Admin review', returned: 'Returned to Sales', accepted: 'Attended (accepted)' }[activity.review_status] || '';
  const canReview = isAdminRole && activity.review_status === 'submitted';
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
          <span>Actual time: {manilaDateTimeLabel(activity.actual_started_at)} · Handled by {activity.handler_name || '—'}{activity.tasted_brand_name ? ` · Brand tasted: ${activity.tasted_brand_name}` : ''}</span>
          <p className="m-0">Notes: {activity.result_notes}</p>
          <span className="flex flex-wrap gap-2 items-center">
            Proof:
            {proofs.map((doc) => (
              <button key={doc.id} type="button" disabled={busy} onClick={() => openActivityProof(activity.id, doc).catch((error) => onError(error.message))}>
                {doc.original_name}{doc.replaced_at ? ' (Replaced)' : ''}
              </button>
            ))}
          </span>
        </>
      )}
      {activity.review_status === 'returned' && <span className="text-[#fbbf24]">Returned: {activity.return_reason}</span>}
      {activity.reviewed_by?.full_name && activity.review_status !== 'submitted' && <span>Reviewed by {activity.reviewed_by.full_name} on {manilaDateTimeLabel(activity.reviewed_at)}</span>}
      {canReview && !returning && (
        <span className="flex flex-wrap gap-2">
          {activity.status === 'completed' && (
            <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy} onClick={() => onAttended(activity)}>
              Mark Attended
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => { setReturning(true); setReason(''); }}>Return to Sales</button>
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

/**
 * Brand Confirmation (after Product Tasting, before Training): the assigned Sales user submits the
 * final brand; Admin confirms it twice (it then locks) or returns it with a reason.
 */
function BrandConfirmationCard({ editing, brands, isAdminRole, isAssignedSales, busy, onSubmit, onConfirm, onReturn }) {
  const state = editing?.brand_confirmation;
  const [form, setForm] = useState(null);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  if (!state) return null;
  const current = state.current;
  const brandName = (id) => (brands || []).find((b) => Number(b.id) === Number(id))?.name || '—';
  const tastedId = state.tasted_brand_id;
  const startForm = () => setForm({
    final_brand_id: String(tastedId || editing.preferred_brand_id || ''), confirmation_method: 'in_person', confirmed_on: localDateInputValue(), notes: '', change_reason: '',
  });
  const differs = form && Number(form.final_brand_id) !== Number(tastedId);
  const formReady = form && form.final_brand_id && form.notes.trim().length >= 5 && (!differs || form.change_reason.trim().length >= 5);
  return (
    <section className="ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] text-[14px] leading-[1.5] text-[#c9d0e0]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">Brand Confirmation</h3>
        {state.locked && <small className="inline-flex items-center gap-[6px] text-[#45d991]"><FaLock aria-hidden="true" /> Brand locked</small>}
      </div>
      {state.legacy && <p className="m-[8px_0_0] text-[#fbbf24]">Legacy - brand confirmation not captured. The brand ({editing.preferred_brand?.name || brandName(editing.preferred_brand_id)}) is locked.</p>}
      {state.confirmed && (
        <p className="m-[8px_0_0]"><FaLock aria-hidden="true" /> <strong>{editing.preferred_brand?.name || brandName(editing.preferred_brand_id)}</strong> — confirmed by {state.locked_by || 'Admin'} on {manilaDateTimeLabel(state.locked_at)}.</p>
      )}
      {current && !state.confirmed && (
        <dl className="grid grid-cols-[170px_minmax(0,_1fr)] gap-[6px_12px] m-[10px_0_0] [&_dt]:text-[#8f9bbd] [&_dd]:m-0">
          <dt>Status</dt><dd>{{ submitted: 'Waiting for Admin', returned: 'Returned to Sales', confirmed: 'Confirmed' }[current.status]}</dd>
          <dt>Final brand</dt><dd>{current.final_brand?.name || brandName(current.final_brand_id)}</dd>
          <dt>Brand tasted</dt><dd>{current.tasted_brand?.name || brandName(current.tasted_brand_id)}</dd>
          <dt>Confirmed by applicant</dt><dd>{BRAND_METHOD_LABELS[current.confirmation_method]} on {formatDate(current.confirmed_on)}</dd>
          <dt>Notes</dt><dd>{current.notes}</dd>
          {current.change_reason && <><dt>Reason for the change</dt><dd>{current.change_reason}</dd></>}
          <dt>Submitted by</dt><dd>{current.submitted_by?.full_name || '—'} · {manilaDateTimeLabel(current.submitted_at)}</dd>
          {current.status === 'returned' && <><dt>Return reason</dt><dd className="text-[#fbbf24]">{current.return_reason}</dd></>}
        </dl>
      )}
      {state.retasting_required && (
        <p className="m-[8px_0_0] text-[#fbbf24]">
          {state.retasting_done
            ? 'The new brand was tasted: Admin can confirm it now.'
            : 'The final brand differs from the tasted one: Product Tasting must be done again for it (use Set Again) before Admin can confirm.'}
        </p>
      )}
      {!state.locked && state.blocked_reason && !current && <p className="m-[8px_0_0] text-muted">{state.blocked_reason}</p>}

      {isAssignedSales && state.can_submit && !form && (
        <button type="button" className="mt-3" disabled={busy} onClick={startForm}>{current?.status === 'returned' ? 'Correct and resubmit' : 'Submit final brand'}</button>
      )}
      {isAssignedSales && form && (
        <div className="grid gap-[10px] mt-3">
          <Field label="Final brand" required full>
            <select value={form.final_brand_id} onChange={(e) => setForm({ ...form, final_brand_id: e.target.value })}>
              {(brands || []).map((b) => <option key={b.id} value={b.id}>{b.name}{Number(b.id) === Number(tastedId) ? ' (tasted)' : ''}</option>)}
            </select>
          </Field>
          <Field label="How the applicant confirmed" required>
            <select value={form.confirmation_method} onChange={(e) => setForm({ ...form, confirmation_method: e.target.value })}>
              {Object.entries(BRAND_METHOD_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <Field label="Date confirmed" required>
            <input type="date" max={localDateInputValue()} value={form.confirmed_on} onChange={(e) => setForm({ ...form, confirmed_on: e.target.value })} />
          </Field>
          <Field label="Notes (required)" required full>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What the applicant said and how it was confirmed" />
          </Field>
          {differs && (
            <Field label="Reason for a brand other than the tasted one (required)" required full>
              <textarea rows={2} value={form.change_reason} onChange={(e) => setForm({ ...form, change_reason: e.target.value })} placeholder="Product Tasting will be done again for the new brand." />
            </Field>
          )}
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
            <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy || !formReady} onClick={() => { onSubmit({ ...form, final_brand_id: Number(form.final_brand_id) }); setForm(null); }}>
              Send to Admin
            </button>
          </span>
        </div>
      )}
      {isAdminRole && current?.status === 'submitted' && !state.confirmed && !returning && (
        <span className="flex flex-wrap gap-2 mt-3">
          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[38px] inline-flex items-center justify-center gap-2 p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]" disabled={busy || (state.retasting_required && !state.retasting_done)} title={state.retasting_required && !state.retasting_done ? 'Product Tasting must be done again for the new brand first.' : ''} onClick={() => onConfirm(current)}>
            Confirm Brand
          </button>
          <button type="button" disabled={busy} onClick={() => { setReturning(true); setReason(''); }}>Return to Sales</button>
        </span>
      )}
      {isAdminRole && returning && (
        <span className="grid gap-2 mt-3">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What Sales must correct (at least 5 characters)" />
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setReturning(false)}>Cancel</button>
            <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => { onReturn(reason.trim()); setReturning(false); }}>Return with reason</button>
          </span>
        </span>
      )}
      {(state.history || []).length > 1 && (
        <details className="mt-3">
          <summary>Earlier submissions ({state.history.length - 1})</summary>
          <ul className="m-[6px_0_0] p-[0_0_0_18px]">
            {state.history.slice(0, -1).map((row) => (
              <li key={row.id}>{row.final_brand?.name || brandName(row.final_brand_id)} · {row.status} · {manilaDateTimeLabel(row.submitted_at)}{row.return_reason ? ` · Returned: ${row.return_reason}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ScheduleSection({
  editing, draft, isAdminRole, sectionRef, onPickChecked, onOpenCalendar, onView,
  busy = false, onAttended = null, onReturn = null, onError = () => {},
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
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] ap-schedule-section [&.is-locked]:opacity-[.92] [&.is-locked_h3]:inline-flex [&.is-locked_h3]:items-center [&.is-locked_h3]:gap-2" ref={sectionRef}>
      <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
        <h3>Schedule activity</h3>
        <small>{doneCount} of {TRACKED_ACTIVITIES.length} done</small>
      </div>
      <ul className="[.ap-schedule-section_&]:[list-style:none] [.ap-schedule-section_&]:m-[12px_0_0] [.ap-schedule-section_&]:p-0 [.ap-schedule-section_&]:flex [.ap-schedule-section_&]:flex-col [.ap-schedule-section_&]:gap-[10px]">
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
          return (
            <li key={tracked.type} className="ap-activity-row flex items-center gap-3 flex-wrap p-[10px_12px] border border-[color:var(--border,_#262b36)] rounded-[12px] [background:color-mix(in_srgb,_var(--panel,_#12151c)_92%,_transparent)]" data-activity-type={tracked.type}>
              <span className={`p-[4px_10px] rounded-[999px] text-[10px] font-[800] tracking-[0.04em] uppercase border border-transparent whitespace-nowrap later-5:[&.is-not\_scheduled]:text-[color:var(--muted,_#8b93a5)] [&.is-not\_scheduled]:[background:color-mix(in_srgb,_var(--muted,_#8b93a5)_14%,_transparent)] [&.is-not\_scheduled]:border-[color:color-mix(in_srgb,_var(--muted,_#8b93a5)_35%,_transparent)] later-6:[&.is-pending\_admin]:text-[#ffc857] later:[&.is-pending\_admin]:[background:color-mix(in_srgb,_#ffc857_12%,_transparent)] later:[&.is-pending\_admin]:border-[color:color-mix(in_srgb,_#ffc857_45%,_transparent)] later-7:[&.is-scheduled]:text-[#4cc9ff] later-2:[&.is-scheduled]:[background:color-mix(in_srgb,_#4cc9ff_12%,_transparent)] later-2:[&.is-scheduled]:border-[color:color-mix(in_srgb,_#4cc9ff_45%,_transparent)] later-8:[&.is-completed]:text-[#7ddfff] later-3:[&.is-completed]:[background:color-mix(in_srgb,_#4cc9ff_18%,_transparent)] later-3:[&.is-completed]:border-[color:color-mix(in_srgb,_#4cc9ff_55%,_transparent)] later-9:[&.is-attended]:text-[#39ffb0] later-4:[&.is-attended]:[background:color-mix(in_srgb,_#39ffb0_14%,_transparent)] later-4:[&.is-attended]:border-[color:color-mix(in_srgb,_#39ffb0_50%,_transparent)] [&.is-attended]:[box-shadow:0_0_10px_color-mix(in_srgb,_#39ffb0_25%,_transparent)] later-10:[&.is-overdue]:text-[#ffb454] later-5:[&.is-overdue]:[background:color-mix(in_srgb,_#ffb454_12%,_transparent)] later-5:[&.is-overdue]:border-[color:color-mix(in_srgb,_#ffb454_45%,_transparent)] [.ap-schedule-section.is-locked_&]:opacity-[.75] is-${overdue ? 'overdue' : state}`}>{overdue ? 'Overdue' : (STATE_LABELS[state] || state)}</span>
              <span className="flex flex-col gap-[2px] min-w-[150px] flex-1 later-2:[&_small]:text-[color:var(--muted,_#8b93a5)] later:[&_small]:text-[11px]">
                <strong>{tracked.label}</strong>
                {info.active && info.starts_at && <small>{fmtDateTime(info.starts_at)}{overdue ? ' · missed' : ''}</small>}
                {info.completed && !saved && <small>Sales marked Complete — waiting for Attended</small>}
                {saved && info.completed_at && <small>Sales completed {fmtDateTime(info.completed_at)}</small>}
                {checked && (
                  <small>
                    Date marked {fmtDateTime(draft.details[tracked.key]?.on)} · Marked by {draft.details[tracked.key]?.by || '—'}
                  </small>
                )}
              </span>
              {state !== 'not_scheduled' && (onOpenCalendar || onView) && (
                <span className="ap-activity-links inline-flex gap-[6px] ml-auto flex-wrap">
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
                  className={`ap-check [border:1px_solid_var(--ap-border-2)] flex items-center later:gap-[10px] min-w-0 later:p-[11px_12px] later:border later:border-[#303749] later:rounded-[11px] later:[background:#191f2e] later:text-[#d4daea] text-left later:[font-family:inherit] later:[font-weight:inherit] [font-style:inherit] later:leading-[1.4] cursor-pointer later:[transition:background_.16s_ease,_border-color_.16s_ease] later-2:hover:border-[#6258c9] later:hover:[background:#1d2335] later-3:[&.checked]:border-[rgba(37,_199,_122,_.45)] later-2:[&.checked]:[background:rgba(37,_199,_122,_.07)] [#update-applicant-form_&]:gap-2 [#update-applicant-form_&]:p-[9px_10px] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&:hover]:[background:#202a40] [&.read-only]:cursor-default [&.read-only:hover]:[background:transparent] [&.read-only:hover]:border-[rgba(226,_232,_255,_.085)] later:[#update-applicant-form_&]:border-[#252e40] later:[#update-applicant-form_&]:rounded-[7px] later:[#update-applicant-form_&]:[background:#141b29] later-2:text-[12px] disabled:cursor-not-allowed disabled:opacity-[.55] [&.is-locked]:cursor-not-allowed later:[&.is-locked]:opacity-[.8] [.ap-activity-row_.ap-activity-links+&]:ml-0 ${checked ? ' checked [&.checklist-item]:border-[color:color-mix(in_srgb,_var(--success)_32%,_transparent)] [&.checklist-item]:[background:color-mix(in_srgb,_var(--success)_7%,_transparent)] [&.checklist-item_.checklist-box]:[background:var(--success)] [&.checklist-item_.checklist-box]:border-success [&.checklist-item_.checklist-box]:text-[#04120c] [&.checklist-item_.checklist-copy_strong]:text-text' : ''}${saved ? ' is-locked' : ''}`}
                  disabled={!canMark}
                  title={saved
                    ? 'Attended is saved and locked.'
                    : canMark
                      ? 'Mark Attended, then Save Applicant to record it.'
                      : 'Sales must mark this activity Complete first.'}
                  onClick={() => onPickChecked(tracked, info)}
                >
                  <span className="place-items-center [border:1px_solid_var(--ap-border-2)] [&_svg]:m-0 later:inline-flex later:flex-[0_0_17px] later:w-[17px] later:h-[17px] items-center justify-center later:border later:border-[#4a5268] rounded-[5px] later:text-[#071a12] later:[background:#0d1220] later:text-[10px] later:[.ap-check.checked_&]:border-[#25c77a] later:[.ap-check.checked_&]:[background:#25c77a]" aria-hidden="true">{checked && <FaCheck />}</span>
                  Attended
                </button>
              )}
              {onAttended && (
                <ActivitySubmission activity={latest} isAdminRole={isAdminRole} busy={busy} onAttended={onAttended} onReturn={onReturn} onError={onError} />
              )}
            </li>
          );
        })}
      </ul>
      {isAdminRole && (
        <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">
          {doneCount === TRACKED_ACTIVITIES.length
            ? 'All three activities are Done — Scheduled is checked.'
            : 'Attended is recorded only when you click Save Applicant.'}
        </p>
      )}
    </section>
  );
}

/**
 * A finished stage section, shown under the current work and collapsed by
 * default (show/hide). The content is the same section, read-only by stage.
 */
/**
 * The saved discount snapshot (Phase 4): original price, discount %, promo
 * name, final total, who set it and when. Display only — the numbers come
 * from the saved record, so a later promo change never rewrites them.
 */
function DiscountSnapshot({ original, percent, promo, final, setBy, setAt, compact = false }) {
  if (final == null) return null;
  const pct = Number(percent) || 0;
  return (
    <dl className={`grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[6px_14px] m-[10px_0_0] p-[10px_12px] border border-[#273044] rounded-[10px] [background:#0d1320] [&_div]:min-w-0 later-5:[&_dt]:text-[#8f9bb8] later-4:[&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.04em] later:[&_dd]:m-[2px_0_0] later-3:[&_dd]:text-[#e4e8f4] later-3:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&.is-compact]:grid-cols-[repeat(6,_minmax(0,_1fr))] [&.is-compact]:m-[10px_0] max-[821px]:later:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[821px]:later:[&.is-compact]:grid-cols-[repeat(2,_minmax(0,_1fr))] max-w-full ${compact ? ' is-compact' : ''}`}>
      <div><dt>Original price</dt><dd>{moneyExact(original ?? final)}</dd></div>
      <div><dt>Discount</dt><dd>{pct > 0 ? `${pct}%` : 'None'}</dd></div>
      <div><dt>Promo</dt><dd>{promo || '—'}</dd></div>
      <div><dt>Final total</dt><dd><strong>{moneyExact(final)}</strong></dd></div>
      <div><dt>Set by</dt><dd>{setBy || '—'}</dd></div>
      <div><dt>Date</dt><dd>{setAt ? formatDate(setAt) : '—'}</dd></div>
    </dl>
  );
}

/**
 * Installment plan read-out (Admin + Sales) and Admin's plan form
 * (frequency + first due date, only after the downpayment is saved).
 * Saved payments only count; the pending amount is shown on its own line.
 */
function InstallmentPlanPanel({ installment, pendingAmount, canSetSchedule, busy, onSave }) {
  const [form, setForm] = useState(null);
  if (!installment) return null;
  const editing = Boolean(form);
  const frequency = form?.frequency ?? installment.frequency ?? installment.default_frequency ?? 'monthly';
  const open = () => setForm({
    frequency: installment.frequency || installment.default_frequency || 'monthly',
    custom_days: String(installment.custom_days || installment.custom_days_default || 30),
    first_due_date: installment.first_due_date || '',
  });
  const formIssue = !form ? ''
    : !form.first_due_date ? 'Pick the first due date.'
      : form.frequency === 'custom' && !(Number(form.custom_days) >= 1 && Number(form.custom_days) <= 365) ? 'Enter 1–365 days.'
        : '';

  return (
    <section className="p-[12px_14px] border border-[#273044] rounded-[11px] [background:#0d1320] [&_.pay-muted-line]:m-[10px_0_0] [&_.pay-muted-line]:text-[#8f9bb8] max-w-full" aria-labelledby="ap-pay-plan-title">
      <div className="flex items-center gap-[10px] mb-2 later-2:[&_h4]:m-0 later:[&_h4]:text-[#edf0fa] later-2:[&_h4]:text-[14px] [&_.pay-mini-btn]:ml-auto">
        <h4 id="ap-pay-plan-title">Installment plan</h4>
        {installment.overdue && <span className="[justify-self:start] p-[1px_8px] rounded-[999px] text-[10px] font-[700] pay-badge-overdue">Overdue</span>}
        {canSetSchedule && !editing && (
          <button type="button" className="pay-mini-btn later:[justify-self:start] p-[2px_10px] border border-[#3b4767] rounded-[7px] [background:transparent] text-[#c9d1e6] text-[10px] font-[700] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:border-[#8175ff] hover:[background:rgba(129,_117,_255,_.1)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px]" onClick={open}>
            <FaPen aria-hidden="true" /> {installment.frequency ? 'Edit plan' : 'Set plan'}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,_minmax(190px,_1fr))] gap-[8px_16px] m-0 later-5:[&_dt]:text-[#8f9bb8] later-4:[&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[.04em] later:[&_dd]:m-[2px_0_0] later-3:[&_dd]:text-[#e4e8f4] later-4:[&_dd]:text-[13.5px] later:[&_dd_small]:text-[#8f9bb8] [&_dd_small]:text-[11.5px] [&_dd.is-overdue]:text-[#fda4af] [&_dd.is-overdue]:font-[700]">
        <div><dt>Minimum downpayment</dt><dd>{moneyExact(installment.min_downpayment_amount)} <small>({installment.min_downpayment_percent}% of the final total)</small></dd></div>
        <div><dt>Saved downpayment</dt><dd>{installment.has_downpayment ? moneyExact(installment.downpayment_amount) : 'Not yet'}{installment.downpayment_is_legacy ? <small> (first saved payment)</small> : null}</dd></div>
        <div><dt>Minimum installment</dt><dd>{installment.minimum_installment != null ? <>{moneyExact(installment.minimum_installment)} <small>({installment.installment_minimum_percent_of_downpayment}% of the downpayment, fixed)</small></> : '—'}</dd></div>
        <div><dt>Next minimum</dt><dd>{installment.next_minimum != null ? moneyExact(installment.next_minimum) : '—'}</dd></div>
        <div><dt>Remaining balance</dt><dd>{moneyExact(installment.remaining_balance)} <small>(saved payments)</small></dd></div>
        <div><dt>Pending (not counted)</dt><dd>{moneyExact(pendingAmount || 0)}</dd></div>
        <div><dt>Frequency</dt><dd>{installment.frequency_label ? `${installment.frequency_label}${installment.frequency === 'custom' && installment.custom_days ? ` · every ${installment.custom_days} days` : ''}` : 'Not set'}</dd></div>
        <div><dt>Next due date</dt><dd className={installment.overdue ? 'is-overdue' : ''}>{installment.next_due_date ? formatDate(installment.next_due_date) : '—'}</dd></div>
        <div><dt>Estimated payments left</dt><dd>{installment.estimated_payments || '—'}</dd></div>
        <div><dt>Estimated last due date</dt><dd>{installment.estimated_last_due_date ? formatDate(installment.estimated_last_due_date) : '—'}</dd></div>
      </dl>
      {!installment.has_downpayment && (
        <p className="pay-muted-line flex-none text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">The plan is set by Admin after the downpayment is saved.</p>
      )}
      {editing && (
        <div className="flex flex-wrap items-end gap-[10px_14px] mt-3 pt-3 border-t border-t-[#273044] [&_label]:grid later:[&_label]:gap-1 later-2:[&_label]:text-[#c3cbe0] later-3:[&_label]:text-[12.5px] later:[&_input]:min-w-[160px] later-6:[&_input]:p-[7px_10px] later-4:[&_input]:border later-5:[&_input]:border-[#2f3a52] later-3:[&_input]:rounded-[8px] later-5:[&_input]:[background:#111827] later-5:[&_input]:text-[#e4e8f4] [&_input]:[color-scheme:dark] later:[&_select]:min-w-[160px] later-3:[&_select]:p-[7px_10px] later-2:[&_select]:border later-2:[&_select]:border-[#2f3a52] later-2:[&_select]:rounded-[8px] later-3:[&_select]:[background:#111827] later-2:[&_select]:text-[#e4e8f4] [&_select]:[color-scheme:dark]">
          <label>
            Frequency
            <select value={frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              {(installment.frequency_options || []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {frequency === 'custom' && (
            <label>
              Every (days)
              <input
                type="text"
                inputMode="numeric"
                value={form.custom_days}
                onChange={(e) => setForm({ ...form, custom_days: e.target.value.replace(/[^\d]/g, '').slice(0, 3) })}
              />
            </label>
          )}
          <label>
            First due date
            <input type="date" value={form.first_due_date} onChange={(e) => setForm({ ...form, first_due_date: e.target.value })} />
          </label>
          <div className="flex gap-2 ml-auto">
            <button type="button" className="pay-mini-btn later:[justify-self:start] p-[2px_10px] border border-[#3b4767] rounded-[7px] [background:transparent] text-[#c9d1e6] text-[10px] font-[700] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:border-[#8175ff] hover:[background:rgba(129,_117,_255,_.1)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px]" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
            <button
              type="button"
              className="pay-mini-btn later:[justify-self:start] border border-[#3b4767] rounded-[7px] [background:transparent] text-[#c9d1e6] text-[10px] font-[700] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:border-[#8175ff] hover:[background:rgba(129,_117,_255,_.1)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px] later:p-[5px_16px] max-[641px]:w-full"
              disabled={busy || Boolean(formIssue)}
              title={formIssue || undefined}
              onClick={async () => {
                const ok = await onSave({
                  frequency: form.frequency,
                  custom_days: form.frequency === 'custom' ? Number(form.custom_days) : null,
                  first_due_date: form.first_due_date,
                });
                if (ok) setForm(null);
              }}
            >
              {busy ? 'Saving…' : 'Save plan'}
            </button>
          </div>
          {formIssue && <small className="text-[#ff9ca3] leading-[1.35] later:text-[12px]">{formIssue}</small>}
        </div>
      )}
      <p className="pay-muted-line flex-none text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">Paying more than the minimum lowers the balance and moves the due date to the next period. Overdue is a reminder only — no penalty or interest.</p>
    </section>
  );
}

function DoneSection({ title, summary, children, tone = 'done', defaultOpen = false }) {
  return (
    <details className={`ap-done-section border border-[#293246] rounded-[12px] [background:#121827] [&>summary]:flex [&>summary]:items-center [&>summary]:gap-[10px] [&>summary]:p-[12px_14px] [&>summary]:cursor-pointer [&>summary]:[list-style:none] [&>summary]:text-[#e4e8f4] later:[&>summary]:text-[13px] [&>summary]:font-[700] [&>summary::-webkit-details-marker]:hidden [&>summary:focus-visible]:[outline:2px_solid_#6d8cff] [&>summary:focus-visible]:[outline-offset:2px] [&>summary:focus-visible]:rounded-[12px] [&>summary_small]:text-[#9ba5bd] [&>summary_small]:font-[500] [&.is-pending]:border-[rgba(245,_158,_11,_.45)] is-${tone}`} open={defaultOpen || undefined}>
      <summary>
        <span className="inline-flex items-center gap-2 later-4:[&_svg]:text-[#4ade80] [.ap-done-section.is-pending_&_svg]:text-[#fbbf24]">
          {tone === 'pending' ? <FaClock aria-hidden="true" /> : <FaCheck aria-hidden="true" />} {title}
        </span>
        {summary && <small>{summary}</small>}
        <span className="ml-auto text-[#9ba5bd] text-[12px] font-[600] [&::after]:[content:'Show'] [.ap-done-section[open]_&::after]:[content:'Hide']" aria-hidden="true" />
      </summary>
      <div className="p-[0_10px_10px] [&_.ap-section]:mb-0">{children}</div>
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
    <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] ap-schedule-section [&.is-locked]:opacity-[.92] [&.is-locked_h3]:inline-flex [&.is-locked_h3]:items-center [&.is-locked_h3]:gap-2 is-locked">
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
  if (sales?.full_name) return <small className="block mt-1 text-[#9aa6c4]">{prefix}: {sales.full_name}</small>;
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
        <span className="text-[#9aa6c4] text-[10.5px] tracking-[.05em] uppercase [&_em]:text-[#7d879e] [&_em]:not-italic [&_em]:tracking-[0] [&_em]:normal-case">LOI document <em>(optional)</em></span>
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
        <span className="text-[#7d879e] text-[10px] leading-[1.4]">PDF, JPG, JPEG or PNG · saved with the applicant record.</span>
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
      <span className="text-[#9aa6c4] text-[10.5px] tracking-[.05em] uppercase [&_em]:text-[#7d879e] [&_em]:not-italic [&_em]:tracking-[0] [&_em]:normal-case">LOI document <em>(optional)</em></span>
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
          {!interactive ? 'Recorded submission'
            : LOI_SOFT_TYPES.includes(draft.submission_type)
              ? 'Soft copy: the image is required for Complete.'
              : 'Hard copy: the image is optional.'}
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
  const summary = applicant.payment_summary || {};

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
            <li><span>Package</span><strong>{summary.package_name || '—'}</strong></li>
            <li><span>Total required</span><strong>{money(summary.total_required_amount)}</strong></li>
            <li><span>Verified</span><strong className="text-[#34d399]! font-[600]">{money(summary.verified_amount)}</strong></li>
            <li><span>Balance</span><strong className="text-[#fbbf24]! font-[600]">{money(summary.remaining_balance)}</strong></li>
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
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  // Blue dots cleared in this session (the server clears them on mark-seen).
  const [seenActivityDots, setSeenActivityDots] = useState(() => new Set());
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(null);
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
  // Payment Record stage: inline payment entry form, inline Total required
  // editor, and the Admin "Return to Sales" note dialog.
  // ADD PAYMENT only appends to `paymentDrafts` — it never calls the API.
  // Save New Record turns the drafts into one pending Sales Report.
  const [paymentEntry, setPaymentEntry] = useState(null);
  const [paymentDrafts, setPaymentDrafts] = useState([]);
  // Admin's local Confirm Payment state: preview of the pending Sales Report.
  // It is persisted only by SAVE APPLICANT; closing the modal drops it.
  const [reportPreview, setReportPreview] = useState(false);
  // Admin's Total required edit mode. The card value saves with its own Save
  // button; `paymentTotal` holds the ORIGINAL amount (before the discount).
  const [paymentTotal, setPaymentTotal] = useState('');
  const [discountChoice, setDiscountChoice] = useState('');
  const [customDiscount, setCustomDiscount] = useState('');
  // Discount snapshot: optional promo name saved with the total (Phase 4).
  const [promoName, setPromoName] = useState('');
  const [savingTotal, setSavingTotal] = useState(false);
  const [totalEditError, setTotalEditError] = useState('');
  const [returnForm, setReturnForm] = useState(null);
  // UI-only presentation state for the redesigned Payment Record panel:
  // Admin's inline Total-required edit and the collapsed Sales Report card.
  // No behavior, handler or API call depends on them.
  const [totalEditing, setTotalEditing] = useState(false);
  const [reportExpanded, setReportExpanded] = useState(false);
  const [activateForm, setActivateForm] = useState(null);
  const [acting, setActing] = useState(false);
  const scheduleRef = useRef(null);
  // The payment Amount input, used to restore the caret after re-grouping.
  const entryAmountRef = useRef(null);

  // The signed-in user, used for "Marked by". The backend names users with `full_name`.
  const authName = String(user?.full_name || user?.name || user?.email || '').trim();
  const authLabel = authName ? `${authName}${role ? ` (${titleCase(role)})` : ''}` : '';
  // "Received by" is the signed-in Sales user; the role label shows when the
  // name is unavailable. The server re-derives both ids from the session.
  const receivedByLabel = authName ? `Received by ${authName} (Sales)` : 'Received by Sales';

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
          status,
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
      const base = detail ? { search, folder: detailFolder, status, ...filterParams } : { search, status, ...filterParams, ...(tab === 'archived' ? { archived: 1 } : {}) };
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

  const closeEditor = () => {
    setEditing(null);
    setDraft(null);
    setMark(null);
    setPaymentEntry(null);
    setPaymentDrafts([]);
    setReportPreview(false);
    setPaymentTotal('');
    setDiscountChoice('');
    setCustomDiscount('');
    setPromoName('');
    setTotalEditError('');
    setReturnForm(null);
    setTotalEditing(false);
    setReportExpanded(false);
    setLoiDraft(null);
    setApproveForm(null);
    setReviseForm(null);
    setRejectForm(null);
    setQualifiedConfirm(false);
  };

  const loadApplicant = async (id) => {
    setActionError('');
    setSuccess('');
    // A freshly opened applicant starts with the schedule section hidden again:
    // it is only revealed by "Set Schedule" (or stays visible from the stage on).
    setScheduleRevealed(false);
    setApproveForm(null);
    setReviseForm(null);
    setRejectForm(null);
    setQualifiedConfirm(false);
    try {
      const detail = await api.get(`/applicants/${id}`);
      setEditing(detail.data);
      // Opening the record counts as reading it: the signed-in user's red dot
      // for this applicant is cleared in the database, then the sidebar/header
      // dots refresh immediately. Failures never block the modal.
      void api.post('/notifications/mark-seen', { record_type: 'applicant', record_id: id })
        .then(() => window.dispatchEvent(new Event('herald:notifications-updated')))
        .catch(() => {});
      setPaymentEntry(null);
      setPaymentDrafts([]);
      setReportPreview(false);
      // Edit mode always starts from the ORIGINAL amount and the saved
      // discount, so a reopened editor never shows a discounted value as if it
      // were the amount the Admin typed.
      setPaymentTotal(
        Number(detail.data.payment_stage?.original_total_required_amount)
          ? String(detail.data.payment_stage.original_total_required_amount)
          : (Number(detail.data.payment_stage?.total_required_amount)
            ? String(detail.data.payment_stage.total_required_amount)
            : ''),
      );
      const savedDiscount = Number(detail.data.payment_stage?.discount_percent) || 0;
      setPromoName(detail.data.payment_stage?.promo_name || '');
      if (savedDiscount <= 0) {
        setDiscountChoice('');
        setCustomDiscount('');
      } else if (DISCOUNT_PRESETS.includes(savedDiscount)) {
        setDiscountChoice(String(savedDiscount));
        setCustomDiscount('');
      } else {
        setDiscountChoice('custom');
        setCustomDiscount(String(savedDiscount));
      }
      setTotalEditError('');
      setReturnForm(null);
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
      setDraft({
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
      });
    } catch (error) {
      setActionError(firstValidationMessage(error));
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

      // Admin previewed a Sales Report with Confirm Payment: THIS is the save
      // that turns it into applicant payment rows. Without this click the
      // request stays pending and the record is untouched.
      if (isAdminRole && reportPreview && editing.payment_stage?.sales_report?.id) {
        await api.post(`/applicants/${editing.id}/payments/apply-report`, {});
      }

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
  const setAgreedAmount = (form) => runRequest(() => api.patch(`/applicants/${editing.id}/payment-plan`, form), 'Agreed Package Amount saved.');
  const submitPaymentEntry = (body) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries`, body), 'Payment recorded — waiting for Admin to verify it.');
  const verifyPaymentEntry = (id) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries/${id}/verify`, {}), 'Payment verified.');
  const returnPaymentEntry = (id, reason) => runRequest(() => api.post(`/applicants/${editing.id}/payment-entries/${id}/return`, { reason }), 'Payment returned to Sales.');
  const logApplicantFollowUp = (body) => runRequest(() => api.post(`/applicants/${editing.id}/follow-ups`, body), 'Follow-up logged.');
  const submitRequirement = (key, body) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}`, body), 'Sent to Admin for review.');
  const acceptRequirement = (key) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}/accept`, {}), 'Requirement accepted.');
  const returnRequirement = (key, reason) => runRequest(() => api.post(`/applicants/${editing.id}/requirements/${key}/return`, { reason }), 'Requirement returned to Sales.');
  const [loiReturn, setLoiReturn] = useState(null);
  const returnLoi = (reason) => runRequest(async () => { const result = await api.post(`/applicants/${editing.id}/loi/return`, { reason }); setLoiReturn(null); return result; }, 'LOI returned to Sales.');
  const markActivityAttended = (activity) => runRequest(() => api.post(`/activities/${activity.id}/attended`, {}), 'Marked Attended.');
  const returnActivity = (activity, reason) => runRequest(() => api.post(`/activities/${activity.id}/return`, { reason }), 'Returned to Sales.');
  const submitBrand = (form) => runRequest(() => api.post(`/applicants/${editing.id}/brand-confirmation`, form), 'Brand Confirmation sent to Admin.');
  const returnBrand = (reason) => runRequest(() => api.post(`/applicants/${editing.id}/brand-confirmation/return`, { reason }), 'Brand Confirmation returned to Sales.');
  // Confirm Brand asks twice: the second dialog names the brand and the applicant.
  const [brandConfirmDialog, setBrandConfirmDialog] = useState(null);
  const confirmBrand = async () => {
    setBrandConfirmDialog(null);
    await runRequest(() => api.post(`/applicants/${editing.id}/brand-confirmation/confirm`, { confirmed: true }), 'Brand confirmed and locked.');
  };

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
          setSuccess('Applicant moved to Scheduling — Schedule Activity is unlocked. Set Orientation, Product Tasting and Training one at a time.');
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
  // Phase 3 rules (the API enforces the same):
  //  - [Complete]: Verified + submission date; a soft copy (Soft copy / Email)
  //    also needs its uploaded image. Hard copy: the image is optional.
  //  - [Proceed]: soft copy only, type + date — image/verification may follow.
  //    The LOI becomes Pending and the applicant moves to Payment Record.
  //  - Uploading never completes the LOI.
  const loiIsSoft = LOI_SOFT_TYPES.includes(loiDraft?.submission_type);
  const loiSavedDocument = currentLoiDocument(editing?.documents);
  const loiHasImage = Boolean(loiDraft?.file) || Boolean(loiSavedDocument && !loiDraft?.removeDocument);
  const loiDateOk = Boolean(loiDraft?.submission_date) && loiDraft.submission_date <= localDateInputValue();
  const loiPending = editing?.loi_status === 'pending';
  const loiCompleteIssue = !loiDraft ? 'Loading the LOI record…'
    : !loiDateOk ? 'Set the submission date (not in the future).'
      : loiDraft.verification_status !== 'verified' ? 'Mark the LOI as Verified.'
        : loiIsSoft && !loiHasImage ? 'A soft copy needs its uploaded image before [Complete].'
          : '';
  const loiProceedIssue = !loiIsSoft ? 'A hard copy has no [Proceed] — finish it with [Complete].'
    : !loiDateOk ? 'Set the submission date (not in the future).'
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
    if (kind === 'proceed' && loiProceedIssue) return;
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
      } else if (kind === 'proceed') {
        await api.post(`/applicants/${editing.id}/loi/proceed`, {});
        setSuccess('Moved to Payment Record with the LOI PENDING. Come back to the LOI section to upload the image, verify it and click Complete — For Approval stays blocked until then.');
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
        {isAdminRole && draft?.status === 'loi_submitted' && loiIsSoft && (
          <button
            type="button"
            disabled={acting || Boolean(loiProceedIssue)}
            title={loiProceedIssue || 'Move to Payment Record now; the LOI stays Pending.'}
            onClick={() => void runLoiAction('proceed')}
          >
            Proceed
          </button>
        )}
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
      {isAdminRole && draft?.status === 'loi_submitted' && loiIsSoft && !loiReady && !loiProceedIssue && (
        <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0">
          [Proceed] moves to Payment Record with the LOI <strong>Pending</strong> — you must come back here to upload the image, verify it and Complete it.
        </p>
      )}
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
  const openActivateForm = () => {
    const existing = editing?.franchisee;
    const location = existing?.locations?.[0];
    setActivateForm({
      business_name: existing?.business_name || editing?.full_name || '',
      'location.name': location?.name || '',
      'location.preferred_branch_type': location?.preferred_branch_type || editing?.preferred_brand?.name || '',
      'location.address': location?.address || editing?.address || '',
      'location.city': location?.city || '',
      'location.province': location?.province || '',
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

  /* ---------- Payment Record stage: Sales collects, Admin confirms ---------- */

  /**
   * Sales [ADD PAYMENT]: append a temporary draft. No API call, no database
   * write. Existing entries are corrected through a pending change request.
   */
  const savePaymentEntry = async (event) => {
    event?.preventDefault();
    if (!editing || !paymentEntry) return;

    if (!paymentEntry.id) {
      if (entryAmountIssue) return;
      setPaymentDrafts((current) => [...current, {
        payment_date: paymentEntry.payment_date || localDateInputValue(),
        amount: paymentEntry.amount,
        payment_type: entryType,
        payment_method: paymentEntry.payment_method || 'cash',
      }]);
      setPaymentEntry(null);
      setActionError('');
      setSuccess('Payment added as a draft. Click Save New Record to send it to Admin.');
      return;
    }

    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.patch(`/applicants/${editing.id}/payments/${paymentEntry.id}`, {
        payment_date: paymentEntry.payment_date,
        amount: paymentEntry.amount,
        payment_type: entryType,
        remarks: paymentEntry.remarks,
      });
      setSuccess('Edit request sent to Admin for approval. The entry is unchanged until Admin saves it.');
      setPaymentEntry(null);
      await refreshApplicant(editing.id);
    } catch (error) {
      // Keep the form open so the 422 message can be read and corrected.
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /** Remove a local draft before it is submitted. */
  const removePaymentDraft = (index) => {
    setPaymentDrafts((current) => current.filter((_, position) => position !== index));
  };

  /** [Save New Record]: drafts -> one pending Sales Report for Admin. */
  const submitSalesReport = async () => {
    if (!editing || paymentDrafts.length === 0) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/applicants/${editing.id}/payments/report`, {
        entries: paymentDrafts.map((draft) => ({
          payment_date: draft.payment_date,
          amount: Number(draft.amount),
          payment_type: draft.payment_type,
          payment_method: draft.payment_method || 'cash',
        })),
      });
      setPaymentDrafts([]);
      setSuccess('Sales Report sent to Admin. The payment is not saved until Admin clicks SAVE APPLICANT.');
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /** Sales: ask Admin to delete one of their own entries (no direct delete). */
  const removePaymentEntry = async (entry) => {
    if (!editing || !entry?.editable) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.delete(`/applicants/${editing.id}/payments/${entry.id}`);
      setSuccess('Delete request sent to Admin for approval. The entry is unchanged until Admin saves it.');
      if (paymentEntry?.id === entry.id) setPaymentEntry(null);
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /**
   * Admin [Confirm Payment] on the Sales Report card: LOCAL preview only. It
   * fills the Payment Record / Payment Record sections in this modal view.
   * SAVE APPLICANT is what persists it; closing discards the preview.
   */
  const confirmReportPreview = () => {
    if (!paymentStage?.sales_report) return;
    setReportPreview(true);
    setActionError('');
    setSuccess('Sales Report loaded into this view. Click SAVE APPLICANT to save it — otherwise it stays pending.');
  };

  /** Admin [COMPLETED]: verified total == total required. */
  const completePaymentStage = async () => {
    if (!editing) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/applicants/${editing.id}/payments/complete`, {});
      setSuccess('Payment completed — the applicant is now at For Approval.');
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
  };

  /**
   * Admin's Edit-mode Save: stores the original amount and the discount, and
   * the server derives the final Total required from them. Sales never sends
   * this request (the backend rejects it as well).
   */
  const saveTotalRequired = async () => {
    if (!editing) return;
    const amountIssue = totalRequiredError(paymentTotal);
    if (amountIssue) {
      setTotalEditError(amountIssue);
      return;
    }
    if (editDiscountIssue) {
      setTotalEditError(editDiscountIssue);
      return;
    }
    setSavingTotal(true);
    setTotalEditError('');
    setActionError('');
    setSuccess('');
    try {
      await api.patch(`/applicants/${editing.id}/payment-plan`, {
        total_required_amount: amountInputValue(paymentTotal),
        discount_percent: editDiscountPercent,
        promo_name: promoName.trim() || null,
      });
      setTotalEditing(false);
      setSuccess('Total required updated.');
      await refreshApplicant(editing.id);
    } catch (error) {
      setTotalEditError(firstValidationMessage(error));
    } finally {
      setSavingTotal(false);
    }
  };

  /** Admin: reject the pending Sales Report and return it with a required note. */
  const returnPaymentToSales = async () => {
    if (!editing || !returnForm?.note.trim()) return;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/applicants/${editing.id}/payments/return`, { note: returnForm.note.trim() });
      setReturnForm(null);
      setReportPreview(false);
      setSuccess('Sales Report returned to Sales.');
      await refreshApplicant(editing.id);
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setActing(false);
    }
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
  // Phase 4b payment state (Admin + Sales only fields): TRUE only after Admin
  // verified the payment; a request that is neither pending nor confirmed was
  // REJECTED — the remarks in payment_request are the Admin's reason.
  const paymentConfirmed = Boolean(editing?.payment_confirmed);
  const paymentsVisible = role === 'admin' || role === 'sales';
  // FEATURE_PAYMENT_ADVANCED (off by default) comes from /auth/me: the hidden features never show without it.
  const paymentAdvancedUi = Boolean(user?.features?.payment_advanced);
  const paymentSummary = editing?.payment_summary || null;
  // Payment Record state machine payload (state, derived totals, entry flags).
  const paymentStage = editing?.payment_stage || null;
  const paymentPercent = Number(paymentSummary?.payment_percent) || 0;
  // Payment stage draft for the inline Sales form (new entry, or editing one).
  const emptyEntryDraft = {
    payment_date: localDateInputValue(), amount: '', payment_type: 'downpayment', payment_method: 'cash', remarks: '',
  };
  const entryDraft = paymentEntry || emptyEntryDraft;
  // Drafts are local only; they do not reduce the server balance until Admin
  // saves the Sales Report, so subtract them here to keep the form within it.
  const draftTotalAmount = paymentDrafts.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  // Remaining balance available to this entry: the verified balance (minus
  // local drafts that are not saved yet) plus whatever the edited entry already
  // occupies inside it. The backend does the same per row of a Sales Report.
  const stageBalance = paymentStage ? Number(paymentStage.balance_including_pending) : 0;
  const entryBalance = stageBalance
    + (paymentEntry?.id ? Number(paymentEntry.amount) || 0 : -draftTotalAmount);
  // Amount the entry may still hold.
  const entryMaxAmount = Math.min(MAX_PAYMENT_AMOUNT, Math.max(0, entryBalance));
  // Phase 4 installment rules on the FINAL total (after the discount). The
  // auto-filled amounts are the MINIMUMS — Sales may type more, never less:
  //   Downpayment  >= min_downpayment_percent of the final total;
  //   Installment  >= saved downpayment × 50% (or the balance when lower).
  const installmentInfo = paymentStage?.installment || null;
  const draftHasDownpayment = !paymentEntry?.id && paymentDrafts.some((item) => item.payment_type === 'downpayment');
  const installmentBase = paymentEntry?.id ? null : downpaymentBase(installmentInfo, paymentDrafts);
  const hasEarlierEntries = (Number(paymentStage?.entry_count) || 0) > 0 || (!paymentEntry?.id && paymentDrafts.length > 0);
  const downpaymentCents = Number(installmentInfo?.min_downpayment_amount)
    || minDownpayment(Number(paymentStage?.total_required_amount) || 0, installmentInfo?.min_downpayment_percent ?? 20);
  const installmentCents = installmentBase != null
    ? currentMinimum(installmentBase, entryMaxAmount, installmentInfo?.installment_minimum_percent_of_downpayment ?? 50)
    : 0;
  // Downpayment only before the first payment (saved, pending or drafted); an
  // installment only after a downpayment; a balance at or under the minimum
  // can only be settled as Full Payment.
  const canUseDownpayment = (paymentStage ? Boolean(paymentStage.can_use_downpayment) : true) && !draftHasDownpayment;
  const availableEntryTypes = (() => {
    if (entryMaxAmount <= 0) return [];
    if (installmentBase == null && !hasEarlierEntries) {
      return canUseDownpayment ? ['downpayment', 'full_payment'] : ['full_payment'];
    }
    if (installmentBase != null && entryMaxAmount <= installmentCents) return ['full_payment'];
    return canUseDownpayment
      ? ['downpayment', 'installment_payment', 'full_payment']
      : ['installment_payment', 'full_payment'];
  })();
  const expectedAmountForType = (type) => {
    if (type === 'full_payment') return entryMaxAmount;
    if (type === 'downpayment') return Math.min(downpaymentCents, entryMaxAmount);
    return Math.min(installmentCents || downpaymentCents, entryMaxAmount);
  };
  const pendingReport = paymentStage?.sales_report || null;
  // The role action panel shows only when it has work in it (Admin: a Sales
  // Report to review; Sales: the Add payment form). Otherwise the content
  // goes full width — no empty half.
  const paySideVisible = (isAdminRole && Boolean(pendingReport)) || (isSalesRole && Boolean(paymentStage?.can_add_entry));
  const reportPreviewActive = Boolean(isAdminRole && reportPreview && pendingReport);
  // Displayed money: verified only, or verified + the previewed report after
  // Admin clicked Confirm Payment. Nothing is persisted by this preview.
  const displayPaid = reportPreviewActive
    ? Number(paymentStage.preview_total_paid_amount)
    : Number(paymentStage?.total_paid_amount);
  const displayBalance = reportPreviewActive
    ? Number(paymentStage.preview_remaining_balance)
    : Number(paymentStage?.balance_including_pending);
  // A 100% discount ends at ₱0: settled, so the progress and status read like
  // a fully paid record instead of an unpaid one with a zero balance.
  const fullyDiscounted = Boolean(paymentStage?.has_total_required)
    && Number(paymentStage?.total_required_amount) === 0;
  const displayProgress = fullyDiscounted
    ? 100
    : (Number(paymentStage?.total_required_amount) > 0
      ? Math.min(100, Math.round((displayPaid / Number(paymentStage.total_required_amount)) * 100))
      : 0);
  const displayStatus = (fullyDiscounted || displayPaid > 0)
    ? (displayBalance <= 0 ? 'fully_paid' : 'partially_paid')
    : 'unpaid';
  const displayStatusLabel = displayStatus === 'fully_paid'
    ? 'Fully paid'
    : (displayStatus === 'partially_paid' ? 'Partially paid' : 'Unpaid');
  const saveRecordIssue = paymentDrafts.length === 0
    ? 'Add at least one payment first.'
    : (draftTotalAmount <= 0 ? 'Add at least one payment first.' : '');
  // Payment Record rows: saved entries + local Sales drafts + Admin preview
  // rows + the Sales Report Sales has already turned over.
  const previewCreateEntries = reportPreviewActive && pendingReport?.action === 'create'
    ? (pendingReport.entries || [])
    : [];
  // A pending report is not an applicant payment yet. Both roles see its rows
  // tagged Pending (not counted); Admin's Confirm Payment preview replaces them.
  // (Sales keeps seeing what they submitted.)
  const salesPendingEntries = (isSalesRole || (isAdminRole && !reportPreviewActive)) && pendingReport?.action === 'create'
    ? (pendingReport.entries || [])
    : [];
  const hasPaymentRows = (paymentStage?.entries || []).length > 0
    || (isSalesRole && paymentDrafts.length > 0)
    || previewCreateEntries.length > 0
    || salesPendingEntries.length > 0;
  // An amount equal to the remaining balance IS Full Payment, whatever was
  // picked in the dropdown — the backend stores it that way too.
  const entryAmountNumber = Number(amountInputValue(entryDraft.amount)) || 0;
  const entrySettlesBalance = entryAmountNumber > 0 && entryAmountNumber >= entryMaxAmount;
  const entryType = entrySettlesBalance
    ? 'full_payment'
    : (availableEntryTypes.includes(LEGACY_PAYMENT_TYPE_MAP[entryDraft.payment_type] || entryDraft.payment_type)
      ? (LEGACY_PAYMENT_TYPE_MAP[entryDraft.payment_type] || entryDraft.payment_type)
      : (availableEntryTypes[0] || 'downpayment'));
  const entrySettlesWithOneInstallment = entryMaxAmount > 0 && entryMaxAmount <= installmentCents;
  const entryAmountIssue = (() => {
    const raw = amountInputValue(entryDraft.amount);
    if (raw === '') return 'Enter an amount.';
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'Numbers only — letters are not allowed.';
    const amount = Number(raw);
    if (amount <= 0) return 'The amount must be greater than zero.';
    if (amount > entryMaxAmount) return `The amount cannot exceed the remaining balance of ${moneyExact(entryMaxAmount)}.`;
    if (amount > MAX_PAYMENT_AMOUNT) return `A payment cannot exceed ${moneyExact(MAX_PAYMENT_AMOUNT)}.`;
    // Phase 4 minimums for a NEW payment (an edit is re-checked by the API).
    if (!paymentEntry?.id) {
      const ruleIssue = entryRuleIssue({
        type: entryType,
        amount,
        remaining: entryMaxAmount,
        totalRequired: Number(paymentStage?.total_required_amount) || 0,
        base: installmentBase,
        hasEarlierEntries: hasEarlierEntries,
        minDownpaymentPercent: installmentInfo?.min_downpayment_percent ?? 20,
        installmentPercent: installmentInfo?.installment_minimum_percent_of_downpayment ?? 50,
      });
      if (ruleIssue) return ruleIssue;
    }
    return '';
  })();
  /**
   * Amount input: the field shows thousands separators while the state keeps
   * the raw digits (that is what the API receives). The caret is put back after
   * the separators are re-applied, so editing in the middle of a number does
   * not jump to the end.
   */
  const onEntryAmountChange = (event) => {
    const input = event.target;
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = input.value.slice(0, caret).replace(/[^\d.]/g, '').length;
    const raw = amountInputValue(input.value);
    setPaymentEntry({ ...entryDraft, amount: raw });
    window.requestAnimationFrame(() => {
      const node = entryAmountRef.current;
      if (!node || document.activeElement !== node) return;
      const formatted = formatAmountInput(raw);
      let position = 0;
      let seen = 0;
      while (position < formatted.length && seen < digitsBeforeCaret) {
        if (/[\d.]/.test(formatted[position])) seen += 1;
        position += 1;
      }
      node.setSelectionRange(position, position);
    });
  };
  // Admin's Total required editor: only where the backend allows it.
  const canEditTotal = isAdminRole
    && draft?.status === 'payment_submitted'
    && Boolean(paymentStage?.can_set_total);
  // Live discount preview: the card recomputes from the ORIGINAL amount only.
  const editDiscountPercent = discountPercentFor(discountChoice, customDiscount);
  const editDiscountIssue = discountChoice === 'custom' ? customDiscountError(customDiscount) : '';
  const editAmountIssue = totalEditing ? totalRequiredError(paymentTotal) : '';
  const editFinalTotal = discountedAmount(paymentTotal, editDiscountPercent);
  // Leaving edit mode without saving restores the saved original + discount.
  /** Admin: save the installment plan (frequency + first due date). Sales is view-only. */
  const savePaymentSchedule = async (body) => {
    if (!editing) return false;
    setActing(true);
    setActionError('');
    setSuccess('');
    try {
      await api.patch(`/applicants/${editing.id}/payment-schedule`, body);
      setSuccess('Installment plan saved.');
      await refreshApplicant(editing.id);
      return true;
    } catch (error) {
      setActionError(firstValidationMessage(error));
      return false;
    } finally {
      setActing(false);
    }
  };

  const cancelTotalEdit = () => {
    const original = Number(paymentStage?.original_total_required_amount)
      || Number(paymentStage?.total_required_amount)
      || 0;
    setPaymentTotal(original ? String(original) : '');
    const saved = Number(paymentStage?.discount_percent) || 0;
    setDiscountChoice(saved <= 0 ? '' : (DISCOUNT_PRESETS.includes(saved) ? String(saved) : 'custom'));
    setCustomDiscount(saved > 0 && !DISCOUNT_PRESETS.includes(saved) ? String(saved) : '');
    setPromoName(paymentStage?.promo_name || '');
    setTotalEditError('');
    setTotalEditing(false);
  };
  // The header chip: the applicant's Preferred Brand / Concept, never a
  // hardcoded name. A price range is appended only when Products defines one
  // for that brand (neither the name nor the numbers are invented here).
  const brandChip = (() => {
    const brand = editing?.preferred_brand;
    if (!brand?.name) return null;
    const min = Number(brand.price_min ?? brand.price_range_min ?? 0);
    const max = Number(brand.price_max ?? brand.price_range_max ?? 0);
    const range = min > 0 && max >= min ? `${moneyShort(min)}–${moneyShort(max)}` : '';
    return { name: brand.name, range };
  })();
  // Saved discount percentage (0 = no discount, so no badge and no strikethrough).
  const stageDiscountPercent = Number(paymentStage?.discount_percent) || 0;
  // Sales user initials for the compact Sales Report avatar (e.g. "SU").
  const reportInitials = String(pendingReport?.requested_by || 'Sales').trim()
    .split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'SU';
  // Confirm Qualified needs every Qualification requirement Accepted (older records keep their checklist).
  const qualificationSummary = editing?.requirements?.summary?.qualification;
  const qualificationDone = qualificationSummary
    ? qualificationSummary.complete || (qualificationSummary.legacy && QUALIFICATION_ITEMS.every(({ key }) => Boolean(draft?.milestones?.[key])))
    : QUALIFICATION_ITEMS.every(({ key }) => Boolean(draft?.milestones?.[key]));
  const qualificationMissing = qualificationSummary?.missing || [];
  const activationMissing = editing?.requirements?.summary?.activation?.missing || [];
  const primary = draft
    ? resolvePrimaryAction({
      stage,
      allAttended: scheduleComplete,
      pendingActivities: TRACKED_ACTIVITIES
        .filter((tracked) => !editing?.activity_state?.[tracked.type]?.done)
        .map((tracked) => tracked.label),
      loiReady,
      qualificationDone,
      qualificationMissing,
      activationMissing,
      paymentPercent,
      isAdminRole,
      isSalesRole,
      hasPortalAccount: Boolean(editing?.has_portal_account),
    })
    : null;
  const showSchedule = Boolean(draft) && (scheduleRevealed || SCHEDULE_VISIBLE_FROM.includes(stage));

  // Applicant-level "Set Again" (Section 4): the NEXT activity step only, shown
  // when the previous step is DONE, a next step exists, and that step has no
  // active or pending schedule yet. It is never placed inside an activity.
  const nextActivity = (() => {
    const state = editing?.activity_state;
    if (!state) return null;
    // A brand other than the tasted one: Set Again books the new Product Tasting first.
    const retasting = editing?.brand_confirmation?.retasting_required && !editing?.brand_confirmation?.retasting_done;
    const index = retasting ? 1 : TRACKED_ACTIVITIES.findIndex((tracked) => !state?.[tracked.type]?.done);
    if (index < 0) return null; // all three Done
    const noShowFirst = (editing?.schedules || []).some((row) => row.activity_type === TRACKED_ACTIVITIES[0].type && row.status === 'no_show');
    if (index === 0 && !noShowFirst) return null; // nothing Done yet: Set Schedule instead
    const tracked = TRACKED_ACTIVITIES[index];
    // Training waits for the Brand Confirmation (the card above explains what is missing).
    if (tracked.type === 'training' && !editing?.brand_confirmation?.locked) return null;
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
                onReturn={returnActivity}
                onError={setActionError}
              />
              <BrandConfirmationCard editing={editing} brands={remote.data?.brands} isAdminRole={false} isAssignedSales={false} busy onSubmit={() => {}} onConfirm={() => {}} onReturn={() => {}} />
            </DoneSection>
          );
        }
        return (
          <DoneSection key={key} title="Qualification" summary={editing.requirements?.summary?.qualification?.legacy ? `Legacy checklist · ${qualificationCount} of ${QUALIFICATION_ITEMS.length} assessed` : 'Requirements accepted'}>
            <RequirementsPanel editing={editing} stage="qualification" readOnly busy={false} onSubmit={() => {}} onAccept={() => {}} onReturn={() => {}} onError={setActionError} />
            {(editing.assessment_log || []).length > 0 && (
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
  const paymentHandedOver = paymentConfirmed
    || ['for_review', 'confirmed'].includes(paymentStage?.state);
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
    if (!focusTab && !focusId) return undefined;
    const tabQuery = focusTab && focusTab !== 'pipeline' ? `?tab=${focusTab}` : '';
    navigate(`${location.pathname}${tabQuery}`, { replace: true, state: null });
    if (focusId && !editing) void loadApplicant(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // Escape closes the Update dialog only when no smaller dialog is open on top of it.
  const updateEscapeEnabled = !mark && !paymentEntry && !returnForm && !activateForm
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
        <div className="flex flex-wrap items-end gap-[10px] m-[0_0_14px] text-[14px] [&_label]:grid [&_label]:gap-1 [&_label]:text-muted [&_input]:h-[40px] [&_select]:h-[40px] [&_input]:p-[0_10px] [&_select]:p-[0_10px] [&_input]:border [&_select]:border [&_input]:border-input-line [&_select]:border-input-line [&_input]:rounded-[10px] [&_select]:rounded-[10px] [&_input]:[background:var(--input-bg)] [&_select]:[background:var(--input-bg)] [&_input]:text-text [&_select]:text-text" aria-label="Date range and filters">
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
          <span className="flex gap-2 ml-auto">
            <button type="button" className={filterBtn} disabled={exporting} onClick={() => void exportFiltered('csv')}>Export CSV</button>
            <button type="button" className={filterBtn} disabled={exporting} onClick={() => void exportFiltered('pdf')}>Export PDF</button>
          </span>
        </div>
      )}

      {/* Unified toolbar: view tabs, search and the status filter share one box. */}
      <div className="unified-toolbar-container flex items-center flex-nowrap gap-[10px] w-full [box-sizing:border-box] m-0 p-[10px_14px] border border-[#252b3b] rounded-[14px] [background:#101421] max-[721px]:later:flex-wrap max-[721px]:later:gap-2 max-[721px]:later:p-[8px_10px] max-[721px]:later:rounded-[12px] [.activities-page_&]:m-0">
        <div className="flex items-center flex-[0_1_auto] min-w-0 gap-[2px] p-1 overflow-x-auto border border-[#1f2638] rounded-[10px] [background:#0b0f19] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:flex-[0_0_auto] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:min-h-[34px] [&>button]:p-[7px_15px] later-2:[&>button]:border later-2:[&>button]:border-transparent later-2:[&>button]:rounded-[8px] [&>button]:[background:transparent] [&>button]:text-[#8a94a6] [&>button]:[font-family:inherit] [&>button]:[font-style:inherit] later-2:[&>button]:text-[13px] later-2:[&>button]:font-[600] later:[&>button]:leading-[1.2] [&>button]:whitespace-nowrap later:[&>button]:cursor-pointer [&>button]:[transition:background_.15s_ease,_color_.15s_ease,_border-color_.15s_ease] [&>button:hover:not(.active):not([aria-selected='true'])]:text-[#d7ddf5] [&>button:hover:not(.active):not([aria-selected='true'])]:[background:rgba(255,_255,_255,_.04)] [&>button:hover:not(.active):not([aria-selected='true'])]:border-transparent [&>button.active]:[background:#252e42] [&>button.active]:text-[#fff] [&>button.active]:font-[600] [&>button.active]:border-transparent [&>button.active]:[box-shadow:none] later:[&>button[aria-selected='true']]:[background:#252e42] [&>button[aria-selected='true']]:text-[#fff] [&>button[aria-selected='true']]:font-[600] [&>button[aria-selected='true']]:border-transparent [&>button[aria-selected='true']]:[box-shadow:none] later:[&>button:focus-visible]:[outline:2px_solid_#8175ff] later:[&>button:focus-visible]:[outline-offset:2px] [&>button_svg]:flex-[0_0_auto] [&>button_svg]:text-[12px] max-[721px]:later:flex-[1_1_100%]" role="tablist" aria-label="Applicant views">
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

        <div className="flex-[1_1_160px] min-w-[120px] flex [&_input]:flex-[1_1_auto] [&_input]:w-full [&_input]:min-w-0 [&_input]:h-[44px] [&_input]:[box-sizing:border-box] [&_input]:p-[0_14px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:text-[13px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_input]:h-[42px]">
          <input
            value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
            placeholder="Search by ID, name, email, or phone"
            aria-label="Search applicants"
          />
        </div>
        {tab !== 'franchisees' && (
          <div className="flex-[0_0_180px] flex [&_select]:w-full [&_select]:h-[44px] [&_select]:[box-sizing:border-box] [&_select]:p-[0_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:text-[13px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select:hover]:border-line-strong later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_select]:h-[42px]">
            <select
              value={status}
              onChange={(e) => { setPage(1); setStatus(e.target.value); }}
              aria-label="Filter applicant status"
            >
              <option value="">All statuses</option>
              {activeStatuses.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
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
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
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
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
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
                    <th className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden">Applicant ID</th><th>Applicant</th><th>Contact</th><th>Brand</th><th>Applied</th>
                    <th>Status</th><th>Update</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((applicant) => (
                    <tr key={applicant.id} data-applicant-id={applicant.id} onClick={tab === 'archived' ? () => navigate(`/admin-settings?tab=applicants&applicant=${applicant.id}`) : undefined}>
                      {/* Applicant ID only, one compact line (the source Lead ID is in the modal / full record). */}
                      <td className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden record-id-col [.data-panel_.table-wrap_table_th&]:w-[1%] [.data-panel_.table-wrap_table_th&]:whitespace-nowrap [.data-panel_.table-wrap_table_td&]:w-[1%] [.data-panel_.table-wrap_table_td&]:whitespace-nowrap [.data-panel_.table-wrap_table_td&_.record-code]:[vertical-align:middle]"><RecordCode code={applicant.applicant_code} label="Applicant ID" /></td>
                      <td>
                        <span className="hidden max-[761px]:later:block max-[761px]:mb-[2px]"><RecordCode code={applicant.applicant_code} label="Applicant ID" /></span>
                        <strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{applicant.full_name}</strong>
                      </td>
                      <td>{applicant.email || '—'}<small>{applicant.phone || '—'}</small></td>
                      <td>{applicant.preferred_brand?.name || '—'}</td>
                      <td>{formatDate(applicant.application_date)}</td>
                      <td>
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
                        <AssignedSalesTag sales={applicant.assigned_sales} />
                        {typeof applicant.days_in_stage === 'number' && (
                          <small className="block text-[#9aa6c4]">
                            {applicant.days_in_stage} day{applicant.days_in_stage === 1 ? '' : 's'} in stage
                            {applicant.overdue && (
                              <span className="inline-flex ml-[6px] p-[1px_8px] rounded-[999px] border border-[rgba(255,_136,_142,_.5)] text-[#ff888e] text-[11px] font-[700]" title={`More than ${applicant.overdue_after_days} days in this stage`}>Overdue</span>
                            )}
                          </small>
                        )}
                      </td>
                      <td>
                        <div className="row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative">
                          {canManage && tab === 'archived' ? (
                            <button onClick={() => navigate(`/admin-settings?tab=applicants&applicant=${applicant.id}`)}>View in Admin Settings</button>
                          ) : canManage ? (
                            <>
                              <button
                                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                                disabled={updatingId === applicant.id}
                                onClick={() => { setSeenActivityDots((current) => new Set(current).add(applicant.id)); void loadApplicant(applicant.id); }}
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
                                <button disabled={updatingId === applicant.id} onClick={() => archiveApplicant(applicant)}>
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

      {editing && draft && (
        <Dialog
          title={<span className="[&_.ap-status-label.ap-endorsed-label]:ml-4 [&_.ap-status-label.ap-endorsed-label]:[align-self:baseline] [&_.record-code]:[vertical-align:middle]">Update {editing.full_name}{editing.applicant_code && <> · <RecordCode code={editing.applicant_code} label="Applicant ID" size="md" /></>} {editing.inquiry?.converted_from_status === 'endorsed' && <small className="ap-status-label inline-flex items-center p-[4px_7px] border border-[#353e57] rounded-[6px] [background:#1a2133] text-[#c5c9ff]! text-[10px]! [&.ap-endorsed-label]:p-0 [&.ap-endorsed-label]:border-0 [&.ap-endorsed-label]:[background:none] [&.ap-endorsed-label]:text-[color:var(--info)]! [&.ap-endorsed-label]:text-[14px]! [&.ap-endorsed-label]:font-[600] ap-endorsed-label" title="Lead source: this inquiry was endorsed before it was converted. The application stage is shown in the tracker.">Endorsed lead</small>}</span>}
          onClose={closeEditor}
          modalClass={paymentsVisible && stage === 'payment_submitted' ? 'is-payment' : ''}
          closeOnEscape={updateEscapeEnabled}
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
              {stage !== 'for_approval'
                && (canEditDetails || (isSalesRole && ['converted', 'qualified'].includes(stage))) && (
                  <button
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] ap-modal-save"
                    form="update-applicant-form"
                    disabled={saving || acting}
                  >
                    {saving ? 'SAVING…' : 'SAVE APPLICANT'}
                  </button>
                )}
              {/* Sales footer CTA (moved from the record box inside the panel):
                  same disabled rules, same handler, nothing else changed. */}
              {isSalesRole && stage === 'payment_submitted' && paymentStage?.can_add_entry && (
                <>
                  <span
                    className="text-[#9ba5bd] text-[11px] [cursor:help]"
                    title={paymentDrafts.length
                      ? 'Temporary only. Save New Record sends the Sales Report to Admin; SAVE APPLICANT by Admin is what records it.'
                      : 'ADD PAYMENT is temporary. Nothing is recorded until you Save New Record and Admin saves it.'}
                  >
                    {paymentDrafts.length} draft payment{paymentDrafts.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] ap-modal-save"
                    disabled={acting || Boolean(saveRecordIssue)}
                    title={saveRecordIssue || 'Sends the Sales Report to Admin — Admin then records it with SAVE APPLICANT.'}
                    onClick={() => void submitSalesReport()}
                  >
                    SAVE NEW RECORD
                  </button>
                </>
              )}
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <Notice type="success">{success}</Notice>
          <form id="update-applicant-form" onSubmit={saveApplicant} noValidate>
            {/* The lead this applicant came from — only here and in the full record, never in the table. */}
            <dl className="flex flex-wrap gap-[6px_18px] m-[6px_0_0] [&_div]:grid [&_div]:gap-[1px] [&_dt]:text-muted [&_dt]:text-[10.5px] [&_dt]:font-[600] [&_dt]:tracking-[.04em] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-text-secondary [&_dd]:text-[12px] ap-modal-ids">
              <div><dt>Source Lead ID</dt><dd>{editing.lead?.lead_code
                ? <RecordCode code={editing.lead.lead_code} label="Source Lead ID" size="md" />
                : <span className="record-code inline-flex items-center gap-1 max-w-full whitespace-nowrap [&.is-empty]:text-[color:var(--muted,_#8f9ab2)] is-empty">No source lead (added directly)</span>}</dd></div>
            </dl>
            <section className={stage === 'payment_submitted' ? 'ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] pay-state-strip later-3:[#update-applicant-form_&]:p-[10px_12px] later-2:[#update-applicant-form_&]:mb-2 [#update-applicant-form_&_.ap-actions]:m-[8px_0_0] [#update-applicant-form_&_.ap-actions:empty]:m-0' : 'ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none]'}>
              <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
                <h3>Application stage</h3>
                {draft.status === 'rejected' && <small className="text-[#ff888e]!">Rejected</small>}
              </div>
              {/* Who handles this applicant: only the assigned Sales user can act for it. */}
              <div className="flex flex-wrap items-center gap-[10px] m-[10px_0_12px] text-[14px] text-[#b9c1d5]">
                <span>Assigned Sales:</span>
                {editing.assigned_sales?.full_name
                  ? <strong className="text-[#edf0fa]">{editing.assigned_sales.full_name}</strong>
                  : <AssignedSalesTag sales={null} />}
                {isAdminRole && !['active_franchisee', 'rejected'].includes(editing.status) && !editing.archived_at && (
                  <button type="button" disabled={acting} onClick={() => void openAssign()}>
                    {editing.assigned_sales_user_id ? 'Reassign' : 'Assign Sales'}
                  </button>
                )}
                {isSalesRole && !isAssignedSales && (
                  <small className="text-[#fbbf24]">
                    {editing.assigned_sales_user_id ? 'View only: another Sales user handles this applicant.' : 'Admin must assign a Sales user first.'}
                  </small>
                )}
              </div>
              {typeof editing.days_in_stage === 'number' && (
                <p className="m-[0_0_10px] text-[14px] text-[#9aa6c4]">
                  {editing.days_in_stage} day{editing.days_in_stage === 1 ? '' : 's'} in the current stage
                  {editing.overdue && <strong className="ml-2 text-[#ff888e]">Overdue (more than {editing.overdue_after_days} days)</strong>}
                </p>
              )}
              {/* Display-only tracker: no click-to-check, the API owns every move. */}
              <Stepper items={stageItems} />

              <div className="ap-actions flex flex-wrap items-center gap-[10px] mt-[14px]">
                {primary && (
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
                      } else if (primary.run === 'activate') openActivateForm();
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
                {/* Payment Record: COMPLETED appears only once it can be used (Total
                    paid == Total required, no Sales Report pending, LOI not Pending) —
                    never as a dead disabled button. The rule itself is unchanged. */}
                {stage === 'payment_submitted' && isAdminRole && paymentStage?.can_complete && (
                  <button
                    type="button"
                    className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.ap-actions_&]:m-0 [.ap-actions_&:disabled]:text-[#7d879e] [.ap-actions_&:disabled]:border [.ap-actions_&:disabled]:border-[#2b344c] [.ap-actions_&:disabled]:[background:#131a29] later:[.ap-actions_&:disabled]:[box-shadow:none] [.ap-actions_&:disabled]:opacity-[1] [.ap-actions_&:disabled]:cursor-not-allowed later-2:[.ap-actions_&:disabled]:[transform:none]"
                    disabled={!paymentStage?.can_complete || acting || saving}
                    title={paymentStage?.can_complete
                      ? 'The Payment Record is Fully Paid with nothing waiting for review. Move the applicant to For Approval.'
                      : paymentStage?.loi_pending
                        ? 'The LOI is still Pending — complete it in the LOI section first. For Approval is blocked until then.'
                        : 'COMPLETED unlocks only when the Payment Record is Fully Paid and nothing is waiting for review.'}
                    onClick={() => void completePaymentStage()}
                  >
                    COMPLETED
                  </button>
                )}
                {draft.status === 'loi_submitted' && isAdminRole && (
                  <button type="button" className="min-h-[34px] p-[0_12px] border border-[#3a4256] rounded-[10px] [background:#181d29] text-[#d6dcea] text-[11px] font-[700] [transition:background_.18s_ease,_border-color_.18s_ease] [&:hover:not(:disabled)]:[background:rgba(244,_184,_74,_.16)] [&:hover:not(:disabled)]:border-[rgba(244,_184,_74,_.7)]" disabled={acting} onClick={() => setUndoLoiForm({ remarks: '' })}>
                    Undo LOI
                  </button>
                )}
                {/* Set Again is an applicant-level action in the Scheduled stage
                    action area — never inside Orientation / Product Tasting / Training. */}
                {stage === 'scheduled' && firstActivity && isAdminRole && (
                  <button
                    type="button"
                    className="[#update-applicant-form_&]:min-h-[34px] [#update-applicant-form_&]:mt-0 [#update-applicant-form_&]:p-[0_14px] [#update-applicant-form_&]:border [#update-applicant-form_&]:border-[color:color-mix(in_srgb,_#39ffb0_45%,_transparent)] [#update-applicant-form_&]:rounded-[7px] [#update-applicant-form_&]:[background:color-mix(in_srgb,_#39ffb0_10%,_transparent)] [#update-applicant-form_&]:text-[#39ffb0] [#update-applicant-form_&]:text-[11px] [#update-applicant-form_&]:font-[700] [#update-applicant-form_&]:tracking-[.02em] [#update-applicant-form_&]:whitespace-nowrap [#update-applicant-form_&:hover:not(:disabled)]:[background:color-mix(in_srgb,_#39ffb0_18%,_transparent)]"
                    disabled={acting || saving}
                    title={`Schedule ${firstActivity.label} for this applicant`}
                    onClick={() => goSchedule(firstActivity.type)}
                  >
                    Set Schedule · {firstActivity.label}
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
                    Set Again · {nextActivity.label}
                  </button>
                )}
              </div>
              {stage === 'payment_submitted' && loiPending && (
                <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0 later-5:[&.ap-action-reason]:text-[#fbbf24]" role="status">
                  LOI Pending — For Approval is blocked until the LOI is completed (LOI section below). Payments continue as usual.
                </p>
              )}
              {primary && !primary.enabled && primary.reason && (
                <p className="ap-action-reason m-[8px_0_0] text-[#8f9ab2] text-[11px] leading-[1.5] [.ap-schedule-actions_&]:m-0" role="status">{primary.reason}</p>
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
                  onError={setActionError}
                />
                {/* The retired five-item checklist stays visible as history only. */}
                {(editing.assessment_log || []).length > 0 && (
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

            {!['active_franchisee', 'rejected'].includes(editing.status) && (
              <FollowUpLog
                items={editing.follow_ups || []}
                canAdd={isAssignedSales && !editing.archived_at}
                busy={acting}
                onAdd={logApplicantFollowUp}
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
                onReturn={returnActivity}
                onError={setActionError}
              />
              <BrandConfirmationCard
                editing={editing}
                brands={remote.data?.brands}
                isAdminRole={isAdminRole}
                isAssignedSales={isAssignedSales}
                busy={acting}
                onSubmit={submitBrand}
                onConfirm={(current) => setBrandConfirmDialog(current)}
                onReturn={returnBrand}
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

            {stage !== 'payment_submitted' && doneSections}

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
                  <Field label="Address"><input value={draft.address} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, address: e.target.value })} /></Field>
                  <Field label="Notes" full>
                    <textarea value={draft.notes} disabled={!canEditDetails} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </Field>
                </div>
              </details>
            )}

            {/* Stage 4: Payment Record. Content, flow and permissions only —
                the tracker, the theme and the stage button spot are untouched. */}
            {paymentsVisible && !paymentAdvancedUi && stage === 'payment_submitted' && (
              <PaymentRecordPanel
                editing={editing}
                busy={acting}
                onSetAmount={setAgreedAmount}
                onSubmitEntry={submitPaymentEntry}
                onVerify={verifyPaymentEntry}
                onReturn={returnPaymentEntry}
                onError={setActionError}
              />
            )}
            {paymentsVisible && (paymentAdvancedUi || paymentStage?.sales_report) && stage === 'payment_submitted' && (
              <section className="flex flex-col p-3 mb-2 border border-[#273044] rounded-[11px] [background:#101521] later:flex-none later:min-h-[auto] overflow-visible h-auto max-h-[none] max-w-full" aria-labelledby="ap-payment-stage-title">
                <div className="pay-columns grid-cols-[minmax(0,_1fr)_minmax(0,_300px)] gap-0 max-[821px]:later:flex-none max-[821px]:later:grid-cols-[1fr] later:flex-none later:min-h-[auto] [&.is-full]:grid-cols-[minmax(0,_1fr)] later:block [&.is-full]:block is-full">
                <div className="flex flex-col min-w-0 border-r-[#273044] max-[821px]:later:pr-0 max-[821px]:later:pb-[10px] max-[821px]:later:border-r-0 max-[821px]:later:border-b max-[821px]:later:border-b-[#273044] flex-none later:min-h-[auto] later:gap-3 later-2:p-0 later-2:border-0 overflow-visible later:[.pay-columns.is-full_&]:p-0 later:[.pay-columns.is-full_&]:border-0 [.pay-columns.is-full_&]:overflow-visible max-w-full">
                  <div className="flex flex-none flex-wrap items-center justify-between gap-2 later-3:[&_h3]:m-0 later-2:[&_h3]:text-[#edf0fa] later:[&_h3]:font-[700] later:[&_h3]:tracking-[.06em] [&_h3]:uppercase later-7:[&_h3]:text-[16px]">
                    <h3 id="ap-payment-stage-title">Payment Record</h3>
                    {/* ONE header chip: the applicant's Preferred Brand / Concept
                        (read from the applicant record), with the brand's price
                        range when Products defines one. */}
                    {brandChip && (
                      <div className="flex items-center gap-[6px]">
                        <span className="border rounded-[999px] font-[700] inline-flex items-center gap-[6px] later:p-[3px_10px] later:border-[rgba(129,_117,_255,_.35)] later:text-[#cfd6ff] [background:rgba(129,_117,_255,_.1)] later:text-[10px] later:tracking-[.02em] later:normal-case later:cursor-default later:[&_svg]:text-[#a89dff] later:[&_svg]:flex-[0_0_auto]" title="Preferred brand / concept">
                          <FaStore aria-hidden="true" />
                          <span>
                            {brandChip.name}
                            {brandChip.range ? ` · ${brandChip.range}` : ''}
                          </span>
                        </span>
                        {editing.brand_confirmation?.locked && (
                          <small className="inline-flex items-center gap-[5px] text-[12px] text-[#45d991]" title="The brand can no longer be changed.">
                            <FaLock aria-hidden="true" />
                            {editing.brand_confirmation.legacy
                              ? 'Locked · Legacy - brand confirmation not captured'
                              : `Locked · confirmed by ${editing.brand_confirmation.locked_by || 'Admin'}, ${manilaDateTimeLabel(editing.brand_confirmation.locked_at)}`}
                          </small>
                        )}
                      </div>
                    )}
                  </div>

                  {paymentStage?.returned_note && (
                    <p className="m-0 p-[7px_10px] border border-[rgba(251,_191,_36,_.35)] rounded-[8px] text-[#ffdf9e] [background:rgba(251,_191,_36,_.07)] text-[11px] leading-[1.4] later:[&_strong]:font-[600]">
                      <strong>
                        Returned by {paymentStage.returned_by || 'Admin'}
                        {paymentStage.returned_at ? ` on ${formatDate(paymentStage.returned_at)}` : ''}:
                      </strong>{' '}
                      {paymentStage.returned_note}
                    </p>
                  )}

                {totalEditing && canEditTotal ? (
                  /* Edit mode: the Total required card stays on the left, a
                     divider, then Edit Value + Select Promos/Discount + Save.
                     Total paid / Remaining balance are hidden while editing. */
                  <div className="grid flex-none grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] gap-[14px] items-stretch max-[641px]:later:grid-cols-[1fr] max-[641px]:later:gap-[10px]">
                    <div className="grid gap-[6px] [align-content:start] min-w-0 min-h-[66px] p-[9px_11px] border border-[#273044] rounded-[10px] [background:#0c111d]">
                      <span className="text-[#9aa6c4] tracking-[.04em] uppercase later:text-[11.5px]">Total required</span>
                      <strong className="text-[#f3f6ff] leading-[1.2] [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] later:text-[21px]">{moneyExact(editFinalTotal)}</strong>
                    </div>
                    <div className="grid gap-2 [align-content:start] min-w-0 pl-[14px] border-l border-l-[#273044] max-[641px]:later:pl-0 max-[641px]:later:pt-[10px] max-[641px]:later:border-l-0 max-[641px]:later:border-t max-[641px]:later:border-t-[#273044]">
                      <label className="flex items-center gap-1 min-w-0 min-h-[38px] p-[6px_10px] border border-[#273044] rounded-[8px] [background:#080c16] text-[#9aa6c4] text-[12.5px] focus-within:border-[#8175ff] [&_input]:w-full [&_input]:min-w-0 later-3:[&_input]:p-0 later-3:[&_input]:border-0 later-2:[&_input]:[background:transparent] later-3:[&_input]:text-[#e7ebf5] [&_input]:[font-family:inherit] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:p-0 later:[&_select]:border-0 later:[&_select]:[background:transparent] later:[&_select]:text-[#e7ebf5] [&_select]:[font-family:inherit] [&_input]:[font-variant-numeric:tabular-nums] later:[&_input:focus]:[outline:none] [&_select:focus]:[outline:none] [&_select_option]:[background:#0c111d] [&_select_option]:text-[#e7ebf5] later-6:[&_input]:text-[13.5px] later-3:[&_select]:text-[13.5px]" htmlFor="ap-pay-edit-value">
                        <span className="flex-none text-[#9aa6c4] text-[12.5px]" aria-hidden="true">₱</span>
                        <input
                          id="ap-pay-edit-value"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="Edit Value"
                          value={formatAmountInput(paymentTotal)}
                          autoFocus
                          aria-invalid={Boolean(editAmountIssue)}
                          onChange={(e) => {
                            setPaymentTotal(amountInputValue(e.target.value));
                            if (totalEditError) setTotalEditError('');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.stopPropagation();
                              void saveTotalRequired();
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              e.stopPropagation();
                              cancelTotalEdit();
                            }
                          }}
                        />
                      </label>
                      <label className="flex items-center gap-1 min-w-0 min-h-[38px] p-[6px_10px] border border-[#273044] rounded-[8px] [background:#080c16] text-[#9aa6c4] text-[12.5px] focus-within:border-[#8175ff] [&_input]:w-full [&_input]:min-w-0 later-3:[&_input]:p-0 later-3:[&_input]:border-0 later-2:[&_input]:[background:transparent] later-3:[&_input]:text-[#e7ebf5] [&_input]:[font-family:inherit] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:p-0 later:[&_select]:border-0 later:[&_select]:[background:transparent] later:[&_select]:text-[#e7ebf5] [&_select]:[font-family:inherit] [&_input]:[font-variant-numeric:tabular-nums] later:[&_input:focus]:[outline:none] [&_select:focus]:[outline:none] [&_select_option]:[background:#0c111d] [&_select_option]:text-[#e7ebf5] later-6:[&_input]:text-[13.5px] later-3:[&_select]:text-[13.5px]" htmlFor="ap-pay-discount">
                        <select
                          id="ap-pay-discount"
                          value={discountChoice}
                          onChange={(e) => {
                            setDiscountChoice(e.target.value);
                            setTotalEditError('');
                          }}
                        >
                          <option value="">Select Promos/Discount</option>
                          <option value="none">No discount</option>
                          {DISCOUNT_PRESETS.map((preset) => (
                            <option key={preset} value={String(preset)}>{preset}%</option>
                          ))}
                          <option value="custom">Custom % (input)</option>
                        </select>
                      </label>
                      {discountChoice === 'custom' && (
                        <label className="flex items-center gap-1 min-w-0 min-h-[38px] p-[6px_10px] border border-[#273044] rounded-[8px] [background:#080c16] text-[#9aa6c4] text-[12.5px] focus-within:border-[#8175ff] [&_input]:w-full [&_input]:min-w-0 later-3:[&_input]:p-0 later-3:[&_input]:border-0 later-2:[&_input]:[background:transparent] later-3:[&_input]:text-[#e7ebf5] [&_input]:[font-family:inherit] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:p-0 later:[&_select]:border-0 later:[&_select]:[background:transparent] later:[&_select]:text-[#e7ebf5] [&_select]:[font-family:inherit] [&_input]:[font-variant-numeric:tabular-nums] later:[&_input:focus]:[outline:none] [&_select:focus]:[outline:none] [&_select_option]:[background:#0c111d] [&_select_option]:text-[#e7ebf5] later-6:[&_input]:text-[13.5px] later-3:[&_select]:text-[13.5px]" htmlFor="ap-pay-custom-discount">
                          <input
                            id="ap-pay-custom-discount"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="Custom %"
                            value={customDiscount}
                            aria-invalid={Boolean(editDiscountIssue)}
                            onChange={(e) => {
                              setCustomDiscount(e.target.value.replace(/[^\d]/g, '').slice(0, 3));
                              setTotalEditError('');
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                void saveTotalRequired();
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelTotalEdit();
                              }
                            }}
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-1 min-w-0 min-h-[38px] p-[6px_10px] border border-[#273044] rounded-[8px] [background:#080c16] text-[#9aa6c4] text-[12.5px] focus-within:border-[#8175ff] [&_input]:w-full [&_input]:min-w-0 later-3:[&_input]:p-0 later-3:[&_input]:border-0 later-2:[&_input]:[background:transparent] later-3:[&_input]:text-[#e7ebf5] [&_input]:[font-family:inherit] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:p-0 later:[&_select]:border-0 later:[&_select]:[background:transparent] later:[&_select]:text-[#e7ebf5] [&_select]:[font-family:inherit] [&_input]:[font-variant-numeric:tabular-nums] later:[&_input:focus]:[outline:none] [&_select:focus]:[outline:none] [&_select_option]:[background:#0c111d] [&_select_option]:text-[#e7ebf5] later-6:[&_input]:text-[13.5px] later-3:[&_select]:text-[13.5px]" htmlFor="ap-pay-promo-name">
                        <input
                          id="ap-pay-promo-name"
                          type="text"
                          maxLength={120}
                          autoComplete="off"
                          placeholder="Promo name (optional)"
                          value={promoName}
                          onChange={(e) => setPromoName(e.target.value)}
                        />
                      </label>
                      <div className="flex flex-wrap justify-end gap-2 max-[641px]:later:[justify-content:stretch]">
                        <button
                          type="button"
                          className="pay-mini-btn later:[justify-self:start] border border-[#3b4767] rounded-[7px] [background:transparent] text-[#c9d1e6] text-[10px] font-[700] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:border-[#8175ff] hover:[background:rgba(129,_117,_255,_.1)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px] later:p-[5px_16px] max-[641px]:w-full"
                          disabled={savingTotal}
                          onClick={() => void saveTotalRequired()}
                        >
                          {savingTotal ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                      {(editAmountIssue || editDiscountIssue || totalEditError) && (
                        <small className="text-[#ff9ca3] leading-[1.35] later:text-[12px]" role="alert">
                          {editAmountIssue || editDiscountIssue || totalEditError}
                        </small>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid flex-none grid-cols-[repeat(3,_minmax(0,_1fr))] gap-2 max-[821px]:later:grid-cols-[1fr]">
                      <article className="grid gap-1 [align-content:start] p-[9px_11px] border border-[#273044] rounded-[10px] [background:#0c111d] min-w-0 min-h-[66px] max-[821px]:later:min-h-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#9aa6c4] tracking-[.04em] uppercase later:text-[11.5px]">Total required</span>
                          {canEditTotal && (
                            <button
                              type="button"
                              className="pay-mini-btn later:[justify-self:start] p-[2px_10px] border border-[#3b4767] rounded-[7px] [background:transparent] text-[#c9d1e6] text-[10px] font-[700] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:border-[#8175ff] hover:[background:rgba(129,_117,_255,_.1)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px] inline-flex items-center gap-1"
                              title="Edit the Total required and the discount"
                              onClick={() => setTotalEditing(true)}
                            >
                              <FaPen aria-hidden="true" /> Edit
                            </button>
                          )}
                        </div>
                        {paymentStage?.has_total_required ? (
                          <>
                            <div className="flex items-center flex-wrap gap-[6px] min-w-0">
                              <strong className="text-[#f3f6ff] leading-[1.2] [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] later:text-[21px]">{moneyExact(paymentStage?.total_required_amount)}</strong>
                              {stageDiscountPercent > 0 && (
                                <span className="flex-[0_0_auto] p-[1px_7px] rounded-[999px] text-[#6fe3b6] [background:rgba(52,_211,_153,_.13)] text-[9.5px] font-[700] tracking-[.03em]">{stageDiscountPercent}% OFF</span>
                              )}
                            </div>
                            {stageDiscountPercent > 0 && (
                              <s className="text-[#7d879e] text-[10.5px] [font-variant-numeric:tabular-nums]">
                                {moneyExact(paymentStage?.original_total_required_amount)}
                              </s>
                            )}
                            {/* Saved discount snapshot: never re-derived from a promo. */}
                            <DiscountSnapshot
                              original={paymentStage?.original_total_required_amount}
                              percent={stageDiscountPercent}
                              promo={paymentStage?.promo_name}
                              final={paymentStage?.total_required_amount}
                              setBy={paymentStage?.discount_set_by}
                              setAt={paymentStage?.discount_set_at}
                            />
                          </>
                        ) : (
                          <span className="self-center [justify-self:center] text-[#9ba5bd] text-[10.5px] leading-[1.4] text-center p-[4px_2px]">Total payment has not been entered yet.</span>
                        )}
                        {!canEditTotal && (
                          <>
                            {paymentStage?.package_name && <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">{paymentStage.package_name}</small>}
                            <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">Set by Admin · view only</small>
                          </>
                        )}
                      </article>
                      <article className="grid gap-1 [align-content:start] p-[9px_11px] border border-[#273044] rounded-[10px] [background:#0c111d] min-w-0 min-h-[66px] max-[821px]:later:min-h-0">
                        <span className="text-[#9aa6c4] tracking-[.04em] uppercase later:text-[11.5px]">Total paid</span>
                        <strong className="text-[#f3f6ff] leading-[1.2] [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] later:text-[21px]">{moneyExact(displayPaid)}</strong>
                        <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">
                          {Number(paymentStage?.entry_count) || 0} saved payment{(Number(paymentStage?.entry_count) || 0) === 1 ? '' : 's'}
                          {reportPreviewActive ? ' · preview includes the Sales Report' : ''}
                        </small>
                      </article>
                      <article className="grid gap-1 [align-content:start] p-[9px_11px] border border-[#273044] rounded-[10px] [background:#0c111d] min-w-0 min-h-[66px] max-[821px]:later:min-h-0">
                        <span className="text-[#9aa6c4] tracking-[.04em] uppercase later:text-[11.5px]">Remaining balance</span>
                        <strong className="text-[#f3f6ff] leading-[1.2] [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] later:text-[21px]">{moneyExact(displayBalance)}</strong>
                        <span className={`[justify-self:start] p-[1px_8px] rounded-[999px] text-[10px] font-[700] pay-badge-${displayStatus}`}>
                          {displayStatusLabel}
                        </span>
                      </article>
                    </div>
                  </>
                )}

                <div className="flex flex-none items-center justify-between gap-2 text-[#9aa6c4] text-[12px] later-3:[&_strong]:text-[#e7ebf5] later-2:[&_strong]:text-[12px] [&_strong]:[font-variant-numeric:tabular-nums]">
                  <small>{reportPreviewActive ? 'Payment progress (preview)' : 'Payment progress (saved payments)'}</small>
                  <strong>{displayProgress}%</strong>
                </div>
                <div
                  className="flex-none h-[4px] rounded-[999px] [background:rgba(255,_255,_255,_.07)] overflow-hidden [&>span]:block [&>span]:h-full later:[&>span]:rounded-[999px] later:[&>span]:[background:linear-gradient(90deg,_#8175ff,_#34d399)] later:[&>span]:[transition:width_.25s_ease]"
                  role="progressbar"
                  aria-label={`Payment progress: ${displayProgress}%`}
                  aria-valuenow={displayProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${Math.min(100, Math.max(0, displayProgress))}%` }} />
                </div>

                {reportPreviewActive && (
                  <small className="flex-none text-[#ffdf9e] later:text-[12.5px] later:leading-[1.5]" role="status">
                    Preview only — the payment below is NOT saved yet. Click SAVE APPLICANT to save it,
                    or close this modal to leave the Sales Report pending.
                  </small>
                )}
                {/* Role action panel, FULL WIDTH (shared layout): Admin = the Sales Report (only while one waits); Sales = the Add payment form. Nothing is rendered otherwise. */}
                {paySideVisible && (
                <div className="pay-action-panel grid gap-[10px] min-w-0 p-[12px_14px] border border-[#273044] rounded-[11px] [background:#0d1320] overflow-visible [&_.pay-side-head_h3]:text-[15px] [&_.pay-detail-list]:p-[10px_14px] [&_.pay-detail-list]:text-[13.5px] [&_.pay-detail-list_dt]:text-[13.5px] [&_.pay-detail-list_dd]:text-[13.5px] max-w-full">
                  {isAdminRole && (
                    <div className="grid gap-2 [.pay-action-panel_&]:grid [.pay-action-panel_&]:gap-[10px] [.pay-action-panel_&]:min-w-0">
                      <div className="pay-side-head later-3:[&_h3]:m-0 later-2:[&_h3]:text-[#edf0fa] later:[&_h3]:font-[700] later:[&_h3]:tracking-[.06em] [&_h3]:uppercase flex flex-none items-center justify-between gap-2 later-7:[&_h3]:text-[16px]">
                        <h3>Sales report</h3>
                        {pendingReport?.requested_at && <small className="text-[#9aa6c4] text-[10px] [.pay-action-panel_&]:text-[12.5px]">{formatDate(pendingReport.requested_at)}</small>}
                      </div>
                      {pendingReport ? (
                        reportExpanded ? (
                          <div className="grid flex-none gap-[7px] p-[10px] border border-[#3b4767] rounded-[10px] [background:#0c111d] [.pay-action-panel_&]:gap-[10px] [.pay-action-panel_&]:p-[14px] [.pay-action-panel_&]:max-h-[none] [.pay-action-panel_&]:overflow-visible">
                            <div className="flex items-start justify-between gap-2">
                              <div className="grid gap-[1px] later-5:[&_strong]:text-[#edf0fa] later-4:[&_strong]:text-[12px]">
                                <span className="text-[#9db2ff] text-[9px] font-[800] tracking-[.1em] uppercase [.pay-action-panel_&]:text-[12.5px]">Payment submission</span>
                                <strong>{pendingReport.action_label}</strong>
                              </div>
                              <button
                                type="button"
                                className="inline-grid flex-none w-[22px] h-[22px] p-0 place-items-center border border-transparent rounded-[7px] [background:transparent] text-[#aab4c8] text-[12px] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] later-5:hover:text-[#fff] hover:[background:#1a2133] hover:border-[#303a50] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px]"
                                aria-label="Collapse Sales Report"
                                onClick={() => setReportExpanded(false)}
                              >
                                <FaXmark aria-hidden="true" />
                              </button>
                            </div>
                            <dl className="pay-detail-list grid m-0 p-[7px_9px] border border-[#222b40] rounded-[8px] [background:#101521] gap-1 later:[&>div]:flex [&>div]:items-baseline [&>div]:justify-between later:[&>div]:gap-[10px] [&>div]:text-[11px] [&_dt]:flex-none later-3:[&_dt]:text-[#8f99b1] [&_dd]:m-0 later:[&_dd]:text-[#edf0fa] [&_dd]:text-right [&_dd]:[font-variant-numeric:tabular-nums] [&_dd]:[overflow-wrap:anywhere]">
                              <div>
                                <dt>Received by</dt>
                                <dd>{pendingReport.received_by || pendingReport.requested_by || 'Sales'}</dd>
                              </div>
                            </dl>
                            {pendingReport.action === 'create' && (pendingReport.entries || []).map((entry, index) => (
                              <dl key={`report-entry-${index}`} className="pay-detail-list grid m-0 p-[7px_9px] border border-[#222b40] rounded-[8px] [background:#101521] gap-1 later:[&>div]:flex [&>div]:items-baseline [&>div]:justify-between later:[&>div]:gap-[10px] [&>div]:text-[11px] [&_dt]:flex-none later-3:[&_dt]:text-[#8f99b1] [&_dd]:m-0 later:[&_dd]:text-[#edf0fa] [&_dd]:text-right [&_dd]:[font-variant-numeric:tabular-nums] [&_dd]:[overflow-wrap:anywhere]">
                                <div>
                                  <dt>Amount paid</dt>
                                  <dd>{moneyExact(entry.amount)}</dd>
                                </div>
                                <div>
                                  <dt>Payment type</dt>
                                  <dd>{entry.payment_type_label || paymentTypeLabel(entry.payment_type)}</dd>
                                </div>
                                <div>
                                  <dt>Payment method</dt>
                                  <dd>{entry.payment_method_label || paymentMethodLabel(entry.payment_method)}</dd>
                                </div>
                                <div>
                                  <dt>Date of payment</dt>
                                  <dd>{formatDate(entry.payment_date)}</dd>
                                </div>
                                {entry.remarks && (
                                  <div>
                                    <dt>Remarks</dt>
                                    <dd>{entry.remarks}</dd>
                                  </div>
                                )}
                              </dl>
                            ))}

                            {pendingReport.action === 'update' && (
                              <div className="grid p-[7px_9px] border border-[#222b40] rounded-[8px] [background:#101521] text-[#c8d1e6] text-[11px] gap-[3px] [&_p]:m-0 later-2:[&_span]:text-[#9aa6c4] [&_span]:font-[600]">
                                <p>
                                  <span>Current:</span>
                                  {pendingReport.target
                                    ? ` ${formatDate(pendingReport.target.payment_date)} · ${moneyExact(pendingReport.target.amount)} · ${pendingReport.target.payment_type_label}`
                                    : ' Entry no longer available.'}
                                </p>
                                <p>
                                  <span>Requested:</span>
                                  {pendingReport.changes
                                    ? ` ${formatDate(pendingReport.changes.payment_date)} · ${moneyExact(pendingReport.changes.amount)} · ${pendingReport.changes.payment_type_label}`
                                    : ' No changes.'}
                                </p>
                              </div>
                            )}

                            {pendingReport.action === 'delete' && (
                              <div className="grid p-[7px_9px] border border-[#222b40] rounded-[8px] [background:#101521] text-[#c8d1e6] text-[11px] gap-[3px] [&_p]:m-0 later-2:[&_span]:text-[#9aa6c4] [&_span]:font-[600]">
                                <p>
                                  <span>Delete:</span>
                                  {pendingReport.target
                                    ? ` ${formatDate(pendingReport.target.payment_date)} · ${moneyExact(pendingReport.target.amount)} · ${pendingReport.target.payment_type_label}`
                                    : ' Entry no longer available.'}
                                </p>
                              </div>
                            )}

                            <div className="flex flex-none flex-wrap items-center justify-end gap-2 [.pay-action-panel_&_.pay-mini-btn]:text-[13px] [.pay-action-panel_&_.pay-mini-btn]:p-[7px_14px] [.pay-action-panel_&_button]:text-[13px] [.pay-action-panel_&_button]:p-[7px_14px]">
                              <button
                                type="button"
                                className="p-[6px_12px] border border-[#3b4767] rounded-[9px] [background:transparent] text-[#c9d1e6] text-[11px] font-[600] cursor-pointer [transition:color_.15s_ease,_border-color_.15s_ease,_background_.15s_ease] [&:hover:not(:disabled)]:text-[#fff] [&:hover:not(:disabled)]:border-[#8175ff] [&:hover:not(:disabled)]:[background:rgba(129,_117,_255,_.08)] disabled:opacity-[.5] disabled:cursor-not-allowed focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px]"
                                disabled={!paymentStage?.can_return || acting || saving}
                                title={paymentStage?.can_return
                                  ? 'Reject the pending Sales Report and send it back to Sales with a note.'
                                  : 'Return unlocks while a Sales Report is awaiting confirmation.'}
                                onClick={() => setReturnForm({ note: '' })}
                              >
                                Return to Sales
                              </button>
                              {!reportPreviewActive && (
                                <button
                                  type="button"
                                  className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] later:p-[6px_12px] later:text-[11px]"
                                  disabled={acting || saving}
                                  onClick={confirmReportPreview}
                                >
                                  Confirm Payment
                                </button>
                              )}
                            </div>
                            {reportPreviewActive && (
                              <span className="text-[#6fe3b6] text-[10.5px] leading-[1.35] [.pay-action-panel_&]:text-[12.5px]">Preview loaded — click SAVE APPLICANT to save it.</span>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="relative mt-1 flex flex-none items-start gap-[9px] w-full p-[9px_10px] border border-[#273044] rounded-[10px] [background:#0c111d] cursor-pointer text-left [transition:border-color_.15s_ease,_background_.15s_ease] hover:border-[#3b4767] hover:[background:#10192c] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:2px] [.pay-action-panel_&]:p-[12px_14px]"
                            aria-expanded={reportExpanded}
                            onClick={() => setReportExpanded(true)}
                          >
                            <span className="grid flex-none w-[26px] h-[26px] place-items-center rounded-[50%] [background:linear-gradient(135deg,_#8175ff,_#6a5ed6)] text-[#fff] text-[9px] font-[700] tracking-[.03em] [.pay-action-panel_&]:w-[32px] [.pay-action-panel_&]:h-[32px] [.pay-action-panel_&]:text-[12px]" aria-hidden="true">{reportInitials}</span>
                            <span className="pay-report-meta grid min-w-0 gap-[2px] later-5:[&_strong]:text-[#edf0fa] later-3:[&_strong]:text-[11.5px] [&_strong]:leading-[1.3] later:[&_strong]:[overflow-wrap:anywhere] [.pay-action-panel_&_strong]:text-[14px]">
                              <strong>{pendingReport.requested_by || 'Sales'}</strong>
                              <small className="[.pay-report-meta_&]:text-[#9db2ff] [.pay-report-meta_&]:text-[10px] [.pay-report-meta_&]:leading-[1.3] [.pay-action-panel_.pay-report-meta_&]:text-[12.5px]">Sales turned over this payment</small>
                              <small className="[.pay-report-meta_&]:text-[#9ba5bd] [.pay-report-meta_&]:text-[9px] [.pay-report-meta_&]:tracking-[.03em] [.pay-report-meta_&]:uppercase later:[.pay-action-panel_&]:text-[12.5px]">{pendingReport.action_label} request</small>
                            </span>
                            {!reportPreviewActive && <span className="absolute -top-[3px] -right-[3px] w-[9px] h-[9px] rounded-[50%] [background:#ff5f6d] border-[2px] border-[#101521]" aria-hidden="true" />}
                          </button>
                        )
                      ) : (
                        <div className="grid flex-none place-items-center gap-[5px] p-[22px_12px] border border-dashed border-[#273044] rounded-[10px] text-[#9ba5bd] text-center later-3:[&_svg]:text-[#4b5570] later:[&_svg]:text-[16px] later-6:[&_strong]:text-[#c9d1e6] later-5:[&_strong]:text-[11.5px] later-4:[&_small]:text-[10.5px] [&_small]:leading-[1.35] later:[.pay-action-panel_&_small]:text-[12.5px]">
                          <FaClipboardCheck aria-hidden="true" />
                          <strong>No report to review</strong>
                          <small>Sales has not sent any payment request for this stage yet.</small>
                        </div>
                      )}
                    </div>
                  )}

                  {isSalesRole && paymentStage?.can_add_entry && (
                    <div className="grid gap-2 [.pay-action-panel_&]:grid [.pay-action-panel_&]:gap-[10px] [.pay-action-panel_&]:min-w-0">
                      {pendingReport && (
                        <p
                          className="m-0 p-[7px_10px] border border-[rgba(129,_117,_255,_.3)] rounded-[8px] text-[#c9d1e6] [background:rgba(129,_117,_255,_.07)] text-[10.5px] leading-[1.4] [cursor:help] [.pay-action-panel_&]:text-[12.5px]"
                          title="Sales Report pending. Your payment is not saved in the applicant record until Admin clicks SAVE APPLICANT."
                        >
                          Waiting for Admin confirmation. Not saved in the payment record yet.
                        </p>
                      )}
                      <div className="pay-entry grid flex-none gap-2 p-[10px] border border-[#273044] rounded-[10px] [background:#0c111d] [&_label]:grid later:[&_label]:gap-1 later:[&_label]:text-[#9aa6c4] [&_input]:w-full later:[&_input]:min-h-[30px] later-4:[&_input]:p-[6px_9px] later-4:[&_input]:border later-3:[&_input]:border-[#273044] later-2:[&_input]:rounded-[7px] later-3:[&_input]:[background:#080c16] later-3:[&_input]:text-[#e7ebf5] later-4:[&_input]:text-[12px] [&_select]:w-full [&_select]:min-h-[30px] later-2:[&_select]:p-[6px_9px] later-2:[&_select]:border later:[&_select]:border-[#273044] later:[&_select]:rounded-[7px] later-2:[&_select]:[background:#080c16] later:[&_select]:text-[#e7ebf5] later-2:[&_select]:text-[12px] later:[&_input:focus]:[outline:none] later-3:[&_input:focus]:border-[#8175ff] later-2:[&_input:focus]:[box-shadow:0_0_0_2px_rgba(129,_117,_255,_.12)] [&_select:focus]:[outline:none] later-2:[&_select:focus]:border-[#8175ff] later:[&_select:focus]:[box-shadow:0_0_0_2px_rgba(129,_117,_255,_.12)] [&_.ap-pay-card-note]:text-[#9ba5bd] [&_.ap-pay-card-note]:text-[10px] later-2:[&_label]:text-[13.5px] [.pay-action-panel_&]:grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] [.pay-action-panel_&]:[align-items:end] [.pay-action-panel_&]:gap-[12px_14px] [.pay-action-panel_&]:p-3 [.pay-action-panel_&_.pay-side-head]:col-span-full [.pay-action-panel_&_label]:text-[12.5px] [.pay-action-panel_&_input]:min-h-[36px] [.pay-action-panel_&_input]:text-[13.5px] [.pay-action-panel_&_select]:min-h-[36px] [.pay-action-panel_&_select]:text-[13.5px]">
                        <div className="pay-side-head later-3:[&_h3]:m-0 later-2:[&_h3]:text-[#edf0fa] later:[&_h3]:font-[700] later:[&_h3]:tracking-[.06em] [&_h3]:uppercase flex flex-none items-center justify-between gap-2 later-7:[&_h3]:text-[16px]">
                          <h3>Add payment</h3>
                          {paymentEntry?.id && <span className="text-[#9db2ff] text-[10px] leading-[1.3] [.pay-action-panel_&]:text-[12.5px]">Edit payment (request Admin approval)</span>}
                        </div>
                        <label htmlFor="ap-pay-entry-date">
                          Date paid
                          <input
                            id="ap-pay-entry-date"
                            type="date"
                            max={localDateInputValue()}
                            value={entryDraft.payment_date || ''}
                            onChange={(e) => setPaymentEntry({ ...entryDraft, payment_date: e.target.value })}
                          />
                        </label>
                        <label htmlFor="ap-pay-entry-amount">
                          Amount
                          <input
                            id="ap-pay-entry-amount"
                            ref={entryAmountRef}
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder={entryMaxAmount > 0 ? `Up to ${moneyExact(entryMaxAmount)}` : '—'}
                            title={entryMaxAmount > 0
                              ? `Any amount above ₱0, up to ${moneyExact(entryMaxAmount)}.`
                              : 'Nothing is left to pay on this record.'
                            }
                            aria-invalid={Boolean(entryAmountIssue)}
                            value={formatAmountInput(entryDraft.amount)}
                            onChange={onEntryAmountChange}
                          />
                          {entryAmountIssue && String(entryDraft.amount ?? '').trim() !== '' && (
                            <small className="text-[#ff9ca3] leading-[1.35] later:text-[12px]">{entryAmountIssue}</small>
                          )}
                          {!paymentEntry?.id && entryType === 'downpayment' && (
                            <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">Minimum downpayment: {moneyExact(downpaymentCents)} — you may pay more.</small>
                          )}
                          {!paymentEntry?.id && entryType === 'installment_payment' && installmentBase != null && (
                            <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">Minimum installment: {moneyExact(installmentCents)} — you may pay more (advance).</small>
                          )}
                        </label>
                        <label htmlFor="ap-pay-entry-type">
                          Type of payment
                          <select
                            id="ap-pay-entry-type"
                            value={entryType}
                            disabled={entrySettlesBalance || availableEntryTypes.length <= 1}
                            onChange={(e) => {
                              const type = e.target.value;
                              setPaymentEntry({
                                ...entryDraft,
                                payment_type: type,
                                // Picking a type fills its fixed expected amount.
                                amount: String(expectedAmountForType(type)),
                              });
                            }}
                          >
                            {availableEntryTypes.map((type) => (
                              <option key={type} value={type}>{paymentTypeLabel(type)}</option>
                            ))}
                          </select>
                          {entrySettlesBalance && (
                            <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">Set automatically — this amount pays the whole remaining balance.</small>
                          )}
                          {!entrySettlesBalance && entrySettlesWithOneInstallment && (
                            <small className="text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]">The remaining balance is at or below the minimum installment, so Full Payment is the only option.</small>
                          )}
                        </label>
                        <label htmlFor="ap-pay-entry-method">
                          Payment method
                          <select
                            id="ap-pay-entry-method"
                            value={entryDraft.payment_method || 'cash'}
                            onChange={(e) => setPaymentEntry({ ...entryDraft, payment_method: e.target.value })}
                          >
                            {PAYMENT_METHOD_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                        {/* Received by: session-derived. The server stores the user
                            and role ids itself, never anything sent from here. */}
                        <label htmlFor="ap-pay-entry-received">
                          Received by
                          <select id="ap-pay-entry-received" value="session" disabled title="Filled from the signed-in account">
                            <option value="session">{receivedByLabel}</option>
                          </select>
                        </label>
                        <div className="flex flex-wrap gap-2 [.pay-action-panel_.pay-entry_&]:col-span-full">
                          <button
                            type="button"
                            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] later:p-[6px_12px] later:text-[11px]"
                            disabled={acting || !entryDraft.payment_date || Boolean(entryAmountIssue)}
                            title={entryAmountIssue || undefined}
                            onClick={() => void savePaymentEntry()}
                          >
                            {paymentEntry?.id ? 'Save changes' : 'ADD PAYMENT'}
                          </button>
                          {paymentEntry?.id && (
                            <button
                              type="button"
                              className="p-[6px_12px] border border-[#3b4767] rounded-[9px] [background:transparent] text-[#c9d1e6] text-[11px] cursor-pointer [&:hover:not(:disabled)]:border-[#8175ff] [&:hover:not(:disabled)]:text-[#fff] disabled:opacity-[.5] disabled:cursor-not-allowed focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:1px]"
                              disabled={acting}
                              onClick={() => setPaymentEntry(null)}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                )}
                {/* Installment plan (Phase 4): minimums, due dates, estimates. */}
                {paymentStage?.has_total_required && Number(paymentStage?.total_required_amount) > 0 && (
                  <InstallmentPlanPanel
                    installment={paymentStage?.installment}
                    pendingAmount={paymentStage?.pending_amount}
                    canSetSchedule={Boolean(paymentStage?.can_set_schedule)}
                    busy={acting}
                    onSave={savePaymentSchedule}
                  />
                )}
                <h4 className="m-[2px_0_0] flex-none text-[#edf0fa] font-[700] tracking-[.05em] uppercase later:text-[12.5px] later:mt-[6px]">Payment record</h4>

                <div className="flex flex-col min-w-0 overflow-auto [overscroll-behavior:contain] border border-[#273044] rounded-[10px] [background:#0c111d] [&::-webkit-scrollbar]:w-[7px] [&::-webkit-scrollbar]:h-[7px] [&::-webkit-scrollbar-thumb]:[background:#39435b] [&::-webkit-scrollbar-thumb]:rounded-[99px] [&_table]:w-full [&_table]:[border-collapse:collapse] [&_th]:border-b [&_th]:border-b-[#222b40] [&_th]:text-left [&_th]:[vertical-align:top] [&_td]:border-b [&_td]:border-b-[#222b40] [&_td]:text-left [&_td]:[vertical-align:top] [&_thead_th]:top-0 [&_thead_th]:z-1 [&_thead_th]:[background:#0c111d] [&_thead_th]:border-b [&_thead_th]:border-b-[#273044] [&_thead_th]:text-[#9aa6c4] [&_thead_th]:font-[700] [&_thead_th]:tracking-[.05em] [&_thead_th]:uppercase [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover_td]:[background:rgba(129,_117,_255,_.04)] later-2:max-h-[none] later:min-h-0 later:overflow-x-auto later:[overflow-y:visible] later:flex-none later:[&_table]:min-w-[760px] later-2:[&_table]:text-[13.5px] later:[&_th]:p-[10px_14px] later:[&_td]:p-[10px_14px] later:[&_thead_th]:static later:[&_thead_th]:text-[12px] [&_td:first-child]:whitespace-nowrap [&_th:first-child]:whitespace-nowrap [&_td:nth-child(2)]:whitespace-nowrap [&_td:nth-child(2)]:[font-variant-numeric:tabular-nums] max-[821px]:later-2:max-h-[none]">
                  <table>
                    <thead>
                      <tr>
                        <th>Date paid</th>
                        <th>Amount</th>
                        <th>Payment type</th>
                        <th>Payment method</th>
                        {isSalesRole && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {hasPaymentRows ? (
                        <>
                          {(paymentStage?.entries || []).map((entry) => {
                            const previewUpdate = reportPreviewActive
                              && pendingReport?.action === 'update'
                              && Number(pendingReport.payment_id) === Number(entry.id);
                            const previewDelete = reportPreviewActive
                              && pendingReport?.action === 'delete'
                              && Number(pendingReport.payment_id) === Number(entry.id);
                            const shown = previewUpdate && pendingReport.changes
                              ? { ...entry, ...pendingReport.changes }
                              : entry;
                            // Sales' edit/delete request is still waiting for Admin.
                            const pendingChange = isSalesRole && pendingReport
                              && Number(pendingReport.payment_id) === Number(entry.id)
                              && ['update', 'delete'].includes(pendingReport.action);
                            return (
                              <tr key={entry.id} className={previewDelete ? '[&_td]:text-[#fb7185]' : undefined}>
                                <td>
                                  {formatDate(shown.payment_date)}
                                  {previewUpdate && <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Preview change</span>}
                                  {previewDelete && <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Will be deleted</span>}
                                  {pendingChange && <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Pending</span>}
                                </td>
                                <td>{moneyExact(shown.amount)}</td>
                                <td>
                                  <span className="text-[#d5ddef]">{shown.payment_type_label || paymentTypeLabel(shown.payment_type)}</span>
                                  {shown.remarks && <small className="block mt-[2px] text-[#8f99b1] text-[10px] leading-[1.3] [overflow-wrap:anywhere]">{shown.remarks}</small>}
                                </td>
                                <td>{shown.payment_method_label || paymentMethodLabel(shown.payment_method)}</td>
                                {isSalesRole && (
                                  <td>
                                    {entry.editable ? (
                                      <div className="row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative flex flex-wrap later:gap-2">
                                        <button
                                          type="button"
                                          className="ap-text-button"
                                          disabled={acting}
                                          onClick={() => setPaymentEntry({
                                            id: entry.id,
                                            payment_date: entry.payment_date || '',
                                            amount: String(entry.amount ?? ''),
                                            payment_type: entry.payment_type || 'downpayment',
                                            remarks: entry.remarks || '',
                                          })}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          className="text-[#ff8d94]"
                                          disabled={acting}
                                          onClick={() => void removePaymentEntry(entry)}
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    ) : '—'}
                                  </td>
                                )}
                              </tr>
                            );
                          })}

                          {isSalesRole && paymentDrafts.map((draft, index) => (
                            <tr key={`draft-${index}`} className="[background:rgba(109,_124,_255,_.06)]">
                              <td>
                                {formatDate(draft.payment_date)}
                                <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Draft</span>
                              </td>
                              <td>{moneyExact(draft.amount)}</td>
                              <td>
                                <span className="text-[#d5ddef]">{paymentTypeLabel(draft.payment_type)}</span>
                              </td>
                              <td>{paymentMethodLabel(draft.payment_method)}</td>
                              <td>
                                <button type="button" className="text-[#ff8d94]" disabled={acting} onClick={() => removePaymentDraft(index)}>
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}

                          {previewCreateEntries.map((entry, index) => (
                            <tr key={`preview-${index}`} className="[background:rgba(109,_124,_255,_.06)]">
                              <td>
                                {formatDate(entry.payment_date)}
                                <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Preview</span>
                              </td>
                              <td>{moneyExact(entry.amount)}</td>
                              <td>
                                <span className="text-[#d5ddef]">{entry.payment_type_label || paymentTypeLabel(entry.payment_type)}</span>
                              </td>
                              <td>{entry.payment_method_label || paymentMethodLabel(entry.payment_method)}</td>
                              {isSalesRole && <td>—</td>}
                            </tr>
                          ))}

                          {/* Sales' own submitted report: kept visible (and after a
                              refresh) while Admin has not confirmed it yet. */}
                          {salesPendingEntries.map((entry, index) => (
                            <tr key={`pending-${index}`} className="[background:rgba(109,_124,_255,_.06)]">
                              <td>
                                {formatDate(entry.payment_date)}
                                <span className="border-[#273044] rounded-[999px] font-[700] tracking-[.03em] uppercase ml-[6px] later:p-[1px_6px] later:border-0 later:text-[#a5b4fc] [background:rgba(109,_124,_255,_.16)] later:text-[9px] later:cursor-default">Pending</span>
                              </td>
                              <td>{moneyExact(entry.amount)}</td>
                              <td>
                                <span className="text-[#d5ddef]">{entry.payment_type_label || paymentTypeLabel(entry.payment_type)}</span>
                              </td>
                              <td>{entry.payment_method_label || paymentMethodLabel(entry.payment_method)}</td>
                              {isSalesRole && <td>—</td>}
                            </tr>
                          ))}
                        </>
                      ) : (
                        <tr>
                          <td colSpan={isSalesRole ? 5 : 4} className="p-[18px_12px]">
                            <div className="grid [justify-items:center] gap-1 text-[#8f99b1] text-center later-2:[&_svg]:text-[#6d7a99] [&_svg]:text-[18px] later-4:[&_strong]:text-[#cfd6ea] later-3:[&_strong]:text-[11.5px] later:[&_strong]:font-[600] later-5:[&_small]:text-[#8f99b1] later-4:[&_small]:text-[10.5px]">
                              <FaClipboardCheck aria-hidden="true" />
                              <strong>No payment records yet</strong>
                              <small>
                                {isSalesRole
                                  ? 'Add the first payment to start this record.'
                                  : 'Payments appear here once Sales reports them.'}
                              </small>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                  {isAdminRole && paymentStage?.state === 'for_review' && !reportPreviewActive && (
                  <small className="pay-muted-line flex-none text-[#9ba5bd] later:text-[12.5px] later:leading-[1.5]" role="status">
                    Click Confirm Payment on the Sales Report card to fill this view, then SAVE APPLICANT to save it.
                  </small>
                )}
                </div>

                </div>
              </section>
            )}

            {stage === 'payment_submitted' && doneSections}

            {/* Later stages (For Approval / Approved / Active Franchise): the
                payment record is read-only. The numbers come from the same
                derived payload the Payment Record stage uses. */}
            {paymentsVisible && !paymentAdvancedUi && stage !== 'payment_submitted' && PAYMENT_PANEL_FROM.includes(stage) && (
              <PaymentRecordPanel editing={editing} readOnly busy={false} onSetAmount={() => {}} onSubmitEntry={() => {}} onVerify={() => {}} onReturn={() => {}} onError={setActionError} />
            )}
            {paymentsVisible && paymentAdvancedUi && stage !== 'payment_submitted' && PAYMENT_PANEL_FROM.includes(stage) && (
              <section className="ap-section [.ap-section+&]:[border-top:1px_solid_var(--ap-border)] m-[0_0_17px] later:p-[17px] border border-[#2a3041] rounded-[13px] [background:#141a28] [&_h3]:m-0 [&_h3]:text-[#edf0fa] later-2:[&_h3]:text-[13px] [&_h3]:font-[750] max-[721px]:later-2:p-[13px] [#update-applicant-form_&_h3]:text-[12px] later:[#update-applicant-form_&]:p-3 later:[#update-applicant-form_&]:mb-[10px] max-[721px]:later-2:[#update-applicant-form_&]:p-[11px] later:[#update-applicant-form_&]:border-[#273044] later:[#update-applicant-form_&]:rounded-[9px] later:[#update-applicant-form_&]:[background:#101521] [#update-applicant-form_&]:[box-shadow:none] ap-payment-ledger" aria-labelledby="ap-payment-ledger-title">
                <div className="[&_h3]:m-0 [&_h3]:text-[0.78rem] [&_h3]:tracking-[0.09em] [&_h3]:uppercase flex later:items-center justify-between gap-3 later:[&_small]:text-[#9ba5bd] later:[&_small]:text-[11px] [&_small]:font-[500] [&_small]:whitespace-nowrap later:mb-[15px] [#update-applicant-form_&]:mb-[11px]">
                  <h3 id="ap-payment-ledger-title">Payment Record</h3>
                  {paymentStage?.state_label && <small className="p-[3px_9px] border border-[#303749] rounded-[999px] text-[#9aa6c4] text-[10px] font-[700] tracking-[.04em] uppercase">{paymentStage.state_label}</small>}
                </div>
                <div className="grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[10px] max-[761px]:later:grid-cols-[1fr]">
                  <article className="grid gap-[6px] [align-content:start] p-[11px_13px] border border-[#303749] rounded-[11px] [background:#0c111d]">
                    <span className="text-[#9aa6c4] text-[10px] tracking-[.05em] uppercase">Total required</span>
                    <strong className="text-[#edf0fa] text-[17px] [font-variant-numeric:tabular-nums]">{moneyExact(paymentStage?.total_required_amount)}</strong>
                    {paymentStage?.package_name && <small className="ap-pay-card-note text-[#9ba5bd] text-[10px] leading-[1.4]">{paymentStage.package_name}</small>}
                  </article>
                  <article className="grid gap-[6px] [align-content:start] p-[11px_13px] border border-[#303749] rounded-[11px] [background:#0c111d]">
                    <span className="text-[#9aa6c4] text-[10px] tracking-[.05em] uppercase">Total paid</span>
                    <strong className="text-[#edf0fa] text-[17px] [font-variant-numeric:tabular-nums]">{moneyExact(paymentStage?.total_paid_amount)}</strong>
                    <small className="ap-pay-card-note text-[#9ba5bd] text-[10px] leading-[1.4]">{moneyExact(paymentStage?.verified_amount)} verified</small>
                  </article>
                  <article className="grid gap-[6px] [align-content:start] p-[11px_13px] border border-[#303749] rounded-[11px] [background:#0c111d]">
                    <span className="text-[#9aa6c4] text-[10px] tracking-[.05em] uppercase">Remaining balance</span>
                    <strong className="text-[#edf0fa] text-[17px] [font-variant-numeric:tabular-nums]">{moneyExact(paymentStage?.balance_including_pending)}</strong>
                    <span className={`[justify-self:start] p-[2px_8px] rounded-[999px] text-[10px] font-[700] ap-pay-badge-${paymentStage?.payment_status || 'unpaid'}`}>
                      {paymentStage?.payment_status_label || 'Unpaid'}
                    </span>
                  </article>
                </div>

                {/* Applicant record: the saved discount snapshot. */}
                <DiscountSnapshot
                  compact
                  original={paymentStage?.original_total_required_amount}
                  percent={paymentStage?.discount_percent}
                  promo={paymentStage?.promo_name}
                  final={paymentStage?.has_total_required ? paymentStage?.total_required_amount : null}
                  setBy={paymentStage?.discount_set_by}
                  setAt={paymentStage?.discount_set_at}
                />

                {(paymentStage?.entries || []).length ? (
                  <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer ap-pay-record-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Date paid</th>
                          <th>Amount</th>
                          <th>Payment type</th>
                          <th>Payment method</th>
                          <th>Received by</th>
                        </tr>
                      </thead>
                      <tbody>{paymentStage.entries.map((entry) => (
                        <tr key={entry.id}>
                          <td>{formatDate(entry.payment_date)}</td>
                          <td>{moneyExact(entry.amount)}</td>
                          <td>{entry.payment_type_label || paymentTypeLabel(entry.payment_type)}</td>
                          <td>{entry.payment_method_label || paymentMethodLabel(entry.payment_method)}</td>
                          <td>{entry.received_by || '—'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : <p className="m-0 italic later:text-[#9ba5bd] later:text-[12px]">No payment records yet.</p>}
                {paymentStage?.fully_paid_on && (
                  <p className="m-0 italic later:text-[#9ba5bd] later:text-[12px]">Fully paid on {formatDate(paymentStage.fully_paid_on)}.</p>
                )}
              </section>
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
      {returnForm && editing && createPortal(
        <div
          className="fixed inset-0 later:z-2147483001 grid place-items-center later:p-[18px] later:[background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setReturnForm(null); }}
        >
          <div className="[&_label]:grid [&_label]:gap-[6px] [&_label]:text-[0.78rem] [&_label]:font-[600] [&_label]:text-[color:var(--ap-muted)] [&_input]:[box-sizing:border-box] [&_input]:w-full later:[&_input]:p-[10px_12px] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later:[&_input]:text-[0.9rem] later:[&_input]:text-[color:var(--ap-text)] later:[&_input]:[background:var(--ap-bg)] later:[&_input]:[border:1px_solid_var(--ap-border-2)] [&_input]:rounded-[10px] [&_input:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_input:focus]:[outline-offset:1px] grid gap-[14px] [border:1px_solid_var(--ap-border-2)] later:w-[min(100%,_390px)] p-[22px] later:border later:border-[#343b50] rounded-[16px] later:[background:#111624] text-[#edf0fa] later:[box-shadow:0_22px_70px_rgba(0,0,0,.5)] later:[&_h3]:m-[0_0_18px] later-3:[&_h3]:text-[15px] [&.ap-record-card]:relative [&.ap-record-card]:w-[min(100%,_440px)] [&.ap-record-card]:max-h-[calc(100dvh_-_36px)] [&.ap-record-card]:p-0 [&.ap-record-card]:overflow-x-hidden [&.ap-record-card]:overflow-y-auto [&.ap-record-card]:border [&.ap-record-card]:border-[#2a3550] [&.ap-record-card]:rounded-[14px] [&.ap-record-card]:[background:linear-gradient(180deg,_#131b2e_0%,_#0f1626_100%)] later-5:[&.ap-record-card]:text-[#e7ebf5] [&.ap-record-card]:[box-shadow:0_24px_64px_rgba(2,_6,_18,_.6),_0_0_0_1px_rgba(129,_117,_255,_.05)] ap-record-card [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[0_0_auto_0] [&::before]:h-[2px] [&::before]:[background:linear-gradient(90deg,_#5b6cff,_#8175ff_55%,_#3b82f6)] [&::before]:opacity-[.9] later:[&:has(.ap-pay-split)]:w-[min(100%,_960px)] [&_.ap-subform-actions]:[border-top:1px_dashed_#2a3550] [&_.ap-subform-actions]:[background:rgba(8,_12,_22,_.45)] max-[481px]:[&_.ap-subform-actions]:p-[12px_16px] max-[481px]:[&_.ap-subform-actions]:flex-wrap" role="dialog" aria-modal="true" aria-labelledby="ap-return-title">
            <header className="flex items-center gap-3 p-[20px_22px_16px] [border-bottom:1px_dashed_#2a3550] max-[481px]:later:p-[16px_16px_14px]">
              <span className="grid flex-none place-items-center w-[36px] h-[36px] rounded-[10px] border border-[rgba(129,_117,_255,_.28)] [background:rgba(129,_117,_255,_.12)] text-[#aeb6ff] text-[15px]" aria-hidden="true"><FaClipboardCheck /></span>
              <div className="flex-1 min-w-0 [.ap-record-card_&_h3]:m-[3px_0_0] [.ap-record-card_&_h3]:text-[#f1f3fb] [.ap-record-card_&_h3]:text-[15px] [.ap-record-card_&_h3]:leading-[1.3] [.ap-record-card_&_h3]:[overflow-wrap:anywhere]">
                <span className="block text-[#8f9bbd] text-[10px] font-[700] tracking-[.14em] uppercase">Return payment</span>
                <h3 id="ap-return-title">Return to Sales — {editing.full_name}</h3>
              </div>
            </header>
            <dl className="m-0 p-[6px_22px] [.ap-pay-split_&]:p-0 max-[481px]:later:p-[4px_16px]">
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Record</dt><dd>Goes back to Collecting. Sales can edit the entries again.</dd></div>
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1">
                <dt><label htmlFor="ap-return-note">Note to Sales</label></dt>
                <dd>
                  <textarea
                    id="ap-return-note"
                    autoFocus
                    rows={3}
                    value={returnForm.note}
                    placeholder="What Sales has to correct"
                    onChange={(e) => setReturnForm({ ...returnForm, note: e.target.value })}
                  />
                </dd>
              </div>
            </dl>
            <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">The note is shown to Sales on the Payment Record stage.</p>
            <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
              <span className="flex-1" />
              <button type="button" onClick={() => setReturnForm(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
                disabled={acting || !returnForm.note.trim()}
                onClick={() => void returnPaymentToSales()}
              >
                Return to Sales
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}

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
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Assessments</dt><dd>{QUALIFICATION_ITEMS.filter(({ key }) => draft.milestones[key]).length} of {QUALIFICATION_ITEMS.length} saved by Sales</dd></div>
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Qualified date</dt><dd>{formatDate(new Date().toISOString())}</dd></div>
              <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Confirmed by</dt><dd className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]"><FaUserCheck aria-hidden="true" /> {authLabel}</dd></div>
            </dl>
            <label className="block p-[4px_22px_12px] max-[481px]:later:p-[4px_16px_10px]">
              <span>Remarks (required, at least 5 characters)</span>
              <textarea
                rows={3}
                value={qualifiedRemarks}
                onChange={(e) => setQualifiedRemarks(e.target.value)}
                placeholder="What was checked, and why the applicant qualifies"
              />
            </label>
            <p className="m-0 p-[4px_22px_16px] text-[#7f8aa8] text-[10.5px] leading-[1.5] max-[481px]:later:p-[4px_16px_14px]">Confirm this applicant as Qualified? This cannot be undone.</p>
            <footer className="ap-subform-actions [&_.spacer]:flex-1 flex items-center gap-2 later:mt-5">
              <span className="flex-1" />
              <button type="button" onClick={() => setQualifiedConfirm(false)}>Cancel</button>
              <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => void performStageAction('qualified', { remarks: qualifiedRemarks.trim() })} disabled={acting || qualifiedRemarks.trim().length < 5}>
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
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Total required</dt><dd>{money(editing.payment_summary?.total_required_amount)}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Total paid</dt><dd className="later:inline-flex items-center later:gap-2 font-[600] [&_svg]:flex-none [&_svg]:text-[#45d991]">{money(editing.payment_summary?.verified_amount)}</dd></div>
                  <div className="grid grid-cols-[104px_minmax(0,_1fr)] items-center gap-3 p-[12px_0] [border-bottom:1px_dotted_#26314a] last:border-b-0 [&_dt]:m-0 later:[&_dt]:text-[#8f9bbd] later:[&_dt]:text-[11px] [&_dt]:font-[600] [&_dt_label]:m-0 [&_dt_label]:text-[#8f9bbd] [&_dt_label]:text-[11px] [&_dt_label]:font-[600] [&_dd]:m-0 [&_dd]:min-w-0 later:[&_dd]:text-[#edf0fa] later:[&_dd]:text-[13px] [&_dd]:[overflow-wrap:anywhere] [&_input]:[box-sizing:border-box] [&_input]:w-full [&_input]:min-h-[34px] later-2:[&_input]:p-[6px_0] later-2:[&_input]:border-0 later-2:[&_input]:border-b later-2:[&_input]:border-b-[#34405c] later:[&_input]:rounded-[0] [&_input]:[outline:none] later-2:[&_input]:[background:transparent] later-2:[&_input]:text-[#edf0fa] [&_input]:[color-scheme:dark] [&_input]:[font-family:inherit] [&_input]:[font-weight:inherit] [&_input]:[font-style:inherit] [&_input]:[line-height:inherit] later-2:[&_input]:text-[13px] later-2:[&_input:focus]:border-b-[#8175ff] later:[&_input:focus]:[box-shadow:0_1px_0_0_#8175ff] max-[481px]:later:grid-cols-[1fr] max-[481px]:later-2:gap-1"><dt>Remaining balance</dt><dd>{money(editing.payment_summary?.remaining_balance)}</dd></div>
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

      {/* Confirm Brand, second step: the lock is permanent. */}
      {brandConfirmDialog && editing && (
        <Dialog
          title="Lock the brand?"
          onClose={() => setBrandConfirmDialog(null)}
          size="small"
          zIndex={2147482500}
          footer={(
            <>
              <button type="button" onClick={() => setBrandConfirmDialog(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]"
                disabled={acting}
                onClick={() => void confirmBrand()}
              >
                {acting ? 'Saving…' : 'Continue'}
              </button>
            </>
          )}
        >
          <p className="m-0 text-[14px] leading-[1.6]">
            This locks <strong>{brandConfirmDialog.final_brand?.name || 'this brand'}</strong> for <strong>{editing.full_name}</strong>. The brand cannot be changed after this. Continue?
          </p>
        </Dialog>
      )}

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
          footer={(
            <>
              <button type="button" onClick={() => setAssignForm(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]"
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
