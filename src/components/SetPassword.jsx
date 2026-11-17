import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FaCircleCheck, FaCircleExclamation, FaCircle, FaEye, FaEyeSlash } from 'react-icons/fa6';
import { API_BASE_URL, authToken } from '../lib/api';
import { supabase } from '../lib/supabase';
import { ROLE_HOME, useAuth } from '../context/AuthContext';
import { BRANCH_LOGIN_PATH } from '../lib/portal';
import { linkKind, passwordChecks, passwordProblem, passwordStrength } from '../lib/passwordRules';
import AuthCard, { errorBox, fieldLabel, primaryButton, textInput } from './AuthCard';

// Opened from the email Supabase sends: an invitation (type=invite) or a password reset (type=recovery).
// Supabase redirects here with the session in the URL hash:
//   /reset-password#access_token=...&refresh_token=...&type=invite
// supabase.js has detectSessionInUrl turned off, so this page reads the hash itself. It is a public
// route (no sign-in guard). The password goes to Supabase only (updateUser); the API is told the
// invitation was accepted or declined, using the link's own session.

const STRENGTH = {
  weak: { label: 'Weak', color: 'var(--danger-text)', width: '25%' },
  fair: { label: 'Fair', color: 'var(--warning-text)', width: '50%' },
  good: { label: 'Good', color: 'var(--accent-text)', width: '75%' },
  strong: { label: 'Strong', color: 'var(--success-text)', width: '100%' },
};
const secondaryButton = 'mt-2 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-line-strong bg-transparent px-[18px] text-[13px] font-bold text-text-secondary transition-colors hover:border-danger/50 hover:text-danger-text disabled:opacity-60';

async function linkCall(method, path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Object.values(body.errors ?? {}).flat()[0] || body.message || 'Something went wrong. Try again.';
    throw new Error(message);
  }
  return body;
}

