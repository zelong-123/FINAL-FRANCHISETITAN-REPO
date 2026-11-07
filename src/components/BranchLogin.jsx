import React, { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { FaCircleExclamation, FaEnvelope, FaLock } from 'react-icons/fa6';
import { firstValidationMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { AppLoader } from './ApiUi';
import AuthSuccessOverlay, { ButtonSpinner } from './AuthSuccessOverlay';
import AppIconImg from '../assets/icon.png.png';

const glow = 'pointer-events-none absolute -z-10 aspect-square w-[min(37vw,460px)] rounded-full opacity-14 blur-[105px]';
const inputWrap = 'flex min-h-12 items-center gap-[11px] rounded-xl border border-white/10 bg-[rgba(5,9,17,.78)] px-[13px] text-[#7f8aa0] transition-[border-color,box-shadow,background,color] duration-[180ms] focus-within:border-[rgba(135,151,255,.74)] focus-within:bg-[rgba(10,14,25,.96)] focus-within:text-[#adb8ff] focus-within:shadow-[0_0_0_3px_rgba(135,151,255,.13)] [&>svg]:w-3.5 [&>svg]:shrink-0';
const input = 'min-h-[46px] w-full min-w-0 border-0 bg-transparent p-0 text-xs text-[#f3f5fb] outline-none placeholder:text-[#687287] placeholder:opacity-100 focus:shadow-none focus-visible:outline-none';
const field = 'grid gap-2 text-[10px] font-[650] text-[#d2d8e5]';
const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[rgba(155,170,255,.85)]';

export default function BranchLogin() {
  const { loginForPortal, isAuthenticated, role, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!success) return undefined;
    const timer = window.setTimeout(() => navigate('/branch-portal', { replace: true }), 350);
    return () => window.clearTimeout(timer);
  }, [success, navigate]);

  if (loading) return <AppLoader label="Restoring branch session…" />;
  if (isAuthenticated && role === 'franchisee' && !success) {
    return <Navigate to="/branch-portal" replace />;
  }

  const handleLogin = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await loginForPortal('branch', email.trim(), password, keepSignedIn);
      setSuccess(true);
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative isolate grid min-h-screen place-items-center overflow-hidden bg-[#080b12] px-5 py-8 text-[#f3f5fb] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(rgba(255,255,255,.16)_.65px,transparent_.65px)] before:opacity-25 before:content-[''] before:[background-size:24px_24px] before:[mask-image:radial-gradient(ellipse_at_center,#000,transparent_72%)] max-[520px]:px-[15px] max-[520px]:py-5">
      <div className={`${glow} top-[-22%] left-[-11%] bg-[#ff7a00]`} aria-hidden="true" />
      <div className={`${glow} top-[11%] right-[-18%] bg-[#70b22c]`} aria-hidden="true" />
      <div className={`${glow} right-[2%] bottom-[-35%] bg-[#0088ff]`} aria-hidden="true" />
      <div className={`${glow} bottom-[-28%] left-[-16%] bg-[#d32f2f]`} aria-hidden="true" />

      <section className="w-[min(100%,448px)] animate-card-rise rounded-[22px] border border-white/8 bg-[rgba(15,19,29,.88)] p-[clamp(28px,6vw,44px)] shadow-[0_32px_100px_rgba(0,0,0,.48),0_0_80px_rgba(115,132,255,.055)] backdrop-blur-[24px] motion-reduce:animate-none max-[520px]:rounded-[19px] max-[520px]:px-[23px] max-[520px]:py-7" aria-labelledby="branch-login-title">
        <header className="flex flex-col items-start">
          <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] border border-white/8 bg-white/[.035] max-[520px]:mb-[22px]"><img className="size-[31px] object-contain" src={AppIconImg} alt="" /></span>
          <span className="inline-flex items-center gap-[7px] text-[9px] leading-normal font-[760] tracking-[.13em] text-[#c0c8d8] uppercase">Branch Portal <span className="text-[#8797ff]" aria-hidden="true">·</span> Private Workspace</span>
          <h1 id="branch-login-title" className="mt-3.5 mb-0 text-[clamp(25px,5vw,31px)] leading-[1.16] font-bold tracking-[-.045em] text-[#f3f5fb] max-[520px]:text-[27px]">Welcome to your Branch</h1>
          <p className="mt-[9px] mb-0 text-xs leading-[1.55] text-[#929bad]">Sign in to securely manage your assigned branch.</p>
        </header>

        {error && (
          <div className="mt-[22px] flex items-start gap-2.5 rounded-xl border border-[rgba(245,109,125,.24)] bg-[rgba(245,109,125,.07)] px-[13px] py-3 text-[11px] leading-normal text-[#ffacb5] [&>svg]:mt-0.5 [&>svg]:shrink-0" role="alert">
            <FaCircleExclamation aria-hidden="true" /><span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="mt-[30px] grid gap-[17px] max-[520px]:mt-[25px]">
          <label className={field} htmlFor="branch-email">
            <span>Branch account email</span>
            <span className={inputWrap}>
              <FaEnvelope aria-hidden="true" />
              <input id="branch-email" className={input} type="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
            </span>
          </label>
          <label className={field} htmlFor="branch-password">
            <span>Password</span>
            <span className={inputWrap}>
              <FaLock aria-hidden="true" />
              <input id="branch-password" className={input} type="password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </span>
          </label>
          <label className="-mt-px flex cursor-pointer items-center gap-[9px] text-[10px] leading-[1.4] text-[#929bad]">
            <input className={`m-0 size-[15px] shrink-0 accent-[#8797ff] ${focusRing}`} type="checkbox" checked={keepSignedIn} onChange={(event) => setKeepSignedIn(event.target.checked)} />
            <span>Keep me signed in on this trusted device</span>
          </label>
          <button type="submit" disabled={submitting} className={`group relative mt-0.5 flex min-h-[49px] items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-white/13 bg-[linear-gradient(120deg,#6478e9,#8071e8)] px-[18px] text-[11px] font-[760] text-white shadow-[0_10px_26px_rgba(100,120,233,.2)] transition-[translate,box-shadow,filter] duration-[180ms] not-disabled:hover:-translate-y-0.5 not-disabled:hover:shadow-[0_14px_31px_rgba(100,120,233,.3)] not-disabled:hover:brightness-108 not-disabled:active:translate-y-0 disabled:cursor-wait disabled:opacity-70 ${focusRing}`}>
            <span>{submitting ? 'Signing in…' : 'Sign in to Branch Workspace'}</span>
            {submitting
              ? <ButtonSpinner className="size-[15px]" />
              : <span className="text-[19px] leading-none font-[450] transition-transform duration-[180ms] group-hover:not-group-disabled:translate-x-[3px]" aria-hidden="true">→</span>}
          </button>
        </form>

        <footer className="mt-[22px] border-t border-white/7 pt-[17px] text-center">
          <Link className={`text-[10px] text-[#a6b0c3] transition-colors duration-[160ms] hover:text-[#e6eaff] ${focusRing}`} to="/">Looking for Franchisor Admin Sign in?</Link>
        </footer>
      </section>

      {success && (
        <AuthSuccessOverlay title="Branch account ready">
          <p className="mt-3 mb-0 text-[10px] font-[650] text-muted">Opening your branch workspace</p>
        </AuthSuccessOverlay>
      )}
    </main>
  );
}
