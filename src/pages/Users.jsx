import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FaUserPlus } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate, titleCase } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { EmptyState, Field, LoadingState, Modal, Notice, PageHeader } from '../components/ApiUi';
import SlidingPagination from '../components/SlidingPagination';
import { accountBadge, localDateTimeInput } from '../lib/accountStatus';

const blank = { full_name: '', email: '', phone: '', role: 'marketing', applicant_id: '' };

/** Every account type is invited by email. Admin asks for an extra confirmation. */
const CREATE_ROLES = [
  { value: 'marketing', label: 'Marketing' },
  { value: 'sales', label: 'Sales' },
  { value: 'logistics', label: 'Logistics' },
  { value: 'admin', label: 'Admin' },
  { value: 'franchisee', label: 'Franchisee (branch)' },
];

const cleanPhone = (value) => String(value || '').replace(/\D/g, '').slice(0, 11);

const PRIMARY = 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]';
const DANGER = 'min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_#ef596b,_#c9374a)] text-[12px] font-[760] disabled:opacity-60';
const FORM_GRID = 'form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr]';

// Same rules as the API (services/credentials.ts).
const NAME_PATTERN = /^[\p{L}\p{M} .'’-]+$/u;
const nameProblem = (value) => {
  const name = value.trim();
  if (!name) return 'Full name is required.';
  if (!NAME_PATTERN.test(name) || (name.match(/\p{L}/gu) || []).length < 2) {
    return 'Use letters, spaces, period, hyphen and apostrophe only (no digits or other symbols).';
  }
  return '';
};
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 9:38 AM — presence timestamps only need the clock in these columns. */
const clock = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
};

