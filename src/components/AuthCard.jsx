import React from 'react';
import AppIconImg from '../assets/icon.png.png';

// Shared styles, copied from Log.jsx so the new pages match the login page.
export const fieldLabel = 'text-[11px] font-[750] tracking-[.02em] text-text-secondary';
export const textInput = 'min-h-[46px] w-full rounded-xl border border-input-line bg-input-bg px-4 text-text outline-none transition-[border-color,box-shadow,background] duration-200 placeholder:text-placeholder hover:border-line-strong focus:border-accent focus:bg-input-focus focus:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_13%,transparent)]';
export const primaryButton = 'relative mt-[5px] flex min-h-[46px] w-full items-center justify-center gap-[11px] overflow-hidden rounded-xl border-0 bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] px-[18px] text-[13px] font-extrabold tracking-[.01em] text-white shadow-[0_14px_30px_color-mix(in_srgb,var(--accent)_25%,transparent)] transition-[translate,box-shadow,filter] duration-200 not-disabled:hover:-translate-y-0.5 not-disabled:hover:saturate-[1.08] disabled:cursor-wait disabled:opacity-65 disabled:shadow-none';
export const errorBox = 'mb-4 flex items-start gap-2.5 rounded-[13px] border border-danger/30 bg-danger/8 px-3.5 py-3 text-xs leading-normal text-danger-text';

export default function AuthCard({ title, subtitle, children }) {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-12 [background:radial-gradient(circle_at_12%_18%,color-mix(in_srgb,var(--accent)_22%,transparent),transparent_28%),radial-gradient(circle_at_88%_82%,color-mix(in_srgb,var(--accent-2)_18%,transparent),transparent_30%),var(--bg)]">
      <section className="relative z-2 w-[min(440px,100%)] rounded-[22px] border border-line-strong bg-panel/92 p-[clamp(24px,5vw,40px)] shadow-xl">
        <div className="mb-6 flex items-center gap-[11px] text-[13px] font-extrabold tracking-[.2em] text-text">
          <img className="size-[34px] object-contain" src={AppIconImg} alt="" />
          <span>FRANCHISE TITAN</span>
        </div>
        <h1 className="m-0 text-[28px] leading-[1.1] tracking-[-.04em] text-text">{title}</h1>
        {subtitle && <p className="mt-2.5 mb-0 text-[13.5px] leading-[1.65] text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </section>
    </main>
  );
}