import React, { useEffect, useState } from 'react';
import { API_BASE_URL } from '../lib/api';
import { compareApi, dismissNote, noteDismissed } from '../lib/apiVersion';

// Embedded at build time by vite.config.js (git tree hash of supabase/functions/api).
// eslint-disable-next-line no-undef
const APP_API_TREE = typeof __APP_API_TREE__ === 'string' ? __APP_API_TREE__ : null;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const storage = (() => { try { return window.localStorage; } catch { return null; } })();

/**
 * Admin only. A strong warning when the live API code differs from the API code this app was built
 * for; a soft, dismissible note (remembered per browser) when the live API carries no deploy stamp.
 */
export default function ApiVersionBanner({ role }) {
  const [result, setResult] = useState({ state: 'unchecked', severity: null, message: null });
  const [dismissed, setDismissed] = useState(() => noteDismissed(storage));
  useEffect(() => {
    if (role !== 'admin' || !APP_API_TREE) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`, { cache: 'no-store' });
        const health = await response.json();
        if (!cancelled) setResult(compareApi(APP_API_TREE, health));
      } catch {
        // Unreachable health: the normal error handling covers it; no banner.
      }
    };
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [role]);
  if (role !== 'admin' || !result.message) return null;
  if (result.severity === 'note') {
    if (dismissed) return null;
    return (
      <div role="status" className="m-[10px_16px_0] p-[7px_10px_7px_12px] flex items-center gap-[10px] rounded-[9px] border border-[color:var(--border)] [background:var(--surface-subtle)] text-muted text-[12px]">
        <span className="flex-1">{result.message}</span>
        <button type="button" aria-label="Dismiss this note" title="Dismiss (remembered in this browser)"
          className="border-0 bg-transparent text-muted cursor-pointer text-[15px] leading-none p-[2px_4px] hover:text-text"
          onClick={() => { dismissNote(storage); setDismissed(true); }}>×</button>
      </div>
    );
  }
  return (
    <div role="alert" className="m-[12px_16px_0] p-[10px_14px] rounded-[10px] border border-[color:var(--warning)] [background:color-mix(in_srgb,_var(--warning)_12%,_var(--panel))] text-[color:var(--warning-text)] text-[13px] font-[650]">
      ⚠ {result.message}
    </div>
  );
}