export default function SetPassword() {
  const navigate = useNavigate();
  const { loginForPortal } = useAuth();
  // checking | ready | invalid | declined | done
  const [status, setStatus] = useState('checking');
  const [invalidMessage, setInvalidMessage] = useState('');
  const [link, setLink] = useState(null); // { kind, token, email, full_name, role }
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [askDecline, setAskDecline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const parsed = linkKind(window.location.hash);
    // Keep the tokens out of the address bar and browser history either way.
    window.history.replaceState(null, '', window.location.pathname);
    if (parsed.kind === 'error') {
      setInvalidMessage(parsed.expired
        ? 'This link has expired. Ask your Admin to resend the invite.'
        : 'This link is not valid or was already used. Ask your Admin to resend the invite.');
      setStatus('invalid');
      return;
    }
    (async () => {
      const { error: sessionError } = await supabase.auth.setSession({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken });
      if (sessionError) throw new Error('This link has expired or was already used. Ask your Admin to resend the invite.');
      const who = (await linkCall('GET', '/auth/invite', parsed.accessToken)).data;
      if (who.status === 'declined') {
        setStatus('declined');
        return;
      }
      setLink({ kind: who.kind === 'recovery' || parsed.kind === 'recovery' ? 'recovery' : 'invite', token: parsed.accessToken, ...who });
      setStatus('ready');
    })().catch((err) => {
      setInvalidMessage(err.message || 'This link has expired or was already used. Ask your Admin to resend the invite.');
      setStatus('invalid');
    });
  }, []);

  const finishSignIn = async (role) => {
    // Out of the setup session, then a normal sign-in with the new password.
    await authToken.clear();
    const portal = role === 'franchisee' ? 'branch' : 'staff';
    try {
      const signedIn = await loginForPortal(portal, link.email, password);
      navigate(ROLE_HOME[signedIn.role?.name || role] || '/', { replace: true });
    } catch {
      navigate(portal === 'branch' ? BRANCH_LOGIN_PATH : '/', { replace: true, state: { successNotice: 'Password set — you can now log in.' } });
    }
  };

  const accept = async (event) => {
    event.preventDefault();
    setError('');
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }
    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw new Error(updateError.message);
      if (link.kind === 'invite') await linkCall('POST', '/auth/invite/accept', link.token);
      await finishSignIn(link.role?.name);
    } catch (err) {
      setError(err.message || 'Could not save the password. Try again.');
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    setError('');
    try {
      await linkCall('POST', '/auth/invite/decline', link.token);
      await authToken.clear();
      setStatus('declined');
    } catch (err) {
      setError(err.message || 'Could not decline the invitation. Try again.');
    } finally {
      setSubmitting(false);
      setAskDecline(false);
    }
  };

  if (status === 'checking') {
    return (
      <AuthCard title="Checking your link">
        <p className="m-0 text-[13px] leading-[1.7] text-muted">One moment…</p>
      </AuthCard>
    );
  }

  if (status === 'invalid') {
    return (
      <AuthCard title="This link can't be used">
        <div className={errorBox} role="alert"><FaCircleExclamation className="mt-0.5 shrink-0" /><span>{invalidMessage}</span></div>
        <p className="m-0 text-[13px] leading-[1.7] text-muted">Invitation and reset links work once and expire after a while. Your Admin can send you a new one from User management.</p>
        <Link to="/" className="mt-6 block text-[12px] font-[650] text-accent-text hover:underline">Back to sign in</Link>
      </AuthCard>
    );
  }

  if (status === 'declined') {
    return (
      <AuthCard title="Invitation declined">
        <p className="m-0 text-[13px] leading-[1.7] text-muted">
          You declined the invitation, so no account was set up. If this was a mistake, ask your Admin to send a new invite.
        </p>
        <Link to="/" className={`${primaryButton} mt-6 no-underline`}>Done</Link>
      </AuthCard>
    );
  }

  const isInvite = link.kind === 'invite';
  const checks = passwordChecks(password);
  const strength = STRENGTH[passwordStrength(password)];
  return (
    <AuthCard
      title={isInvite ? 'Set up your Franchise Titan account' : 'Reset your password'}
      subtitle={isInvite ? 'Choose a password to accept the invitation. You sign in with your email and this password.' : 'Choose a new password for your account.'}
    >
      {error && (
        <div className={errorBox} role="alert"><FaCircleExclamation className="mt-0.5 shrink-0" /><span>{error}</span></div>
      )}
      <form onSubmit={accept} className="flex flex-col gap-2">
        <dl className="m-0 mb-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-surface-subtle px-4 py-3 text-[13px]">
          {link.full_name && (<><dt className="text-muted">Name</dt><dd className="m-0 text-text">{link.full_name}</dd></>)}
          <dt className="text-muted">Role</dt><dd className="m-0 font-semibold text-text">{link.role?.label || link.role?.name}</dd>
        </dl>
        <label className={fieldLabel} htmlFor="username">Username (your email)</label>
        <input id="username" className={`${textInput} text-muted`} value={link.email} readOnly autoComplete="username" />

        <label className={`${fieldLabel} mt-1.5`} htmlFor="password">Password</label>
        <div className="relative">
          <input
            id="password"
            className={`${textInput} pr-[52px]`}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            aria-describedby="password-rules"
            required
          />
          <button
            type="button"
            className="absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-[10px] border-0 bg-transparent text-muted hover:bg-hover hover:text-text"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <FaEyeSlash /> : <FaEye />}
          </button>
        </div>
        {strength && (
          <div className="flex items-center gap-2.5 text-[11px]" aria-live="polite">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-strong"><span className="block h-full rounded-full transition-[width] duration-200" style={{ width: strength.width, background: strength.color }} /></span>
            <span style={{ color: strength.color }}>{strength.label}</span>
          </div>
        )}
        <ul id="password-rules" className="m-0 grid list-none gap-1 p-0 text-[12px]">
          {checks.map((check) => (
            <li key={check.key} className={`flex items-center gap-2 ${check.ok ? 'text-success-text' : 'text-muted'}`}>
              {check.ok ? <FaCircleCheck aria-hidden="true" /> : <FaCircle aria-hidden="true" className="text-[8px]" />}
              {check.label}
            </li>
          ))}
        </ul>

        <label className={`${fieldLabel} mt-1.5`} htmlFor="confirm">Confirm password</label>
        <input
          id="confirm"
          className={textInput}
          type={showPassword ? 'text' : 'password'}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
        />
        <button type="submit" disabled={submitting} className={primaryButton}>
          {submitting ? 'Saving…' : isInvite ? 'Accept & set password' : 'Set new password'}
        </button>
        {isInvite && !askDecline && (
          <button type="button" className={secondaryButton} disabled={submitting} onClick={() => setAskDecline(true)}>Decline invitation</button>
        )}
        {isInvite && askDecline && (
          <div className="mt-2 rounded-xl border border-danger/30 bg-danger/8 p-3 text-[12.5px] leading-normal text-text" role="alertdialog" aria-label="Decline the invitation?">
            <p className="m-0">Decline this invitation? Your account will not be set up, and the link stops working.</p>
            <div className="mt-2.5 flex gap-2">
              <button type="button" className="flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-semibold text-text-secondary" onClick={() => setAskDecline(false)} disabled={submitting}>Keep it</button>
              <button type="button" className="flex-1 rounded-lg border-0 bg-[linear-gradient(135deg,#ef596b,#c9374a)] px-3 py-2 font-bold text-white" onClick={decline} disabled={submitting}>Yes, decline</button>
            </div>
          </div>
        )}
      </form>
    </AuthCard>
  );
}
