import React, { useState } from 'react';
import { api, firstValidationMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';

const MIN = 8;
const MAX = 15;

/**
 * An account created with a temporary password must set its own before anything else
 * (staff and branch portals alike). The API refuses every other request until then, so this
 * screen is the only way forward; signing out is the only other choice.
 */
export default function FirstPasswordGate({ children }) {
  const { user, isAuthenticated, refreshUser, logout } = useAuth();
  const [form, setForm] = useState({ password: '', password_confirmation: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!isAuthenticated || !user?.must_change_password) return children;

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (form.password.length < MIN || form.password.length > MAX) { setError(`Use ${MIN} to ${MAX} characters.`); return; }
    if (form.password !== form.password_confirmation) { setError('The two passwords do not match.'); return; }
    setSaving(true);
    try {
      await api.post('/auth/first-password', form);
      setForm({ password: '', password_confirmation: '' });
      await refreshUser();
    } catch (err) {
      setError(firstValidationMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen grid place-items-center p-4 [background:var(--bg,_#0b0f19)] text-text">
      <form onSubmit={submit} className="w-[min(100%,_420px)] grid gap-4 p-[26px_24px] border border-line rounded-[18px] [background:var(--panel,_#101421)] [box-shadow:var(--shadow-md)]" aria-labelledby="first-password-title">
        <div className="grid gap-1">
          <h1 id="first-password-title" className="m-0 text-[1.25rem]">Set a new password</h1>
          <p className="m-0 text-muted text-[0.9rem] leading-[1.5]">
            Welcome, {user.full_name}. You signed in with a temporary password. Choose your own password to continue.
          </p>
        </div>
        {error && <p className="m-0 p-[10px_12px] rounded-[10px] text-[#ff9ca3] [background:rgba(255,_107,_107,_.08)] border border-[rgba(255,_107,_107,_.35)] text-[0.88rem]" role="alert">{error}</p>}
        <label className="grid gap-[6px] text-[0.88rem]">
          <span>New password</span>
          <input type="password" required autoComplete="new-password" minLength={MIN} maxLength={MAX} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="h-[44px] p-[0_12px] rounded-[10px] border border-input-line [background:var(--input-bg)] text-text" />
          <small className="text-muted">{MIN} to {MAX} characters.</small>
        </label>
        <label className="grid gap-[6px] text-[0.88rem]">
          <span>Confirm new password</span>
          <input type="password" required autoComplete="new-password" minLength={MIN} maxLength={MAX} value={form.password_confirmation} onChange={(e) => setForm({ ...form, password_confirmation: e.target.value })} className="h-[44px] p-[0_12px] rounded-[10px] border border-input-line [background:var(--input-bg)] text-text" />
        </label>
        <button type="submit" disabled={saving} className="primary-button min-h-[44px] inline-flex items-center justify-center rounded-[12px] text-[#fff] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]">
          {saving ? 'Saving…' : 'Save new password'}
        </button>
        <button type="button" onClick={logout} className="justify-self-center text-muted text-[0.85rem] [background:none] border-0 underline cursor-pointer">Sign out</button>
      </form>
    </main>
  );
}
