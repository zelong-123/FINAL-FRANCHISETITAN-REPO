import React, { useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Log from './components/Log';
import BranchLogin from './components/BranchLogin';
import ProtectedRoute from './components/ProtectedRoute';
import { AppLoader } from './components/ApiUi';
import { AuthProvider, ROLE_HOME, useAuth } from './context/AuthContext';
import { rolesFor } from './lib/roleAccess';
import { scheduleRedirectTarget } from './lib/navigation';
import { BRANCH_LOGIN_PATH, IS_BRANCH_PORTAL, IS_STAFF_PORTAL, WRONG_PORTAL_MESSAGE, isWrongPortalRole } from './lib/portal';
import { ChatProvider } from './context/ChatContext';
import AppShell from './layout/AppShell';
import Dashboard from './pages/Dashboard';
import Inquiries from './pages/Inquiries';
import InquiryHistory from './pages/InquiryHistory';
import Applicants from './pages/Applicants';
import Activities from './pages/Activities';
import Users from './pages/Users';
import Inventory from './pages/Inventory';
import Products from './pages/Products';
import SupplyRequests from './pages/SupplyRequests';
import EstimatedRequirement from './pages/EstimatedRequirement';
import ForecastNetwork from './pages/ForecastNetwork';
import Branches from './pages/Branches';
import AdminSettings from './pages/AdminSettings';
import Messenger from './pages/Messenger';
import BranchPortal from './pages/BranchPortal';
import FirstPasswordGate from './components/FirstPasswordGate';

function RoleRedirect() {
  const { loading, role, isAuthenticated } = useAuth();
  if (loading) return <AppLoader label="Loading Herald…" />;
  return <Navigate to={isAuthenticated ? (role === 'franchisee' ? '/branch-portal' : ROLE_HOME[role] || '/') : '/'} replace />;
}

function StaffRoute() {
  const { role } = useAuth();
  return role === 'franchisee' ? <Navigate to="/branch-portal" replace /> : <Outlet />;
}

function BranchPortalRoute() {
  const { loading, isAuthenticated, role } = useAuth();
  const location = useLocation();
  if (loading) return <AppLoader label="Restoring branch session…" />;
  if (!isAuthenticated) return <Navigate to={BRANCH_LOGIN_PATH} replace />;
  if (role === 'admin' && location.pathname.endsWith('/preview')) return <BranchPortal preview />;
  return role === 'franchisee' ? <BranchPortal /> : <Navigate to={ROLE_HOME[role] || '/'} replace />;
}

/**
 * A session that belongs to the other portal (a franchisee on the staff site, or
 * staff on the branch site) is signed out here, before any route renders, and the
 * visitor lands on this site's login with a short notice.
 */
function PortalSessionGuard({ children }) {
  const { loading, isAuthenticated, role, logout } = useAuth();
  const navigate = useNavigate();
  const signingOut = useRef(false);
  const wrongPortal = !loading && isAuthenticated && isWrongPortalRole(role);

  useEffect(() => {
    if (!wrongPortal || signingOut.current) return;
    signingOut.current = true;
    // Move to this site's login first, while the loader below still covers the routes,
    // so the login page mounts with the notice once the session is cleared.
    navigate('/', { replace: true, state: { portalNotice: WRONG_PORTAL_MESSAGE } });
    logout().finally(() => { signingOut.current = false; });
  }, [wrongPortal, logout, navigate]);

  if (wrongPortal) return <AppLoader label="Signing out…" />;
  return children;
}

/**
 * Old Master Schedule URL: Master Schedule now lives in Activities & Schedule.
 * /schedule?session=12 -> /activities?view=master-schedule&session=12
 */
function ScheduleRedirect() {
  const location = useLocation();
  return <Navigate to={scheduleRedirectTarget(location.search)} replace />;
}

/** Route guard fed by the central role config (lib/roleAccess.js). */
function RouteGuard({ path }) {
  return <ProtectedRoute allowedRoles={rolesFor(path)} />;
}

export default function App() {
  const base = import.meta.env.BASE_URL === '/' ? undefined : import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <BrowserRouter basename={base}>
      <AuthProvider>
        <ChatProvider>
          <PortalSessionGuard>
          <FirstPasswordGate>
          <Routes>
            {/* VITE_PORTAL (lib/portal.js): the staff build has no branch login, the branch
                build has no staff login or staff pages; unset keeps every route. */}
            <Route path="/" element={IS_BRANCH_PORTAL ? <BranchLogin /> : <Log />} />
            {!IS_STAFF_PORTAL && (
              <>
                <Route path="/branch-login" element={<BranchLogin />} />
                <Route path="/branch_portal/login" element={<Navigate to="/branch-portal/login" replace />} />
                <Route path="/branch-portal/login" element={<BranchLogin />} />
                {/* Estimated Requirement left the branch workspace: old links open the dashboard. */}
                <Route path="/branch-portal/estimated-requirement" element={<Navigate to="/branch-portal" replace />} />
              </>
            )}
            {/* Kept in the staff build too: Admin's read-only /branch-portal/preview. */}
            <Route path="/branch-portal/*" element={<BranchPortalRoute />} />
            {!IS_BRANCH_PORTAL && (
            <Route element={<ProtectedRoute />}>
              <Route element={<StaffRoute />}>
                <Route element={<AppShell />}>
                  <Route path="/chat" element={<Messenger />} />
                  <Route path="/messages" element={<Navigate to="/chat" replace />} />
                  <Route element={<RouteGuard path="/admin-dashboard" />}><Route path="/admin-dashboard" element={<Dashboard />} /></Route>
                  <Route element={<RouteGuard path="/users" />}><Route path="/users" element={<Users />} /></Route>
                  <Route element={<RouteGuard path="/admin-settings" />}><Route path="/admin-settings" element={<AdminSettings />} /></Route>
                  <Route element={<RouteGuard path="/marketing-dashboard" />}><Route path="/marketing-dashboard" element={<Dashboard />} /></Route>
                  <Route element={<RouteGuard path="/sales-dashboard" />}><Route path="/sales-dashboard" element={<Dashboard />} /></Route>
                  <Route element={<RouteGuard path="/logistics-dashboard" />}><Route path="/logistics-dashboard" element={<Dashboard />} /></Route>
                  <Route element={<RouteGuard path="/franchisee-dashboard" />}><Route path="/franchisee-dashboard" element={<Dashboard />} /></Route>
                  <Route element={<RouteGuard path="/inquiries" />}><Route path="/inquiries" element={<Inquiries />} /><Route path="/marketing-inquiries" element={<Navigate to="/inquiries" replace />} /></Route>
                  <Route element={<RouteGuard path="/applicants" />}><Route path="/applicants" element={<Applicants />} /></Route>
                  <Route element={<RouteGuard path="/activities" />}><Route path="/activities" element={<Activities />} /></Route>
                  <Route element={<RouteGuard path="/schedule" />}><Route path="/schedule" element={<ScheduleRedirect />} /></Route>
                  <Route element={<RouteGuard path="/branches" />}><Route path="/branches" element={<Branches />} /></Route>
                  <Route element={<RouteGuard path="/inventory" />}><Route path="/inventory" element={<Inventory />} /></Route>
                  <Route element={<RouteGuard path="/products" />}><Route path="/products" element={<Products />} /></Route>
                  {/* Analytics page retired: direct URLs go to the role's own dashboard. */}
                  <Route path="/profittrack" element={<RoleRedirect />} />
                  <Route element={<RouteGuard path="/supply-requests" />}><Route path="/supply-requests" element={<SupplyRequests />} /></Route>
                  <Route element={<RouteGuard path="/estimated-requirement" />}><Route path="/estimated-requirement" element={<EstimatedRequirement />} /></Route>
                  <Route element={<RouteGuard path="/estimated-requirement/network" />}><Route path="/estimated-requirement/network" element={<ForecastNetwork />} /></Route>
                  <Route path="/analytics" element={<RoleRedirect />} />
                  <Route element={<RouteGuard path="/inquiry-history" />}><Route path="/inquiry-history" element={<InquiryHistory />} /></Route>
                  <Route path="/franchise-management" element={<Navigate to="/applicants" replace />} />
                  <Route path="/user-management" element={<Navigate to="/users" replace />} />
                  <Route path="/supply-chain" element={<Navigate to="/supply-requests" replace />} />
                  <Route path="/analytics-dashboard" element={<RoleRedirect />} />
                </Route>
              </Route>
            </Route>
            )}
            <Route path="/branch-portal" element={<BranchPortalRoute />} />
            <Route path="/franchisee-dashboard" element={<Navigate to="/branch-portal" replace />} />
            <Route path="*" element={<RoleRedirect />} />
          </Routes>
          </FirstPasswordGate>
          </PortalSessionGuard>
        </ChatProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
