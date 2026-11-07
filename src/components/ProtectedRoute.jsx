import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth, ROLE_HOME } from '../context/AuthContext';
import { AppLoader } from './ApiUi';

export default function ProtectedRoute({ allowedRoles }) {
  const { loading, isAuthenticated, role } = useAuth();
  const location = useLocation();

  if (loading) return <AppLoader />;
  if (!isAuthenticated) return <Navigate to="/" replace state={{ from: location }} />;
  if (allowedRoles && !allowedRoles.includes(role)) {
    return <Navigate to={ROLE_HOME[role] || '/'} replace />;
  }
  return <Outlet />;
}
