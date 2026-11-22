import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaChevronLeft, FaChevronRight, FaRegCalendarDays } from 'react-icons/fa6';

// Panel size and rough height (used to flip the popup up near the bottom of the window).
const PANEL_WIDTH = 252;
const PANEL_HEIGHT = 360;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (value) => String(value).padStart(2, '0');
const keyOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const parseKey = (key) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
};

const displayOf = (key) => {
  const date = parseKey(key);
  return date ? `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}` : '';
};

// Types mm/dd/yyyy (or m/d/yy) and returns a yyyy-mm-dd key, '' for empty, or null when unreadable.
const parseTyped = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(raw);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return keyOf(date);
};

// Buttons are reset with ! so the page's "all buttons" rules can't add grey fills/borders.
const RESET = 'min-h-0! h-auto! p-0! rounded-none! shadow-none! appearance-none! [background:transparent]! [font-family:inherit]!';

// Master Schedule "Custom" calendar nav: chevron in a bordered rounded square.
const NAV_BUTTON = `grid place-items-center w-[30px] h-[30px] p-0! min-h-0! rounded-none! appearance-none! [font-family:inherit]! border! border-[#2A3650]! [background:transparent]! text-[#C9D1E0]! shadow-none! [transition:background_.15s_ease,_border-color_.15s_ease,_color_.15s_ease] hover:text-[#fff]! hover:border-[#5B7FC4]! hover:[background:#2B3F6B]! light:border-line! light:text-muted! light:hover:text-text! light:hover:[background:var(--hover)]!`;

const ICON_BUTTON = `absolute right-[5px] top-1/2 -translate-y-1/2 grid place-items-center w-[26px] h-[26px] p-0! min-h-0! appearance-none! border-0! rounded-none! [background:transparent]! text-[#8591A8]! shadow-none! [transition:color_.15s_ease] hover:text-[#eef2fb]! light:text-muted! light:hover:text-text!`;

const DAY_CELL = 'w-full h-[40px] p-0! min-h-0! rounded-none! appearance-none! [font-family:inherit]! [background:transparent]! [border-top:0]! [border-left:0]! [border-right:0]! [border-bottom:1px_solid_#17203A]! text-[15px]! font-[700]! tabular-nums [transition:box-shadow_.15s_ease,_color_.15s_ease] light:[background:transparent]! light:[border-bottom-color:var(--border)]!';

/**
 * Date field with a themed calendar popup (#0B0F19) because the native
 * input[type=date] picker panel cannot be styled by CSS.
 */
