import React, { useEffect, useRef, useState } from 'react';
import {
  FaBars,
  FaBell,
  FaCheck,
  FaCommentDots,
  FaMoon,
  FaSun,
  FaWifi,
} from 'react-icons/fa6';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, firstValidationMessage } from '../../../lib/api';
import { formatDate, titleCase } from '../../../lib/format';
import { getRouteTitle } from '../../../lib/routes';
import ProfileModal from './ProfileModal';
import { notificationTarget } from '../../../lib/notificationRoutes';
import { useAuth } from '../../../context/AuthContext';
import { useChat } from '../../../context/ChatContext';
import { useTheme } from '../../../context/ThemeContext';
import { initialsOf } from '../../../lib/initials';

function initials(name = 'User') {
  return initialsOf(name);
}

export default function Header({ onMenu, mobileOpen }) {
  const { user, role } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { unreadTotal, toggleMessenger } = useChat();
  const location = useLocation();
  const navigate = useNavigate();
  const notificationRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState('');
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [systemStatus, setSystemStatus] = useState('checking');
  const [routeTitle, routeSubtitle] = getRouteTitle(location.pathname);

  const loadNotifications = async () => {
    setNotificationLoading(true);
    try {
      const response = await api.get('/notifications', { per_page: 10 });
      setNotifications(response.data || []);
      setError('');
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setNotificationLoading(false);
    }
  };

  // The badge counts EVERY unread notification (not just the ten in the popover).
  const refreshUnreadCount = async () => {
    try {
      const response = await api.get('/notifications', { per_page: 1, unread_only: 1 });
      setUnreadCount(Number(response.meta?.total ?? 0));
    } catch {
      // Keep the last known count when the poll fails.
    }
  };

  // The popover list loads when it is opened (toggleNotifications). On mount only the
  // badge count is fetched, so a page load costs one notification request, not two.
  // Live badge: new activity anywhere in the system shows the red count within 30s.
  useEffect(() => {
    const refresh = () => void refreshUnreadCount();
    void refreshUnreadCount();
    // Opening a record marks it seen; refresh the badge in the same beat as the
    // sidebar dots instead of waiting for the 30s poll.
    window.addEventListener('herald:notifications-updated', refresh);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshUnreadCount();
    }, 30000);
    return () => {
      window.removeEventListener('herald:notifications-updated', refresh);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const checkHealth = async () => {
      try {
        await api.get('/health', undefined, { skipAuth: true, timeout: 8000 });
        if (mounted) setSystemStatus('online');
      } catch {
        if (mounted) setSystemStatus('offline');
      }
    };
    void checkHealth();
    const interval = window.setInterval(checkHealth, 60000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (open && notificationRef.current && !notificationRef.current.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggleNotifications = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await loadNotifications();
      // Re-sync the badge and the sidebar dots to the real unread total.
      await refreshUnreadCount();
      window.dispatchEvent(new Event('herald:notifications-updated'));
    }
  };

  const markAllRead = async () => {
    try {
      await api.patch('/notifications/read-all', {});
      setNotifications((items) => items.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() })));
      setUnreadCount(0);
      // Clear the on-tab red dots in the same beat as the bell badge.
      window.dispatchEvent(new Event('herald:notifications-updated'));
      setError('');
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    }
  };

  const markRead = async (item) => {
    if (item.read_at) return;
    try {
      await api.patch(`/notifications/${item.id}/read`, {});
      setNotifications((items) => items.map((row) => (
        row.id === item.id ? { ...row, read_at: new Date().toISOString() } : row
      )));
      setUnreadCount((count) => Math.max(0, count - 1));
      // Sidebar red dots read the same unread set — refresh them without the 30s poll.
      window.dispatchEvent(new Event('herald:notifications-updated'));
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    }
  };

  // Where a notification leads (see lib/notificationRoutes.js). Unknown types just mark as read.

  return (
    <header className="herald-header sticky top-0 z-40 min-h-[var(--header-height)] flex items-center justify-between gap-5 p-[0_clamp(18px,_3vw,_34px)] border-b border-b-line [background:color-mix(in_srgb,_var(--bg)_82%,_transparent)] [backdrop-filter:blur(22px)_saturate(140%)] max-[681px]:later:p-[0_13px]">
      <div className="flex items-center min-w-0 gap-3">
        <button
          type="button"
          className="w-[40px] h-[40px] place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] later:hidden max-[861px]:later-2:inline-grid"
          onClick={onMenu}
          aria-label="Toggle navigation"
          aria-expanded={mobileOpen}
        >
          <FaBars />
        </button>
        <div className="min-w-0 flex flex-col gap-1 [&_strong]:overflow-hidden [&_strong]:text-text [&_strong]:text-[13px] [&_strong]:font-[790] [&_strong]:tracking-[-.01em] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_span]:overflow-hidden [&_span]:text-muted [&_span]:text-[9px] [&_span]:text-ellipsis [&_span]:whitespace-nowrap max-[681px]:[&_span]:hidden max-[451px]:later:hidden">
          <strong>{routeTitle}</strong>
          <span>{routeSubtitle}</span>
        </div>
      </div>

      <div className="header-right flex items-center gap-3 [&>*]:self-center">
        <div className={`flex items-center gap-[7px] min-h-[32px] p-[0_10px] border border-line rounded-[999px] text-muted [background:var(--surface-subtle)] text-[9px] font-[760] [&_svg]:text-[10px] max-[861px]:[&_span]:hidden max-[861px]:w-[34px] max-[861px]:justify-center max-[861px]:later:p-0 max-[681px]:later:hidden system-${systemStatus}`} title={`API status: ${systemStatus}`}>
          <FaWifi aria-hidden="true" />
          <span>{systemStatus === 'checking' ? 'Checking' : systemStatus === 'online' ? 'Live' : 'Offline'}</span>
        </div>

        <button
          type="button"
          className="w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)] overflow-hidden [&_svg]:[transition:transform_.3s_cubic-bezier(.2,_.8,_.2,_1)] [&:hover_svg]:[transform:rotate(18deg)_scale(1.08)]"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <FaSun /> : <FaMoon />}
        </button>

        <button
          type="button"
          className="w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)]"
          onClick={toggleMessenger}
          aria-label={`Live Messenger${unreadTotal ? `, ${unreadTotal} unread` : ''}`}
          title="Live Department Messenger"
        >
          <FaCommentDots />
          {unreadTotal > 0 && <span className="absolute right-[2px] top-[1px] min-w-[17px] h-[17px] grid place-items-center p-[0_4px] border-[2px] border-bg rounded-[999px] text-[#fff] [background:var(--danger)] [box-shadow:0_4px_10px_color-mix(in_srgb,_var(--danger)_30%,_transparent)] text-[8px] font-[850]">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
        </button>

        <div className="relative" ref={notificationRef}>
          <button
            type="button"
            className="w-[40px] h-[40px] inline-grid place-items-center flex-[0_0_auto] p-0 border border-transparent rounded-[12px] text-text-secondary [background:transparent] [transition:color_.18s_ease,_background_.18s_ease,_border-color_.18s_ease,_transform_.18s_ease] hover:text-text hover:[background:var(--hover)] hover:border-line hover:[transform:translateY(-1px)]"
            onClick={toggleNotifications}
            aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
            aria-expanded={open}
          >
            <FaBell />
            {unreadCount > 0 && <span className="absolute right-[2px] top-[1px] min-w-[17px] h-[17px] grid place-items-center p-[0_4px] border-[2px] border-bg rounded-[999px] text-[#fff] [background:var(--danger)] [box-shadow:0_4px_10px_color-mix(in_srgb,_var(--danger)_30%,_transparent)] text-[8px] font-[850]">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>

          {open && (
            <section className="absolute right-0 top-[49px] w-[min(400px,_calc(100vw_-_28px))] max-h-[min(560px,_calc(100vh_-_98px))] overflow-auto border border-line-strong rounded-[18px] [background:color-mix(in_srgb,_var(--panel)_97%,_transparent)] [box-shadow:var(--shadow-lg)] [backdrop-filter:blur(24px)] [animation:popoverIn_.2s_cubic-bezier(.2,_.8,_.2,_1)_both] max-[451px]:later:fixed max-[451px]:later:top-[62px] max-[451px]:later:right-[10px] max-[451px]:later:left-[10px] max-[451px]:later:w-auto" aria-label="Notifications">
              <div className="sticky top-0 z-2 flex items-center justify-between gap-[14px] p-[15px_16px] border-b border-b-line [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [backdrop-filter:blur(18px)] [&>div]:flex [&>div]:flex-col [&>div]:gap-[3px] later:[&_strong]:text-[12px] [&_span]:text-muted later:[&_span]:text-[8px] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-[5px] [&_button]:p-[6px_8px] [&_button]:border-0 [&_button]:rounded-[8px] [&_button]:text-accent-text [&_button]:[background:transparent] [&_button]:text-[8px] [&_button]:font-[760] [&_button:hover:not(:disabled)]:[background:var(--hover)]">
                <div><strong>Notifications</strong><span>{unreadCount ? `${unreadCount} unread` : 'You are all caught up'}</span></div>
                <button type="button" onClick={markAllRead} disabled={!unreadCount}><FaCheck /> Mark all read</button>
              </div>
              {error && <p className="m-0 p-[24px_16px] text-[10px] text-center later:text-danger-text [background:color-mix(in_srgb,_var(--danger)_6%,_transparent)]">{error}</p>}
              {notificationLoading && notifications.length === 0 ? (
                <div className="m-0 p-[24px_16px] text-muted text-[10px] text-center [&_.spinner]:w-[16px] [&_.spinner]:h-[16px] [&_.spinner]:mr-2 [&_.spinner]:[vertical-align:middle]"><span className="spinner w-[20px] h-[20px] inline-block flex-[0_0_auto] border-[2px] border-[color:color-mix(in_srgb,_var(--muted)_25%,_transparent)] border-t-accent rounded-[50%] [animation:spin_.8s_linear_infinite]" /> Loading updates…</div>
              ) : notifications.length === 0 ? (
                <p className="m-0 p-[24px_16px] text-muted text-[10px] text-center [&_.spinner]:w-[16px] [&_.spinner]:h-[16px] [&_.spinner]:mr-2 [&_.spinner]:[vertical-align:middle]">No notifications yet.</p>
              ) : notifications.map((item) => (
                <button
                  type="button"
                  className={`notification-item relative w-full grid grid-cols-[8px_minmax(0,_1fr)] gap-[10px] p-[14px_16px] border-0 border-b border-b-line text-text [background:transparent] text-left [transition:background_.18s_ease] hover:[background:var(--hover)] later:[&.unread]:[background:color-mix(in_srgb,_var(--accent)_6%,_transparent)] [&.unread:hover]:[background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] [&>span:last-child]:min-w-0 [&_strong]:block [&_strong]:overflow-hidden later-2:[&_strong]:text-[10px] later:[&_strong]:font-[750] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_p]:[display:-webkit-box] [&_p]:overflow-hidden [&_p]:m-[5px_0_7px] [&_p]:text-text-secondary [&_p]:text-[9px] [&_p]:leading-[1.5] [&_p]:[-webkit-box-orient:vertical] [&_p]:[-webkit-line-clamp:2] [&_small]:text-muted [&_small]:text-[8px] ${item.read_at ? '' : ' unread'}`}
                  key={item.id}
                  onClick={() => {
                    // Mark as read first (badge + sidebar dots clear immediately),
                    // then open the page and record the notification is about.
                    markRead(item);
                    setOpen(false);
                    const target = notificationTarget(item);
                    if (target) {
                      navigate(target.path, target.state ? { state: target.state } : undefined);
                    }
                  }}
                >
                  <span className="w-[6px] h-[6px] mt-[5px] rounded-[50%] [background:transparent] [.notification-item.unread_&]:[background:var(--accent)] [.notification-item.unread_&]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_12%,_transparent)]" aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong>
                    <p>{item.message}</p>
                    <small>{formatDate(item.created_at, true)}</small>
                  </span>
                </button>
              ))}
            </section>
          )}
        </div>

        <button
          type="button"
          className="flex items-center [.header-right_&]:min-h-[40px] gap-[10px] min-w-0 ml-[6px] pl-[13px] border-l border-l-line later:[button&]:border-0 later:[button&]:border-l later:[button&]:border-l-line later:[button&]:rounded-[0] later:[button&]:[background:transparent] [button&]:[font-family:inherit] later:[button&]:[font-size:inherit] later:[button&]:[font-weight:inherit] [button&]:[font-style:inherit] [button&]:[line-height:inherit] [button&]:text-left later:[button&]:cursor-pointer [button&:hover]:[background:var(--hover)] [button&:focus-visible]:[outline:2px_solid_var(--accent)] [button&:focus-visible]:[outline-offset:2px] [&>div]:min-w-0 [&>div]:flex [&>div]:flex-col [&>div]:gap-[3px] [&_strong]:max-w-[170px] [&_strong]:overflow-hidden [&_strong]:text-text later-2:[&_strong]:text-[10px] later-2:[&_strong]:font-[730] [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_span]:text-muted later:[&_span]:text-[8px] max-[1121px]:later:[&_strong]:max-w-[120px] max-[681px]:later:[&>div]:hidden max-[681px]:later:ml-[1px] max-[681px]:later:pl-2"
          title={`${user?.full_name || 'User'} · ${titleCase(role)}`}
          onClick={() => setProfileOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="w-[36px] h-[36px] grid place-items-center flex-[0_0_auto] border border-[color:color-mix(in_srgb,_var(--accent)_24%,_var(--border))] rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_18%,_transparent)] text-[10px] font-[850]" aria-hidden="true">{initials(user?.full_name)}</span>
          <div><strong>{user?.full_name || 'User'}</strong><span>{titleCase(role)} workspace</span></div>
        </button>
      </div>

      {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} />}
    </header>
  );
}
