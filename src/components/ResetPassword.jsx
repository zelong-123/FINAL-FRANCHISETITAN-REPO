import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaCircleExclamation, FaEye, FaEyeSlash } from 'react-icons/fa6';
import { authToken } from '../lib/api';
import { supabase } from '../lib/supabase';
import AuthCard, { errorBox, fieldLabel, primaryButton, textInput } from './AuthCard';

// Opened from the email Supabase sends (new account or forgotten password).
// Supabase redirects here with the session in the URL hash:
//   /reset-password#access_token=...&refresh_token=...&type=recovery
// supabase.js has detectSessionInUrl turned off, so this page reads the hash itself.
export default function ResetPassword() {
  const [status, setStatus] = useState('checking'); // checking | ready | invalid | done
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (params.get('error') || !accessToken || !refreshToken) {
      setStatus('invalid');
      return;
    }

    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          setStatus('invalid');
          return;
        }
        // Keep the tokens out of the address bar and browser history.
        window.history.replaceState(null, '', window.location.pathname);
        setStatus('ready');
      });
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSubmitting(false);
      setError(updateError.message);
      return;
    }
    // Sign out of the setup session so the user signs in normally with the new password.
    await authToken.clear();
    setSubmitting(false);
    setStatus('done');
  };

  if (status === 'checking') {
    return (
      <AuthCard title="Verifying link">
        <p className="m-0 text-[13px] leading-[1.7] text-muted">One moment…</p>
      </AuthCard>
    );
  }

  if (status === 'invalid') {
    return (
      <AuthCard title="Link not valid">
        <p className="m-0 text-[13px] leading-[1.7] text-muted">
          This link has expired or was already used. Ask your administrator to send a new one.
        </p>
        <Link to="/" className="mt-6 block text-[12px] font-[650] text-accent-text hover:underline">Back to sign in</Link>
      </AuthCard>
    );
  }

  if (status === 'done') {
    return (
      <AuthCard title="Password saved">
        <p className="m-0 text-[13px] leading-[1.7] text-muted">Your password is set. Sign in to continue.</p>
        <Link to="/" className={`${primaryButton} no-underline`}>Go to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your password" subtitle="Choose a password for your Franchise Titan account.">
      {error && (
        <div className={errorBox} role="alert"><FaCircleExclamation className="mt-0.5 shrink-0" /><span>{error}</span></div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label className={fieldLabel} htmlFor="password">New password</label>
        <div className="relative">
          <input
            id="password"
            className={`${textInput} pr-[52px]`}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
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
          {submitting ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </AuthCard>
  );
}