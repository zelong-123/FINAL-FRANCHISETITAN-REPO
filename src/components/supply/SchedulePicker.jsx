import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaChevronLeft, FaChevronRight, FaRegCalendarDays } from 'react-icons/fa6';
import { INPUT } from './supplyStyles';

const pad2 = (value) => String(value).padStart(2, '0');
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ROW_H = 26;
// Only one calendar can be open at a time: opening one asks the previous to close.
let activePickerClose = null;

// Day/time cells must not pick up the app's global button fills.
const CELL_RESET = 'appearance-none! min-h-0! shadow-none! border-0!';
const NAV = `${CELL_RESET} grid h-[26px] w-[26px] place-items-center rounded-[6px] p-0! text-[#A9B4C8]! [background:transparent]! cursor-pointer [transition:color_.15s_ease,_background_.15s_ease] hover:text-white! hover:[background:#141C2D]!`;
const FOOT = `${CELL_RESET} p-0! text-[11.5px]! font-[680]! [background:transparent]! cursor-pointer`;

const parseValue = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] || 0), Number(match[5] || 0));
  return Number.isNaN(date.getTime()) ? null : date;
};
const dayKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const toLocalValue = (date) => `${dayKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const displayValue = (date, mode) => {
  if (!date) return '';
  const head = `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}/${date.getFullYear()}`;
  if (mode === 'date') return head;
  const hours = date.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${head}  ${h12}:${pad2(date.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
};

/**
 * Date (or date + time) field with the app's own #070A13 calendar popup, because the native
 * picker panel cannot be recoloured. `mode="date"` drops the hour/minute columns; `minDay`
 * and `maxDay` (YYYY-MM-DD) lock the calendar, and `maxDateTime` caps the time columns.
 */
export default function SchedulePicker({
  id, value, onChange, disabled, ariaDescribedBy, mode = 'datetime', minDay = '', maxDay = '', maxDateTime = '',
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = parseValue(value) || parseValue(minDay) || new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const buttonRef = useRef(null);
  const popupRef = useRef(null);
  const hourColRef = useRef(null);
  const minuteColRef = useRef(null);
  const closeSelfRef = useRef(null);

  const selected = parseValue(value);
  const cap = parseValue(maxDateTime);
  const now = new Date();
  const todayKey = dayKey(now);
  const dateOnly = mode === 'date';
  const width = dateOnly ? 272 : 322;
  const height = 302;
  const selectedDayKey = selected ? dayKey(selected) : '';

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < height && rect.top > spaceBelow;
    setAnchor(above ? { left, bottom: window.innerHeight - rect.top + 6 } : { left, top: rect.bottom + 6 });
  };

  useEffect(() => {
    if (!open) return undefined;
    place();
    // Capture phase: dialogs stop mousedown propagation, so a bubble listener would never run.
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeSelf = () => setOpen(false);
    closeSelfRef.current = closeSelf;
    activePickerClose?.();
    activePickerClose = closeSelf;
    const reposition = () => place();
    // Capture phase so Escape closes only the popup, never the whole dialog.
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      if (activePickerClose === closeSelf) activePickerClose = null;
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  // Bring the current hour/minute into view inside the scroll columns.
  useEffect(() => {
    if (!open || dateOnly) return;
    const base = selected || new Date();
    const h12 = base.getHours() % 12 === 0 ? 12 : base.getHours() % 12;
    if (hourColRef.current) hourColRef.current.scrollTop = Math.max(0, (h12 - 1) * ROW_H - ROW_H);
    if (minuteColRef.current) minuteColRef.current.scrollTop = Math.max(0, (base.getMinutes() - 2) * ROW_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  const commit = (date) => {
    if (dateOnly) {
      onChange(dayKey(date));
      return;
    }
    onChange(toLocalValue(cap && date > cap ? cap : date));
  };

  const pickDay = (date) => {
    if (dateOnly) {
      onChange(dayKey(date));
      return;
    }
    const base = selected ? new Date(selected) : new Date();
    base.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    commit(base);
  };

  const withTime = (fn) => {
    const base = selected ? new Date(selected) : new Date();
    fn(base);
    commit(base);
  };
  const setHour = (h12) => withTime((base) => {
    const meridiem = base.getHours() < 12 ? 'AM' : 'PM';
    base.setHours((h12 % 12) + (meridiem === 'PM' ? 12 : 0));
  });
  const setMinute = (minute) => withTime((base) => base.setMinutes(minute));
  const setMeridiem = (next) => withTime((base) => {
    const hours = base.getHours();
    base.setHours(next === 'PM' ? (hours % 12) + 12 : hours % 12);
  });

  const hour24 = selected ? selected.getHours() : now.getHours();
  const minuteValue = selected ? selected.getMinutes() : now.getMinutes();
  const h12Value = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiemValue = hour24 < 12 ? 'AM' : 'PM';
  const capDayKey = cap ? dayKey(cap) : '';

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const offset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;

  const hourBlocked = (h12) => Boolean(cap) && selectedDayKey === capDayKey && (h12 % 12) + (meridiemValue === 'PM' ? 12 : 0) > cap.getHours();
  const minuteBlocked = (minute) => Boolean(cap) && selectedDayKey === capDayKey && hour24 >= cap.getHours() && minute > cap.getMinutes();

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={ariaDescribedBy}
        onClick={() => {
          if (!open) {
            const base = selected || parseValue(minDay) || new Date();
            setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
          }
          setOpen((current) => !current);
        }}
        className={`${INPUT} flex items-center justify-between gap-[8px] text-left cursor-pointer disabled:opacity-[.55] disabled:cursor-not-allowed`}
      >
        <span className={`truncate tabular-nums ${selected ? '' : 'text-placeholder'}`}>
          {selected ? displayValue(selected, mode) : (dateOnly ? 'mm/dd/yyyy' : 'mm/dd/yyyy  --:-- --')}
        </span>
        <FaRegCalendarDays aria-hidden="true" className="flex-none text-muted text-[12.5px]" />
      </button>

      {open && anchor && createPortal(
        <div
          ref={popupRef}
          data-schedule-picker="true"
          role="dialog"
          aria-label={dateOnly ? 'Choose a date' : 'Choose a date and time'}
          style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, width }}
          className="fixed z-[1300] max-w-[calc(100vw_-_16px)] p-[9px] border border-[#1B2437] rounded-[8px] [background:#070A13] [box-shadow:0_18px_44px_rgba(3,7,18,.6)]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className={dateOnly ? '' : 'grid grid-cols-[1fr_96px] gap-[8px]'}>
            <div>
              <div className="flex items-center justify-between gap-[6px] mb-[6px]">
                <button type="button" aria-label="Previous month" onClick={() => setViewMonth(new Date(year, month - 1, 1))} className={NAV}>
                  <FaChevronLeft aria-hidden="true" className="text-[11px]" />
                </button>
                <strong className="text-[12.5px] font-[720] tracking-[-.01em] text-[#EEF2FA]">{MONTH_NAMES[month]} {year}</strong>
                <button type="button" aria-label="Next month" onClick={() => setViewMonth(new Date(year, month + 1, 1))} className={NAV}>
                  <FaChevronRight aria-hidden="true" className="text-[11px]" />
                </button>
              </div>

              <div className="grid grid-cols-7 mb-[2px]">
                {WEEKDAY_NAMES.map((label) => (
                  <span key={label} className="grid h-[22px] place-items-center text-[9.5px] font-[800] tracking-[.04em] text-[#7B879C]">{label.toUpperCase()}</span>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-[1px]">
                {Array.from({ length: cellCount }, (_, index) => {
                  const date = new Date(year, month, 1 - offset + index);
                  if (date.getMonth() !== month) return <span key={`blank-${index}`} aria-hidden="true" className="h-[28px]" />;
                  const key = dayKey(date);
                  const isSelected = key === selectedDayKey;
                  const blocked = (minDay && key < minDay) || (maxDay && key > maxDay);
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={Boolean(blocked)}
                      aria-pressed={isSelected}
                      aria-current={key === todayKey ? 'date' : undefined}
                      onClick={() => pickDay(date)}
                      className={`${CELL_RESET} grid h-[28px] w-full place-items-center rounded-[6px] p-0! text-[13px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${isSelected ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! font-[560]! hover:[background:#141C2D]!'} ${blocked ? 'opacity-[.24]! cursor-not-allowed! hover:[background:transparent]!' : ''} ${key === todayKey && !isSelected && !blocked ? 'text-[#9DB2FF]!' : ''}`}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-[8px] pt-[6px] mt-[4px] border-t border-[#1B2437]">
                <button
                  type="button"
                  onClick={() => {
                    if (dateOnly) { onChange(''); return; }
                    // "Now" fills the field with the current date and time, still open for adjusting.
                    const current = new Date();
                    setViewMonth(new Date(current.getFullYear(), current.getMonth(), 1));
                    commit(current);
                  }}
                  className={`${FOOT} ${dateOnly ? 'text-[#A9B4C8]! hover:text-white!' : 'text-[#8FA8FF]! hover:text-[#B4C6FF]!'}`}
                >
                  {dateOnly ? 'Clear' : 'Now'}
                </button>
              </div>
            </div>

            {/* Hour / minute / meridiem columns, only when a time is part of the answer. */}
            {!dateOnly && (
              <div className="grid grid-cols-[1fr_1fr_38px] gap-[2px] pt-[2px] border-l border-[#1B2437] pl-[6px]">
                <div role="listbox" aria-label="Hour" ref={hourColRef} className="h-[190px] overflow-y-auto [scrollbar-width:thin]">
                  {Array.from({ length: 12 }, (_, index) => index + 1).map((h12) => (
                    <button
                      key={h12}
                      type="button"
                      role="option"
                      aria-selected={h12 === h12Value}
                      disabled={hourBlocked(h12)}
                      onClick={() => setHour(h12)}
                      className={`${CELL_RESET} grid h-[26px] w-full place-items-center rounded-[6px] p-0! text-[12.5px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${h12 === h12Value ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]!'} ${hourBlocked(h12) ? 'opacity-[.25]! cursor-not-allowed!' : ''}`}
                    >
                      {pad2(h12)}
                    </button>
                  ))}
                </div>
                <div role="listbox" aria-label="Minute" ref={minuteColRef} className="h-[190px] overflow-y-auto [scrollbar-width:thin]">
                  {Array.from({ length: 60 }, (_, index) => index).map((minute) => (
                    <button
                      key={minute}
                      type="button"
                      role="option"
                      aria-selected={minute === minuteValue}
                      disabled={minuteBlocked(minute)}
                      onClick={() => setMinute(minute)}
                      className={`${CELL_RESET} grid h-[26px] w-full place-items-center rounded-[6px] p-0! text-[12.5px] tabular-nums cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${minute === minuteValue ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]!'} ${minuteBlocked(minute) ? 'opacity-[.25]! cursor-not-allowed!' : ''}`}
                    >
                      {pad2(minute)}
                    </button>
                  ))}
                </div>
                <div role="listbox" aria-label="AM or PM" className="h-[190px] overflow-y-auto [scrollbar-width:thin]">
                  {['AM', 'PM'].map((label) => (
                    <button
                      key={label}
                      type="button"
                      role="option"
                      aria-selected={label === meridiemValue}
                      onClick={() => setMeridiem(label)}
                      className={`${CELL_RESET} grid h-[26px] w-full place-items-center rounded-[6px] p-0! text-[12px] font-[650] cursor-pointer [background:transparent]! [transition:background_.12s_ease,_color_.12s_ease] ${label === meridiemValue ? 'text-white! font-[720]! [background:color-mix(in_srgb,_var(--accent)_38%,_transparent)]!' : 'text-[#DCE3F2]! hover:[background:#141C2D]!'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
