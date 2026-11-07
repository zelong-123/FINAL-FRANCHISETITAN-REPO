import React, { useEffect, useRef, useState } from 'react';
import { FaCheck, FaRegCopy } from 'react-icons/fa6';

/**
 * Copy text to the clipboard. The async Clipboard API only exists on secure
 * origins (https / localhost); on the LAN over plain http the hidden-textarea
 * fallback is what works.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Applicant ID with the small "from LD-…" line naming the lead it came from. */
export function ApplicantIdCell({ code, leadCode, copyable = true }) {
  return (
    <>
      <RecordCode code={code} label="Applicant ID" copyable={copyable} />
      {leadCode && (
        <span className="record-code-sub block mt-[2px] text-[color:var(--muted,_#8f9ab2)] text-[10.5px] [&_.record-code-text]:text-[color:var(--text-secondary,_#c9d1e4)] later:[&_.record-code-text]:text-[10.5px]">from <RecordCode code={leadCode} label="Lead ID" copyable={copyable} /></span>
      )}
    </>
  );
}

/**
 * A permanent record ID (LD-YYYY-NNNNN / APL-YYYY-NNNNN) in a monospace chip
 * with a copy button. Clicking copy never opens the row it sits in.
 *
 * Props: code (string|null), label (aria prefix, e.g. "Lead ID"), size ("sm"|"md").
 */
export default function RecordCode({ code, label = 'ID', size = 'sm', className = '', copyable = true }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!code) return <span className={`record-code inline-flex items-center gap-1 max-w-full whitespace-nowrap [&.is-empty]:text-[color:var(--muted,_#8f9ab2)] is-empty ${className}`}>—</span>;
  // Inside another button (e.g. a folder card) a nested copy button is invalid HTML.
  if (!copyable) {
    return (
      <span className={`record-code inline-flex items-center gap-1 max-w-full whitespace-nowrap [&.is-empty]:text-[color:var(--muted,_#8f9ab2)] record-code--${size} ${className}`}>
        <span className="record-code-text text-[color:var(--accent-text,_#9db2ff)] later:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_Consolas,_'Liberation_Mono',_monospace] [font-variant-numeric:tabular-nums] text-[11.5px] tracking-[.01em] [.record-code--md_&]:text-[13px]">{code}</span>
      </span>
    );
  }

  const onCopy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (await copyText(code)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <span className={`record-code inline-flex items-center gap-1 max-w-full whitespace-nowrap [&.is-empty]:text-[color:var(--muted,_#8f9ab2)] record-code--${size} ${className}`}>
      <span className="record-code-text text-[color:var(--accent-text,_#9db2ff)] later:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_Consolas,_'Liberation_Mono',_monospace] [font-variant-numeric:tabular-nums] text-[11.5px] tracking-[.01em] [.record-code--md_&]:text-[13px]">{code}</span>
      <button
        type="button"
        className={`relative inline-grid place-items-center w-[20px] h-[20px] p-0 border border-transparent rounded-[5px] [background:transparent] text-[color:var(--muted,_#8f9ab2)] text-[10.5px] cursor-pointer opacity-[.7] [transition:opacity_.15s_ease,_color_.15s_ease,_background_.15s_ease] hover:opacity-[1] hover:text-[color:var(--text,_#f3f6ff)] hover:[background:var(--hover,_rgba(255,_255,_255,_.055))] focus-visible:opacity-[1] focus-visible:text-[color:var(--text,_#f3f6ff)] focus-visible:[background:var(--hover,_rgba(255,_255,_255,_.055))] focus-visible:[outline:2px_solid_var(--accent,_#6687ff)] focus-visible:[outline-offset:1px] [&.is-copied]:opacity-[1] later:[&.is-copied]:text-[color:var(--success-text,_#75e2bd)] [.record-code-sub_&]:w-[16px] [.record-code-sub_&]:h-[16px] [.record-code-sub_&]:text-[9px] [.data-panel_.table-wrap_table_td.record-id-col_&]:w-[18px] [.data-panel_.table-wrap_table_td.record-id-col_&]:h-[18px] ${copied ? ' is-copied' : ''}`}
        onClick={onCopy}
        onKeyDown={(event) => event.stopPropagation()}
        aria-label={copied ? `${label} copied` : `Copy ${label} ${code}`}
        title={copied ? 'Copied' : `Copy ${label}`}
      >
        {copied ? <FaCheck aria-hidden="true" /> : <FaRegCopy aria-hidden="true" />}
        {copied && <span className="absolute left-[50%] bottom-[calc(100%_+_4px)] [transform:translateX(-50%)] p-[2px_6px] rounded-[4px] [background:var(--panel-3,_#1a2235)] text-[color:var(--success-text,_#75e2bd)] text-[10px] whitespace-nowrap pointer-events-none" role="status">Copied</span>}
      </button>
    </span>
  );
}
