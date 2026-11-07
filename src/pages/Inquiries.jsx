import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { FaPlus, FaRightLeft, FaRotateLeft, FaInbox, FaTriangleExclamation, FaXmark, FaPen } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, titleCase } from '../lib/format';
import { EmptyState, Field, LoadingState, Modal, Notice, StatusBadge } from '../components/ApiUi';
import { useAuth } from '../context/AuthContext';
import { brandColor } from '../lib/brandColors';
import { initialsOf } from '../lib/initials';
import { can } from '../lib/roleAccess';
import RecordCode from '../components/RecordCode';

const initialForm = {
  first_name: '',
  last_name: '',
  source: '',
  email: '',
  phone: '',
  viber_number: '',
  preferred_brand_id: '', // shown to users as "Concept"
  current_city: '',
  preferred_franchise_location: '',
  remarks: '',
};

const sourceOptions = ['facebook', 'gmail', 'viber', 'walk_in', 'referral'];

// ---- Pagination settings ----
const PAGE_SIZE = 8;   // records per page
const PAGE_WINDOW = 4; // page numbers visible at a time

const PHONE_LENGTH = 11;
// Numbers lang, hanggang 11 digits.
const digitsOnly = (value) => String(value || '').replace(/\D/g, '').slice(0, PHONE_LENGTH);

/**
 * Renders its children straight into <body>.
 *
 * Why: when a modal / panel lives inside the page, any ancestor with transform / filter /
 * backdrop-filter / animation (or an inner scroll container) becomes the reference for
 * `position: fixed`. The element then scrolls away with the page instead of staying in the
 * viewport. Portaling it to <body> avoids all of that.
 *
 * Used for the modals AND for the read panel (inquiry drawer), so the panel always follows
 * the screen while scrolling up and down.
 *
 * The wrapper keeps the `page-container` class (so page-scoped CSS rules still match) and
 * uses `display: contents`, so it creates no box of its own and cannot affect the layout.
 */
function ModalPortal({ children }) {
  return createPortal(
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] modal-portal-root" style={{ display: 'contents' }}>
      {children}
    </div>,
    document.body,
  );
}

// Phone input: hindi makakapag-type ng letters/symbols, hindi lalampas ng 11 digits.
function PhoneInput({ value, onChange, required = false, label }) {
  const handleKeyDown = (event) => {
    // Hayaan ang shortcuts (Ctrl/Cmd+C/V/A...) at control keys (Backspace, Arrow, Tab, etc.)
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length > 1) return;
    if (!/^\d$/.test(event.key)) event.preventDefault();
  };

  const handlePaste = (event) => {
    event.preventDefault();
    const pasted = (event.clipboardData || window.clipboardData).getData('text');
    const el = event.target;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(digitsOnly(`${value.slice(0, start)}${pasted}${value.slice(end)}`));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      required={required}
      maxLength={PHONE_LENGTH}
      placeholder="09"
      aria-label={label}
      title="Must be exactly 11 digits (e.g. 09123456789)"
      value={value}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onChange={(e) => onChange(digitsOnly(e.target.value))}
    />
  );
}

/**
 * Pagination for the Leads & inquiries table.
 * - Hidden completely when there are PAGE_SIZE records or fewer.
 * - Shows at most PAGE_WINDOW page numbers in a sliding window (1 2 3 4 -> 3 4 5 6 ...).
 * - Record count on the left, controls on the right.
 * Data comes from the API `meta` (total, per_page, last_page, current_page).
 */
