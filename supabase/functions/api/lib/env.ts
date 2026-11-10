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
  updateUser(authUserId: string, changes: { email?: string; password?: string }): Promise<void>;
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
  /** FEATURE_PAYMENT_ADVANCED: off (the default) hides discount/promo, installments, due dates, the minimum rules and Sales Report batching. */
  paymentAdvanced?: boolean;
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
