import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  FaArrowRight,
  FaChartLine,
  FaCircleExclamation,
  FaEye,
  FaEyeSlash,
  FaGlobe,
  FaMoon,
  FaShieldHalved,
  FaSun,
} from 'react-icons/fa6';
import FranchiseImg from '../assets/Logo.jpg.png';
import AppIconImg from '../assets/icon.png.png';
import { api, firstValidationMessage } from '../lib/api';
import { ROLE_HOME, roleName, useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { AppLoader } from './ApiUi';
import AuthSuccessOverlay, { ButtonSpinner } from './AuthSuccessOverlay';

const highlights = [
  [FaGlobe, 'Multi-role operations', 'One secure workspace across the franchise lifecycle.'],
  [FaChartLine, 'Live intelligence', 'Connected performance, inventory, and pipeline visibility.'],
  [FaShieldHalved, 'Role-based security', 'Protected access aligned with operational responsibility.'],
];

const STATUS_DOT = {
  online: 'bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_13%,transparent)]',
  offline: 'bg-danger shadow-[0_0_0_4px_color-mix(in_srgb,var(--danger)_13%,transparent)]',
  checking: 'bg-warning shadow-[0_0_0_4px_color-mix(in_srgb,var(--warning)_13%,transparent)]',
};
const STATUS_LABEL = { online: 'Systems operational', offline: 'Server unavailable', checking: 'Checking connection' };

const ambient = 'pointer-events-none absolute size-[420px] animate-ambient rounded-full opacity-20 blur-[90px]';
const fieldLabel = 'text-[11px] font-[750] tracking-[.02em] text-text-secondary';
const textInput = 'min-h-[46px] w-full rounded-xl border border-input-line bg-input-bg px-4 text-text outline-none transition-[border-color,box-shadow,background] duration-200 placeholder:text-placeholder hover:border-line-strong focus:border-accent focus:bg-input-focus focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_13%,transparent)] short-laptop:min-h-[42px]';

export default function Log() {
  const { loginForPortal, isAuthenticated, role, loading } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  // A session signed out for being on the wrong portal arrives with a short notice.
  const [error, setError] = useState(() => location.state?.portalNotice || '');
  const [showPassword, setShowPassword] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [loggedUser, setLoggedUser] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverStatus, setServerStatus] = useState('checking');

  useEffect(() => {
    let active = true;
    api.get('/health', undefined, { skipAuth: true, timeout: 8000 })
      .then(() => { if (active) setServerStatus('online'); })
      .catch(() => { if (active) setServerStatus('offline'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (showSuccess && loggedUser) {
      const timer = window.setTimeout(() => {
        navigate(ROLE_HOME[roleName(loggedUser)] || '/', { replace: true });
      }, 1050);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [showSuccess, loggedUser, navigate]);

  if (loading) return <AppLoader label="Restoring your secure session…" />;
  if (isAuthenticated && !showSuccess) return <Navigate to={role === 'franchisee' ? '/branch-portal' : ROLE_HOME[role] || '/'} replace />;

  const handleLogin = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const user = await loginForPortal('staff', email.trim(), password, keepSignedIn);
      setLoggedUser(user);
      setShowSuccess(true);
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-8 pt-[clamp(68px,9vh,84px)] pb-[clamp(44px,6vh,56px)] [background:radial-gradient(circle_at_12%_18%,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_28%),radial-gradient(circle_at_88%_82%,color-mix(in_srgb,var(--accent-2)_18%,transparent),transparent_30%),var(--bg)] before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(var(--grid-line)_1px,transparent_1px),linear-gradient(90deg,var(--grid-line)_1px,transparent_1px)] before:opacity-38 before:content-[''] before:[background-size:44px_44px] before:[mask-image:linear-gradient(to_bottom,black,transparent_85%)] short-laptop:pt-16 short-laptop:pb-11 max-[940px]:pt-[86px] max-[620px]:block max-[620px]:px-3.5 max-[620px]:pt-[76px] max-[620px]:pb-16">
      <div className={`${ambient} top-[14%] left-[-210px] bg-accent`} />
      <div className={`${ambient} right-[-220px] bottom-[6%] bg-accent-2 [animation-delay:-5s]`} />

      <header className="absolute inset-x-0 top-0 z-3 flex h-[72px] items-center justify-between px-[clamp(22px,5vw,72px)] max-[620px]:h-[62px] max-[620px]:px-4">
        <div className="flex items-center gap-[11px] text-[13px] font-extrabold tracking-[.2em] text-text">
          <img className="size-[34px] object-contain drop-shadow-[0_8px_18px_color-mix(in_srgb,var(--accent)_30%,transparent)]" src={AppIconImg} alt="" />
          <span>FRANCHISE TITAN</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex min-h-[34px] items-center gap-2 rounded-full border border-line bg-panel/78 px-3 text-[11px] font-[650] text-muted backdrop-blur-md max-[620px]:w-[34px] max-[620px]:justify-center max-[620px]:p-0 max-[620px]:text-[0]">
            <span className={`size-[7px] rounded-full max-[620px]:size-2 ${STATUS_DOT[serverStatus]}`} />{STATUS_LABEL[serverStatus]}
          </span>
          <button
            type="button"
            className="grid size-[38px] place-items-center rounded-xl border border-line bg-panel/78 text-text backdrop-blur-md transition-[translate,rotate,background,border-color] duration-200 hover:-translate-y-0.5 hover:rotate-[5deg] hover:border-line-strong hover:bg-panel"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <FaSun /> : <FaMoon />}
          </button>
        </div>
      </header>

      <section className="relative z-2 grid min-h-[clamp(560px,76vh,660px)] w-[min(1040px,100%)] animate-card-in grid-cols-[minmax(360px,.88fr)_minmax(400px,1.12fr)] overflow-hidden rounded-[26px] border border-line-strong bg-panel/92 shadow-xl short-laptop:min-h-[540px] max-[940px]:min-h-0 max-[940px]:w-[min(640px,100%)] max-[940px]:grid-cols-1 max-[620px]:rounded-[22px]" aria-label="Herald sign in">
        <div className="relative z-1 flex flex-col justify-center bg-[linear-gradient(145deg,color-mix(in_srgb,var(--panel)_98%,transparent),color-mix(in_srgb,var(--panel-2)_92%,transparent))] px-[clamp(28px,4.5vw,56px)] py-[clamp(26px,4.5vh,48px)] text-text after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[linear-gradient(to_bottom,transparent,var(--border-strong),transparent)] after:content-[''] max-[940px]:after:hidden max-[620px]:px-[22px] max-[620px]:pt-9 max-[620px]:pb-7">
          <div className="mb-[clamp(16px,2.6vh,22px)]">
            <span className="mb-3 inline-flex items-center gap-2 text-[10px] font-extrabold tracking-[.13em] text-accent-text uppercase">
              <span className="size-[7px] rounded-full bg-accent shadow-[0_0_0_5px_color-mix(in_srgb,var(--accent)_13%,transparent)]" /> Enterprise operations platform
            </span>
            <h1 className="m-0 text-[clamp(32px,3.6vw,44px)] leading-[1.04] tracking-[-.05em] text-text short-laptop:text-[clamp(30px,3.2vw,38px)] max-[620px]:text-[37px]">Welcome back.</h1>
            <p className="mt-2.5 mb-0 max-w-[440px] text-[13.5px] leading-[1.65] text-muted short-laptop:text-[13px] short-laptop:leading-[1.55]">Sign in to your secure Herald workspace and continue managing the franchise network.</p>
          </div>

          {error && (
            <div className="mb-4 flex animate-shake-in items-start gap-2.5 rounded-[13px] border border-danger/30 bg-danger/8 px-3.5 py-3 text-xs leading-normal text-danger-text [&>svg]:mt-0.5 [&>svg]:shrink-0" role="alert">
              <FaCircleExclamation /><span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="flex flex-col gap-2">
            <label className={fieldLabel} htmlFor="email">Work email</label>
            <input
              id="email"
              className={textInput}
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              spellCheck="false"
              required
            />

            <div className="mt-[5px] flex items-center justify-between">
              <label className={fieldLabel} htmlFor="password">Password</label>
              <Link to="/forgot-password" className="text-[11px] font-[650] text-accent-text hover:underline">Forgot password?</Link>
            </div>
            <div className="relative">
              <input
                id="password"
                className={`${textInput} pr-[52px] [&::-ms-clear]:hidden [&::-ms-reveal]:hidden [&::-webkit-credentials-auto-fill-button]:hidden [&::-webkit-strong-password-auto-fill-button]:hidden`}
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
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

            <label className="mt-1.5 mb-1 flex cursor-pointer items-center gap-2.5 text-[11px] text-muted">
              <input className="size-[17px] accent-accent" type="checkbox" checked={keepSignedIn} onChange={(event) => setKeepSignedIn(event.target.checked)} />
              <span>Keep me signed in on this trusted device</span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="group relative mt-[5px] flex min-h-[46px] items-center justify-center gap-[11px] overflow-hidden rounded-xl border-0 bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] px-[18px] text-[13px] font-extrabold tracking-[.01em] text-white shadow-[0_14px_30px_color-mix(in_srgb,var(--accent)_25%,transparent)] transition-[translate,box-shadow,filter] duration-200 before:absolute before:inset-0 before:-translate-x-[120%] before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent)] before:transition-transform before:duration-[600ms] before:content-[''] not-disabled:hover:-translate-y-0.5 not-disabled:hover:shadow-[0_18px_38px_color-mix(in_srgb,var(--accent)_32%,transparent)] not-disabled:hover:saturate-[1.08] not-disabled:hover:before:translate-x-[120%] not-disabled:active:translate-y-0 disabled:cursor-wait disabled:opacity-65 disabled:shadow-none short-laptop:min-h-[42px]"
            >
              <span>{submitting ? 'Authenticating…' : 'Sign in to Herald'}</span>
              {submitting ? <ButtonSpinner /> : <FaArrowRight />}
            </button>
          </form>

          {import.meta.env.DEV && <p className="mt-3 mb-0 text-[10px] leading-normal text-accent-text">Development seed: admin@franchisetitan.local / Password123!</p>}
          <p className="mt-4 mb-0 border-t border-line pt-3.5 text-[9px] leading-[1.6] text-muted">Authorized staff only. Activity may be logged for security and audit purposes.</p>
        </div>

        <div className="relative min-w-0 overflow-hidden bg-cover bg-center after:absolute after:inset-0 after:bg-[linear-gradient(110deg,color-mix(in_srgb,#07101f_78%,transparent)_0%,rgba(5,12,28,.42)_58%,rgba(5,12,28,.18)_100%)] after:content-[''] max-[940px]:min-h-[390px] max-[620px]:min-h-[360px] max-[450px]:hidden" style={{ backgroundImage: `url(${FranchiseImg})` }}>
          <div className="absolute inset-0 z-1 [background:radial-gradient(circle_at_78%_18%,rgba(119,149,255,.32),transparent_28%),linear-gradient(to_top,rgba(3,8,20,.78),transparent_52%)]" />
          <div className="pointer-events-none absolute inset-0 z-2 text-white [&>*]:pointer-events-auto">
            <span className="absolute top-[clamp(24px,3vw,36px)] left-[clamp(28px,4vw,48px)] inline-flex rounded-full border border-white/18 bg-[rgba(8,15,35,.35)] px-2.5 py-[7px] text-[9px] font-extrabold tracking-[.16em] text-white/80 uppercase backdrop-blur-[10px] max-[620px]:top-5 max-[620px]:left-6">Built for scale</span>
            <div className="absolute inset-x-[clamp(28px,4vw,52px)] bottom-[clamp(28px,4.5vh,52px)] grid gap-2 max-[620px]:inset-x-6 max-[620px]:bottom-7">
              {highlights.map(([Icon, title, copy]) => (
                <div className="flex items-center gap-[13px] rounded-[14px] border border-white/11 bg-[rgba(5,12,28,.38)] px-3 py-[9px] backdrop-blur-md transition-[translate,background] duration-[250ms] hover:translate-x-[5px] hover:bg-[rgba(5,12,28,.55)]" key={title}>
                  <span className="grid size-[34px] shrink-0 place-items-center rounded-xl bg-[rgba(115,145,255,.18)] text-[#dfe8ff]"><Icon /></span>
                  <div className="flex flex-col gap-[3px]">
                    <strong className="text-[11px]">{title}</strong>
                    <small className="text-[9px] leading-[1.4] text-[rgba(232,239,255,.6)] short-laptop:hidden">{copy}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <footer className="absolute inset-x-[clamp(22px,5vw,72px)] bottom-[22px] z-2 flex items-center justify-between text-[9px] tracking-[.04em] text-muted max-[620px]:relative max-[620px]:inset-auto max-[620px]:mt-5 max-[620px]:flex-wrap max-[620px]:gap-2.5 max-[620px]:px-1">
        <span>© {new Date().getFullYear()} Herald Operations</span><span>Secure · Connected · Auditable</span>
      </footer>

      {showSuccess && (
        <AuthSuccessOverlay
          title="Login successful"
          icon={(
            <div className="relative mb-[21px] grid size-[92px] place-items-center rounded-[26px] border border-accent/38 bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel))] shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_18px_35px_color-mix(in_srgb,var(--accent)_18%,transparent)] after:absolute after:-inset-2 after:animate-spin-back after:rounded-[32px] after:border after:border-dashed after:border-accent/45 after:content-['']">
              <img src={AppIconImg} alt="Herald" className="size-[66px] animate-icon-pulse object-contain" />
            </div>
          )}
        >
          <p className="mt-[11px] mb-[22px] text-[13px] leading-[1.6] text-muted">
            Welcome, <span className="font-extrabold text-accent-text capitalize">{roleName(loggedUser)}</span>{' '}
            <strong className="mt-[3px] block text-text">{loggedUser?.full_name}</strong>
          </p>
          <div className="flex items-center gap-[9px] rounded-full border border-line bg-surface-subtle px-3.5 py-2">
            <span className="size-[7px] animate-dot-pulse rounded-full bg-accent" />
            <p className="m-0 text-[10px] font-[650] text-muted">Preparing your connected workspace</p>
          </div>
          <div className="mt-[26px] h-[3px] w-full overflow-hidden rounded-full bg-surface-strong">
            <span className="block size-full origin-left animate-login-progress bg-[linear-gradient(90deg,var(--accent),var(--success))]" />
          </div>
        </AuthSuccessOverlay>
      )}
    </main>
  );
}