function InquiryPagination({ meta, page, onPage }) {
  const total = Number(meta?.total ?? 0);
  const perPage = Number(meta?.per_page ?? PAGE_SIZE) || PAGE_SIZE;
  const last = Number(meta?.last_page ?? Math.ceil(total / perPage));
  if (!total || total <= PAGE_SIZE || last <= 1) return null;

  const current = Math.min(Math.max(Number(meta?.current_page ?? page), 1), last);
  const from = (current - 1) * perPage + 1;
  const to = Math.min(current * perPage, total);

  // The active page sits in the 3rd slot when possible, and the window never runs past the last page.
  const start = Math.max(1, Math.min(current - 2, last - PAGE_WINDOW + 1));
  const pages = Array.from({ length: Math.min(PAGE_WINDOW, last) }, (_, index) => start + index);

  return (
    <nav className="inquiry-pagination flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Inquiries pagination">
      <span className="page-count">Showing {from} to {to} of {total} leads</span>
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

// Sort / filter control: one dropdown whose content follows the category chosen with the icon button.
const SORT_LABELS = ['Default sort', 'By branch', 'Sort by date', 'By source'];
const SORT_SOURCES = [
  { value: 'gmail', label: 'Gmail' },
  { value: 'viber', label: 'Viber' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'walk_in', label: 'Walk in' },
  { value: 'referral', label: 'Referral' },
];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const actionMessages = {
  endorse: 'Inquiry endorsed to the next team successfully.',
  convert: 'Inquiry converted into an applicant successfully.',
  unconvert: 'Conversion undone. The applicant record was removed.',
  archive: 'Inquiry archived.',
  restore: 'Inquiry restored to the pipeline.',
  delete: 'Inquiry deleted.',
};

const actionCopy = {
  convert: {
    title: 'Convert inquiry to applicant?',
    button: 'Convert inquiry',
    body: 'This creates an applicant record and moves the lead into the franchise application pipeline.',
  },
  unconvert: {
    title: 'Undo this conversion?',
    button: 'Undo conversion',
    body: 'This removes the applicant record created from this lead and returns the inquiry to the pipeline.',
  },
  archive: {
    title: 'Archive this inquiry?',
    button: 'Archive inquiry',
    body: 'The inquiry is hidden from the active pipeline and can be restored later from Admin settings.',
  },
  restore: {
    title: 'Restore this inquiry?',
    button: 'Restore inquiry',
    body: 'The inquiry returns to the active pipeline with its original details.',
  },
  delete: {
    title: 'Delete this inquiry?',
    button: 'Delete permanently',
    body: 'This removes the lead permanently. Archive instead if you may need the record later.',
  },
  endorse: {
    title: 'Endorse this inquiry?',
    button: 'Endorse inquiry',
    body: 'This advances the lead for follow-up by the responsible sales team.',
  },
};

// Works for new records (first_name / last_name) and older ones (lead_name only).
const leadDisplayName = (inquiry) => {
  const full = [inquiry.first_name, inquiry.last_name].filter(Boolean).join(' ').trim();
  return full || inquiry.lead_name || '—';
};

// Every lead is identified by its permanent Lead ID (LD-YYYY-NNNNN) — never a row
// number or the database id. Archived rows also show their Archive ID.
const archiveLabel = (inquiry) => {
  if (!inquiry.archived_at) return null;
  const log = inquiry.current_archive_log;
  return log ? `Archive ID ${log.archive_id}` : 'Archived';
};

/** The inquiry panel header: labelled, read-only IDs (never shown in the table). */
function LeadIds({ inquiry }) {
  const archived = archiveLabel(inquiry);
  return (
    <dl className="flex flex-wrap gap-[6px_18px] m-[6px_0_0] [&_div]:grid [&_div]:gap-[1px] [&_dt]:text-muted [&_dt]:text-[10.5px] [&_dt]:font-[600] [&_dt]:tracking-[.04em] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-text-secondary [&_dd]:text-[12px]">
      <div><dt>Lead ID</dt><dd><RecordCode code={inquiry.lead_code} label="Lead ID" size="md" /></dd></div>
      {inquiry.applicant?.applicant_code && (
        <div><dt>Applicant ID</dt><dd><RecordCode code={inquiry.applicant.applicant_code} label="Applicant ID" size="md" /></dd></div>
      )}
      {archived && <div><dt>Archive</dt><dd>{archived}</dd></div>}
    </dl>
  );
}

// ---- Normalizers used for duplicate detection and contact suggestions ----
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeName = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const normalizePhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = `0${digits.slice(2)}`; // +63 9xx -> 09xx
  else if (digits.length === 10 && digits.startsWith('9')) digits = `0${digits}`;
  return digits;
};

const splitName = (row) => {
  if (row.first_name || row.last_name) return { first: row.first_name || '', last: row.last_name || '' };
  const parts = String(row.lead_name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
};

// Existing people whose name contains everything typed so far (one entry per person).
const buildSuggestions = (rows, query) => {
  const tokens = normalizeName(query).split(' ').filter(Boolean);
  const unique = new Map();
  rows.forEach((row) => {
    const name = normalizeName(leadDisplayName(row));
    if (!tokens.every((token) => name.includes(token))) return;
    const key = normalizeEmail(row.email) || normalizePhone(row.phone) || name;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()].slice(0, 6);
};

// Decides whether an existing inquiry is the same person as the one being entered.
// Returns the reasons it matched, or null when it is not the same person.
const matchPerson = (row, mine) => {
  const rowEmail = normalizeEmail(row.email);
  const rowPhones = [normalizePhone(row.phone), normalizePhone(row.viber_number)].filter(Boolean);
  const reasons = [];
  if (mine.email && rowEmail && mine.email === rowEmail) reasons.push('email address');
  if (mine.phones.some((phone) => rowPhones.includes(phone))) reasons.push('contact number');
  if (reasons.length) {
    // A shared phone/email with a completely different name (e.g. family) is not the same person.
    const rowTokens = normalizeName(leadDisplayName(row)).split(' ').filter(Boolean);
    const myTokens = mine.name.split(' ').filter(Boolean);
    const namesCompatible = !rowTokens.length || !myTokens.length || myTokens.some((token) => rowTokens.includes(token));
    return namesCompatible ? reasons : null;
  }

  // Name alone is only enough when the contact details do not contradict each other.
  if (!mine.name || normalizeName(leadDisplayName(row)) !== mine.name) return null;
  if (mine.email && rowEmail) return null;
  if (mine.phones.length && rowPhones.length) return null;
  return ['name'];
};

function BrandText({ name }) {
  if (!name) return '—';
  return <span className="[.data-panel_.table-wrap_table_tbody_tr.inquiry-row_td:nth-child(3)_&]:text-[0.725rem]! [.data-panel_.table-wrap_table_tbody_tr.inquiry-row_td:nth-child(3)_&]:font-[350]! font-[600]" style={{ color: brandColor(name) }}>{name}</span>;
}

function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 p-[8px_0] text-[0.9rem] later:[&_dt]:text-[color:var(--drawer-muted)] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_a]:text-[#9aa5ff] [&_a]:[text-decoration:none] [&_a:hover]:[text-decoration:underline] max-[521px]:later:grid-cols-[1fr] max-[521px]:later:gap-[2px]">
      <dt>{label}</dt>
      <dd>{children || <span className="text-[color:var(--drawer-muted)] opacity-[0.7] italic">Not provided</span>}</dd>
    </div>
  );
}

export default function Inquiries() {
  const { role, user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const showArchived = false;
  // 0 = default, 1 = by branch, 2 = by date, 3 = by source (cycled with the sort icon button)
  const [sortMode, setSortMode] = useState(0);
  const [brandFilter, setBrandFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');

  // ---- Edit state ----
  const [editingId, setEditingId] = useState(null);          // table edit: reuses the New inquiry modal
  const [drawerEditing, setDrawerEditing] = useState(false); // details panel: inline edit
  const [drawerForm, setDrawerForm] = useState(null);
  const [drawerError, setDrawerError] = useState('');
  const [drawerSaving, setDrawerSaving] = useState(false);

  const remote = useRemote(async () => {
    const [inquiries, brands] = await Promise.all([
      api.get('/inquiries', {
        page,
        per_page: PAGE_SIZE,
        search,
        status,
        ...(showArchived ? { archived: 1 } : {}),
        ...(sortMode === 1 && brandFilter ? { brand_id: brandFilter } : {}),
        ...(sortMode === 2 ? { sort: 'date', ...(monthFilter ? { month: monthFilter } : {}), ...(yearFilter ? { year: yearFilter } : {}) } : {}),
        ...(sortMode === 3 && sourceFilter ? { source: sourceFilter } : {}),
      }),
      api.get('/brands'),
    ]);
    return { inquiries: inquiries.data, meta: inquiries.meta, brands: brands.data };
  }, [page, search, status, showArchived, sortMode, brandFilter, monthFilter, yearFilter, sourceFilter]);

  // Action rights come from the central role matrix (UI twin of config/roles.php);
  // the API blocks the same actions with 403 for Sales (view-only panel).
  const canEdit = can(role, 'inquiries.update');
  const canConvert = can(role, 'inquiries.convert');
  const canEndorse = can(role, 'inquiries.endorse');
  const canArchive = can(role, 'inquiries.archive');
  // Marketing cannot act on a Converted lead (UI mirror of the API lock in InquiryController).
  const isLockedRow = (inquiry) => role === 'marketing' && inquiry.status === 'converted';
  const rows = remote.data?.inquiries || [];
  const brandOptions = useMemo(() => remote.data?.brands || [], [remote.data?.brands]);
  const sortedBrands = useMemo(() => [...brandOptions].sort((a, b) => a.name.localeCompare(b.name)), [brandOptions]);
  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 8 }, (_, index) => current - index);
  }, []);

  // If the current page no longer exists (e.g. the only row on the last page was archived
  // or deleted), move to the last valid page instead of showing an empty table.
  useEffect(() => {
    const meta = remote.data?.meta;
    if (!meta) return;
    const last = Math.max(1, Number(meta.last_page) || 1);
    if (page > last) setPage(last);
  }, [remote.data?.meta, page]);

  // Icon button: default -> branch -> date -> source -> default. Clears the previous category's selection.
  const cycleSort = () => {
    setSortMode((mode) => (mode + 1) % SORT_LABELS.length);
    setBrandFilter('');
    setMonthFilter('');
    setYearFilter('');
    setSourceFilter('');
    setPage(1);
  };

  const isViber = form.source === 'viber';
  // An older record's "other" or custom source is no longer offered, but it must stay visible while editing.
  const hasLegacySource = Boolean(form.source) && !sourceOptions.includes(form.source);

  // ---------- Table edit: open / close the form ----------
  // Opens the same modal as "New inquiry", filled with the selected inquiry's values.
  const openEdit = (inquiry) => {
    const { first, last } = splitName(inquiry);
    setActionError('');
    setSuccess('');
    setForm({
      first_name: first,
      last_name: last,
      source: inquiry.source || '',
      email: inquiry.email || '',
      phone: digitsOnly(inquiry.phone),
      viber_number: digitsOnly(inquiry.viber_number),
      preferred_brand_id: String(inquiry.preferred_brand_id ?? inquiry.preferred_brand?.id ?? ''),
      current_city: inquiry.current_city || '',
      preferred_franchise_location: inquiry.preferred_franchise_location || '',
      remarks: inquiry.remarks || '',
    });
    setEditingId(inquiry.id);
    setShowCreate(true);
  };

  const closeForm = () => {
    if (editingId) setForm(initialForm); // do not leak edited values into the next "New inquiry"
    setShowCreate(false);
    setEditingId(null);
  };

  // ---------- Duplicate warning ----------
  const [duplicateMatches, setDuplicateMatches] = useState(null);
  const duplicateRef = useRef(null);

  // Any edit to the form makes an earlier warning outdated.
  useEffect(() => { setDuplicateMatches(null); }, [form]);
  useEffect(() => { if (!showCreate) setDuplicateMatches(null); }, [showCreate]);
  useEffect(() => {
    if (duplicateMatches && duplicateRef.current) {
      duplicateRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [duplicateMatches]);

  // Looks for an existing inquiry for the same person AND the same brand/concept.
  // A different preferred franchise location does not matter.
  // While editing, the record being edited is ignored.
  const findDuplicates = async () => {
    const brandId = Number(form.preferred_brand_id);
    if (!brandId) return []; // no concept selected: nothing to compare against

    const mine = {
      email: normalizeEmail(form.email),
      phones: [normalizePhone(form.phone)].filter(Boolean),
      name: normalizeName(`${form.first_name} ${form.last_name}`),
    };
    const terms = [...new Set([
      form.email.trim(),
      form.phone.trim(),
      form.last_name.trim(),
    ].filter(Boolean))];

    const results = await Promise.all(terms.map((term) => api.get('/inquiries', { page: 1, per_page: 50, search: term })));
    const byId = new Map();
    results.forEach((result) => (result.data || []).forEach((row) => byId.set(row.id, row)));

    return [...byId.values()]
      .filter((row) => row.id !== editingId)
      .filter((row) => Number(row.preferred_brand_id ?? row.preferred_brand?.id) === brandId)
      .map((row) => ({ row, reasons: matchPerson(row, mine) }))
      .filter((item) => item.reasons);
  };

  // Frontend-only validation (hindi umaasa sa browser pattern).
  const validateForm = () => {
    if (!form.source) {
      return 'Please choose a source.';
    }
    if (!form.phone.trim()) {
      return 'Phone number is required.';
    }
    if (form.phone && form.phone.length !== PHONE_LENGTH) {
      return `Phone number must be exactly ${PHONE_LENGTH} digits (you entered ${form.phone.length}).`;
    }
    if (!form.preferred_brand_id) {
      return 'Please choose a concept (brand).';
    }
    return '';
  };

  // Creates a new inquiry, or updates the existing one when editingId is set.
  // Both calls throw on failure, so the success message only shows when the request worked.
  const postInquiry = async () => {
    const firstName = form.first_name.trim();
    const lastName = form.last_name.trim();
    const payload = {
      ...form,
      first_name: firstName,
      last_name: lastName,
      // Kept so the existing backend validation on lead_name keeps working.
      lead_name: `${firstName} ${lastName}`.trim(),
      // The phone number doubles as the Viber number (kept so the existing backend field still works).
      viber_number: isViber ? form.phone.trim() : null,
      preferred_brand_id: form.preferred_brand_id ? Number(form.preferred_brand_id) : null,
    };

    if (editingId) {
      await api.put(`/inquiries/${editingId}`, payload);
      setSuccess('Inquiry updated successfully.');
    } else {
      await api.post('/inquiries', payload);
      setSuccess('Inquiry recorded successfully.');
    }
    setForm(initialForm);
    setDuplicateMatches(null);
    setShowCreate(false);
    setEditingId(null);
    await remote.reload();
  };

  const submitCreate = async (event) => {
    event.preventDefault();
    if (saving) return;
    setActionError('');
    setSuccess('');

    const validationError = validateForm();
    if (validationError) {
      setActionError(validationError);
      return;
    }

    setSaving(true);
    try {
      let matches = [];
      try {
        matches = await findDuplicates();
      } catch {
        matches = []; // if the check itself fails, do not block saving
      }
      if (matches.length) {
        setDuplicateMatches(matches);
        return;
      }
      await postInquiry();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDuplicate = async () => {
    setSaving(true);
    setActionError('');
    try {
      await postInquiry();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // ---------- Existing-contact suggestions ----------
  const [suggestions, setSuggestions] = useState([]);
  const [suggestField, setSuggestField] = useState(null); // which name input is being typed in
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const suggestRequest = useRef(0);
  const nameQuery = `${form.first_name} ${form.last_name}`.trim();

  useEffect(() => {
    // No autofill suggestions while editing an existing inquiry.
    if (!showCreate || editingId || !suggestField || nameQuery.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    const requestId = suggestRequest.current + 1;
    suggestRequest.current = requestId;
    const timer = setTimeout(async () => {
      try {
        // Search by the longest word typed, then keep only people matching every word.
        const term = nameQuery.split(/\s+/).sort((a, b) => b.length - a.length)[0];
        const result = await api.get('/inquiries', { page: 1, per_page: 50, search: term });
        if (requestId !== suggestRequest.current) return;
        setSuggestions(buildSuggestions(result.data || [], nameQuery));
        setActiveSuggestion(-1);
      } catch {
        if (requestId === suggestRequest.current) setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [nameQuery, suggestField, showCreate, editingId]);

  // Autofill happens only here, after the user clicks a suggestion.
  // Brand/concept and preferred franchise location are intentionally NOT copied.
  const applySuggestion = (row) => {
    const { first, last } = splitName(row);
    setForm((current) => ({
      ...current,
      first_name: first,
      last_name: last,
      email: current.email.trim() ? current.email : (row.email || ''),
      phone: current.phone.trim() ? current.phone : digitsOnly(row.phone),
      viber_number: current.viber_number.trim() ? current.viber_number : digitsOnly(row.viber_number),
      current_city: current.current_city.trim() ? current.current_city : (row.current_city || ''),
    }));
    setSuggestField(null);
    setSuggestions([]);
  };

  const onNameKeyDown = (event) => {
    if (!suggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion((index) => (index + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault();
      applySuggestion(suggestions[activeSuggestion]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setSuggestField(null);
    }
  };

  const renderSuggestions = (field) => {
    if (suggestField !== field || !suggestions.length) return null;
    return (
      <ul className="absolute top-[calc(100%_+_4px)] left-0 right-0 z-20 m-0 p-1 [list-style:none] max-h-[232px] overflow-y-auto [background:#0d1220] border border-[#1f2842] rounded-[10px]" role="listbox" aria-label="Existing contacts">
        {suggestions.map((row, index) => {
          const details = [row.phone, row.email, row.current_city].filter(Boolean).join(' · ');
          return (
            <li
              key={row.id}
              role="option"
              aria-selected={index === activeSuggestion}
              className={`flex flex-col gap-[2px] p-[9px_12px] rounded-[8px] cursor-pointer [&.active]:[background:rgba(123,_136,_255,_0.14)] hover:[background:rgba(123,_136,_255,_0.14)] [&_small]:text-[#8590a8] [&_small]:[overflow-wrap:anywhere] ${index === activeSuggestion ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
              // mousedown (not click) so the input keeps focus and the list does not close first
              onMouseDown={(event) => { event.preventDefault(); applySuggestion(row); }}
              onMouseEnter={() => setActiveSuggestion(index)}
            >
              <span className="text-[0.9rem] font-[600] [&_em]:not-italic [&_em]:font-[400] [&_em]:text-[#8590a8]">{leadDisplayName(row)} <em>— Existing Contact</em></span>
              {details && <small>{details}</small>}
            </li>
          );
        })}
      </ul>
    );
  };

  const runAction = async () => {
    if (!pendingAction) return;
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      if (pendingAction.type === 'delete') {
        await api.delete(`/inquiries/${pendingAction.inquiry.id}`);
      } else {
        await api.post(`/inquiries/${pendingAction.inquiry.id}/${pendingAction.type}`, {});
      }
      setSuccess(actionMessages[pendingAction.type] || 'Inquiry updated.');
      setPendingAction(null);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const brandMap = useMemo(() => new Map(brandOptions.map((brand) => [brand.id, brand.name])), [brandOptions]);

  // Read panel: keep only the id so the panel always shows fresh data after a reload.
  const [selectedId, setSelectedId] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  // Notification deep link: open the read panel for the inquiry, then clear the route state.
  useEffect(() => {
    const focusInquiryId = location.state?.focusInquiryId;
    if (!focusInquiryId) return;
    setSelectedId(focusInquiryId);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  // Opening the read panel is "seen": the signed-in user's dot for this
  // inquiry is persisted as read, then the sidebar/header dots refresh.
  useEffect(() => {
    if (!selectedId) return;
    void api.post('/notifications/mark-seen', { record_type: 'inquiry', record_id: selectedId })
      .then(() => window.dispatchEvent(new Event('herald:notifications-updated')))
      .catch(() => {});
  }, [selectedId]);

  // Route state can carry the id as a string; compare loosely so the record still opens.
  const selected = rows.find((row) => String(row.id) === String(selectedId)) || null;
  const lastSelected = useRef(null);
  if (selected) lastSelected.current = selected;
  const shown = selected || lastSelected.current; // keeps content visible while the panel slides out
  const closeDetails = () => setSelectedId(null);
  const toggleRow = (id) => setSelectedId((current) => (current === id ? null : id));

  // Keeps the curved pointer on the panel's left edge level with the selected row.
  // (The panel itself stays pinned to the screen; only the pointer follows the row.)
  const drawerRef = useRef(null);
  const prevSelectedRef = useRef(null);
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return undefined;
    if (!selectedId) {
      prevSelectedRef.current = null;
      return undefined;
    }

    // Finds the bottom edge of the fixed/sticky top header so the panel starts right below it
    // (touching, never covered by or covering the header).
    const headerBottom = () => {
      const x = Math.max(0, Math.floor(window.innerWidth / 2 - 220));
      const stack = document.elementsFromPoint(x, 4).filter((el) => !drawer.contains(el));
      for (const el of stack) {
        let node = el;
        while (node && node !== document.body && node !== document.documentElement) {
          const position = window.getComputedStyle(node).position;
          if (position === 'fixed' || position === 'sticky') {
            return Math.max(0, Math.round(node.getBoundingClientRect().bottom));
          }
          node = node.parentElement;
        }
      }
      return 0;
    };

    const place = () => {
      const topEdge = headerBottom();
      drawer.style.setProperty('--drawer-top', `${topEdge}px`);
      const row = document.querySelector(`tr[data-inquiry-id="${selectedId}"]`);
      if (!row) {
        drawer.style.setProperty('--pointer-opacity', '0');
        return;
      }
      const rowRect = row.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const centerInViewport = rowRect.top + rowRect.height / 2;
      const visible = centerInViewport >= topEdge + 24 && centerInViewport <= window.innerHeight - 30;
      drawer.style.setProperty('--pointer-y', `${centerInViewport - drawerRect.top}px`);
      drawer.style.setProperty('--pointer-opacity', visible ? '1' : '0');
    };

    // Glide between rows, but don't animate the very first placement or scrolling.
    const switching = prevSelectedRef.current !== null && prevSelectedRef.current !== selectedId;
    prevSelectedRef.current = selectedId;
    drawer.classList.toggle('pointer-animate', switching);
    place();
    const timer = switching ? setTimeout(() => drawer.classList.remove('pointer-animate'), 450) : 0;

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('scroll', schedule, true); // capture: also catches inner scroll containers
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (observer) observer.observe(document.body);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (observer) observer.disconnect();
    };
  }, [selectedId, remote.data]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !showCreate && !pendingAction) setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, showCreate, pendingAction]);

  const shownName = shown ? leadDisplayName(shown) : '';
  const shownConcept = shown ? (shown.preferred_brand?.name || brandMap.get(shown.preferred_brand_id)) : '';

  // ---------- Details panel: inline edit ----------
  const startDrawerEdit = () => {
    if (!shown) return;
    const { first, last } = splitName(shown);
    setDrawerForm({
      first_name: first,
      last_name: last,
      phone: digitsOnly(shown.phone),
      email: shown.email || '',
      preferred_brand_id: String(shown.preferred_brand_id ?? shown.preferred_brand?.id ?? ''),
      preferred_franchise_location: shown.preferred_franchise_location || '',
      remarks: shown.remarks || '',
    });
    setDrawerError('');
    setDrawerEditing(true);
  };

  const cancelDrawerEdit = () => {
    setDrawerEditing(false);
    setDrawerError('');
  };

  // Switching rows or closing the panel discards unsaved edits.
  useEffect(() => {
    setDrawerEditing(false);
    setDrawerError('');
  }, [selectedId]);

  const saveDrawerEdit = async () => {
    if (!shown || !drawerForm || drawerSaving) return;
    const f = drawerForm;
    if (!f.first_name.trim() || !f.last_name.trim()) {
      setDrawerError('First name and last name are required.');
      return;
    }
    if (f.phone && f.phone.length !== PHONE_LENGTH) {
      setDrawerError(`Phone number must be exactly ${PHONE_LENGTH} digits (you entered ${f.phone.length}).`);
      return;
    }
    if (!f.preferred_brand_id) {
      setDrawerError('Please choose a concept (brand).');
      return;
    }
    setDrawerSaving(true);
    setDrawerError('');
    setSuccess('');
    try {
      await api.put(`/inquiries/${shown.id}`, {
        // Fields not editable in the panel are sent back unchanged so backend validation sees a full record.
        source: shown.source,
        // For Viber leads the phone number is the Viber number, so keep them in sync.
        viber_number: shown.source === 'viber' ? (f.phone || null) : (shown.viber_number || null),
        current_city: shown.current_city || '',
        first_name: f.first_name.trim(),
        last_name: f.last_name.trim(),
        lead_name: `${f.first_name.trim()} ${f.last_name.trim()}`.trim(),
        email: f.email.trim(),
        phone: f.phone,
        preferred_brand_id: f.preferred_brand_id ? Number(f.preferred_brand_id) : null,
        preferred_franchise_location: f.preferred_franchise_location.trim(),
        remarks: f.remarks,
      });
      setDrawerEditing(false);
      setSuccess('Inquiry updated successfully.');
      await remote.reload(); // the table row and the panel both read from `rows`, so both refresh
    } catch (error) {
      setDrawerError(firstValidationMessage(error));
    } finally {
      setDrawerSaving(false);
    }
  };

  // ---------- Archive view: multi-select, bulk restore, permanent delete ----------
  const [selectedIds, setSelectedIds] = useState([]); // in click order; the first one hosts the action buttons
  const [bulkRestoreTargets, setBulkRestoreTargets] = useState(null);
  const selectedRows = selectedIds.map((id) => rows.find((row) => row.id === id)).filter(Boolean);

  // The selection belongs to the rows currently on screen.
  useEffect(() => { setSelectedIds([]); }, [page, search, status, showArchived, sortMode, brandFilter, monthFilter, yearFilter, sourceFilter]);
  useEffect(() => {
    setSelectedIds((current) => {
      const next = current.filter((id) => rows.some((row) => row.id === id));
      return next.length === current.length ? current : next;
    });
  }, [remote.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selectedIds.length) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !bulkRestoreTargets && !pendingAction && !showCreate) setSelectedIds([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.length, bulkRestoreTargets, pendingAction, showCreate]);

  // Plain click opens the read panel. In the archive view, Ctrl/Cmd+click toggles a row
  // in the selection and Shift+click selects the range from the first selected row.
  const handleRowClick = (event, inquiry) => {
    if (showArchived && canEdit && (event.ctrlKey || event.metaKey)) {
      setSelectedId(null);
      setSelectedIds((current) => (
        current.includes(inquiry.id) ? current.filter((id) => id !== inquiry.id) : [...current, inquiry.id]
      ));
      return;
    }
    if (showArchived && canEdit && event.shiftKey && selectedIds.length) {
      const anchor = rows.findIndex((row) => row.id === selectedIds[0]);
      const target = rows.findIndex((row) => row.id === inquiry.id);
      if (anchor >= 0 && target >= 0) {
        const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
        const range = rows.slice(from, to + 1).map((row) => row.id).filter((id) => id !== selectedIds[0]);
        setSelectedId(null);
        setSelectedIds([selectedIds[0], ...range]);
        return;
      }
    }
    if (selectedIds.length) setSelectedIds([]);
    toggleRow(inquiry.id);
  };

  const confirmBulkRestore = async () => {
    if (!bulkRestoreTargets?.length) return;
    setSaving(true);
    setActionError('');
    setSuccess('');
    let restored = 0;
    try {
      for (const item of bulkRestoreTargets) {
        await api.post(`/inquiries/${item.id}/restore`, {});
        restored += 1;
      }
      setSuccess(`${restored} ${restored === 1 ? 'inquiry' : 'inquiries'} restored to the pipeline.`);
    } catch (error) {
      setActionError(`Restored ${restored} of ${bulkRestoreTargets.length}. ${firstValidationMessage(error)}`);
    }
    setBulkRestoreTargets(null);
    setSelectedIds([]);
    setSaving(false);
    await remote.reload();
  };

  // Buttons for an archived row. While rows are selected, only the first selected row
  // shows them and they act on the whole selection.
  const renderArchiveActions = (inquiry) => {
    const hasSelection = selectedIds.length > 0;
    if (hasSelection && selectedIds[0] !== inquiry.id) {
      return selectedIds.includes(inquiry.id) ? <span className="[.row-actions_&]:text-[0.78rem] [.row-actions_&]:text-[#9aa5ff]">Selected</span> : null;
    }
    const targets = hasSelection ? selectedRows : [inquiry];
    const many = targets.length > 1;
    return (
      <>
        {canEdit && (
          <button
            type="button"
            onClick={() => (many ? setBulkRestoreTargets(targets) : setPendingAction({ type: 'restore', inquiry }))}
          >
            <FaRotateLeft /> Restore{many ? ` (${targets.length})` : ''}
          </button>
        )}
        {hasSelection && (
          <button type="button" className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)]" title="Clear selection" aria-label="Clear selection" onClick={() => setSelectedIds([])}>
            <FaXmark aria-hidden="true" />
          </button>
        )}
      </>
    );
  };

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] inquiries-page later-2:[&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! [&_.eyebrow]:hidden! later-3:[&>:empty]:hidden! [&_.toolbar]:m-0! [&_.toolbar]:p-[10px_12px] [&_.toolbar]:items-center [&_.data-panel]:m-0! [&.page-container_.toolbar]:[--toolbar-control-h:48px] [&.page-container_.toolbar]:flex! [&.page-container_.toolbar]:items-center! [&.page-container_.toolbar]:gap-[10px] [&.page-container_.toolbar>input]:min-w-0 [&.page-container_.toolbar>input]:flex-[1_1_auto] [&.page-container_.toolbar>input]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar>input]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar>input]:[box-sizing:border-box] [&.page-container_.toolbar_select]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_select]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_select]:[box-sizing:border-box] [&.page-container_.toolbar_button.tab]:h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_button.tab]:min-h-[var(--toolbar-control-h)]! [&.page-container_.toolbar_button.tab]:[box-sizing:border-box] [&.page-container_.toolbar_button.tab]:inline-flex! [&.page-container_.toolbar_button.tab]:items-center [&.page-container_.toolbar_button.tab]:justify-center [&.page-container_.toolbar_button.tab]:gap-2 [&.page-container_.toolbar_button.tab]:flex-none [&.page-container_.toolbar_button.tab]:p-[0_20px]! [&.page-container_.toolbar_button.tab]:border! [&.page-container_.toolbar_button.tab]:border-[#1f2842]! [&.page-container_.toolbar_button.tab]:rounded-[12px]! [&.page-container_.toolbar_button.tab]:[background-color:#161d30]! [&.page-container_.toolbar_button.tab]:text-[#fff]! [&.page-container_.toolbar_button.tab]:text-[1rem]! [&.page-container_.toolbar_button.tab]:font-[600]! [&.page-container_.toolbar_button.tab]:whitespace-nowrap [&.page-container_.toolbar_button.tab]:cursor-pointer [&.page-container_.toolbar_button.tab]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&.page-container_.toolbar_button.tab_svg]:m-0 [&.page-container_.toolbar_button.tab_svg]:text-[1rem] [&.page-container_.toolbar_button.tab:hover]:[background-color:rgba(123,_136,_255,_0.14)]! [&.page-container_.toolbar_button.tab:hover]:border-[rgba(123,_136,_255,_0.5)]! later:[&.page-container_.toolbar_button.tab.active]:[background-color:rgba(123,_136,_255,_0.22)]! later:[&.page-container_.toolbar_button.tab.active]:border-[#7b88ff]! [&.page-container_.toolbar_button.tab:focus-visible]:[outline:2px_solid_#7b88ff] [&.page-container_.toolbar_button.tab:focus-visible]:[outline-offset:2px] max-[721px]:[&.page-container_.toolbar]:flex-wrap max-[721px]:later:[&.page-container_.toolbar>input]:flex-[1_1_100%] max-[721px]:later:[&.page-container_.toolbar_button.tab]:flex-[1_1_100%]">
      {/* Compact header: title + New inquiry button in one row (no eyebrow text, no extra spacing). */}
      <div className="[.inquiries-page_&]:flex! [.inquiries-page_&]:flex-row! [.inquiries-page_&]:items-center! [.inquiries-page_&]:justify-between! [.inquiries-page_&]:gap-4 [.inquiries-page_&]:m-0! [.inquiries-page_&]:p-0! [.inquiries-page_&]:min-h-0! [.inquiries-page_&_h1]:m-0! [.inquiries-page_&_h1]:p-0! [.inquiries-page_&_h1]:text-[2rem] [.inquiries-page_&_h1]:font-[800] [.inquiries-page_&_h1]:leading-[1.15] [.inquiries-page_&_h1]:tracking-[-.045em] [.inquiries-page_&_.primary-button]:flex-none [.inquiries-page_&_.primary-button]:w-auto! [.inquiries-page_&_.primary-button]:m-0!">
        <h1>Leads &amp; inquiries</h1>
      </div>
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>
      <div className="toolbar flex items-center flex-wrap gap-[9px] mb-[14px] p-[10px] border border-line rounded-[15px] [background:color-mix(in_srgb,_var(--panel)_92%,_transparent)] [box-shadow:var(--shadow-sm)] [&_input]:flex-[1_1_270px] [&_select]:flex-[0_1_210px] [&_input]:min-h-[40px] [&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:min-h-[40px] [&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong [&_select:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[681px]:later:items-stretch max-[681px]:flex-col max-[681px]:[&_input]:w-full max-[681px]:later:[&_input]:flex-[auto] max-[681px]:[&_select]:w-full max-[681px]:later:[&_select]:flex-[auto]">
        <input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Search by ID, name, email, or phone" aria-label="Search inquiries" />
        <div className="sort-control [.page-container.inquiries-page_.toolbar_&]:flex [.page-container.inquiries-page_.toolbar_&]:items-center [.page-container.inquiries-page_.toolbar_&]:gap-2 [.page-container.inquiries-page_.toolbar_&]:flex-[0_0_auto] [.page-container.inquiries-page_.toolbar_&_select]:min-w-[140px] max-[721px]:later:[.page-container.inquiries-page_.toolbar_&]:flex-[1_1_100%] max-[721px]:[.page-container.inquiries-page_.toolbar_&_select]:flex-1">
          {sortMode === 2 ? (
            <>
              <select value={monthFilter} onChange={(e) => { setPage(1); setMonthFilter(e.target.value); }} aria-label="Filter by month">
                <option value="">Sort by date</option>
                {MONTH_NAMES.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
              </select>
              <select value={yearFilter} onChange={(e) => { setPage(1); setYearFilter(e.target.value); }} aria-label="Filter by year">
                <option value="">Year</option>
                {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </>
          ) : sortMode === 1 ? (
            <select
              value={brandFilter}
              onChange={(e) => { setPage(1); setBrandFilter(e.target.value); }}
              aria-label="Filter by branch"
              style={{ color: brandColor(brandMap.get(Number(brandFilter))) }}
            >
              <option value="">By branch</option>
              {sortedBrands.map((brand) => <option key={brand.id} value={brand.id} style={{ color: brandColor(brand.name) }}>{brand.name}</option>)}
            </select>
          ) : sortMode === 3 ? (
            <select value={sourceFilter} onChange={(e) => { setPage(1); setSourceFilter(e.target.value); }} aria-label="Filter by source">
              <option value="">By source</option>
              {SORT_SOURCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          ) : (
            <select value="" onChange={() => {}} aria-label="Sort category">
              <option value="">Default sort</option>
            </select>
          )}
          <button
            type="button"
            className={`[.page-container.inquiries-page_.toolbar_button&]:h-[var(--toolbar-control-h)]! [.page-container.inquiries-page_.toolbar_button&]:min-h-[var(--toolbar-control-h)]! [.page-container.inquiries-page_.toolbar_button&]:[box-sizing:border-box] [.page-container.inquiries-page_.toolbar_.sort-control_button&]:inline-grid! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:place-items-center [.page-container.inquiries-page_.toolbar_.sort-control_button&]:flex-none [.page-container.inquiries-page_.toolbar_.sort-control_button&]:w-[var(--toolbar-control-h)]! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:p-0! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:border! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:border-[rgba(154,_165,_255,_0.55)]! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:rounded-[12px]! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:[background:linear-gradient(135deg,_#7b88ff_0%,_#5b6cf5_100%)]! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:text-[#fff]! [.page-container.inquiries-page_.toolbar_.sort-control_button&]:text-[1rem] [.page-container.inquiries-page_.toolbar_.sort-control_button&]:cursor-pointer [.page-container.inquiries-page_.toolbar_.sort-control_button&]:[box-shadow:0_6px_16px_rgba(91,_108,_245,_0.28),_inset_0_1px_0_rgba(255,_255,_255,_0.18)] [.page-container.inquiries-page_.toolbar_.sort-control_button&]:[transition:transform_0.15s_ease,_box-shadow_0.2s_ease,_filter_0.2s_ease] [.page-container.inquiries-page_.toolbar_.sort-control_button&_svg]:m-0 [.page-container.inquiries-page_.toolbar_.sort-control_button&_svg]:[transition:transform_0.3s_ease] [.page-container.inquiries-page_.toolbar_.sort-control_button&:hover]:[filter:brightness(1.1)] [.page-container.inquiries-page_.toolbar_.sort-control_button&:hover]:[transform:translateY(-1px)] [.page-container.inquiries-page_.toolbar_.sort-control_button&:hover]:[box-shadow:0_10px_22px_rgba(91,_108,_245,_0.4),_inset_0_1px_0_rgba(255,_255,_255,_0.22)] [.page-container.inquiries-page_.toolbar_.sort-control_button&:hover_svg]:[transform:rotate(180deg)] later:[.page-container.inquiries-page_.toolbar_.sort-control_button&:active]:[transform:translateY(0)] later:[.page-container.inquiries-page_.toolbar_.sort-control_button&:active]:[filter:brightness(0.96)] [.page-container.inquiries-page_.toolbar_.sort-control_button&:focus-visible]:[outline:2px_solid_#9aa5ff] [.page-container.inquiries-page_.toolbar_.sort-control_button&:focus-visible]:[outline-offset:2px] later:[.page-container.inquiries-page_.toolbar_.sort-control_button&.is-active]:[box-shadow:0_0_0_3px_rgba(123,_136,_255,_0.28),_0_8px_20px_rgba(91,_108,_245,_0.4)] ${sortMode !== 0 ? ' is-active' : ''}`}
            onClick={cycleSort}
            title={`Change sort category (now: ${SORT_LABELS[sortMode]})`}
            aria-label={`Change sort category. Current: ${SORT_LABELS[sortMode]}`}
          >
            <FaRightLeft aria-hidden="true" />
          </button>
        </div>
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} aria-label="Filter inquiry status">
          <option value="">All statuses</option>
          {['new', 'contacted', 'endorsed', 'converted', 'closed'].map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
        </select>
        {can(role, 'inquiries.create') && (
          <button
            type="button"
            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
            onClick={() => { setActionError(''); setEditingId(null); setForm(initialForm); setShowCreate(true); }}
          >
            <FaPlus /> New inquiry
          </button>
        )}
      </div>

      {showArchived && canEdit && rows.length > 0 && (
        <p className="muted-note text-muted text-[8px] leading-[1.6] [.inquiries-page_&]:m-0 m-[0_0_10px]">
          Click a row to view it. Hold Ctrl (⌘ on Mac) and click to select several records to restore together, or Shift+click for a range. Esc clears the selection.
        </p>
      )}

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        {remote.loading ? <LoadingState /> : rows.length === 0 ? (
          <EmptyState label="No inquiries match the current filters." detail="Adjust your search or create a new inquiry to begin the pipeline." />
        ) : (
          <div className={`table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer ${showArchived ? ' archive-mode' : ''}`}><table><thead><tr><th>Lead</th><th>Contact</th><th>Concept</th><th>Source</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>
            {rows.map((inquiry) => (
              <tr
                key={inquiry.id}
                data-inquiry-id={inquiry.id}
                className={`inquiry-row [tr&]:cursor-pointer [tr&]:[transition:background-color_0.2s_ease] [tr&:hover]:[background:rgba(123,_136,_255,_0.06)] [tr&:focus-visible]:[outline:2px_solid_#7b88ff] [tr&:focus-visible]:[outline-offset:-2px] later:[tr&.is-selected]:[background:rgba(123,_136,_255,_0.1)] [tr&.is-selected]:[box-shadow:inset_3px_0_0_#7b88ff] [.data-panel_.table-wrap_table_tbody_tr&_td]:[vertical-align:middle]! [.data-panel_.table-wrap_table_tbody_tr&_td]:pt-4! [.data-panel_.table-wrap_table_tbody_tr&_td]:pb-4! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:text-[1.025rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:font-[600]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_strong]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:text-[0.8rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:font-[500]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(1)_small]:mt-[2px]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:text-[0.825rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:font-[400]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)]:leading-[1.35]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:text-[0.78rem]! [.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:font-[500]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(2)_small]:mt-[3px]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(3)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(3)]:font-[350]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(4)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(4)]:font-[350]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(5)]:text-[0.725rem]! later:[.data-panel_.table-wrap_table_tbody_tr&_td:nth-child(5)]:font-[350]! [.archive-mode_tr&]:[user-select:none] later-2:[tr&.is-picked]:[background:rgba(123,_136,_255,_0.14)] [tr&.is-picked]:[box-shadow:inset_3px_0_0_#7b88ff] [&.is-view-focus>td]:[background:rgba(59,_130,_246,_.14)] [&.is-view-focus>td:first-child]:[box-shadow:inset_3px_0_0_#60a5fa] ${inquiry.id === selectedId ? ' is-selected' : ''}${selectedIds.includes(inquiry.id) ? ' is-picked' : ''}`}
                tabIndex={0}
                aria-label={`View details for ${leadDisplayName(inquiry)}`}
                onClick={(event) => handleRowClick(event, inquiry)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleRowClick(event, inquiry);
                  }
                }}
              >
                {/* No ID in the table: the Lead ID lives in the inquiry panel (and still works in search). */}
                <td><strong className="[.data-panel_.table-wrap_table_tbody_td_&]:block [.data-panel_.table-wrap_table_tbody_td_&]:text-text! [.data-panel_.table-wrap_table_tbody_td_&]:text-[1rem]! [.data-panel_.table-wrap_table_tbody_td_&]:font-[600]! [.data-panel_.table-wrap_table_tbody_td_&]:leading-[1.3]! [.data-panel_.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.data-panel_.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere] [.table-wrap_table_tbody_td_&]:block [.table-wrap_table_tbody_td_&]:text-text! [.table-wrap_table_tbody_td_&]:text-[1rem]! [.table-wrap_table_tbody_td_&]:font-[600]! [.table-wrap_table_tbody_td_&]:leading-[1.3]! [.table-wrap_table_tbody_td_&]:tracking-[-.005em] [.table-wrap_table_tbody_td_&]:[overflow-wrap:anywhere]">{leadDisplayName(inquiry)}</strong></td>
                <td>
                  {inquiry.email || '—'}
                  <small>{inquiry.phone || '—'}</small>
                  {inquiry.viber_number && inquiry.viber_number !== inquiry.phone && <small>Viber: {inquiry.viber_number}</small>}
                </td>
                <td><BrandText name={inquiry.preferred_brand?.name || brandMap.get(inquiry.preferred_brand_id)} /></td>
                <td>{titleCase(inquiry.source)}</td>
                <td>{formatDate(inquiry.inquiry_date)}</td>
                <td><StatusBadge value={inquiry.status} /></td>
                <td><div className={`row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative ${showArchived ? '' : ' later-4:[&.row-actions]:grid! [&.row-actions]:grid-cols-[132px_42px_42px] [&.row-actions]:gap-[10px] [&.row-actions]:items-center [&.row-actions_.action-slot]:flex [&.row-actions_.action-slot]:min-h-[42px] [&.row-actions_.action-slot]:items-center [&.row-actions_.action-slot_button]:h-[32px] [&.row-actions_.action-slot_button]:justify-center [&.row-actions_.action-slot_button]:whitespace-nowrap [&.row-actions_.action-slot_button]:text-[0.825rem]! [&.row-actions_.action-slot_button]:font-[500]! [&.row-actions_.icon-button]:w-[42px] [&.row-actions_.icon-button]:h-[42px]'}`} onClick={(event) => event.stopPropagation()}>
                  {showArchived ? renderArchiveActions(inquiry) : (
                    <>
                      {isLockedRow(inquiry) ? (
                        <span className="muted-note text-muted text-[8px] leading-[1.6]">Locked</span>
                      ) : (
                      <>
                      {/* Slot 1: Endorse / Convert / Undo convert (always the same position) */}
                      <div className="action-slot">
                        {canEndorse && !['endorsed', 'converted'].includes(inquiry.status) && (
                          <button onClick={() => setPendingAction({ type: 'endorse', inquiry })}>Endorse</button>
                        )}
                        {canConvert && inquiry.status !== 'converted' && (
                          <button onClick={() => setPendingAction({ type: 'convert', inquiry })}>Convert</button>
                        )}
                        {/* Undo a conversion that has not progressed past the first stage. */}
                        {canConvert && inquiry.status === 'converted' && inquiry.applicant?.status === 'converted' && (
                          <button onClick={() => setPendingAction({ type: 'unconvert', inquiry })}>Undo convert</button>
                        )}
                      </div>

                      {/* Slot 2: Edit (colorless square icon button) */}
                      <div className="action-slot">
                        {canEdit && (
                          <button
                            type="button"
                            className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] edit-button"
                            title="Edit inquiry"
                            aria-label={`Edit ${leadDisplayName(inquiry)}`}
                            onClick={() => openEdit(inquiry)}
                          >
                            <FaPen aria-hidden="true" />
                          </button>
                        )}
                      </div>

                      {/* Slot 3: Archive (colorless square icon button) */}
                      <div className="action-slot">
                        {canArchive && (role !== 'marketing' || inquiry.status === 'new') && (
                          <button
                            type="button"
                            className="icon-button w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] archive-icon-button"
                            title="Archive inquiry"
                            aria-label={`Archive ${leadDisplayName(inquiry)}`}
                            onClick={() => setPendingAction({ type: 'archive', inquiry })}
                          >
                            <FaInbox aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      </>
                      )}
                    </>
                  )}
                </div></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <InquiryPagination meta={remote.data?.meta} page={page} onPage={setPage} />
      </section>

      {/* The read panel is portaled to <body> so `position: fixed` is always relative to the
          screen. It stays pinned in view while the page scrolls up or down. */}
      <ModalPortal>
        <aside
          ref={drawerRef}
          className={`inquiry-drawer [--drawer-bg:#0a0e18] [--drawer-border:#1a2133] [--drawer-text:#e6e9f2] [--drawer-muted:#8590a8] [--drawer-accent:#7b88ff] [--drawer-accent-2:#38bdf8] fixed top-[var(--drawer-top,_var(--header-height,_76px))] right-0 bottom-0 z-40 w-[min(440px,_100vw)] flex flex-col [background:radial-gradient(circle_at_100%_0%,_color-mix(in_srgb,_var(--drawer-accent)_16%,_transparent),_transparent_22%),_radial-gradient(circle_at_100%_100%,_color-mix(in_srgb,_var(--drawer-accent-2)_10%,_transparent),_transparent_20%),_var(--drawer-bg)] text-[color:var(--drawer-text)] [border-left:1px_solid_var(--drawer-border)] [box-shadow:-24px_0_48px_rgba(0,_0,_0,_0.35)] [transform:translate3d(100%,_0,_0)] [visibility:hidden] [will-change:transform] [transition:transform_0.5s_cubic-bezier(0.32,_0.72,_0,_1),_visibility_0s_linear_0.5s] [&.open]:[transform:translate3d(0,_0,_0)] [&.open]:[visibility:visible] [&.open]:[transition-delay:0s] motion-reduce:later:[transition:none] ${selected ? ' open' : ''}`}
          aria-label="Inquiry details"
          aria-hidden={!selected}
        >
          <span className="drawer-pointer absolute -left-[15px] top-[calc(var(--pointer-y,_0px)_-_24px)] w-[16px] h-[48px] opacity-[var(--pointer-opacity,_0)] pointer-events-none [transition:opacity_0.2s_ease] [.inquiry-drawer.pointer-animate_&]:[transition:top_0.4s_cubic-bezier(0.32,_0.72,_0,_1),_opacity_0.2s_ease] [&_svg]:block [&_svg]:overflow-visible max-[521px]:hidden motion-reduce:later:[.inquiry-drawer.pointer-animate_&]:[transition:none]" aria-hidden="true">
            <svg width="16" height="48" viewBox="0 0 16 48">
              <path className="[.drawer-pointer_&]:[fill:var(--drawer-bg)]" d="M15.5 0 C15.5 10 1.5 10 1.5 24 C1.5 38 15.5 38 15.5 48 L16 48 L16 0 Z" />
              <path className="[.drawer-pointer_&]:[fill:none] [.drawer-pointer_&]:[stroke:var(--drawer-border)] [.drawer-pointer_&]:[stroke-width:1]" d="M15.5 0 C15.5 10 1.5 10 1.5 24 C1.5 38 15.5 38 15.5 48" />
            </svg>
          </span>
          {shown && (
            <>
              <header className="flex-none flex items-center gap-4 p-[24px_20px_20px_28px] [border-bottom:1px_solid_var(--drawer-border)] [background:linear-gradient(180deg,_rgba(123,_136,_255,_0.08),_transparent)] [&_h2]:m-0 later:[&_h2]:text-[1.2rem] [&_h2]:leading-[1.25] [&_h2]:[overflow-wrap:anywhere] later:[&_p]:m-[4px_0_0] later:[&_p]:text-[0.85rem] later:[&_p]:text-[color:var(--drawer-muted)] max-[521px]:later:p-[18px_14px_16px_18px] max-[521px]:later:gap-3">
                <span className="drawer-avatar flex-none w-[54px] h-[54px] grid place-items-center rounded-[50%] font-[700] text-[1.05rem] text-[#d4d9ff] [background:radial-gradient(circle_at_25%_20%,_color-mix(in_srgb,_var(--drawer-accent)_45%,_transparent),_transparent_70%),_color-mix(in_srgb,_var(--drawer-accent-2)_12%,_transparent)] border border-[rgba(123,_136,_255,_0.45)] [box-shadow:0_0_0_4px_rgba(123,_136,_255,_0.08),_0_6px_18px_rgba(123,_136,_255,_0.18)]" aria-hidden="true">{initialsOf(shownName)}</span>
                <div className="min-w-0 flex-[1_1_auto]">
                  <h2>{shownName}</h2>
                  <LeadIds inquiry={shown} />
                </div>
                <div className="flex-none ml-auto flex items-center gap-2">
                  {canEdit && !shown.archived_at && !drawerEditing && (
                    <button type="button" className="flex-none inline-flex items-center gap-[6px] h-[34px] p-[0_12px] rounded-[8px] [border:1px_solid_var(--drawer-border)] [background:transparent] text-[#fde68a] text-[0.85rem] cursor-pointer [transition:background-color_0.2s_ease,_border-color_0.2s_ease] hover:[background:rgba(253,_230,_138,_0.08)] hover:border-[rgba(253,_230,_138,_0.4)] focus-visible:[outline:2px_solid_var(--drawer-accent)] focus-visible:[outline-offset:2px]" onClick={startDrawerEdit} title="Edit inquiry">
                      <FaPen aria-hidden="true" /> Edit
                    </button>
                  )}
                  {/* Close button now lives inside the panel, so it moves together with the content. */}
                  <button type="button" className="flex-none w-[34px] h-[34px] grid place-items-center p-0 rounded-[8px] [border:1px_solid_var(--drawer-border)] [background:transparent] text-[color:var(--drawer-muted)] cursor-pointer [transition:color_0.2s_ease,_border-color_0.2s_ease,_background-color_0.2s_ease] [&_svg]:m-0 later-5:hover:text-[color:var(--drawer-text)] hover:border-[color:var(--drawer-accent)] hover:[background:rgba(123,_136,_255,_0.08)] focus-visible:[outline:2px_solid_var(--drawer-accent)] focus-visible:[outline-offset:2px]" onClick={closeDetails} aria-label="Close details" title="Close (Esc)">
                    <FaXmark aria-hidden="true" />
                  </button>
                </div>
              </header>
              <div className="drawer-body flex-[1_1_auto] min-h-0 overflow-y-auto [overscroll-behavior:contain] p-[8px_28px_32px] [&_section]:p-[20px_0_6px] [&_section+section]:[border-top:1px_solid_var(--drawer-border)] [&_h3]:m-[0_0_14px] [&_h3]:text-[0.74rem] [&_h3]:font-[700] [&_h3]:tracking-[0.09em] [&_h3]:uppercase [&_h3]:text-[color:var(--drawer-muted)] [&_dl]:m-0 max-[521px]:later:pl-[18px] max-[521px]:later:pr-[18px]">
                {drawerEditing && drawerForm ? (
                  <section className="drawer-edit [&_label]:grid [&_label]:gap-[6px] [&_label]:mb-[14px] [&_label>span]:text-[0.8rem] [&_label>span]:font-[600] [&_label>span]:text-[color:var(--drawer-muted)] [&_input]:w-full [&_input]:[box-sizing:border-box] [&_select]:w-full [&_select]:[box-sizing:border-box] [&_textarea]:w-full [&_textarea]:[box-sizing:border-box] [&_textarea]:[resize:vertical] [.inquiry-drawer_.drawer-body_section&]:grid [.inquiry-drawer_.drawer-body_section&]:grid-cols-[repeat(2,_minmax(0,_1fr))] [.inquiry-drawer_.drawer-body_section&]:gap-x-[14px] [.inquiry-drawer_.drawer-body_section&]:gap-y-4 [.inquiry-drawer_.drawer-body_section&]:p-[20px_0_18px] [.inquiry-drawer_.drawer-body_section&>h3]:col-span-full [.inquiry-drawer_.drawer-body_section&>h3]:m-0 [.inquiry-drawer_.drawer-body_section&>div]:col-span-full [.inquiry-drawer_.drawer-body_section&>div]:m-0 [.inquiry-drawer_.drawer-body_section&>label]:grid [.inquiry-drawer_.drawer-body_section&>label]:col-span-full [.inquiry-drawer_.drawer-body_section&>label]:[align-content:start] [.inquiry-drawer_.drawer-body_section&>label]:gap-[7px] [.inquiry-drawer_.drawer-body_section&>label]:min-w-0 [.inquiry-drawer_.drawer-body_section&>label]:m-0 [.inquiry-drawer_.drawer-body_section&>label:nth-of-type(-n+4)]:col-[span_1] [.inquiry-drawer_.drawer-body_section&>label>span]:block [.inquiry-drawer_.drawer-body_section&>label>span]:text-[0.78rem] [.inquiry-drawer_.drawer-body_section&>label>span]:font-[650] [.inquiry-drawer_.drawer-body_section&>label>span]:tracking-[0.02em] [.inquiry-drawer_.drawer-body_section&>label>span]:text-[color:var(--drawer-muted,_#8590a8)] [.inquiry-drawer_.drawer-body_section&_input]:block [.inquiry-drawer_.drawer-body_section&_input]:w-full [.inquiry-drawer_.drawer-body_section&_input]:[box-sizing:border-box] [.inquiry-drawer_.drawer-body_section&_input]:min-h-[42px] [.inquiry-drawer_.drawer-body_section&_input]:p-[10px_12px] [.inquiry-drawer_.drawer-body_section&_input]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.inquiry-drawer_.drawer-body_section&_input]:rounded-[8px] [.inquiry-drawer_.drawer-body_section&_input]:[background-color:rgba(255,_255,_255,_0.03)] [.inquiry-drawer_.drawer-body_section&_input]:text-[color:var(--drawer-text,_#e6e9f2)] [.inquiry-drawer_.drawer-body_section&_input]:[font-family:inherit] [.inquiry-drawer_.drawer-body_section&_input]:[font-weight:inherit] [.inquiry-drawer_.drawer-body_section&_input]:[font-style:inherit] [.inquiry-drawer_.drawer-body_section&_input]:text-[0.9rem] [.inquiry-drawer_.drawer-body_section&_input]:leading-[1.3] [.inquiry-drawer_.drawer-body_section&_input]:[color-scheme:dark] [.inquiry-drawer_.drawer-body_section&_input]:[transition:border-color_0.15s_ease,_box-shadow_0.15s_ease,_background-color_0.15s_ease] [.inquiry-drawer_.drawer-body_section&_select]:block [.inquiry-drawer_.drawer-body_section&_select]:w-full [.inquiry-drawer_.drawer-body_section&_select]:[box-sizing:border-box] [.inquiry-drawer_.drawer-body_section&_select]:min-h-[42px] [.inquiry-drawer_.drawer-body_section&_select]:p-[10px_12px] [.inquiry-drawer_.drawer-body_section&_select]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.inquiry-drawer_.drawer-body_section&_select]:rounded-[8px] [.inquiry-drawer_.drawer-body_section&_select]:[background-color:rgba(255,_255,_255,_0.03)] [.inquiry-drawer_.drawer-body_section&_select]:text-[color:var(--drawer-text,_#e6e9f2)] [.inquiry-drawer_.drawer-body_section&_select]:[font-family:inherit] [.inquiry-drawer_.drawer-body_section&_select]:[font-weight:inherit] [.inquiry-drawer_.drawer-body_section&_select]:[font-style:inherit] [.inquiry-drawer_.drawer-body_section&_select]:text-[0.9rem] [.inquiry-drawer_.drawer-body_section&_select]:leading-[1.3] [.inquiry-drawer_.drawer-body_section&_select]:[color-scheme:dark] [.inquiry-drawer_.drawer-body_section&_select]:[transition:border-color_0.15s_ease,_box-shadow_0.15s_ease,_background-color_0.15s_ease] [.inquiry-drawer_.drawer-body_section&_textarea]:block [.inquiry-drawer_.drawer-body_section&_textarea]:w-full [.inquiry-drawer_.drawer-body_section&_textarea]:[box-sizing:border-box] [.inquiry-drawer_.drawer-body_section&_textarea]:p-[10px_12px] [.inquiry-drawer_.drawer-body_section&_textarea]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.inquiry-drawer_.drawer-body_section&_textarea]:rounded-[8px] [.inquiry-drawer_.drawer-body_section&_textarea]:[background-color:rgba(255,_255,_255,_0.03)] [.inquiry-drawer_.drawer-body_section&_textarea]:text-[color:var(--drawer-text,_#e6e9f2)] [.inquiry-drawer_.drawer-body_section&_textarea]:[font-family:inherit] [.inquiry-drawer_.drawer-body_section&_textarea]:[font-weight:inherit] [.inquiry-drawer_.drawer-body_section&_textarea]:[font-style:inherit] [.inquiry-drawer_.drawer-body_section&_textarea]:text-[0.9rem] [.inquiry-drawer_.drawer-body_section&_textarea]:leading-[1.3] [.inquiry-drawer_.drawer-body_section&_textarea]:[color-scheme:dark] [.inquiry-drawer_.drawer-body_section&_textarea]:[transition:border-color_0.15s_ease,_box-shadow_0.15s_ease,_background-color_0.15s_ease] [.inquiry-drawer_.drawer-body_section&_select]:cursor-pointer later:[.inquiry-drawer_.drawer-body_section&_textarea]:min-h-[104px] [.inquiry-drawer_.drawer-body_section&_textarea]:[resize:vertical] [.inquiry-drawer_.drawer-body_section&_input::placeholder]:text-[color:var(--drawer-muted,_#8590a8)] [.inquiry-drawer_.drawer-body_section&_input::placeholder]:opacity-[0.7] [.inquiry-drawer_.drawer-body_section&_textarea::placeholder]:text-[color:var(--drawer-muted,_#8590a8)] [.inquiry-drawer_.drawer-body_section&_textarea::placeholder]:opacity-[0.7] [.inquiry-drawer_.drawer-body_section&_input:hover]:border-[rgba(123,_136,_255,_0.45)] [.inquiry-drawer_.drawer-body_section&_select:hover]:border-[rgba(123,_136,_255,_0.45)] [.inquiry-drawer_.drawer-body_section&_textarea:hover]:border-[rgba(123,_136,_255,_0.45)] [.inquiry-drawer_.drawer-body_section&_input:focus]:[outline:none] later:[.inquiry-drawer_.drawer-body_section&_input:focus]:border-[color:var(--drawer-accent,_#7b88ff)] [.inquiry-drawer_.drawer-body_section&_input:focus]:[box-shadow:0_0_0_3px_rgba(123,_136,_255,_0.22)] [.inquiry-drawer_.drawer-body_section&_input:focus]:[background-color:rgba(123,_136,_255,_0.05)] [.inquiry-drawer_.drawer-body_section&_select:focus]:[outline:none] later:[.inquiry-drawer_.drawer-body_section&_select:focus]:border-[color:var(--drawer-accent,_#7b88ff)] [.inquiry-drawer_.drawer-body_section&_select:focus]:[box-shadow:0_0_0_3px_rgba(123,_136,_255,_0.22)] [.inquiry-drawer_.drawer-body_section&_select:focus]:[background-color:rgba(123,_136,_255,_0.05)] [.inquiry-drawer_.drawer-body_section&_textarea:focus]:[outline:none] later:[.inquiry-drawer_.drawer-body_section&_textarea:focus]:border-[color:var(--drawer-accent,_#7b88ff)] [.inquiry-drawer_.drawer-body_section&_textarea:focus]:[box-shadow:0_0_0_3px_rgba(123,_136,_255,_0.22)] [.inquiry-drawer_.drawer-body_section&_textarea:focus]:[background-color:rgba(123,_136,_255,_0.05)] max-[521px]:later:[.inquiry-drawer_.drawer-body_section&>label:nth-of-type(-n+4)]:col-span-full">
                    <h3>Edit details</h3>
                    <Notice type="error">{drawerError}</Notice>
                    <label>
                      <span>First name</span>
                      <input value={drawerForm.first_name} onChange={(e) => setDrawerForm({ ...drawerForm, first_name: e.target.value })} />
                    </label>
                    <label>
                      <span>Last name</span>
                      <input value={drawerForm.last_name} onChange={(e) => setDrawerForm({ ...drawerForm, last_name: e.target.value })} />
                    </label>
                    <label>
                      <span>Contact number</span>
                      <PhoneInput
                        label="Contact number"
                        value={drawerForm.phone}
                        onChange={(next) => setDrawerForm((current) => ({ ...current, phone: next }))}
                      />
                    </label>
                    <label>
                      <span>Email</span>
                      <input type="email" value={drawerForm.email} onChange={(e) => setDrawerForm({ ...drawerForm, email: e.target.value })} />
                    </label>
                    <label>
                      <span>Concept</span>
                      <select
                        value={drawerForm.preferred_brand_id}
                        onChange={(e) => setDrawerForm({ ...drawerForm, preferred_brand_id: e.target.value })}
                        style={{ color: brandColor(brandMap.get(Number(drawerForm.preferred_brand_id))) }}
                      >
                        {brandOptions.map((brand) => <option key={brand.id} value={brand.id} style={{ color: brandColor(brand.name) }}>{brand.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Preferred franchise location</span>
                      <input
                        value={drawerForm.preferred_franchise_location}
                        onChange={(e) => setDrawerForm({ ...drawerForm, preferred_franchise_location: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Remarks</span>
                      <textarea rows={4} value={drawerForm.remarks} onChange={(e) => setDrawerForm({ ...drawerForm, remarks: e.target.value })} />
                    </label>
                    <div className="flex justify-end gap-2 p-[6px_0_14px] [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:flex [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:justify-end [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:gap-[10px] [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:mt-1 [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:p-[16px_0_0] [.inquiry-drawer_.drawer-body_section.drawer-edit_&]:[border-top:1px_solid_var(--drawer-border,_#1a2133)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:min-h-[40px] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:p-[0_18px] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:rounded-[8px] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:[font-family:inherit] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:[font-style:inherit] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:[line-height:inherit] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:text-[0.88rem] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:font-[650] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button]:cursor-pointer [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button)]:[border:1px_solid_var(--drawer-border,_#1a2133)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button)]:[background:transparent] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button)]:text-[color:var(--drawer-muted,_#b4bdd4)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button)]:[transition:background-color_0.15s_ease,_color_0.15s_ease,_border-color_0.15s_ease] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button):hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.05)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button):hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.45)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:not(.primary-button):hover:not(:disabled)]:text-[color:var(--drawer-text,_#e6e9f2)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:disabled]:opacity-[0.55] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:disabled]:cursor-not-allowed [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:focus-visible]:[outline:2px_solid_var(--drawer-accent,_#7b88ff)] [.inquiry-drawer_.drawer-body_section.drawer-edit_&_button:focus-visible]:[outline-offset:2px]">
                      <button type="button" onClick={cancelDrawerEdit} disabled={drawerSaving}>Cancel</button>
                      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={saveDrawerEdit} disabled={drawerSaving}>
                        {drawerSaving ? 'Saving…' : 'Save changes'}
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    <section>
                      <h3>About</h3>
                      <dl>
                        <DetailRow label="Contact number">
                          {shown.phone && <a href={`tel:${shown.phone}`}>{shown.phone}</a>}
                        </DetailRow>
                        {shown.viber_number && shown.viber_number !== shown.phone && (
                          <DetailRow label="Viber number">{shown.viber_number}</DetailRow>
                        )}
                        <DetailRow label="Email">
                          {shown.email && <a href={`mailto:${shown.email}`}>{shown.email}</a>}
                        </DetailRow>
                        <DetailRow label="Source">{titleCase(shown.source)}</DetailRow>
                        <DetailRow label="Date inquired">{formatDate(shown.inquiry_date)}</DetailRow>
                      </dl>
                    </section>
                    <section>
                      <h3>Franchise interest</h3>
                      <dl>
                        <DetailRow label="Concept">{shownConcept ? <BrandText name={shownConcept} /> : null}</DetailRow>
                        <DetailRow label="Current city of residence">{shown.current_city}</DetailRow>
                        <DetailRow label="Preferred franchise location">{shown.preferred_franchise_location}</DetailRow>
                        {shown.address && <DetailRow label="Address (previous record)">{shown.address}</DetailRow>}
                      </dl>
                    </section>
                  </>
                )}
                <section>
                  <h3>Status</h3>
                  <div className="pb-[14px]"><StatusBadge value={shown.status} /></div>
                </section>
                {!drawerEditing && (
                  <section>
                    <h3>Remarks</h3>
                    <p className="m-[0_0_14px] text-[0.9rem] leading-[1.55] whitespace-pre-wrap">{shown.remarks || <span className="text-[color:var(--drawer-muted)] opacity-[0.7] italic">No remarks recorded.</span>}</p>
                  </section>
                )}
              </div>
            </>
          )}
        </aside>
      </ModalPortal>

      {showCreate && (
        <ModalPortal>
          <Modal
            title={editingId ? 'Edit inquiry' : 'Record a new inquiry'}
            onClose={closeForm}
            footer={<><button onClick={closeForm}>Cancel</button><button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="inquiry-form" disabled={saving || Boolean(duplicateMatches) || !form.first_name.trim() || !form.last_name.trim() || !form.source || !form.phone.trim() || !form.preferred_brand_id}>{saving ? 'Saving…' : (editingId ? 'Save changes' : 'Save inquiry')}</button></>}
          >
            <Notice type="error">{actionError}</Notice>
            <form id="inquiry-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submitCreate} noValidate>
              <Field label="First name" required>
                <div className="relative [&>input]:w-full">
                  <input
                    required
                    autoComplete="off"
                    value={form.first_name}
                    onChange={(e) => { setForm({ ...form, first_name: e.target.value }); setSuggestField('first_name'); }}
                    onKeyDown={onNameKeyDown}
                    onBlur={() => setSuggestField(null)}
                  />
                  {renderSuggestions('first_name')}
                </div>
              </Field>
              <Field label="Last name" required>
                <div className="relative [&>input]:w-full">
                  <input
                    required
                    autoComplete="off"
                    value={form.last_name}
                    onChange={(e) => { setForm({ ...form, last_name: e.target.value }); setSuggestField('last_name'); }}
                    onKeyDown={onNameKeyDown}
                    onBlur={() => setSuggestField(null)}
                  />
                  {renderSuggestions('last_name')}
                </div>
              </Field>

              <Field label="Source" required>
                <select required value={form.source} onChange={(e) => setForm((current) => ({ ...current, source: e.target.value }))}>
                  <option value="">-- Select Source --</option>
                  {sourceOptions.map((source) => <option key={source} value={source}>{titleCase(source)}</option>)}
                  {hasLegacySource && <option value={form.source}>{titleCase(form.source)} (legacy)</option>}
                </select>
              </Field>

              <Field label="Email">
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>

              {/* When the source is Viber, this same number is the Viber number (no extra field). */}
              <Field label="Phone number" required>
                <PhoneInput
                  label="Phone number"
                  required
                  value={form.phone}
                  onChange={(next) => setForm((current) => ({ ...current, phone: next }))}
                />
              </Field>

              <Field label="Concept" required>
                <select
                  required
                  value={form.preferred_brand_id}
                  onChange={(e) => setForm({ ...form, preferred_brand_id: e.target.value })}
                  style={{ color: brandColor(brandMap.get(Number(form.preferred_brand_id))) }}
                >
                  <option value="">-- Select Branch / Concept --</option>
                  {brandOptions.map((brand) => <option key={brand.id} value={brand.id} style={{ color: brandColor(brand.name) }}>{brand.name}</option>)}
                </select>
              </Field>
              <Field label="Current city of residence">
                <input value={form.current_city} onChange={(e) => setForm({ ...form, current_city: e.target.value })} />
              </Field>
              <Field label="Preferred franchise location">
                <input value={form.preferred_franchise_location} onChange={(e) => setForm({ ...form, preferred_franchise_location: e.target.value })} />
              </Field>
              {/* Logged By is never typed: it is the signed-in user, or the
                  person who encoded the record when editing. */}
              <Field label="Logged By" full>
                <input
                  className="is-locked"
                  value={editingId ? (rows.find((row) => row.id === editingId)?.encoded_by?.full_name || '—') : (user?.full_name || '')}
                  readOnly
                  aria-readonly="true"
                  tabIndex={-1}
                  title="Filled automatically from the signed-in account"
                />
              </Field>
              <Field label="Remarks" full>
                <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="Context, needs, timing, and next step" />
              </Field>
              {duplicateMatches && (
                <div className="col-span-full p-[14px_16px] rounded-[12px] border border-[rgba(251,_191,_36,_0.4)] [background:rgba(251,_191,_36,_0.08)]" role="alert" ref={duplicateRef}>
                  <div className="flex gap-[10px] items-start text-[#fbbf24] [&_svg]:flex-none later:[&_svg]:mt-[3px] later-2:[&_p]:m-0 [&_p]:font-[600] later:[&_p]:leading-[1.45] later-2:[&_p]:text-[#f4e3b0]">
                    <FaTriangleExclamation aria-hidden="true" />
                    <p>An inquiry for this person and brand already exists. Do you still want to save this inquiry?</p>
                  </div>
                  <ul className="m-[12px_0_0] p-[0_0_0_26px] grid gap-2 text-[0.88rem] [&_small]:block [&_small]:text-[#8590a8]">
                    {duplicateMatches.slice(0, 3).map(({ row, reasons }) => (
                      <li key={row.id}>
                        <strong>{leadDisplayName(row)}</strong>
                        <span> — <BrandText name={row.preferred_brand?.name || brandMap.get(row.preferred_brand_id)} /></span>
                        <small>
                          {[row.preferred_franchise_location, formatDate(row.inquiry_date), titleCase(row.status)].filter(Boolean).join(' · ')}
                          {' · '}matched by {reasons.join(' and ')}
                        </small>
                      </li>
                    ))}
                    {duplicateMatches.length > 3 && <li><small>and {duplicateMatches.length - 3} more</small></li>}
                  </ul>
                  <div className="flex justify-end gap-2 mt-[14px]">
                    <button type="button" onClick={() => setDuplicateMatches(null)} disabled={saving}>Cancel</button>
                    <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={confirmDuplicate} disabled={saving}>
                      {saving ? 'Saving…' : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </form>
          </Modal>
        </ModalPortal>
      )}

      {bulkRestoreTargets && (
        <ModalPortal>
          <Modal
            title={`Restore ${bulkRestoreTargets.length} inquiries?`}
            onClose={() => setBulkRestoreTargets(null)}
            size="small"
            footer={(
              <>
                <button onClick={() => setBulkRestoreTargets(null)} disabled={saving}>Cancel</button>
                <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={confirmBulkRestore} disabled={saving}>
                  {saving ? 'Restoring…' : 'Restore inquiries'}
                </button>
              </>
            )}
          >
            <div className="grid grid-cols-[48px_minmax(0,_1fr)] gap-[14px] [align-items:start] [&_strong]:block [&_strong]:m-[2px_0_7px] later-2:[&_strong]:text-text later-3:[&_strong]:text-[11px] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[9px] [&_p]:leading-[1.6] max-[451px]:later:grid-cols-[1fr]">
              <span className="confirmation-icon w-[48px] h-[48px] grid place-items-center rounded-[15px] text-danger-text [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)] text-[18px] [&.confirmation-icon]:text-accent-text [&.confirmation-icon]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)]"><FaRotateLeft /></span>
              <div>
                <strong>{bulkRestoreTargets.length} selected inquiries</strong>
                <p>They return to the active pipeline with their original details.</p>
              </div>
            </div>
          </Modal>
        </ModalPortal>
      )}

      {pendingAction && (
        <ModalPortal>
          <Modal
            title={actionCopy[pendingAction.type]?.title || 'Update this inquiry?'}
            onClose={() => setPendingAction(null)}
            size="small"
            footer={(
              <>
                <button onClick={() => setPendingAction(null)}>Cancel</button>
                <button
                  className={pendingAction.type === 'delete' ? 'danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]' : 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]'}
                  onClick={runAction}
                  disabled={saving}
                >
                  {saving ? 'Processing…' : actionCopy[pendingAction.type]?.button}
                </button>
              </>
            )}
          >
            <Notice type="error">{actionError}</Notice>
            <div className="grid grid-cols-[48px_minmax(0,_1fr)] gap-[14px] [align-items:start] [&_strong]:block [&_strong]:m-[2px_0_7px] later-2:[&_strong]:text-text later-3:[&_strong]:text-[11px] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[9px] [&_p]:leading-[1.6] max-[451px]:later:grid-cols-[1fr]">
              <span className="confirmation-icon w-[48px] h-[48px] grid place-items-center rounded-[15px] text-danger-text [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)] text-[18px] [&.confirmation-icon]:text-accent-text [&.confirmation-icon]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)]"><FaRightLeft /></span>
              <div>
                <strong>{leadDisplayName(pendingAction.inquiry)}</strong>
                <p>{actionCopy[pendingAction.type]?.body}</p>
              </div>
            </div>
          </Modal>
        </ModalPortal>
      )}
    </div>
  );
}
