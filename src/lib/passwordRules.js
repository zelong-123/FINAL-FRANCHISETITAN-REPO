// The password a person chooses on /reset-password (invitation or reset): at least 8 characters,
// with a letter and a number. Supabase stores only its hash; the API never sees it.
export const PASSWORD_MIN = 8;

/** The rules, each with whether it is met — shown as a checklist under the field. */
export function passwordChecks(password) {
  const value = String(password ?? '');
  return [
    { key: 'length', label: `At least ${PASSWORD_MIN} characters`, ok: value.length >= PASSWORD_MIN },
    { key: 'letter', label: 'A letter', ok: /\p{L}/u.test(value) },
    { key: 'number', label: 'A number', ok: /\d/.test(value) },
  ];
}

/** The first unmet rule as a sentence, the confirmation mismatch, or '' when the password is acceptable. */
export function passwordProblem(password, confirm) {
  const missing = passwordChecks(password).find((check) => !check.ok);
  if (missing) return `The password needs: ${missing.label.toLowerCase()}.`;
  if (password !== confirm) return 'The two passwords do not match.';
  return '';
}

/** A hint only — never a rule: 'weak' | 'fair' | 'good' | 'strong' (null when empty). */
export function passwordStrength(password) {
  const value = String(password ?? '');
  if (!value) return null;
  let score = 0;
  if (value.length >= PASSWORD_MIN) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\p{L}\d]/u.test(value)) score += 1;
  if (score <= 2) return 'weak';
  if (score === 3) return 'fair';
  if (score === 4) return 'good';
  return 'strong';
}

/** What the setup link is for, read from the Supabase redirect (#…&type=invite | recovery). */
export function linkKind(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  if (params.get('error') || params.get('error_code')) {
    return { kind: 'error', expired: /expired/i.test(`${params.get('error_code')} ${params.get('error_description')}`) };
  }
  const type = params.get('type');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return { kind: 'error', expired: false };
  return { kind: type === 'recovery' ? 'recovery' : 'invite', accessToken, refreshToken };
}
