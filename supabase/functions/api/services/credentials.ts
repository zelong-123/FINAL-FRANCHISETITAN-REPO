// How a new account gets its first password, plus the shared rules for account fields.
//
// Every account (staff, Admin, Franchisee) gets an invitation email from Supabase Auth and the
// person sets their own password on the app's /reset-password page (services/accounts.ts). The
// system never creates, shows, stores or logs a password; the API only ever reports
// { method: 'email_link', sent_to, note }.
import type { Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

export type CredentialDelivery = { method: 'email_link'; sent_to: string; note: string };

/** Older accounts still marked must_change_password set a new one at first sign-in (POST /auth/first-password). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 15;

/** Letters (any language, e.g. ñ, é), spaces, period, hyphen and apostrophe. At least two letters. */
const NAME = /^[\p{L}\p{M} .'’-]+$/u;
export function cleanPersonName(value: unknown, field = 'full_name'): string {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail(field, 'Full name is required.');
  if (!NAME.test(name) || (name.match(/\p{L}/gu) ?? []).length < 2) {
    fail(field, 'Full name may contain letters, spaces, period, hyphen and apostrophe only (no digits or other symbols).');
  }
  if (name.length > 255) fail(field, 'Full name may not be longer than 255 characters.');
  return name;
}

/** Optional phone: empty means none; otherwise exactly 11 digits. */
export function cleanOptionalPhone(value: unknown, field = 'phone'): string | null {
  const phone = String(value ?? '').trim();
  if (!phone) return null;
  if (!/^[0-9]{11}$/.test(phone)) fail(field, 'Phone / Contact must be exactly 11 digits (numbers only), or left empty.');
  return phone;
}

/** The fields of a new account that the audit log may keep — never a password. */
export function accountAuditValues(user: Row, role: string, delivery: CredentialDelivery, extra: Row = {}): Row {
  return { full_name: user.full_name, email: user.email, role, account_status: user.account_status, credential_method: delivery.method, ...extra };
}