export default function Users() {
  const location = useLocation();
  const { user: currentUser } = useAuth();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('staff');
  const [roleFilter, setRoleFilter] = useState('');
  // Franchisee: the applicants who may get an account (Approved or Active Franchisee, no account yet).
  const [candidates, setCandidates] = useState({ key: null, status: 'loading', list: [] });
  const [candidateAttempt, setCandidateAttempt] = useState(0);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  // Archive (suspend): a warning first, then the window and reason.
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveStep, setArchiveStep] = useState('warn');
  const [archiveForm, setArchiveForm] = useState({ from: '', until: '', reason: '' });
  const [archiveError, setArchiveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelTarget, setCancelTarget] = useState(null);
  const remote = useRemote(async () => api.get('/users', {
    page,
    per_page: 8,
    search,
    role: tab === 'branch' ? 'franchisee' : (roleFilter || 'staff'),
  }), [page, search, tab, roleFilter]);
  const visibleUsers = (remote.data?.data || []).filter((user) => {
    const userRole = user.role?.name || user.role;
    return tab === 'branch'
      ? userRole === 'franchisee'
      : ['admin', 'sales', 'marketing', 'logistics'].includes(userRole);
  });

  const isFranchisee = form.role === 'franchisee';
  const candidateKey = showCreate && isFranchisee ? candidateAttempt : null;
  const candidateStatus = candidates.key === candidateKey ? candidates.status : 'loading';
  const candidateList = candidates.key === candidateKey ? candidates.list : [];
  const chosenApplicant = candidateList.find((a) => String(a.id) === String(form.applicant_id)) || null;

  useEffect(() => {
    if (candidateKey === null) return undefined;
    let active = true;
    api.get('/users/franchisee-candidates')
      .then((response) => {
        if (!active) return;
        const list = response.data || [];
        setCandidates({ key: candidateKey, status: list.length ? 'ready' : 'empty', list });
      })
      .catch(() => { if (active) setCandidates({ key: candidateKey, status: 'error', list: [] }); });
    return () => { active = false; };
  }, [candidateKey]);

  // Opened from an applicant ("Create Account"): Franchisee with that applicant chosen.
  useEffect(() => {
    const applicant = location.state?.createFranchiseeFor;
    if (!applicant) return;
    setTab('branch');
    setPage(1);
    setForm({
      ...blank,
      role: 'franchisee',
      applicant_id: String(applicant.applicantId),
      full_name: applicant.full_name || '',
      email: applicant.email || '',
      phone: cleanPhone(applicant.phone),
    });
    setActionError('');
    setShowCreate(true);
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }, [location.state]);

  const openCreate = () => { setForm(blank); setActionError(''); setShowCreate(true); };
  const closeCreate = () => { setShowCreate(false); setConfirmAdmin(false); setForm(blank); setActionError(''); };

  const changeRole = (role) => {
    // Switching between staff and Franchisee starts the identity fields again.
    const wasFranchisee = form.role === 'franchisee';
    if (wasFranchisee === (role === 'franchisee')) setForm({ ...form, role });
    else setForm({ ...blank, role });
    setActionError('');
  };

  const chooseApplicant = (id) => {
    const applicant = candidateList.find((a) => String(a.id) === String(id));
    setForm({
      ...form,
      applicant_id: id,
      full_name: applicant?.full_name || '',
      email: applicant?.email || '',
      phone: cleanPhone(applicant?.phone),
    });
  };

  const nameError = !isFranchisee && form.full_name ? nameProblem(form.full_name) : '';

  const checkForm = () => {
    if (isFranchisee && !form.applicant_id) return 'Choose the applicant for this Franchisee account.';
    if (!isFranchisee) {
      const problem = nameProblem(form.full_name);
      if (problem) return problem;
    }
    if (!EMAIL_PATTERN.test(form.email.trim())) return 'Enter a valid email address.';
    if (form.phone && !/^[0-9]{11}$/.test(form.phone)) return 'Phone / Contact must be exactly 11 digits, or left empty.';
    return '';
  };

  const sendInvite = async (adminConfirmed = false) => {
    setActionError('');
    setSuccess('');
    const problem = checkForm();
    if (problem) { setActionError(problem); return; }
    // Another Admin has full access: ask first.
    if (form.role === 'admin' && !adminConfirmed) { setConfirmAdmin(true); return; }
    setConfirmAdmin(false);
    setSaving(true);
    try {
      const email = form.email.trim();
      const full_name = (isFranchisee ? (chosenApplicant?.full_name || form.full_name) : form.full_name).trim();
      // The API decides where the email link opens (APP_STAFF_URL / APP_BRANCH_URL); this address is
      // only used when those are not set (local development).
      const invite = {
        email,
        full_name,
        role: form.role,
        phone: form.phone || null,
        redirect_to: `${window.location.origin}/reset-password`,
        ...(form.role === 'admin' ? { confirm_admin: true } : {}),
      };
      const response = isFranchisee
        ? await api.post(`/applicants/${form.applicant_id}/portal-user`, invite)
        : await api.post('/users', invite);
      const created = response.data;
      setShowCreate(false);
      setForm(blank);
      setSuccess(`Invite email sent to ${created?.credentials?.sent_to || created?.email || email}. They set their own password when they open the link.`);
      await remote.reload();
      if (isFranchisee) window.dispatchEvent(new CustomEvent('herald:branch-account-created'));
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const createUser = (event) => { event.preventDefault(); void sendInvite(false); };

  const resend = async (user) => {
    setActionError('');
    setSuccess('');
    try {
      const response = await api.post(`/users/${user.id}/resend-invite`);
      setSuccess(response.message || `Invite email sent to ${user.email}.`);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    }
  };

  const confirmCancel = async () => {
    setBusy(true);
    try {
      const response = await api.delete(`/users/${cancelTarget.id}/invite`);
      setSuccess(response.message || `The invitation for ${cancelTarget.email} was cancelled.`);
      setCancelTarget(null);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
      setCancelTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const openArchive = (user) => {
    setActionError('');
    setSuccess('');
    setArchiveError('');
    setArchiveStep('warn');
    setArchiveForm({ from: localDateTimeInput(), until: '', reason: '' });
    setArchiveTarget(user);
  };

  const confirmArchive = async (event) => {
    event.preventDefault();
    const from = archiveForm.from ? new Date(archiveForm.from) : new Date();
    const until = archiveForm.until ? new Date(archiveForm.until) : null;
    if (until && until <= from) { setArchiveError('The suspension must end after it starts.'); return; }
    setBusy(true);
    setArchiveError('');
    try {
      const response = await api.post(`/users/${archiveTarget.id}/archive`, {
        suspended_from: from.toISOString(),
        suspended_until: until ? until.toISOString() : null,
        reason: archiveForm.reason.trim() || null,
      });
      const name = archiveTarget.full_name;
      setArchiveTarget(null);
      setSuccess(`${name} was archived${until ? ` until ${formatDate(until, true)}` : ' until an Admin restores them'}. ${response.data?.account_status === 'suspended' ? 'They are signed out now.' : 'The suspension starts at the time you chose.'}`);
      await remote.reload();
    } catch (error) {
      setArchiveError(firstValidationMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = (user, action) => {
    if (action === 'archive') openArchive(user);
    else if (action === 'resend') void resend(user);
    else if (action === 'cancel') { setActionError(''); setSuccess(''); setCancelTarget(user); }
  };

  return (
    <div className="page-container w-full m-[0_auto] p-[clamp(10px,_1.2vw,_16px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] users-page [&.page-container]:flex! [&.page-container]:flex-col! [&.page-container]:justify-start! [&.page-container]:gap-3! [&.page-container]:pt-[14px]! later:[&>:empty]:hidden! [&_.unified-toolbar-container]:m-0 [&_.data-panel]:m-0 [&_.table-wrap_table]:text-[12px] [&_.table-wrap_table_tbody_td]:text-[12px] [&_.table-wrap_table_tbody_td]:leading-[1.5] [&_.table-wrap_table_tbody_td]:pt-3 [&_.table-wrap_table_tbody_td]:pb-3 [&_.table-wrap_table_tbody_td_strong]:text-[15px] [&_.table-wrap_table_tbody_td_small]:text-[11px]">
      <PageHeader title="User management" subtitle="Accounts and role-based access" />
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError || remote.error}</Notice>

      <div className="unified-toolbar-container flex items-center flex-nowrap gap-[10px] w-full [box-sizing:border-box] m-0 p-[10px_14px] border border-[#252b3b] rounded-[14px] [background:#101421] max-[721px]:later:flex-wrap max-[721px]:later:gap-2 max-[721px]:later:p-[8px_10px] max-[721px]:later:rounded-[12px] [.activities-page_&]:m-0">
        <div className="flex items-center flex-[0_1_auto] min-w-0 gap-[2px] p-1 overflow-x-auto border border-[#1f2638] rounded-[10px] [background:#0b0f19] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:flex-[0_0_auto] [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:min-h-[34px] [&>button]:p-[7px_15px] later-2:[&>button]:border later-2:[&>button]:border-transparent later-2:[&>button]:rounded-[8px] [&>button]:[background:transparent] [&>button]:text-[#8a94a6] [&>button]:[font-family:inherit] [&>button]:[font-style:inherit] later-2:[&>button]:text-[13px] later-2:[&>button]:font-[600] later:[&>button]:leading-[1.2] [&>button]:whitespace-nowrap later:[&>button]:cursor-pointer [&>button]:[transition:background_.15s_ease,_color_.15s_ease,_border-color_.15s_ease] [&>button:hover:not(.active):not([aria-selected='true'])]:text-[#d7ddf5] [&>button:hover:not(.active):not([aria-selected='true'])]:[background:rgba(255,_255,_255,_.04)] [&>button:hover:not(.active):not([aria-selected='true'])]:border-transparent [&>button.active]:[background:#252e42] [&>button.active]:text-[#fff] [&>button.active]:font-[600] [&>button.active]:border-transparent [&>button.active]:[box-shadow:none] later:[&>button[aria-selected='true']]:[background:#252e42] [&>button[aria-selected='true']]:text-[#fff] [&>button[aria-selected='true']]:font-[600] [&>button[aria-selected='true']]:border-transparent [&>button[aria-selected='true']]:[box-shadow:none] later:[&>button:focus-visible]:[outline:2px_solid_#8175ff] later:[&>button:focus-visible]:[outline-offset:2px] [&>button_svg]:flex-[0_0_auto] [&>button_svg]:text-[12px] max-[721px]:later:flex-[1_1_100%]" role="tablist" aria-label="User account types">
          <button type="button" role="tab" aria-selected={tab === 'staff'} className={tab === 'staff' ? 'active' : ''} onClick={() => { setTab('staff'); setPage(1); }}>Staff / Admin</button>
          <button type="button" role="tab" aria-selected={tab === 'branch'} className={tab === 'branch' ? 'active' : ''} onClick={() => { setTab('branch'); setPage(1); }}>Active Franchisees</button>
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
          className={`${PRIMARY} [.unified-toolbar-container_&]:flex-[0_0_auto] [.unified-toolbar-container_&]:h-[44px] [.unified-toolbar-container_&]:min-h-[44px] [.unified-toolbar-container_&]:p-[0_18px] [.unified-toolbar-container_&]:rounded-[10px] [.unified-toolbar-container_&]:text-[13px] [.unified-toolbar-container_&]:font-[700] max-[721px]:later:[.unified-toolbar-container_&]:flex-[1_1_100%]`}
          onClick={openCreate}
        >
          <FaUserPlus aria-hidden="true" /> New user
        </button>
      </div>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[10px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)]">
        {remote.loading ? <LoadingState /> : !visibleUsers.length ? (
          <EmptyState label={tab === 'branch' ? 'No branch accounts match this search.' : 'No staff users match this search.'} detail="Clear the search or create a new account. Archived users are in Admin settings → Archive." />
        ) : (
          <div className="table-wrap overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  {tab === 'branch' ? <th>Created</th> : <><th>Time in</th><th>Time out</th></>}
                  <th>Status</th>
                  <th>Update</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => {
                  const presence = user.presence || {};
                  const isSelf = String(user.id) === String(currentUser?.id);
                  const badge = accountBadge(user, presence);
                  const pending = ['invited', 'expired', 'declined'].includes(user.invite_state);
                  return (
                    <tr key={user.id}>
                      <td><strong>{user.full_name}</strong><small>{user.email}</small>{user.user_code && <small>{user.user_code}</small>}</td>
                      <td>{titleCase(user.role?.name || user.role)}{isSelf && <small>your account</small>}</td>
                      {tab === 'branch' ? <td>{formatDate(user.created_at)}</td> : (
                        <>
                          <td>{clock(presence.time_in)}</td>
                          <td>{clock(presence.time_out)}</td>
                        </>
                      )}
                      <td>
                        <span
                          className={`status-pill min-h-[24px] inline-flex items-center gap-[6px] p-[4px_9px] border border-line rounded-[999px] text-text-secondary [background:var(--surface-subtle)] text-[8px] font-[720] capitalize whitespace-nowrap status-${badge.key}`}
                          style={badge.style}
                        >
                          <span className="w-[6px] h-[6px] rounded-[50%] [background:currentColor] [box-shadow:0_0_0_3px_color-mix(in_srgb,_currentColor_11%,_transparent)]" aria-hidden="true" />
                          {badge.label}
                        </span>
                        {badge.detail && <small>{badge.detail}</small>}
                      </td>
                      <td>
                        {isSelf ? (
                          <span className="muted-note text-muted text-[8px] leading-[1.6]">Your account</span>
                        ) : (
                          <select
                            className="border border-input-line rounded-[11px] later:[outline:none] text-text [background:var(--input-bg)] [transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] hover:border-line-strong later:focus:border-accent focus:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] focus:[background:var(--input-focus-bg)] w-[min(180px,_100%)] later:min-h-[34px] later:p-[6px_8px] text-[8px]"
                            value=""
                            aria-label={`Update ${user.full_name}`}
                            onChange={(e) => onUpdate(user, e.target.value)}
                          >
                            <option value="">Update</option>
                            {pending ? (
                              <>
                                <option value="resend">Resend invite</option>
                                <option value="cancel">Cancel invite</option>
                              </>
                            ) : (
                              <option value="archive">Archive (suspend)</option>
                            )}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <SlidingPagination meta={remote.data?.meta} onPage={setPage} />
      </section>

      {showCreate && (
        <Modal
          title={isFranchisee ? 'Invite a branch account' : 'Invite a user'}
          onClose={closeCreate}
          footer={(
            <>
              <button type="button" onClick={closeCreate}>Cancel</button>
              <button className={PRIMARY} form="user-form" disabled={saving || Boolean(nameError) || (isFranchisee && !form.applicant_id)}>
                {saving ? 'Sending…' : 'Send invite'}
              </button>
            </>
          )}
        >
          <Notice type="error">{actionError}</Notice>
          <form id="user-form" className={FORM_GRID} onSubmit={createUser}>
            <Field label="Role" required>
              <select value={form.role} onChange={(e) => changeRole(e.target.value)} aria-label="Role">
                {CREATE_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </select>
            </Field>
            {isFranchisee ? (
              <Field label="Full name" required hint="Approved or Active Franchisee applicants without an account.">
                {candidateStatus === 'error' ? (
                  <span className="grid gap-2" role="alert">
                    <span className="text-[#ff9ca3]">Could not load the applicants. Try again.</span>
                    <button type="button" className="w-fit" onClick={() => setCandidateAttempt((n) => n + 1)}>Retry</button>
                  </span>
                ) : candidateStatus === 'empty' ? (
                  <span className="text-[#f4e3b0]" role="alert">No approved or active franchisee without an account.</span>
                ) : (
                  <select required value={form.applicant_id} onChange={(e) => chooseApplicant(e.target.value)} aria-label="Full name" disabled={candidateStatus === 'loading'}>
                    <option value="">{candidateStatus === 'loading' ? 'Loading applicants…' : 'Choose an applicant…'}</option>
                    {candidateList.map((a) => (
                      <option key={a.id} value={a.id}>{a.full_name}{a.applicant_code ? ` · ${a.applicant_code}` : ''} · {a.status === 'active_franchisee' ? 'Active Franchisee' : 'Approved'}</option>
                    ))}
                  </select>
                )}
              </Field>
            ) : (
              <Field label="Full name" required hint={nameError || 'Letters, spaces, period, hyphen and apostrophe only.'}>
                <input required value={form.full_name} maxLength={255} autoComplete="off" aria-invalid={Boolean(nameError)} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              </Field>
            )}
            <Field label="Email (their username)" required>
              <input required type="email" maxLength={255} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Phone / Contact" hint="Optional. Exactly 11 digits, e.g. 09123456789.">
              <input inputMode="numeric" maxLength={11} pattern="[0-9]{11}" value={form.phone} onChange={(e) => setForm({ ...form, phone: cleanPhone(e.target.value) })} />
            </Field>
            {isFranchisee && chosenApplicant && (
              <Field label="Preferred Branch Type">
                <input readOnly value={chosenApplicant.preferred_brand?.name || 'Not specified'} />
              </Field>
            )}
            <p className="col-span-full m-0 text-muted text-[0.8rem]">
              An invitation is emailed to this address. They open it, set their own password and accept.
              {isFranchisee ? ' An Approved applicant becomes Active Franchisee when they accept.' : ''}
            </p>
          </form>
        </Modal>
      )}

      {confirmAdmin && (
        <Modal
          title="Create another Admin?"
          size="small"
          onClose={() => setConfirmAdmin(false)}
          footer={(
            <>
              <button type="button" onClick={() => setConfirmAdmin(false)}>Go back</button>
              <button type="button" className={PRIMARY} disabled={saving} onClick={() => sendInvite(true)}>{saving ? 'Sending…' : 'Yes, invite this Admin'}</button>
            </>
          )}
        >
          <p className="m-0 text-[14px] leading-[1.6]">You are creating another Admin with full access.</p>
          <p className="m-[8px_0_0] text-[13px] text-muted">{form.full_name || 'This person'} ({form.email}) will be able to manage every user, applicant, branch and setting. This is recorded in the audit log.</p>
        </Modal>
      )}

      {cancelTarget && (
        <Modal
          title="Cancel this invitation?"
          size="small"
          onClose={() => setCancelTarget(null)}
          footer={(
            <>
              <button type="button" onClick={() => setCancelTarget(null)}>Keep it</button>
              <button type="button" className={DANGER} disabled={busy} onClick={confirmCancel}>{busy ? 'Cancelling…' : 'Cancel invite'}</button>
            </>
          )}
        >
          <p className="m-0 text-[14px] leading-[1.6]">The invitation for <strong>{cancelTarget.email}</strong> is removed completely, with its pending sign-in. The email link stops working.</p>
          <p className="m-[8px_0_0] text-[13px] text-muted">You can invite the same address again later.</p>
        </Modal>
      )}

      {archiveTarget && (
        <Modal
          title={`Archive ${archiveTarget.full_name}`}
          onClose={() => setArchiveTarget(null)}
          size="small"
          footer={archiveStep === 'warn' ? (
            <>
              <button type="button" onClick={() => setArchiveTarget(null)}>Cancel</button>
              <button type="button" className={PRIMARY} onClick={() => setArchiveStep('form')}>Continue</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setArchiveStep('warn')}>Back</button>
              <button className={DANGER} form="archive-form" disabled={busy}>{busy ? 'Archiving…' : 'Confirm'}</button>
            </>
          )}
        >
          {archiveStep === 'warn' ? (
            <p className="m-0 text-[14px] leading-[1.6]">
              Archiving this user will suspend their account. They won&apos;t be able to sign in until the suspension ends or an Admin restores them.
            </p>
          ) : (
            <>
              <Notice type="error">{archiveError}</Notice>
              <form id="archive-form" className={FORM_GRID} onSubmit={confirmArchive}>
                <Field label="Suspension start" required hint="Now, or a later date and time.">
                  <input required type="datetime-local" value={archiveForm.from} onChange={(e) => setArchiveForm({ ...archiveForm, from: e.target.value })} />
                </Field>
                <Field label="End (optional)" hint="Empty: until an Admin restores them. Restored automatically after this time.">
                  <input type="datetime-local" min={archiveForm.from} value={archiveForm.until} onChange={(e) => setArchiveForm({ ...archiveForm, until: e.target.value })} />
                </Field>
                <Field label="Reason (optional)" full>
                  <textarea rows={3} maxLength={2000} value={archiveForm.reason} onChange={(e) => setArchiveForm({ ...archiveForm, reason: e.target.value })} placeholder="e.g. On leave, left the company" />
                </Field>
              </form>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
