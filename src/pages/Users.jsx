import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FaUserPlus } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, titleCase } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader, Pagination } from '../components/ApiUi';

const blank = { full_name: '', email: '', phone: '', password: '', role: 'marketing', account_status: 'active' };
const branchBlank = { ...blank, role: 'franchisee' };

const cleanPhone = (value) => value.replace(/\D/g, '').slice(0, 11);

/** 9:38 AM — presence timestamps only need the clock in these columns. */
const clock = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
};

/** YYYY-MM-DD in the browser's own timezone (form date inputs use local dates). */
const localDate = (date = new Date()) => {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
};

export default function Users() {
  const location = useLocation();
  const { user: currentUser } = useAuth();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('staff');
  const [roleFilter, setRoleFilter] = useState('');
  const [applicantSelection, setApplicantSelection] = useState(null);
  const [applicantChoices, setApplicantChoices] = useState([]);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  // Suspending always asks for the window first, then applies it on Confirm.
  const [suspendTarget, setSuspendTarget] = useState(null);
  const [suspendForm, setSuspendForm] = useState({ from: '', until: '' });
  const [suspendError, setSuspendError] = useState('');
  const [suspending, setSuspending] = useState(false);
  const remote = useRemote(async () => api.get('/users', {
    page,
    per_page: 20,
    search,
    role: tab === 'branch' ? 'franchisee' : (roleFilter || 'staff'),
  }), [page, search, tab, roleFilter]);
  const visibleUsers = (remote.data?.data || []).filter((user) => {
    const userRole = user.role?.name || user.role;
    return tab === 'branch'
      ? userRole === 'franchisee'
      : ['admin', 'sales', 'marketing', 'logistics'].includes(userRole);
  });

  useEffect(() => {
    if (!showCreate || applicantSelection) return undefined;
    let active = true;
    api.get('/applicants', { status: 'approved', per_page: 100 })
      .then((response) => { if (active) setApplicantChoices(response.data || []); })
      .catch(() => { if (active) setApplicantChoices([]); });
    return () => { active = false; };
  }, [showCreate, applicantSelection]);

  useEffect(() => {
    const applicant = location.state?.createFranchiseeFor;
    if (!applicant) return;
    setApplicantSelection(applicant);
    setTab('branch');
    setPage(1);
    setForm({ ...branchBlank, full_name: applicant.full_name || '', email: applicant.email || '', phone: cleanPhone(applicant.phone || '') });
    setActionError('');
    setShowCreate(true);
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }, [location.state]);

  const createUser = async (event) => {
    event.preventDefault();
    const creatingBranchAccount = Boolean(applicantSelection);
    setSaving(true);
    setActionError('');
    setSuccess('');
    try {
      if (!/^[0-9]{11}$/.test(form.phone)) throw new Error('Phone / Contact must be exactly 11 numeric digits.');
      if (form.password.length < 8 || form.password.length > 15) throw new Error('Password must be between 8 and 15 characters.');
      if (form.password !== form.confirm_password) throw new Error('Password and Confirm Password must match.');
      if (applicantSelection) {
        await api.post(`/applicants/${applicantSelection.applicantId}/portal-user`, { email: form.email, phone: form.phone, password: form.password, confirm_password: form.confirm_password });
      } else {
        await api.post('/users', form);
      }
      setForm(blank);
      setApplicantSelection(null);
      setShowCreate(false);
      setSuccess('User account created successfully.');
      await remote.reload();
      if (creatingBranchAccount) window.dispatchEvent(new CustomEvent('herald:branch-account-created'));
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const openSuspend = (user) => {
    setActionError('');
    setSuccess('');
    setSuspendError('');
    setSuspendForm({ from: localDate(), until: '' });
    setSuspendTarget(user);
  };

  const confirmSuspend = async (event) => {
    event.preventDefault();
    const { from, until } = suspendForm;
    if (!until) {
      setSuspendError('Choose the date this suspension ends.');
      return;
    }
    if (until < from) {
      setSuspendError('The suspension must end on or after the date it starts.');
      return;
    }
    setSuspending(true);
    setSuspendError('');
    try {
      await api.put(`/users/${suspendTarget.id}`, {
        account_status: 'suspended',
        suspended_from: from,
        suspended_until: until,
      });
      const name = suspendTarget.full_name;
      setSuspendTarget(null);
      setSuccess(`${name}'s account is suspended until ${formatDate(until)}. It returns to Active automatically after that date.`);
      await remote.reload();
    } catch (error) {
      setSuspendError(firstValidationMessage(error));
    } finally {
      setSuspending(false);
    }
  };

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] users-page [&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later:[&>:empty]:hidden! [&_.unified-toolbar-container]:m-0 [&_.data-panel]:m-0 [&_.table-wrap_table]:text-[12px] [&_.table-wrap_table_tbody_td]:text-[12px] [&_.table-wrap_table_tbody_td]:leading-[1.5] [&_.table-wrap_table_tbody_td]:pt-3 [&_.table-wrap_table_tbody_td]:pb-3 [&_.table-wrap_table_tbody_td_strong]:text-[13px] [&_.table-wrap_table_tbody_td_small]:text-[11px]">
      <PageHeader title="User management" subtitle="Accounts and role-based access" />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>

      {/* Unified toolbar: section tabs, search, role filter and the primary action. */}
      <div className="unified-toolbar-container flex items-center flex-nowrap gap-[10px] w-full [box-sizing:border-box] m-0 p-[10px_14px] border border-[#252b3b] rounded-[14px] [background:#101421] max-[721px]:later:flex-wrap max-[721px]:later:gap-2 max-[721px]:later:p-[8px_10px] max-[721px]:later:rounded-[12px] [.activities-page_&]:m-0">
        <div className="flex items-center flex-[0_1_auto] min-w-0 gap-[2px] p-1 overflow-x-auto border border-[#1f2638] rounded-[10px] [background:#0b0f19] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:flex-[0_0_auto] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:min-h-[34px] [&>button]:p-[7px_15px] later-2:[&>button]:border later-2:[&>button]:border-transparent later-2:[&>button]:rounded-[8px] [&>button]:[background:transparent] [&>button]:text-[#8a94a6] [&>button]:[font-family:inherit] [&>button]:[font-style:inherit] later-2:[&>button]:text-[13px] later-2:[&>button]:font-[600] later:[&>button]:leading-[1.2] [&>button]:whitespace-nowrap later:[&>button]:cursor-pointer [&>button]:[transition:background_.15s_ease,_color_.15s_ease,_border-color_.15s_ease] [&>button:hover:not(.active):not([aria-selected='true'])]:text-[#d7ddf5] [&>button:hover:not(.active):not([aria-selected='true'])]:[background:rgba(255,_255,_255,_.04)] [&>button:hover:not(.active):not([aria-selected='true'])]:border-transparent [&>button.active]:[background:#252e42] [&>button.active]:text-[#fff] [&>button.active]:font-[600] [&>button.active]:border-transparent [&>button.active]:[box-shadow:none] later:[&>button[aria-selected='true']]:[background:#252e42] [&>button[aria-selected='true']]:text-[#fff] [&>button[aria-selected='true']]:font-[600] [&>button[aria-selected='true']]:border-transparent [&>button[aria-selected='true']]:[box-shadow:none] later:[&>button:focus-visible]:[outline:2px_solid_#8175ff] later:[&>button:focus-visible]:[outline-offset:2px] [&>button_svg]:flex-[0_0_auto] [&>button_svg]:text-[12px] max-[721px]:later:flex-[1_1_100%]" role="tablist" aria-label="User account types">
          <button type="button" role="tab" aria-selected={tab === 'staff'} className={tab === 'staff' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} onClick={() => { setTab('staff'); setPage(1); }}>Staff / Admin</button>
          <button type="button" role="tab" aria-selected={tab === 'branch'} className={tab === 'branch' ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''} onClick={() => { setTab('branch'); setPage(1); }}>Active Franchisees</button>
        </div>
        <div className="flex-[1_1_160px] min-w-[120px] flex [&_input]:flex-[1_1_auto] [&_input]:w-full [&_input]:min-w-0 [&_input]:h-[44px] [&_input]:[box-sizing:border-box] [&_input]:p-[0_14px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:text-[13px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_input]:h-[42px]">
          <input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Search by name, email or User ID" aria-label="Search users" />
        </div>
        {tab === 'staff' && (
          <div className="flex-[0_0_180px] flex [&_select]:w-full [&_select]:h-[44px] [&_select]:[box-sizing:border-box] [&_select]:p-[0_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:text-[13px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select:hover]:border-line-strong later:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_select:focus]:[background:var(--input-focus-bg)] max-[721px]:later:flex-[1_1_100%] max-[721px]:later:[&_select]:h-[42px]">
            <select value={roleFilter} onChange={(e) => { setPage(1); setRoleFilter(e.target.value); }} aria-label="Filter by role">
              <option value="">All roles</option>
              {['admin', 'marketing', 'sales', 'logistics'].map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}
            </select>
          </div>
        )}
        <button
          type="button"
          className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] [.unified-toolbar-container_&]:flex-[0_0_auto] [.unified-toolbar-container_&]:inline-flex [.unified-toolbar-container_&]:items-center [.unified-toolbar-container_&]:justify-center [.unified-toolbar-container_&]:gap-2 [.unified-toolbar-container_&]:h-[44px] [.unified-toolbar-container_&]:min-h-[44px] [.unified-toolbar-container_&]:p-[0_18px] [.unified-toolbar-container_&]:rounded-[10px] [.unified-toolbar-container_&]:text-[13px] [.unified-toolbar-container_&]:font-[700] max-[721px]:later:[.unified-toolbar-container_&]:flex-[1_1_100%]"
          onClick={() => { setApplicantSelection(null); setForm(blank); setActionError(''); setShowCreate(true); }}
        >
          <FaUserPlus aria-hidden="true" /> New user
        </button>
      </div>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        {remote.loading ? <LoadingState /> : !visibleUsers.length ? (
          <EmptyState label={tab === 'branch' ? 'No branch accounts match this search.' : 'No staff users match this search.'} detail="Clear the search or create a new account." />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer"><table><thead><tr>
            <th>User</th><th>Role</th>
            {tab === 'branch' ? <th>Created</th> : <><th>Time in</th><th>Time out</th></>}
            <th>Status</th><th>Update</th>
          </tr></thead><tbody>
            {visibleUsers.map((user) => {
              const presence = user.presence || {};
              const isSelf = String(user.id) === String(currentUser?.id);
              const online = Boolean(presence.is_online);
              // Active/InActive is automatic (live session); suspension overrides it.
              const badge = user.account_status === 'suspended'
                ? 'suspended'
                : online ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : 'inactive';
              return (
                <tr key={user.id}>
                  <td><strong>{user.full_name}</strong><small>{user.email}</small>{user.user_code && <small>{user.user_code}</small>}</td>
                  <td>{titleCase(user.role?.name || user.role)}{isSelf && <small>your account</small>}</td>
                  {tab === 'branch' ? <td>{formatDate(user.created_at)}</td> : <>
                    <td>{clock(presence.time_in)}</td>
                    <td>{clock(presence.time_out)}</td>
                  </>}
                  <td>
                    <span className={`status-pill min-h-[24px] inline-flex items-center gap-[6px] p-[4px_9px] border border-line rounded-[999px] text-text-secondary [background:var(--surface-subtle)] text-[8px] font-[720] capitalize whitespace-nowrap [.readable-list_&]:text-[12px] status-${badge}`}>
                      <span className="w-[6px] h-[6px] rounded-[50%] [background:currentColor] [box-shadow:0_0_0_3px_color-mix(in_srgb,_currentColor_11%,_transparent)]" aria-hidden="true" />
                      {badge === 'active' ? 'Active' : badge === 'suspended' ? 'Suspended' : 'InActive'}
                    </span>
                    {badge === 'suspended' && (
                      <small>
                        {user.suspended_from ? formatDate(user.suspended_from) : 'Now'} – {user.suspended_until ? formatDate(user.suspended_until) : 'no end date'}
                      </small>
                    )}
                    {badge === 'inactive' && presence.last_active && <small>Last active {formatDate(presence.last_active, true)}</small>}
                  </td>
                  <td>
                    {isSelf ? (
                      <span className="muted-note text-muted text-[8px] leading-[1.6]">Your account</span>
                    ) : (
                      <select
                        className="border border-input-line rounded-[11px] later:[outline:none] text-text [background:var(--input-bg)] [transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] hover:border-line-strong later:focus:border-accent focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] focus:[background:var(--input-focus-bg)] w-[min(180px,_100%)] later:min-h-[34px] later:p-[6px_8px] text-[8px]"
                        value=""
                        aria-label={`Update ${user.full_name}`}
                        onChange={(e) => { if (e.target.value === 'suspend') openSuspend(user); }}
                      >
                        <option value="">Update</option>
                        <option value="suspend">{user.account_status === 'suspended' ? 'Suspend again' : 'Suspend'}</option>
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody></table></div>
        )}
        <Pagination meta={remote.data?.meta} onPage={setPage} />
      </section>

      {showCreate && (
        <Modal title={applicantSelection ? `Create branch account for ${applicantSelection.full_name}` : 'Create user account'} onClose={() => { setShowCreate(false); setApplicantSelection(null); }} footer={<><button onClick={() => { setShowCreate(false); setApplicantSelection(null); }}>Cancel</button><button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="user-form" disabled={saving}>{saving ? 'Saving…' : 'Create user'}</button></>}>
          <Notice type="error">{actionError}</Notice>
          <form id="user-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={createUser}>
            {applicantSelection
              ? <Field label="Full name" required><input required readOnly value={form.full_name} /></Field>
                : <Field label="Full name" required><select required value={form.full_name} onChange={(e) => {
                const selectedApplicant = applicantChoices.find((candidate) => candidate.full_name === e.target.value);
                setApplicantSelection(selectedApplicant ? {
                  applicantId: selectedApplicant.id,
                  full_name: selectedApplicant.full_name,
                  email: selectedApplicant.email || '',
                  phone: selectedApplicant.phone || '',
                  preferred_brand: selectedApplicant.preferred_brand || null,
                  preferred_brand_id: selectedApplicant.preferred_brand_id || null,
                  status: selectedApplicant.status,
                } : null);
                setForm({ ...branchBlank, full_name: selectedApplicant?.full_name || '', email: selectedApplicant?.email || '', phone: cleanPhone(selectedApplicant?.phone || '') });
              }}>
                <option value="">Select an approved applicant</option>
                {applicantChoices.map((candidate) => <option key={candidate.id} value={candidate.full_name}>{candidate.full_name}</option>)}
              </select></Field>}
            <Field label="Email" required><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Phone / Contact" required><input required inputMode="numeric" maxLength={11} pattern="[0-9]{11}" value={form.phone} onChange={(e) => setForm({ ...form, phone: cleanPhone(e.target.value) })} /></Field>
            <Field label="Password" required hint="Use 8 to 15 characters. Share it through a secure channel."><input required minLength="8" maxLength="15" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
            <Field label="Confirm Password" required><input required minLength="8" maxLength="15" type="password" autoComplete="new-password" value={form.confirm_password || ''} onChange={(e) => setForm({ ...form, confirm_password: e.target.value })} /></Field>
            {applicantSelection && <Field label="Preferred Branch Type"><input readOnly value={applicantSelection.preferred_brand?.name || 'Not specified'} /></Field>}
            {!applicantSelection && <Field label="Role" required><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['marketing', 'sales', 'logistics'].map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</select></Field>}
            {/* Status is automatic (live session heartbeat): new accounts start Active. */}
          </form>
        </Modal>
      )}

      {suspendTarget && (
        <Modal
          title={`Suspend ${suspendTarget.full_name}`}
          onClose={() => setSuspendTarget(null)}
          size="small"
          footer={(
            <>
              <button type="button" onClick={() => setSuspendTarget(null)}>Cancel</button>
              <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="suspend-form" disabled={suspending}>
                {suspending ? 'Suspending…' : 'Confirm suspension'}
              </button>
            </>
          )}
        >
          <Notice type="error">{suspendError}</Notice>
          <p className="muted-note text-muted text-[8px] leading-[1.6]" style={{ marginTop: 0 }}>
            Pick when the suspension starts and when it ends. The account is blocked as soon as you
            confirm and returns to Active automatically after the end date; setting it back to Active
            lifts the suspension early.
          </p>
          <form id="suspend-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={confirmSuspend}>
            <Field label="Start date" required>
              <input
                required
                type="date"
                value={suspendForm.from}
                onChange={(e) => setSuspendForm({ ...suspendForm, from: e.target.value })}
              />
            </Field>
            <Field label="End date" required hint="The account returns to Active after this date.">
              <input
                required
                type="date"
                min={suspendForm.from}
                value={suspendForm.until}
                onChange={(e) => setSuspendForm({ ...suspendForm, until: e.target.value })}
              />
            </Field>
          </form>
        </Modal>
      )}
    </div>
  );
}
