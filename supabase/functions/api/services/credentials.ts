declare const Deno: any;
// How a new account gets its first password, plus the shared rules for account fields.
//
// Staff accounts made in User Management have NO password to hand over. Supabase Auth needs
// a password to create the sign-in, so the system gives it a random placeholder that is never
// shown or stored anywhere, then emails the user an invitation link (emailSetPasswordLink)
// where they create their own password. The email is sent by Supabase Auth through the custom
// SMTP (Brevo) set in the dashboard. If it cannot be sent, the Admin can use Resend invitation.
//
// issueInitialCredentials() below is still used where an account is made with a temporary
// password (Franchisee accounts created from an applicant). Nothing stores a password in plain
// text (Supabase Auth keeps only its hash) and it is never written to the audit log.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

export type CredentialDelivery =
  | { method: 'temporary_password'; temporary_password: string; note: string }
  | { method: 'email_link'; sent_to: string; note: string };

export const TEMPORARY_PASSWORD_NOTE = 'Share it privately. The user must change it at first sign-in.';
export const SET_PASSWORD_NOTE = 'An invitation link was emailed to them. They will create their own password from it. The link expires, so ask them to open it soon, and to check spam if it does not arrive.';
export const EMAIL_FAILED_NOTE = 'The account was created, but the invitation email could not be sent. Use Update > Resend invitation to try again.';
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

/**
 * Asks Supabase Auth to email the user an invitation link (its recovery email, sent through the
 * project's custom SMTP). `redirectTo` is the page the link opens (the browser sends
 * `${origin}/reset-password`); Supabase only honours it when it is in the dashboard's Redirect
 * URLs list, otherwise it falls back to the Site URL. Without `redirectTo`, the optional secret
 * APP_URL is used. SUPABASE_URL and SUPABASE_ANON_KEY are provided to Edge Functions automatically.
 * Returns false instead of throwing, so the caller can report it.
 */
export async function emailSetPasswordLink(email: string, redirectTo?: unknown): Promise<boolean> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    console.error('emailSetPasswordLink: SUPABASE_URL or SUPABASE_ANON_KEY is not set.');
    return false;
  }

  let target = '';
  if (typeof redirectTo === 'string' && /^https?:\/\//.test(redirectTo)) target = redirectTo;
  else if (Deno.env.get('APP_URL')) target = `${Deno.env.get('APP_URL')!.replace(/\/$/, '')}/reset-password`;
  if (!target) {
    console.error('emailSetPasswordLink: no redirect_to was sent and APP_URL is not set.');
    return false;
  }

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/recover?redirect_to=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error('emailSetPasswordLink failed', response.status, await response.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('emailSetPasswordLink error', error);
    return false;
  }
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