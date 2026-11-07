import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  FaArrowRightFromBracket,
  FaEllipsisVertical,
  FaGear,
  FaLock,
  FaPenToSquare,
} from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../../lib/api';
import { formatDate, titleCase } from '../../../lib/format';
import { Field, Notice } from '../../ApiUi';
import { useAuth } from '../../../context/AuthContext';
import { initialsOf } from '../../../lib/initials';

/**
 * Header avatar dialog: one clean card (no title bar, no footer).
 *  - closes on backdrop click, Escape, logout or navigation
 *  - Admin : Edit Profile, Account Security (username + password), Admin Settings
 *  - Staff : Edit Profile only (name / email / contact)
 */
export default function ProfileModal({ onClose }) {
  const { user, role, logout, refreshUser } = useAuth();
  const navigate = useNavigate();
  const cardRef = useRef(null);
  const menuRef = useRef(null);
  const onCloseRef = useRef(onClose);

  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState(null); // null | 'edit' | 'security'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [profile, setProfile] = useState({ full_name: '', email: '', phone: '' });
  const [security, setSecurity] = useState({ email: '', password: '', password_confirmation: '' });

  const isAdmin = role === 'admin';
  const presence = user?.presence || {};
  const roleLabel = titleCase(role || '') || 'Team member';

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Fresh profile + presence (time in / last active) every time the card opens.
  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  // Overlay behaviour: lock the page, close on Escape, restore focus afterwards.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const openPanel = (next) => {
    setMenuOpen(false);
    setError('');
    setSuccess('');
    setPanel(next);
    if (next === 'edit') {
      setProfile({ full_name: user?.full_name || '', email: user?.email || '', phone: user?.phone || '' });
    }
    if (next === 'security') {
      setSecurity({ email: user?.email || '', password: '', password_confirmation: '' });
    }
  };

  const saveProfile = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.put('/auth/profile', {
        full_name: profile.full_name,
        email: profile.email,
        phone: profile.phone || null,
      });
      await refreshUser();
      setPanel(null);
      setSuccess('Profile updated.');
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  const saveSecurity = async (event) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    if (security.password && security.password !== security.password_confirmation) {
      setError('Password and Confirm Password must match.');
      return;
    }
    setSaving(true);
    try {
      await api.put('/auth/security', {
        email: security.email,
        ...(security.password ? { password: security.password, password_confirmation: security.password_confirmation } : {}),
      });
      await refreshUser();
      setPanel(null);
      setSuccess('Login credentials updated. Use the new username and password next time you sign in.');
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return createPortal(
    <div className="fixed inset-0 z-1500 grid place-items-center p-5 [background:rgba(3,_7,_16,_0.74)] [backdrop-filter:blur(3px)] [animation:profileFadeIn_0.16s_ease_both] max-[681px]:later:p-3" role="presentation" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className="relative w-[min(720px,_100%)] max-h-[calc(100vh_-_40px)] overflow-y-auto overflow-x-hidden pb-[6px] border border-[#252b3b] rounded-[14px] [background:#101421] text-[#dce2ef] [box-shadow:0_30px_70px_rgba(2,_6,_20,_0.6)] [animation:profileRise_0.18s_ease_both] max-[681px]:later:max-h-[calc(100vh_-_24px)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-dialog-name"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="absolute top-[14px] right-[16px] z-4 flex items-center gap-[10px] max-[681px]:later:top-[10px] max-[681px]:later:right-[12px]">
          <button type="button" className="inline-flex items-center gap-[7px] p-[6px_12px] border border-[rgba(239,_68,_68,_0.6)] rounded-[8px] [background:transparent] text-[#f87171] text-[11px] font-[700] tracking-[0.08em] uppercase cursor-pointer [transition:background_0.15s_ease,_color_0.15s_ease,_border-color_0.15s_ease] hover:border-[#ef4444] hover:[background:rgba(239,_68,_68,_0.14)] hover:text-[#fecaca]" onClick={signOut}>
            <FaArrowRightFromBracket aria-hidden="true" /> Logout
          </button>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              className="w-[34px] h-[34px] grid place-items-center border border-[#2c3549] rounded-[8px] [background:#111827] text-[#cbd3e3] cursor-pointer hover:border-[#4b477d] hover:[background:#1a2133] hover:text-[#fff]"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Profile options"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <FaEllipsisVertical aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="absolute top-[calc(100%_+_8px)] right-0 z-5 min-w-[208px] grid gap-[2px] p-[6px] border border-[#252b3b] rounded-[12px] [background:#101421] [box-shadow:0_18px_40px_rgba(2,_6,_20,_0.55)] [&_button]:flex [&_button]:items-center [&_button]:gap-[9px] [&_button]:min-h-[36px] [&_button]:p-[8px_10px] later-2:[&_button]:border-0 later-2:[&_button]:rounded-[8px] [&_button]:[background:transparent] [&_button]:text-[#cbd3e3] later-2:[&_button]:text-[12px] later-2:[&_button]:font-[600] [&_button]:text-left later:[&_button]:cursor-pointer later:[&_button:hover]:[background:#1a2133] [&_button:hover]:text-[#fff] [&_button_svg]:text-[#8a94a6]" role="menu">
                {isAdmin && (
                  <button type="button" role="menuitem" onClick={() => openPanel('security')}>
                    <FaLock aria-hidden="true" /> Account security
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => openPanel('edit')}>
                  <FaPenToSquare aria-hidden="true" /> Edit profile
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onClose(); navigate('/admin-settings'); }}
                  >
                    <FaGear aria-hidden="true" /> Admin settings
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <header className="relative flex items-center gap-5 mt-14 p-[20px_24px_18px] border-b border-b-[#252b3b] [background:#1a2133] max-[681px]:later:gap-[14px] max-[681px]:later:mt-13 max-[681px]:later:p-[16px_16px_14px]">
          <span className="w-[96px] h-[96px] flex-[0_0_auto] grid place-items-center -mt-[58px] border-[5px] border-[#0b0f19] rounded-[50%] [background:radial-gradient(circle_at_32%_26%,_#8b8cff,_#5b5bd6_60%,_#4a49b8)] text-[#fff] text-[30px] font-[800] tracking-[0.01em] leading-[1] text-center [box-shadow:0_16px_34px_rgba(74,_73,_184,_0.35)] max-[681px]:later:w-[76px] max-[681px]:later:h-[76px] max-[681px]:later:-mt-[46px] max-[681px]:later:border-[4px] max-[681px]:later:text-[24px]" aria-hidden="true">{initialsOf(user?.full_name || 'User')}</span>
          <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[#fff] [&_h2]:text-[22px] [&_h2]:font-[800] [&_h2]:leading-[1.2] [&_h2]:tracking-[-0.02em] [&_p]:m-[5px_0_0] [&_p]:text-[#9aa4bb] [&_p]:text-[12.5px] [&_p]:font-[600] max-[681px]:later:[&_h2]:text-[17px] max-[681px]:later:[&_p]:text-[11.5px]">
            <h2 id="profile-dialog-name">{user?.full_name || 'User'}</h2>
            <p>{roleLabel}</p>
          </div>
        </header>

        <div className="grid grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)] gap-0 p-[18px_24px_20px] max-[681px]:later:grid-cols-[1fr] max-[681px]:later:p-[14px_16px_16px]">
          <section className="profile-col min-w-0 [.profile-col+&]:ml-[22px] [.profile-col+&]:pl-[22px] [.profile-col+&]:border-l [.profile-col+&]:border-l-[#252b3b] [&_h3]:m-[0_0_11px] [&_h3]:text-[#7f889b] [&_h3]:text-[10.5px] [&_h3]:font-[800] [&_h3]:tracking-[0.12em] [&_h3]:uppercase [&_dl]:grid [&_dl]:gap-[10px] [&_dl]:m-0 [&_dl>div]:grid [&_dl>div]:grid-cols-[132px_minmax(0,_1fr)] [&_dl>div]:gap-[10px] [&_dl>div]:items-baseline [&_dt]:text-[#8a94a6] [&_dt]:text-[10.5px] [&_dt]:font-[700] [&_dt]:tracking-[0.05em] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-[#e7ebf5] [&_dd]:text-[12px] [&_dd]:[overflow-wrap:anywhere] max-[681px]:later:[.profile-col+&]:m-[14px_0_0] max-[681px]:later:[.profile-col+&]:p-[14px_0_0] max-[681px]:later:[.profile-col+&]:border-l-0 max-[681px]:later:[.profile-col+&]:border-t max-[681px]:later:[.profile-col+&]:border-t-[#252b3b] max-[681px]:later-2:[&_dl>div]:grid-cols-[108px_minmax(0,_1fr)]">
            <h3>Information</h3>
            <dl>
              <div><dt>Name</dt><dd>{user?.full_name || '—'}</dd></div>
              <div><dt>Email (optional)</dt><dd>{user?.email || '—'}</dd></div>
              <div><dt>Contact (optional)</dt><dd>{user?.phone || '—'}</dd></div>
            </dl>
          </section>
          <section className="profile-col min-w-0 [.profile-col+&]:ml-[22px] [.profile-col+&]:pl-[22px] [.profile-col+&]:border-l [.profile-col+&]:border-l-[#252b3b] [&_h3]:m-[0_0_11px] [&_h3]:text-[#7f889b] [&_h3]:text-[10.5px] [&_h3]:font-[800] [&_h3]:tracking-[0.12em] [&_h3]:uppercase [&_dl]:grid [&_dl]:gap-[10px] [&_dl]:m-0 [&_dl>div]:grid [&_dl>div]:gap-[10px] [&_dl>div]:items-baseline [&_dt]:text-[#8a94a6] [&_dt]:text-[10.5px] [&_dt]:font-[700] [&_dt]:tracking-[0.05em] [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-[#e7ebf5] [&_dd]:text-[12px] [&_dd]:[overflow-wrap:anywhere] max-[681px]:later:[.profile-col+&]:m-[14px_0_0] max-[681px]:later:[.profile-col+&]:p-[14px_0_0] max-[681px]:later:[.profile-col+&]:border-l-0 max-[681px]:later:[.profile-col+&]:border-t max-[681px]:later:[.profile-col+&]:border-t-[#252b3b] later:[&_dl>div]:grid-cols-[96px_minmax(0,_1fr)] max-[681px]:later-2:[&_dl>div]:grid-cols-[108px_minmax(0,_1fr)]">
            <dl>
              <div><dt>Active</dt><dd>{presence.time_in ? formatDate(presence.time_in, true) : 'Not signed in today'}</dd></div>
              <div><dt>Last active</dt><dd>{presence.last_active ? formatDate(presence.last_active, true) : '—'}</dd></div>
              <div><dt>Date created</dt><dd>{formatDate(user?.created_at)}</dd></div>
            </dl>
          </section>
        </div>

        {(error || success) && (
          <div className="grid gap-2 p-[0_24px_14px] max-[681px]:later:p-[0_16px_12px]">
            <Notice type="error">{error}</Notice>
            <Notice type="success">{success}</Notice>
          </div>
        )}

        {panel === 'edit' && (
          <form className="m-[0_24px_22px] p-4 border border-[#232a3a] rounded-[12px] [background:#151b28] later:[&_h3]:m-[0_0_10px] later:[&_h3]:text-[#fff] later:[&_h3]:text-[12px] [&_h3]:font-[800] later:[&_h3]:tracking-[0.08em] [&_h3]:uppercase max-[681px]:later:m-[0_16px_16px] max-[681px]:later:p-[13px]" onSubmit={saveProfile}>
            <h3>Edit profile</h3>
            <div className="profile-form-grid grid gap-[10px] [&_input]:w-full [&_input]:min-h-[38px] [&_input]:p-[8px_11px] [&_input]:border [&_input]:border-[#2c3549] [&_input]:rounded-[9px] [&_input]:[background:#0d1421] [&_input]:text-[#e7ebf5] [&_input]:text-[12px] [&_input:focus]:[outline:none] [&_input:focus]:border-[#7468ed] [&_input:focus]:[box-shadow:0_0_0_3px_rgba(129,_117,_255,_0.12)]">
              <Field label="Name" required>
                <input required value={profile.full_name} onChange={(event) => setProfile({ ...profile, full_name: event.target.value })} />
              </Field>
              <Field label="Email">
                <input type="email" required value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} />
              </Field>
              <Field label="Contact" hint="11-digit mobile number.">
                <input
                  inputMode="numeric"
                  maxLength={11}
                  value={profile.phone}
                  onChange={(event) => setProfile({ ...profile, phone: event.target.value.replace(/\D/g, '').slice(0, 11) })}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 mt-[14px] [&_button]:min-h-[36px] later:[&_button]:p-[0_14px] later-3:[&_button]:border later-2:[&_button]:border-[#2c3549] later-3:[&_button]:rounded-[9px] later-2:[&_button]:[background:#111827] [&_button]:text-[#cbd3e3] later-2:[&_button]:text-[12px] later-3:[&_button]:font-[700] later:[&_button]:cursor-pointer [&_button:hover:not(:disabled)]:border-[#4b477d] [&_button:hover:not(:disabled)]:[background:#1a2133] [&_button:hover:not(:disabled)]:text-[#fff]">
              <button type="button" onClick={() => setPanel(null)}>Cancel</button>
              <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        )}

        {panel === 'security' && isAdmin && (
          <form className="m-[0_24px_22px] p-4 border border-[#232a3a] rounded-[12px] [background:#151b28] later:[&_h3]:m-[0_0_10px] later:[&_h3]:text-[#fff] later:[&_h3]:text-[12px] [&_h3]:font-[800] later:[&_h3]:tracking-[0.08em] [&_h3]:uppercase max-[681px]:later:m-[0_16px_16px] max-[681px]:later:p-[13px]" onSubmit={saveSecurity}>
            <h3>Account security</h3>
            <p className="m-[0_0_12px] text-[#8a94a6] text-[11px] leading-[1.5]">
              Your username is the email used on the login page. A new password is hashed and saved
              immediately, so the new credentials apply to the next sign-in.
            </p>
            <div className="profile-form-grid grid gap-[10px] [&_input]:w-full [&_input]:min-h-[38px] [&_input]:p-[8px_11px] [&_input]:border [&_input]:border-[#2c3549] [&_input]:rounded-[9px] [&_input]:[background:#0d1421] [&_input]:text-[#e7ebf5] [&_input]:text-[12px] [&_input:focus]:[outline:none] [&_input:focus]:border-[#7468ed] [&_input:focus]:[box-shadow:0_0_0_3px_rgba(129,_117,_255,_0.12)]">
              <Field label="Username" required>
                <input type="email" required value={security.email} onChange={(event) => setSecurity({ ...security, email: event.target.value })} />
              </Field>
              <Field label="Password" hint="Leave blank to keep the current password. 8–15 characters.">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={15}
                  value={security.password}
                  onChange={(event) => setSecurity({ ...security, password: event.target.value })}
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={15}
                  value={security.password_confirmation}
                  onChange={(event) => setSecurity({ ...security, password_confirmation: event.target.value })}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 mt-[14px] [&_button]:min-h-[36px] later:[&_button]:p-[0_14px] later-3:[&_button]:border later-2:[&_button]:border-[#2c3549] later-3:[&_button]:rounded-[9px] later-2:[&_button]:[background:#111827] [&_button]:text-[#cbd3e3] later-2:[&_button]:text-[12px] later-3:[&_button]:font-[700] later:[&_button]:cursor-pointer [&_button:hover:not(:disabled)]:border-[#4b477d] [&_button:hover:not(:disabled)]:[background:#1a2133] [&_button:hover:not(:disabled)]:text-[#fff]">
              <button type="button" onClick={() => setPanel(null)}>Cancel</button>
              <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>{saving ? 'Updating…' : 'Confirm'}</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
