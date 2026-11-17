import type { Db, Row } from './db.ts';

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  auth_user_id: string;
}

export interface VerifiedToken {
  authUserId: string;
  sessionId: string | null;
}

/** Everything the API needs from Supabase Auth, so tests can run against real Postgres. */
export interface AuthProvider {
  signIn(email: string, password: string): Promise<AuthSession | null>;
  verify(accessToken: string): Promise<VerifiedToken | null>;
  createUser(email: string, password: string): Promise<string>;
  /**
   * Emails an invitation; the person sets their own password from the link (which opens
   * `redirectTo`). Returns the new auth user id. Throws when the invitation cannot be sent.
   */
  inviteUser(email: string, options?: { redirectTo?: string | null; fullName?: string | null }): Promise<string>;
  /**
   * Emails a "Reset password" link for an existing sign-in (it opens `redirectTo`, i.e. /reset-password).
   * Throws when the email cannot be sent.
   */
  sendPasswordReset(email: string, options?: { redirectTo?: string | null }): Promise<void>;
  updateUser(authUserId: string, changes: { email?: string; password?: string }): Promise<void>;
  /** Removes the sign-in. Throws when Supabase refuses (callers that do not care catch it). */
  deleteUser(authUserId: string): Promise<void>;
  /** Ends this session only (sign out, or a sign-in rejected after the password check). */
  revoke(accessToken: string): Promise<void>;
  /** Every other device is signed out; the session making the change keeps working. */
  revokeOthers(accessToken: string): Promise<void>;
  revokeAll(authUserId: string): Promise<void>;
}

/** Uploaded files. 'private' needs the API to download; 'public' has a direct URL. */
export interface FileStore {
  put(disk: 'private' | 'public', path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(disk: string, path: string): Promise<Uint8Array | null>;
  remove(disk: string, paths: string[]): Promise<void>;
  publicUrl(path: string): string;
}

export interface Deps {
  db: Db;
  auth: AuthProvider;
  files: FileStore;
  /** FEATURE_COSTING: off hides every cost/price field outside applicant routes. */
  costingEnabled: boolean;
  /** Removed: FEATURE_PAYMENT_ADVANCED (billing) is permanently off and ignored. */
  paymentAdvanced?: boolean;
  /**
   * Where invitation and password-reset links open (APP_STAFF_URL / APP_BRANCH_URL): the site's
   * /reset-password page. Unset: the link the browser sent is used (local development).
   */
  appUrls?: { staff: string | null; branch: string | null };
  /** How long an invitation link stays valid, in hours (Supabase "Email OTP expiration"; default 24). */
  inviteTtlHours?: number;
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    db: Db;
    user: Row;
    accessToken: string;
    sessionId: string | null;
  };
};
