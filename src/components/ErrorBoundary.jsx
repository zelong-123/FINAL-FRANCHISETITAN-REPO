import React from 'react';
import { FaArrowRotateRight, FaTriangleExclamation } from 'react-icons/fa6';
import AppIconImg from '../assets/icon.png.png';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Herald UI error:', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="min-h-[100vh] grid place-items-center p-6 [background:var(--bg)]">
        <section className="relative w-[min(520px,_100%)] p-10 border border-line-strong rounded-[24px] [background:var(--panel)] [box-shadow:var(--shadow-xl)] text-center [&>img]:w-[58px] [&>img]:h-[58px] [&>img]:object-contain [&>img]:mb-4 [&_h1]:m-0 [&_h1]:text-[25px] [&_h1]:tracking-[-.04em] [&_p:not(.page-eyebrow)]:m-[13px_auto_22px] [&_p:not(.page-eyebrow)]:text-muted [&_p:not(.page-eyebrow)]:text-[10px] [&_p:not(.page-eyebrow)]:leading-[1.65]" role="alert">
          <img src={AppIconImg} alt="" />
          <span className="absolute top-[24px] right-[24px] text-danger-text"><FaTriangleExclamation /></span>
          <p className="page-eyebrow block mb-2 text-accent-text text-[8px] font-[850] tracking-[.15em] uppercase [.insight-copy_&]:mb-2 [.inquiries-page_&]:hidden!">Protected recovery</p>
          <h1>Herald could not display this screen.</h1>
          <p>Your session and data are safe. Reload the workspace to recover from the interface error.</p>
          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => window.location.reload()}>
            <FaArrowRotateRight /> Reload workspace
          </button>
        </section>
      </main>
    );
  }
}
