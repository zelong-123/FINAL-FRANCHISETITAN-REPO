import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { API_BASE_URL, api, authToken } from '../lib/api';

// Presence key: one per browser tab (sessionStorage is not shared between tabs), so
// opening a second tab counts as a second live session and closing one keeps the
// account Active while the other is still open.
const SESSION_KEY = 'herald_session_key';

function tabSessionKey() {
  let key = sessionStorage.getItem(SESSION_KEY);
  if (!key) {
    key = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(SESSION_KEY, key);
  }
  return key;
}

const AuthContext = createContext(null);

export const ROLE_HOME = {
  admin: '/admin-dashboard',
  marketing: '/marketing-dashboard',
  sales: '/sales-dashboard',
  logistics: '/logistics-dashboard',
  franchisee: '/branch-portal',
};

export function roleName(user) {
  return user?.role?.name || user?.role || '';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loginPortal, setLoginPortal] = useState(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    authToken.clear();
    setUser(null);
    setLoginPortal(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!(await authToken.get())) {
      setLoading(false);
      return null;
    }
    try {
      const response = await api.get('/auth/me');
      setUser(response.data);
      setLoginPortal(null);
      return response.data;
    } catch {
      clearSession();
      setLoginPortal(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    refreshUser();
    const handleUnauthorized = () => clearSession();
    window.addEventListener('herald:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('herald:unauthorized', handleUnauthorized);
  }, [clearSession, refreshUser]);

  // Live presence: the account is Active while this tab keeps beating (see
  // App\Services\UserPresence). Closing the tab, hiding it for good or signing out
  // tells the server at once so the User Management list turns InActive.
  useEffect(() => {
    if (!user) return undefined;

    const key = tabSessionKey();

    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      api.post('/auth/heartbeat', { session_key: key }, { timeout: 10000 }).catch(() => {});
    };

    const endSession = () => {
      const token = authToken.latest();
      if (!token) return;
      // sendBeacon cannot attach the bearer header, but keepalive fetch survives unload.
      fetch(`${API_BASE_URL}/auth/session-end`, {
        method: 'POST',
        keepalive: true,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_key: key }),
      }).catch(() => {});
    };

    beat();
    const interval = window.setInterval(beat, 45000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', endSession);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', endSession);
    };
  }, [user]);

  const login = useCallback(async (email, password, keepSignedIn = false) => {
    const response = await api.post('/auth/login', {
      email,
      password,
      portal: 'staff',
      session_key: tabSessionKey(),
      device_name: keepSignedIn ? 'herald-browser-persistent' : 'herald-browser-session',
    }, { skipAuth: true });
    await authToken.set(response.data, keepSignedIn);
    setUser(response.data.user);
    setLoginPortal(null);
    return response.data.user;
  }, []);

  const loginForPortal = useCallback(async (portal, email, password, keepSignedIn = false) => {
    const response = await api.post('/auth/login', {
      email,
      password,
      portal,
      session_key: tabSessionKey(),
      device_name: keepSignedIn ? `herald-${portal}-persistent` : `herald-${portal}-session`,
    }, { skipAuth: true });
    const signedInUser = response.data.user;

    await authToken.set(response.data, keepSignedIn);
    setUser(signedInUser);
    setLoginPortal(portal);
    return signedInUser;
  }, []);

  const logout = useCallback(async () => {
    try {
      if (await authToken.get()) await api.post('/auth/logout');
    } catch {
      // The local session must still be cleared if the server is unreachable.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo(() => ({
    user,
    role: roleName(user),
    loginPortal,
    loading,
    login,
    loginForPortal,
    logout,
    refreshUser,
    isAuthenticated: Boolean(user),
  }), [user, loginPortal, loading, login, loginForPortal, logout, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
