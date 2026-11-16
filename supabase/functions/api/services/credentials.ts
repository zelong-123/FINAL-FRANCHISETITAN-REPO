// How a new account gets its first password, plus the shared rules for account fields.
//
// Today there is no email integration, so the system generates a strong temporary password,
// returns it ONCE to the Admin who created the account, and marks the account
// must_change_password. Nothing stores it in plain text (Supabase Auth keeps only its hash)
// and it is never written to the audit log.
//
// A future "email a set-password link" replaces issueInitialCredentials() only: it would
// create the sign-in with an unguessable password nobody sees, send the link, and return
// { method: 'email_link', ... }. The routes and the form stay the same, because they only
// pass the returned `delivery` object through.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

export type CredentialDelivery =
  | { method: 'temporary_password'; temporary_password: string; note: string }
  | { method: 'email_link'; sent_to: string; note: string };

export const TEMPORARY_PASSWORD_NOTE = 'Share it privately. The user must change it at first sign-in.';
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 15;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%*?-_+';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function pick(chars: string, random: number) {
  return chars[random % chars.length];
}

/** 14 characters from a cryptographic source, with at least one upper, lower, digit and symbol. */
export function generateTemporaryPassword(length = 14): string {
  const bytes = new Uint32Array(length + length);
  crypto.getRandomValues(bytes);
  const chars = [pick(UPPER, bytes[0]), pick(LOWER, bytes[1]), pick(DIGITS, bytes[2]), pick(SYMBOLS, bytes[3])];
  for (let i = 4; i < length; i += 1) chars.push(pick(ALL, bytes[i]));
  // Fisher–Yates with the second half of the random values, so the required classes are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[length + i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * The first password of a new account and how the user receives it. The returned password
 * goes to Supabase Auth only; `delivery` is what the API response may carry.
 */
export function issueInitialCredentials(_c: Context<AppEnv>, _email: string): { password: string; delivery: CredentialDelivery } {
  const password = generateTemporaryPassword();
  return { password, delivery: { method: 'temporary_password', temporary_password: password, note: TEMPORARY_PASSWORD_NOTE } };
}

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
