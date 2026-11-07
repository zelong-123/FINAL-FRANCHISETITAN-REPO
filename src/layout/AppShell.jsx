import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/ADMIN/HeaderAndNav/Sidebar';
import Header from '../components/ADMIN/HeaderAndNav/Header';
import MessengerWidget from '../components/Messenger/MessengerWidget';
import { getRouteTitle } from '../lib/routes';
import { api } from '../lib/api';
import { notificationPath } from '../lib/notificationRoutes';

const SIDEBAR_KEY = 'herald_sidebar_collapsed';

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unreadByPath, setUnreadByPath] = useState({});
  // Blue dots: Sales marked an activity Complete (Admin's Applicants nav).
  const [blueByPath, setBlueByPath] = useState({});
  const location = useLocation();

  // Red dots on module tabs: unread notifications grouped by the page they open.
  // The same effect also listens for the Header bell's instant
  // "herald:notifications-updated" broadcast, so dots clear without the 30s poll.
  useEffect(() => {
    const loadUnread = async () => {
      try {
        const response = await api.get('/notifications', { per_page: 100, unread_only: 1 });
        const counts = {};
        const blue = {};
        (response.data || []).forEach((item) => {
          const path = notificationPath(item);
          if (!path) return;
          if (item.type === 'applicant_activity_completed') blue[path] = (blue[path] || 0) + 1;
          else counts[path] = (counts[path] || 0) + 1;
        });
        setUnreadByPath(counts);
        setBlueByPath(blue);
      } catch {
        // Keep the last known dots when the poll fails.
      }
    };
    const refresh = () => void loadUnread();
    window.addEventListener('herald:notifications-updated', refresh);
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30000);
    return () => {
      window.removeEventListener('herald:notifications-updated', refresh);
      window.clearInterval(interval);
    };
  }, [location.pathname]);

  const updateCollapsed = (value) => {
    setCollapsed(value);
    localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
  };

  useEffect(() => {
    const [title] = getRouteTitle(location.pathname);
    document.title = `${title} · Franchise Titan`;
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [location.pathname]);

  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    const handleResize = () => {
      if (window.innerWidth > 860) setMobileOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle('navigation-open', mobileOpen);
    return () => document.body.classList.remove('navigation-open');
  }, [mobileOpen]);

  return (
    <div className={`min-h-[100vh] grid grid-cols-[var(--sidebar-width)_minmax(0,_1fr)] [transition:grid-template-columns_.32s_cubic-bezier(.2,_.8,_.2,_1)] [&.sidebar-collapsed]:grid-cols-[var(--sidebar-collapsed-width)_minmax(0,_1fr)] max-[861px]:later:block max-[861px]:[&.sidebar-collapsed]:block ${collapsed ? ' sidebar-collapsed [&_.side-link-copy]:hidden [&_.side-link]:justify-center [&_.side-link]:px-[5px] [&_.side-link::before]:-left-[2px] max-[861px]:later:[&_.side-link-copy]:flex max-[861px]:later:[&_.side-link]:justify-start max-[861px]:later:[&_.side-link]:p-[6px_10px]' : ''}${mobileOpen ? ' mobile-sidebar-open' : ''}`}>
      <a className="fixed z-1000 left-[16px] -top-[60px] p-[10px_14px] rounded-[10px] text-[#fff] [background:var(--accent)] text-[12px] font-[750] [transition:top_.2s_ease] focus:top-[14px]" href="#main-content">Skip to main content</a>
      <Sidebar
        isCollapsed={collapsed}
        setIsCollapsed={updateCollapsed}
        onNavigate={() => setMobileOpen(false)}
        unreadByPath={unreadByPath}
        blueByPath={blueByPath}
      />
      <button
        className="hidden max-[861px]:fixed max-[861px]:inset-0 max-[861px]:z-45 max-[861px]:later:block max-[861px]:[visibility:hidden] max-[861px]:opacity-[0] max-[861px]:border-0 max-[861px]:[background:rgba(3,_6,_14,_.56)] max-[861px]:[backdrop-filter:blur(4px)] max-[861px]:[transition:opacity_.24s_ease,_visibility_.24s_ease] max-[861px]:[.mobile-sidebar-open_&]:[visibility:visible] max-[861px]:[.mobile-sidebar-open_&]:opacity-[1]"
        type="button"
        aria-label="Close navigation"
        aria-hidden={!mobileOpen}
        tabIndex={mobileOpen ? 0 : -1}
        onClick={() => setMobileOpen(false)}
      />
      <div className="min-w-0">
        <Header onMenu={() => setMobileOpen((value) => !value)} mobileOpen={mobileOpen} />
        <main id="main-content" className="min-h-[calc(100vh_-_var(--header-height))]" tabIndex="-1">
          <div key={location.pathname} className="min-h-[inherit] [animation:routeIn_.38s_cubic-bezier(.2,_.8,_.2,_1)_both]"><Outlet /></div>
        </main>
      </div>
      <MessengerWidget />
    </div>
  );
}
