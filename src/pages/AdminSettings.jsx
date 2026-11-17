import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FaBoxArchive, FaRotateLeft, FaTrashCan, FaXmark } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatDate } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { EmptyState, LoadingState, Modal, Notice, PageHeader } from '../components/ApiUi';
import FollowUpRules from '../components/applicants/FollowUpRules';

const SECTIONS = [
  { key: 'users', label: 'Users', heading: 'Archived users' },
  { key: 'inquiries', label: 'Inquiries', heading: 'Archived inquiries' },
  { key: 'applicants', label: 'Applicants', heading: 'Archived applicants' },
];

export default function AdminSettings() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => (['information', 'follow_up'].includes(params.get('tab')) || SECTIONS.some((section) => section.key === params.get('tab')) ? params.get('tab') : 'information'));
  const { user } = useAuth();
  const [restoringId, setRestoringId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');

  // Inquiries tab: select several records (Ctrl/Cmd+click, Shift+click) to RESTORE them together.
  // Permanent delete is deliberately single-record only.
  const [selectedIds, setSelectedIds] = useState([]); // click order; the first one hosts the buttons
  const [bulkBusy, setBulkBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null); // { item, many } awaiting confirmation
  const [restoreAck, setRestoreAck] = useState(false); // second confirmation checkbox
  const [purgeReason, setPurgeReason] = useState('');
  const [purgeError, setPurgeError] = useState('');
  const [purging, setPurging] = useState(false);

  const remote = useRemote(async () => (await api.get('/archive')).data, []);
  const activeCounts = useRemote(async () => {
    const [users, inquiries, applicants] = await Promise.all([
      api.get('/users', { per_page: 1, role: 'staff' }),
      api.get('/inquiries', { per_page: 1 }),
      api.get('/applicants', { per_page: 1 }),
    ]);
    return {
      users: Number(users.data?.meta?.total ?? 0),
      inquiries: Number(inquiries.data?.meta?.total ?? 0),
      applicants: Number(applicants.data?.meta?.total ?? 0),
    };
  }, []);

  const data = remote.data || {};
  const section = data[tab] || { items: [] };
  const items = section.items || [];
  const selectable = tab === 'inquiries';
  const selectedItems = selectedIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const reasonOk = purgeReason.trim().length >= 5;

  useEffect(() => { setSelectedIds([]); }, [tab]);
  useEffect(() => {
    // Drop selections that are no longer in the list (after a restore or delete).
    setSelectedIds((current) => {
      const next = current.filter((id) => items.some((item) => item.id === id));
      return next.length === current.length ? current : next;
    });
  }, [remote.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selectedIds.length) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !purgeTarget) setSelectedIds([]); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds.length, purgeTarget]);

  const restore = async (item) => {
    setRestoringId(item.id);
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/archive/${tab}/${item.id}/restore`);
      setSuccess(`${item.label} restored.`);
      await remote.reload();
    } catch (error) {
      setActionError(firstValidationMessage(error));
    } finally {
      setRestoringId(null);
    }
  };

  const restoreSelected = async () => {
    if (!selectedItems.length) return;
    setBulkBusy(true);
    setActionError('');
    setSuccess('');
    let restored = 0;
    try {
      for (const item of selectedItems) {
        await api.post(`/archive/inquiries/${item.id}/restore`);
        restored += 1;
      }
      setSuccess(`${restored} ${restored === 1 ? 'inquiry' : 'inquiries'} restored.`);
    } catch (error) {
      setActionError(`Restored ${restored} of ${selectedItems.length}. ${firstValidationMessage(error)}`);
    }
    setSelectedIds([]);
    setBulkBusy(false);
    await remote.reload();
  };

  const handleItemClick = (event, item) => {
    if (!selectable) return;
    if (event.ctrlKey || event.metaKey) {
      setSelectedIds((current) => (
        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]
      ));
      return;
    }
    if (event.shiftKey && selectedIds.length) {
      const anchor = items.findIndex((entry) => entry.id === selectedIds[0]);
      const target = items.findIndex((entry) => entry.id === item.id);
      if (anchor >= 0 && target >= 0) {
        const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
        const range = items.slice(from, to + 1).map((entry) => entry.id).filter((id) => id !== selectedIds[0]);
        setSelectedIds([selectedIds[0], ...range]);
        return;
      }
    }
    if (selectedIds.length) setSelectedIds([]);
  };

  const openPurge = (item) => {
    setPurgeError('');
    setPurgeReason('');
    setPurgeTarget(item);
  };

  const confirmPurge = async () => {
    if (!purgeTarget || !reasonOk) return;
    setPurging(true);
    setPurgeError('');
    setActionError('');
    setSuccess('');
    try {
      await api.post(`/archive/inquiries/${purgeTarget.id}/purge`, { reason: purgeReason.trim() });
      setSuccess(`${purgeTarget.label} was permanently deleted.`);
      setPurgeTarget(null);
      setPurgeReason('');
      setSelectedIds([]);
      await remote.reload();
    } catch (error) {
      setPurgeError(firstValidationMessage(error));
    } finally {
      setPurging(false);
    }
  };

  // Buttons for one archived item. While several inquiries are selected, only the first
  // selected row shows them (Restore for the whole selection) and Permanent delete is hidden.
  const renderActions = (item) => {
    const hasSelection = selectable && selectedIds.length > 0;
    if (hasSelection && selectedIds[0] !== item.id) {
      return selectedIds.includes(item.id) ? <span className="[.row-actions_&]:text-[0.78rem] [.row-actions_&]:text-[#9aa5ff]">Selected</span> : null;
    }
    const many = hasSelection && selectedItems.length > 1;
    const busy = restoringId === item.id || bulkBusy;
    return (
      <>
        <button
          type="button"
          className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
          disabled={busy}
          onClick={() => setRestoreTarget({ item, many })}
        >
          <FaRotateLeft /> {busy ? 'Restoring…' : `Restore${many ? ` (${selectedItems.length})` : ''}`}
        </button>
        {selectable && !many && (
          <button
            type="button"
            className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]"
            disabled={busy || item.has_applicant}
            title={item.has_applicant ? 'Converted to an applicant. Restore it and use Undo convert first.' : 'Permanently delete this inquiry'}
            onClick={() => openPurge(item)}
          >
            <FaTrashCan /> Delete permanently
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

  if (remote.loading) return <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]"><LoadingState label="Loading admin settings…" /></div>;
  if (remote.error) return <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]"><Notice type="error">{remote.error}</Notice></div>;

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]">
      <div className="relative mb-[10px] -mx-[clamp(22px,_3vw,_38px)] pt-[46px] [background:linear-gradient(180deg,_#0b0f19,_#1a2133_46%,_#1a2133)]">
        <div className="flex items-end gap-[26px] px-[clamp(22px,_3vw,_38px)] pb-[16px]">
          <span className="w-[118px] h-[118px] flex-[0_0_auto] grid place-items-center -mt-[52px] border-[6px] border-[#0b0f19] rounded-[50%] [background:#6366d6] text-[#fff] text-[48px] font-[800] [box-shadow:0_16px_34px_rgba(74,_73,_184,_0.35)]" aria-hidden="true">{(user?.full_name || 'A').charAt(0).toUpperCase()}</span>
          <div className="min-w-0 pb-[6px]">
            <h1 className="m-0 text-[#fff] text-[34px] font-[800] leading-[1.1] tracking-[-0.02em]">{(user?.full_name || 'Admin').toUpperCase()}</h1>
            <p className="m-[4px_0_0] text-[#c3cad9] text-[16px]">Admin</p>
          </div>
        </div>
      </div>
      <Notice type="success">{success}</Notice>
      <Notice type="error">{actionError}</Notice>

      <div className="flex flex-wrap items-center gap-[34px] px-[clamp(22px,_3vw,_38px)] mb-[16px] border-b-2 border-b-[#2a3550]" role="tablist" aria-label="Admin sections">
        <button type="button" role="tab" aria-selected={tab === 'information'} className={`admin-tab py-[14px] border-0 border-b-2 bg-transparent text-[16px] font-[600] cursor-pointer -mb-[2px] ${tab === 'information' ? 'text-[#fff] border-b-[#7b88ff]' : 'text-[#8fa0c0] border-b-transparent'}`} onClick={() => setTab('information')}>
          Information
        </button>
        <button type="button" role="tab" aria-selected={tab === 'follow_up'} className={`admin-tab py-[14px] border-0 border-b-2 bg-transparent text-[16px] font-[600] cursor-pointer -mb-[2px] ${tab === 'follow_up' ? 'text-[#fff] border-b-[#7b88ff]' : 'text-[#8fa0c0] border-b-transparent'}`} onClick={() => setTab('follow_up')}>
          Follow-up rules
        </button>
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`admin-tab py-[14px] border-0 border-b-2 bg-transparent text-[16px] font-[600] cursor-pointer -mb-[2px] ${tab === item.key ? 'text-[#fff] border-b-[#7b88ff]' : 'text-[#8fa0c0] border-b-transparent'}`}
            onClick={() => setTab(item.key)}
          >
            {item.label} ({activeCounts.data?.[item.key] ?? 0})
          </button>
        ))}
      </div>

      {tab === 'information' && (
        <section key="information" className="admin-tab-panel data-panel mb-[18px] p-[22px] border border-line rounded-[19px] [background:var(--panel)]">
          <div className="grid gap-[18px] [grid-template-columns:minmax(0,_1fr)_minmax(0,_1fr)] max-[861px]:[grid-template-columns:1fr]">
            <div>
              <h2 className="m-0 mb-[14px] text-[12px] font-[800] tracking-[.12em] uppercase text-muted">Information</h2>
              <dl className="grid gap-[12px] m-0">
                <div><dt className="text-[10px] uppercase text-muted">Name</dt><dd className="m-0 text-text">{user?.full_name || '—'}</dd></div>
                <div><dt className="text-[10px] uppercase text-muted">Email (optional)</dt><dd className="m-0 text-text">{user?.email || '—'}</dd></div>
                <div><dt className="text-[10px] uppercase text-muted">Contact (optional)</dt><dd className="m-0 text-text">{user?.phone || '—'}</dd></div>
              </dl>
            </div>
            <dl className="grid gap-[12px] m-0 content-start">
              <div><dt className="text-[10px] uppercase text-muted">Active</dt><dd className="m-0 text-text">{user?.presence?.time_in ? formatDate(user.presence.time_in, true) : 'Not signed in today'}</dd></div>
              <div><dt className="text-[10px] uppercase text-muted">Last active</dt><dd className="m-0 text-text">{user?.presence?.last_active ? formatDate(user.presence.last_active, true) : '—'}</dd></div>
              <div><dt className="text-[10px] uppercase text-muted">Date created</dt><dd className="m-0 text-text">{formatDate(user?.created_at)}</dd></div>
            </dl>
          </div>
        </section>
      )}

      {tab === 'follow_up' && (
        <section key="follow_up" className="admin-tab-panel data-panel mb-[18px] p-[22px] border border-line rounded-[19px] [background:var(--panel)]">
          <FollowUpRules />
        </section>
      )}

      {tab !== 'information' && tab !== 'follow_up' && <section key={tab} className="admin-tab-panel data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
          <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
            <h2>{SECTIONS.find((item) => item.key === tab)?.heading}</h2>
            <span>Records removed from the active workspace</span>
          </div>
        </div>

        {selectable && items.length > 0 && (
          <p className="muted-note text-muted text-[8px] leading-[1.6] [.inquiries-page_&]:m-0 m-[0_0_10px]">
          </p>
        )}

        {!items.length ? (
          <EmptyState
            label={`No archived ${tab}.`}
            detail="Archived records will appear here and can be restored at any time."
          />
        ) : (
          <div className={`overflow-x-auto ${selectable ? 'archive-selectable' : ''}`}>
            <table className="w-full border-collapse text-[13px] [&_th]:text-left [&_th]:p-[12px_18px] [&_th]:text-[11px] [&_th]:font-[700] [&_th]:tracking-[.08em] [&_th]:uppercase [&_th]:text-[#8a94a6] [&_th]:border-b [&_th]:border-b-[#1f2842] [&_td]:p-[14px_18px] [&_td]:align-middle [&_td]:border-b [&_td]:border-b-[#1f2842] [&_td]:text-[#e7ebf5] [&_tr:last-child_td]:border-b-0">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Details</th>
                  <th>Archived</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
            {items.map((item) => (
              <tr
                className={`${selectedIds.includes(item.id) || (tab === 'applicants' && String(item.id) === params.get('applicant')) ? 'bg-[rgba(123,_136,_255,_0.14)]' : ''}`}
                key={item.id}
                onClick={(event) => handleItemClick(event, item)}
              >
                <td>
                  <strong className="block text-text text-[14px]">{item.label}</strong>
                </td>
                <td className="text-muted">
                  {item.detail || '—'}
                  {item.badge ? ` · ${item.badge}` : ''}
                  {tab === 'users' && (
                    <div className="mt-1 text-[12px] leading-[1.5]">
                      <span className={item.status === 'suspended' ? 'text-danger-text font-[650]' : 'text-warning-text font-[650]'}>
                        {item.status === 'suspended' ? 'Suspended' : 'Suspension scheduled'}
                      </span>
                      {' · '}
                      {item.suspended_from ? formatDate(item.suspended_from, true) : 'Now'} – {item.suspended_until ? formatDate(item.suspended_until, true) : 'until restored'}
                      {item.suspended_until && <div className="text-[11px]">Restored automatically after the end time.</div>}
                      {item.reason && <div className="text-[11px]">Reason: {item.reason}</div>}
                    </div>
                  )}
                </td>
                <td className="text-muted whitespace-nowrap">
                  {item.archived_at ? formatDate(item.archived_at, true) : '—'}
                  {item.archived_by ? <div className="text-[11px]">{item.archived_by}</div> : null}
                </td>
                <td className="text-right">
                <span className="row-actions [&_button]:min-h-[34px] later:[&_button]:p-[0_10px] later-2:[&_button]:border later-3:[&_button]:border-line later-3:[&_button]:rounded-[9px] later:[&_button]:text-text-secondary later-2:[&_button]:[background:var(--surface-subtle)] later-3:[&_button]:text-[9px] later-3:[&_button]:font-[700] later:[&_button]:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease,_transform_.16s_ease] [&_button:hover:not(:disabled)]:text-text [&_button:hover:not(:disabled)]:border-line-strong [&_button:hover:not(:disabled)]:[background:var(--hover)] [&_button:hover:not(:disabled)]:[transform:translateY(-1px)] flex flex-wrap gap-[6px] [&_.icon-button]:inline-grid [&_.icon-button]:place-items-center [&_.icon-button]:w-[34px] [&_.icon-button]:h-[34px] [&_.icon-button]:p-0 [&_.icon-button]:border later:[&_.icon-button]:border-[#1f2842] [&_.icon-button]:rounded-[6px] later:[&_.icon-button]:[background:rgba(255,_255,_255,_0.04)] later:[&_.icon-button]:text-[#d5dbec] [&_.icon-button]:[box-shadow:none] [&_.icon-button]:cursor-pointer [&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [&_.icon-button_svg]:m-0 [&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.09)] [&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [&_.icon-button:focus-visible]:[outline:2px_solid_#7b88ff] [&_.icon-button:focus-visible]:[outline-offset:2px] [&_.icon-button:disabled]:opacity-[0.5] [&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&]:flex [.activities-page_&]:items-center [.activities-page_&]:justify-between later:[.activities-page_&]:gap-4 [.activities-page_&]:flex-nowrap [.activities-page_&_.icon-button]:inline-grid [.activities-page_&_.icon-button]:place-items-center later:[.activities-page_&_.icon-button]:w-[36px] later:[.activities-page_&_.icon-button]:h-[36px] [.activities-page_&_.icon-button]:p-0 [.activities-page_&_.icon-button]:[border:1px_solid_var(--act-line)] [.activities-page_&_.icon-button]:rounded-[var(--act-radius-cell)] [.activities-page_&_.icon-button]:[background:var(--act-cell)] [.activities-page_&_.icon-button]:text-[color:var(--text,_inherit)] later:[.activities-page_&_.icon-button]:cursor-pointer [.activities-page_&_.icon-button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease] [.activities-page_&_.icon-button_svg]:m-0 [.activities-page_&_.icon-button:hover:not(:disabled)]:[background:rgba(255,_255,_255,_0.08)] [.activities-page_&_.icon-button:hover:not(:disabled)]:border-[rgba(255,_255,_255,_0.28)] [.activities-page_&_.icon-button:focus-visible]:[outline:2px_solid_var(--act-accent)] [.activities-page_&_.icon-button:focus-visible]:[outline-offset:2px] [.activities-page_&_.icon-button:disabled]:cursor-not-allowed [.activities-page_&_.icon-button:disabled]:opacity-[0.5] [&_.primary-button]:relative" onClick={(event) => event.stopPropagation()}>
                  {renderActions(item)}
                </span>
                </td>
              </tr>
            ))}
              </tbody>
            </table>
          </div>
        )}
      </section>}

      {tab !== 'information' && <p className="muted-note text-muted text-[8px] leading-[1.6]" style={{ marginTop: 12 }}>
        <FaBoxArchive aria-hidden="true" /> Permanent delete removes an archived inquiry from the database for good. Archive instead
        when a record may be needed later.
      </p>}

      {restoreTarget && (
        <Modal
          title={restoreTarget.many ? `Restore ${selectedItems.length} records?` : `Restore ${restoreTarget.item.label}?`}
          onClose={() => { setRestoreTarget(null); setRestoreAck(false); }}
          size="small"
          footer={(
            <>
              <button onClick={() => { setRestoreTarget(null); setRestoreAck(false); }} disabled={restoringId !== null || bulkBusy}>Cancel</button>
              <button
                className="primary-button min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] rounded-[12px] text-[#fff] text-[12px] font-[760] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]"
                disabled={!restoreAck || restoringId !== null || bulkBusy}
                onClick={async () => {
                  const { item, many } = restoreTarget;
                  setRestoreTarget(null);
                  setRestoreAck(false);
                  if (many) await restoreSelected();
                  else await restore(item);
                }}
              >
                Yes, restore
              </button>
            </>
          )}
        >
          <p className="m-0 text-muted text-[13px] leading-[1.6]">
            {restoreTarget.many
              ? `${selectedItems.length} archived ${tab} will return to the active workspace.`
              : tab === 'users'
                ? `${restoreTarget.item.label}'s account is reactivated now and they can sign in again.`
                : `${restoreTarget.item.label} will return to the active workspace.`}
          </p>
          <label className="flex items-start gap-[10px] mt-[16px] text-[13px] text-text cursor-pointer">
            <input type="checkbox" className="mt-[3px]" checked={restoreAck} onChange={(event) => setRestoreAck(event.target.checked)} />
            <span>I have checked this record and want to restore it.</span>
          </label>
        </Modal>
      )}

      {purgeTarget && (
        <Modal
          title="Permanently delete this inquiry?"
          onClose={() => setPurgeTarget(null)}
          size="small"
          footer={(
            <>
              <button onClick={() => setPurgeTarget(null)} disabled={purging}>Cancel</button>
              <button className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" onClick={confirmPurge} disabled={purging || !reasonOk}>
                {purging ? 'Deleting…' : 'Confirm delete'}
              </button>
            </>
          )}
        >
          <Notice type="error">{purgeError}</Notice>
          <div className="grid grid-cols-[48px_minmax(0,_1fr)] gap-[14px] [align-items:start] [&_strong]:block [&_strong]:m-[2px_0_7px] later-2:[&_strong]:text-text later-3:[&_strong]:text-[11px] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[9px] [&_p]:leading-[1.6] max-[451px]:later:grid-cols-[1fr]">
            <span className="confirmation-icon w-[48px] h-[48px] grid place-items-center rounded-[15px] text-danger-text [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)] text-[18px] [&.confirmation-icon]:text-accent-text [&.confirmation-icon]:[background:color-mix(in_srgb,_var(--accent)_9%,_transparent)]"><FaTrashCan /></span>
            <div>
              <strong>{purgeTarget.label}</strong>
              <p>
                This removes the record from the database and cannot be undone. The reason you enter is saved in the audit log.
              </p>
            </div>
          </div>
          <label className="block mt-[14px] [&_span]:block [&_span]:mb-[6px] later-2:[&_span]:text-[0.85rem] [&_span]:font-[600] [&_em]:not-italic [&_em]:font-[400] [&_em]:text-[#8590a8] [&_textarea]:w-full [&_textarea]:min-h-[92px] [&_textarea]:[resize:vertical] [&_textarea]:[box-sizing:border-box] [&_textarea]:p-[10px_12px] [&_textarea]:text-[color:inherit] [&_textarea]:[font-family:inherit] [&_textarea]:[font-size:inherit] [&_textarea]:[font-weight:inherit] [&_textarea]:[font-style:inherit] [&_textarea]:[line-height:inherit] [&_textarea]:[background:rgba(255,_255,_255,_0.03)] [&_textarea]:border [&_textarea]:border-[#1f2842] [&_textarea]:rounded-[10px] [&_textarea:focus]:[outline:2px_solid_rgba(123,_136,_255,_0.5)] [&_textarea:focus]:[outline-offset:1px]">
            <span>Reason for deletion <em>(required, at least 5 characters)</em></span>
            <textarea
              value={purgeReason}
              onChange={(e) => setPurgeReason(e.target.value)}
              placeholder="e.g. Duplicate record, same email and phone as an existing inquiry"
              autoFocus
            />
          </label>
        </Modal>
      )}
    </div>
  );
}