export default function DatePickerField({
  value = '',
  onChange,
  ariaLabel,
  placeholder = 'mm/dd/yyyy',
  min = '',
  max = '',
  className = '',
  inputClassName = '',
  required = false,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => displayOf(value));
  const [viewDate, setViewDate] = useState(() => parseKey(value) || new Date());
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const popupRef = useRef(null);
  const [anchor, setAnchor] = useState(null);

  /** The popup lives in a portal, so it is placed against the input's screen position. */
  const placePopup = () => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - PANEL_WIDTH - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < PANEL_HEIGHT && rect.top > spaceBelow;
    setAnchor(above
      ? { left, bottom: window.innerHeight - rect.top + 6 }
      : { left, top: rect.bottom + 6 });
  };

  // Closed state always mirrors the real value, so a change the parent rejects (e.g. a weekend) never sticks in the text.
  useEffect(() => {
    if (!open) setDraft(displayOf(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return undefined;
    setViewDate(parseKey(value) || new Date());
    placePopup();
    const onPointerDown = (event) => {
      if (rootRef.current?.contains(event.target) || popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const reposition = () => placePopup();
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      inputRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, value]);

  const commitDraft = () => {
    const next = parseTyped(draft);
    if (next === null || (next && ((min && next < min) || (max && next > max)))) {
      setDraft(displayOf(value));
      return;
    }
    setDraft(displayOf(next));
    if (next !== value) onChange?.(next);
  };

  const pick = (key) => {
    setDraft(displayOf(key));
    if (key !== value) onChange?.(key);
    setOpen(false);
  };

  const shiftMonth = (delta) => {
    setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  const cells = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const offset = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const total = Math.ceil((offset + daysInMonth) / 7) * 7;
    const start = new Date(year, month, 1 - offset);
    return Array.from({ length: total }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  }, [viewDate]);

  const today = keyOf(new Date());
  const viewMonth = viewDate.getMonth();

  return (
    <div ref={rootRef} className={`relative inline-flex items-center ${className}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        required={required}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        placeholder={placeholder}
        className={`min-w-[175px] pr-[34px]! [color-scheme:dark] placeholder:text-placeholder ${inputClassName}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitDraft();
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        aria-label={ariaLabel ? `Open calendar for ${ariaLabel}` : 'Open calendar'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={ICON_BUTTON}
      >
        <FaRegCalendarDays aria-hidden="true" className="text-[12px]" />
      </button>

      {open && anchor && createPortal(
        <div
          ref={popupRef}
          role="dialog"
          aria-label="Choose date"
          style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom }}
          className="fixed z-[1200] w-[252px] max-w-[calc(100vw_-_16px)] p-[10px] border border-[#1B2437] rounded-none [background:#070A13] [box-shadow:0_18px_44px_rgba(3,7,18,.55)] light:border-line light:[background:var(--panel)] light:[box-shadow:var(--shadow-md)]"
        >
          <div className="flex items-center justify-between gap-2 mb-[8px]">
            <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)} className={NAV_BUTTON}>
              <FaChevronLeft aria-hidden="true" className="text-[12px]" />
            </button>
            <strong className="text-[13px]! font-[750]! tracking-[-.01em] text-[#F1F4FB]! light:text-text!">
              {MONTHS[viewMonth]} {viewDate.getFullYear()}
            </strong>
            <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)} className={NAV_BUTTON}>
              <FaChevronRight aria-hidden="true" className="text-[12px]" />
            </button>
          </div>

          <div className="grid grid-cols-7 [background:#131C2C] light:[background:var(--surface-subtle)]">
            {WEEKDAYS.map((label) => (
              <span key={label} className="grid place-items-center h-[26px] text-[9.5px] font-[800] tracking-[.04em] text-[#8B96AC] light:text-muted">
                {label.toUpperCase()}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {cells.map((date) => {
              const key = keyOf(date);
              const selected = key === value;
              const outside = date.getMonth() !== viewMonth;
              // Neighbouring months are blank, like the Master Schedule calendar (arrows change month).
              if (outside) return <span key={key} aria-hidden="true" className="h-[40px] [border-bottom:1px_solid_#17203A] light:[border-bottom-color:var(--border)]" />;
              const blocked = Boolean((min && key < min) || (max && key > max));
              // Selection/hover are painted with an inset shadow so the flat cell keeps no fill or border radius.
              const tone = selected
                ? '[box-shadow:inset_0_0_0_999px_rgba(91,_124,_250,.18)]! text-[#fff]! light:[box-shadow:inset_0_0_0_999px_color-mix(in_srgb,_var(--accent)_16%,_transparent)]! light:text-text!'
                : `text-[#F1F4FB]! light:text-text! hover:[box-shadow:inset_0_0_0_999px_rgba(255,_255,_255,.05)]! light:hover:[box-shadow:inset_0_0_0_999px_var(--hover)]! ${key === today ? 'text-[#9DB2FF]! light:text-accent-text!' : ''}`;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={blocked}
                  aria-pressed={selected}
                  aria-current={key === today ? 'date' : undefined}
                  onClick={() => pick(key)}
                  className={`${DAY_CELL} ${tone} ${blocked ? 'opacity-[.3] cursor-not-allowed' : ''}`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 pt-[8px]">
            <button
              type="button"
              onClick={() => {
                setDraft('');
                if (value) onChange?.('');
                setOpen(false);
              }}
              className={`${RESET} justify-self-start border-0! text-[11.5px]! font-[650]! text-[#7D89A0]! hover:text-[#eef2fb]! light:text-muted! light:hover:text-text!`}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => pick(today)}
              disabled={Boolean((min && today < min) || (max && today > max))}
              className={`${RESET} justify-self-center border-0! text-[12px]! font-[700]! text-[#8FA8FF]! hover:text-[#B4C6FF]! light:text-accent-text! disabled:opacity-[.4]`}
            >
              Today
            </button>
            <span aria-hidden="true" />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
