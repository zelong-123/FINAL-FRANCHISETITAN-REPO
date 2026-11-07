import React from 'react';

export function ButtonSpinner({ className = 'size-4' }) {
  return <span className={`animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`} aria-hidden="true" />;
}

/** The blurred "signed in" moment shown by both login screens before they navigate away. */
export default function AuthSuccessOverlay({ title, icon, children }) {
  return (
    <div className="fixed inset-0 z-[9999] grid animate-overlay-in place-items-center bg-bg/58 p-[22px] backdrop-blur-[22px] backdrop-saturate-150">
      <div className="relative flex w-[min(440px,100%)] animate-modal-pop flex-col items-center overflow-hidden rounded-[26px] border border-line-strong bg-panel/90 px-[38px] pt-10 pb-[34px] text-center text-text shadow-xl before:pointer-events-none before:absolute before:inset-x-0 before:-top-1/2 before:h-[180px] before:bg-[radial-gradient(circle,color-mix(in_srgb,var(--success)_24%,transparent),transparent_70%)] before:content-['']">
        {icon}
        <span className="mb-2 text-[9px] font-[850] tracking-[.15em] text-success-text uppercase">Authentication verified</span>
        <h3 className="m-0 text-[25px] tracking-[-.03em]">{title}</h3>
        {children}
      </div>
    </div>
  );
}
