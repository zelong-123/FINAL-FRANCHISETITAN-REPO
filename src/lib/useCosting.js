import { useAuth } from '../context/AuthContext';

/**
 * Costing (unit cost, stock value, receipt cost, prices) is hidden outside the
 * applicant Payment Submission stage. One switch on the server
 * (config features.costing), reported by /auth/me.
 */
export default function useCosting() {
  const { user } = useAuth();
  return Boolean(user?.features?.costing);
}
