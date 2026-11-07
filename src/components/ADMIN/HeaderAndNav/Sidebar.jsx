import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { FaAngleLeft, FaAngleRight, FaRightFromBracket, FaStore } from 'react-icons/fa6';
import AppIconImg from '../../../assets/icon.png.png';
import { useAuth } from '../../../context/AuthContext';
import { titleCase } from '../../../lib/format';
import { NAVIGATION } from '../../../lib/roleAccess';
import { Modal } from '../../ApiUi';

/* Navigation lives in lib/roleAccess.js — the single role → nav/panel config
   shared with the dashboard renderer, so no stray nav item can appear for a
   role that does not own the module. */

export default function Sidebar({ isCollapsed, setIsCollapsed, onNavigate, unreadByPath = {}, blueByPath = {} }) {
  const { role, logout } = useAuth();
  const navigate = useNavigate();
  // A section with no items is never rendered (no empty header).
  const groups = (NAVIGATION[role] || []).filter((group) => (group.items || []).length > 0);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setConfirmLogout(false);
    setLoggingOut(true);
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <>
      <aside className="sticky top-0 z-50 h-[100vh] min-w-0 flex flex-col p-[16px_12px_14px] border-r border-r-line [background:radial-gradient(circle_at_25%_0%,_color-mix(in_srgb,_var(--accent)_10%,_transparent),_transparent_24%),_color-mix(in_srgb,_var(--panel)_97%,_transparent)] [backdrop-filter:blur(22px)] [box-shadow:12px_0_40px_rgba(0,_0,_0,_.06)] max-[861px]:later:fixed max-[861px]:later:inset-[0_auto_0_0] max-[861px]:w-[min(300px,_calc(100vw_-_52px))] max-[861px]:[transform:translateX(-105%)] max-[861px]:[transition:transform_.28s_cubic-bezier(.2,.8,.2,1)] max-[861px]:later:[box-shadow:24px_0_60px_rgba(0,0,0,.25)] max-[861px]:[.mobile-sidebar-open_&]:[transform:translateX(0)]" aria-label="Primary navigation">
        <div className="min-h-[58px] flex items-center gap-3 overflow-hidden p-[0_9px] [&>div]:min-w-0 [&>div]:flex [&>div]:flex-col [&>div]:gap-1 [&>div]:whitespace-nowrap [&_strong]:text-[14px] [&_strong]:font-[850] [&_strong]:tracking-[.19em] [&_span]:overflow-hidden [&_span]:text-muted [&_span]:text-[9px] [&_span]:text-ellipsis [.sidebar-collapsed_&>div]:hidden [.sidebar-collapsed_&]:justify-center [.sidebar-collapsed_&]:p-0 max-[861px]:later:[.sidebar-collapsed_&>div]:flex max-[861px]:later:[.sidebar-collapsed_&]:justify-start max-[861px]:later:[.sidebar-collapsed_&]:p-[0_9px]">
          <span className="w-[42px] h-[42px] grid place-items-center flex-[0_0_auto] border border-line-strong rounded-[14px] [background:linear-gradient(145deg,_var(--panel-2),_var(--surface-subtle))] [box-shadow:var(--shadow-sm)] [&_img]:w-[32px] [&_img]:h-[32px] [&_img]:object-contain"><img src={AppIconImg} alt="" /></span>
          <div><strong>FRANCHISE TITAN</strong><span>Global franchise operations</span></div>
        </div>

        <div className="min-h-[31px] flex items-center gap-2 overflow-hidden m-[13px_6px_11px] p-[0_11px] border border-line rounded-[999px] text-accent-text [background:color-mix(in_srgb,_var(--accent)_6%,_transparent)] text-[9px] font-[800] tracking-[.08em] uppercase whitespace-nowrap [.sidebar-collapsed_&]:hidden max-[861px]:later:[.sidebar-collapsed_&]:flex"><span className="w-[7px] h-[7px] flex-[0_0_auto] later:rounded-[50%] later:[background:var(--success)] [box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--success)_12%,_transparent)]" />{titleCase(role || 'user')} workspace</div>
        {/* Branch Portal Login: Admin only (removed for Marketing and Logistics;
            Sales never had it). The branch login page itself is unchanged. */}
        {role === 'admin' && (
          <NavLink
            to="/branch-portal/login"
            onClick={onNavigate}
            className="side-link relative min-h-[50px] flex items-center gap-[11px] w-full overflow-hidden p-[6px_10px] border border-transparent rounded-[14px] text-muted [background:transparent] text-left whitespace-nowrap [transition:color_.2s_ease,_background_.2s_ease,_border-color_.2s_ease,_transform_.2s_ease,_box-shadow_.2s_ease] [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[7px_auto_7px_0] [&::before]:w-[3px] [&::before]:rounded-[999px] [&::before]:[background:linear-gradient(var(--accent),_var(--accent-2))] [&::before]:opacity-[0] [&::before]:[transform:scaleY(.4)] [&::before]:[transition:opacity_.2s_ease,_transform_.2s_ease] hover:text-text hover:[background:var(--hover)] hover:[transform:translateX(2px)] [&.active]:text-text [&.active]:border-[color:color-mix(in_srgb,_var(--accent)_18%,_var(--border))] later:[&.active]:[background:linear-gradient(135deg,_color-mix(in_srgb,_var(--accent)_12%,_transparent),_color-mix(in_srgb,_var(--accent-2)_8%,_transparent))] [&.active]:[box-shadow:inset_0_1px_0_color-mix(in_srgb,_#fff_5%,_transparent)] [&.active::before]:opacity-[1] [&.active::before]:[transform:scaleY(1)]"
            title={isCollapsed ? 'Branch Portal Login' : undefined}
          >
            <span className="side-link-icon w-[34px] h-[34px] grid place-items-center flex-[0_0_auto] rounded-[11px] text-text-secondary [background:var(--surface-subtle)] [transition:color_.2s_ease,_background_.2s_ease,_transform_.2s_ease] [.side-link:hover_&]:[transform:scale(1.04)] [.side-link.active_&]:text-[#fff] [.side-link.active_&]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [.side-link.active_&]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_20%,_transparent)]"><FaStore aria-hidden="true" /></span>
            <span className="side-link-copy min-w-0 flex flex-col gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-[color:inherit] later:[&_strong]:text-[11px] later:[&_strong]:font-[720] [&_strong]:text-ellipsis [&_small]:overflow-hidden [&_small]:text-muted [&_small]:text-[8px] [&_small]:text-ellipsis"><strong>Branch Portal Login</strong><small>Franchisee sign in</small></span>
          </NavLink>
        )}

        <nav className="min-h-0 flex flex-1 flex-col gap-[14px] overflow-x-hidden overflow-y-auto p-[5px_2px_16px]">
          {groups.map((group) => (
            <div className="flex flex-col gap-1" key={group.label}>
              <span className="p-[0_11px_4px] text-muted text-[8px] font-[850] tracking-[.13em] uppercase whitespace-nowrap [.sidebar-collapsed_&]:hidden max-[861px]:later:[.sidebar-collapsed_&]:flex">{group.label}</span>
              {group.items.map(({ label, path, Icon, description }) => (
                <NavLink
                  key={path}
                  to={path}
                  onClick={onNavigate}
                  className={({ isActive }) => `side-link relative min-h-[50px] flex items-center gap-[11px] w-full overflow-hidden p-[6px_10px] border border-transparent rounded-[14px] text-muted [background:transparent] text-left whitespace-nowrap [transition:color_.2s_ease,_background_.2s_ease,_border-color_.2s_ease,_transform_.2s_ease,_box-shadow_.2s_ease] [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[7px_auto_7px_0] [&::before]:w-[3px] [&::before]:rounded-[999px] [&::before]:[background:linear-gradient(var(--accent),_var(--accent-2))] [&::before]:opacity-[0] [&::before]:[transform:scaleY(.4)] [&::before]:[transition:opacity_.2s_ease,_transform_.2s_ease] hover:text-text hover:[background:var(--hover)] hover:[transform:translateX(2px)] [&.active]:text-text [&.active]:border-[color:color-mix(in_srgb,_var(--accent)_18%,_var(--border))] later:[&.active]:[background:linear-gradient(135deg,_color-mix(in_srgb,_var(--accent)_12%,_transparent),_color-mix(in_srgb,_var(--accent-2)_8%,_transparent))] [&.active]:[box-shadow:inset_0_1px_0_color-mix(in_srgb,_#fff_5%,_transparent)] [&.active::before]:opacity-[1] [&.active::before]:[transform:scaleY(1)] ${isActive ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
                  title={isCollapsed ? label : undefined}
                >
                  <span className="side-link-icon w-[34px] h-[34px] grid place-items-center flex-[0_0_auto] rounded-[11px] text-text-secondary [background:var(--surface-subtle)] [transition:color_.2s_ease,_background_.2s_ease,_transform_.2s_ease] [.side-link:hover_&]:[transform:scale(1.04)] [.side-link.active_&]:text-[#fff] [.side-link.active_&]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [.side-link.active_&]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_20%,_transparent)]"><Icon aria-hidden="true" /></span>
                  <span className="side-link-copy min-w-0 flex flex-col gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-[color:inherit] later:[&_strong]:text-[11px] later:[&_strong]:font-[720] [&_strong]:text-ellipsis [&_small]:overflow-hidden [&_small]:text-muted [&_small]:text-[8px] [&_small]:text-ellipsis"><strong>{label}</strong><small>{description}</small></span>
                  {(unreadByPath[path] || 0) > 0
                    ? <span className="flex-[0_0_auto] w-[7px] h-[7px] ml-auto rounded-[50%] [background:#e5484d] [box-shadow:0_0_0_3px_rgba(229,_72,_77,_.14)] [&.is-blue]:[background:#3b82f6] [&.is-blue]:[box-shadow:0_0_0_3px_rgba(59,_130,_246,_.18)]" aria-label={`${unreadByPath[path]} unread`} />
                    : (blueByPath[path] || 0) > 0 && <span className="flex-[0_0_auto] w-[7px] h-[7px] ml-auto rounded-[50%] [background:#e5484d] [box-shadow:0_0_0_3px_rgba(229,_72,_77,_.14)] [&.is-blue]:[background:#3b82f6] [&.is-blue]:[box-shadow:0_0_0_3px_rgba(59,_130,_246,_.18)] is-blue" aria-label={`${blueByPath[path]} activity update(s)`} />}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-[7px] pt-[9px] border-t border-t-line">
          <div className="min-h-[45px] flex items-center gap-[11px] overflow-hidden p-[6px_10px] text-muted [&>span:last-child]:flex [&>span:last-child]:flex-col [&>span:last-child]:gap-[3px] [&>span:last-child]:whitespace-nowrap later:[&_strong]:text-text-secondary later-2:[&_strong]:text-[9px] [&_small]:text-[8px] [.sidebar-collapsed_&>span:last-child]:hidden [.sidebar-collapsed_&]:justify-center max-[861px]:later:[.sidebar-collapsed_&>span:last-child]:flex max-[861px]:later:[.sidebar-collapsed_&]:justify-start">
            <span className="w-[7px] h-[7px] flex-[0_0_auto] rounded-[50%] [background:var(--success)] [box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--success)_12%,_transparent)]" />
            <span><strong>Secure session</strong><small>Encrypted API access</small></span>
          </div>
          <button
            type="button"
            className="side-link relative min-h-[50px] flex items-center gap-[11px] w-full overflow-hidden p-[6px_10px] border border-transparent rounded-[14px] [background:transparent] text-left whitespace-nowrap [transition:color_.2s_ease,_background_.2s_ease,_border-color_.2s_ease,_transform_.2s_ease,_box-shadow_.2s_ease] [&::before]:[content:''] [&::before]:absolute [&::before]:inset-[7px_auto_7px_0] [&::before]:w-[3px] [&::before]:rounded-[999px] [&::before]:[background:linear-gradient(var(--accent),_var(--accent-2))] [&::before]:opacity-[0] [&::before]:[transform:scaleY(.4)] [&::before]:[transition:opacity_.2s_ease,_transform_.2s_ease] hover:[transform:translateX(2px)] [&.active]:text-text [&.active]:border-[color:color-mix(in_srgb,_var(--accent)_18%,_var(--border))] later:[&.active]:[background:linear-gradient(135deg,_color-mix(in_srgb,_var(--accent)_12%,_transparent),_color-mix(in_srgb,_var(--accent-2)_8%,_transparent))] [&.active]:[box-shadow:inset_0_1px_0_color-mix(in_srgb,_#fff_5%,_transparent)] [&.active::before]:opacity-[1] [&.active::before]:[transform:scaleY(1)] later:text-danger-text [&_.side-link-icon]:text-danger-text [&_.side-link-icon]:[background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] later:hover:text-danger-text hover:border-[color:color-mix(in_srgb,_var(--danger)_17%,_transparent)] later:hover:[background:color-mix(in_srgb,_var(--danger)_7%,_transparent)]"
            onClick={() => setConfirmLogout(true)}
            title={isCollapsed ? 'Log out' : undefined}
          >
            <span className="side-link-icon w-[34px] h-[34px] grid place-items-center flex-[0_0_auto] rounded-[11px] text-text-secondary [background:var(--surface-subtle)] [transition:color_.2s_ease,_background_.2s_ease,_transform_.2s_ease] [.side-link:hover_&]:[transform:scale(1.04)] [.side-link.active_&]:text-[#fff] [.side-link.active_&]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [.side-link.active_&]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_20%,_transparent)]"><FaRightFromBracket aria-hidden="true" /></span>
            <span className="side-link-copy min-w-0 flex flex-col gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-[color:inherit] later:[&_strong]:text-[11px] later:[&_strong]:font-[720] [&_strong]:text-ellipsis [&_small]:overflow-hidden [&_small]:text-muted [&_small]:text-[8px] [&_small]:text-ellipsis"><strong>Log out</strong><small>End this session</small></span>
          </button>
        </div>

        <button
          type="button"
          className="absolute top-[82px] -right-[14px] z-2 w-[28px] h-[28px] grid place-items-center p-0 border border-line-strong rounded-[50%] text-text-secondary [background:var(--panel-2)] [box-shadow:var(--shadow-sm)] [transition:color_.18s_ease,_transform_.18s_ease,_background_.18s_ease] hover:text-[#fff] hover:[background:var(--accent)] hover:[transform:scale(1.08)] max-[861px]:later:hidden"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {isCollapsed ? <FaAngleRight /> : <FaAngleLeft />}
        </button>
      </aside>

      {confirmLogout && (
        <Modal
          title="End your Herald session?"
          onClose={() => setConfirmLogout(false)}
          size="small"
          footer={(
            <>
              <button type="button" onClick={() => setConfirmLogout(false)}>Stay signed in</button>
              <button type="button" className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" onClick={handleLogout}>Log out securely</button>
            </>
          )}
        >
          <div className="grid grid-cols-[48px_minmax(0,_1fr)] gap-[14px] [align-items:start] [&_strong]:block [&_strong]:m-[2px_0_7px] later-2:[&_strong]:text-text later-3:[&_strong]:text-[11px] [&_p]:m-0 [&_p]:text-muted [&_p]:text-[9px] [&_p]:leading-[1.6] max-[451px]:later:grid-cols-[1fr]">
            <span className="confirmation-icon w-[48px] h-[48px] grid place-items-center rounded-[15px] text-danger-text [background:color-mix(in_srgb,_var(--danger)_9%,_transparent)] text-[18px]"><FaRightFromBracket /></span>
            <div><strong>You will return to the sign-in screen.</strong><p>Any saved server data remains safe. Unsaved form entries in this browser will be cleared.</p></div>
          </div>
        </Modal>
      )}

      {loggingOut && (
        <div className="fixed inset-0 z-220 grid place-items-center p-5 [background:color-mix(in_srgb,_var(--bg)_68%,_transparent)] [backdrop-filter:blur(14px)]" role="status" aria-live="polite">
          <div className="min-w-[270px] later:flex flex-col items-center gap-2 p-[26px] later:border later:border-line-strong later:rounded-[18px] [background:var(--panel)] [box-shadow:var(--shadow-lg)] text-center later:[&_strong]:mt-[5px] later-3:[&_strong]:text-[11px] [&_small]:text-muted [&_small]:text-[8px]"><span className="spinner w-[20px] h-[20px] inline-block flex-[0_0_auto] border-[2px] border-[color:color-mix(in_srgb,_var(--muted)_25%,_transparent)] border-t-accent rounded-[50%] [animation:spin_.8s_linear_infinite]" /><strong>Signing out securely…</strong><small>Closing your authenticated session</small></div>
        </div>
      )}
    </>
  );
}
