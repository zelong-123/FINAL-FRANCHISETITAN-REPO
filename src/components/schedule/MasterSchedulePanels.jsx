import React, { useLayoutEffect, useRef, useState } from 'react';
import { FaChevronLeft, FaChevronRight } from 'react-icons/fa6';
import { SESSION_STATUSES, STATUS_COLORS } from '../../lib/scheduleSessions';
import { dayDots, monthWeeks, shiftMonth } from '../../lib/masterScheduleDays';

const MONTH_LABEL = new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_HEADINGS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Mon-Fri mini calendar. Clicking a day switches the chart; dots = scheduled applicants. */
export function MiniCalendar({ month, selectedDate, todayDate, sessions, onMonth, onPickDate, children, plain = false, activeWeekStart = null, activeWeekEnd = null }) {
  const weeks = monthWeeks(month);
  const title = MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
  const [slide, setSlide] = useState('');
  const boxRef = useRef(null);
  const [indicator, setIndicator] = useState(null);
  // Measure the selected day's cell so one indicator can glide between days.
  // offsetLeft/offsetTop ignore the slide transform on the table.
  useLayoutEffect(() => {
    const cell = boxRef.current?.querySelector('[aria-pressed="true"]');
    setIndicator(cell ? { left: cell.offsetLeft, top: cell.offsetTop } : null);
  }, [month, selectedDate]);
  return (
    <div ref={boxRef} className="relative flex flex-col flex-1 min-h-0 rounded-[8px] border border-line p-[10px] [background:#070A13]">
      <div className="flex items-center justify-between mb-[8px]">
        <button type="button" aria-label="Previous month" className="inline-flex items-center justify-center w-[32px] h-[32px] border border-line rounded-[8px] [background:transparent] text-muted hover:text-text" onClick={() => { setSlide('ms-cal-grid-prev'); onMonth(shiftMonth(month, -1)); }}><FaChevronLeft aria-hidden="true" /></button>
        <strong className="text-text text-[14px] font-[700]">{title}</strong>
        <button type="button" aria-label="Next month" className="inline-flex items-center justify-center w-[32px] h-[32px] border border-line rounded-[8px] [background:transparent] text-muted hover:text-text" onClick={() => { setSlide('ms-cal-grid-next'); onMonth(shiftMonth(month, 1)); }}><FaChevronRight aria-hidden="true" /></button>
      </div>
      {indicator && !plain && <span aria-hidden="true" className="ms-day-indicator absolute z-0 w-[32px] h-[32px] rounded-[50%] [background:#070A13] [border:2px_solid_#5b7fc0] pointer-events-none" style={{ left: indicator.left, top: indicator.top }} />}
      <table key={month} className={`w-full border-collapse text-center text-[13px] ${slide}`}>
        <thead>
          <tr>{DAY_HEADINGS.map((day) => <th key={day} className="text-muted text-[14px] font-[800] pb-[4px]">{day}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={index}>
              {week.map((date, cell) => {
                if (!date) return <td key={cell} />;
                const { dots, more, done } = plain ? { dots: 0, more: 0, done: 0 } : dayDots(sessions, date);
                const selected = date === selectedDate;
                const isToday = date === todayDate;
                return (
                  <td key={cell} className={`p-[5px_2px] ${plain && activeWeekStart && date >= activeWeekStart && date <= activeWeekEnd ? '[background:rgba(59,91,143,.18)]' : ''}`}>
                    <button
                      type="button"
                      aria-label={date}
                      aria-pressed={selected}
                      onClick={() => onPickDate(date)}
                      className={`relative w-[32px] h-[32px] mx-auto rounded-[50%] flex flex-col items-center justify-center text-text text-[17px] border-0 shadow-none [background:transparent] ${selected ? 'font-[750]' : ''} ${isToday ? 'text-accent' : ''}`}
                    >
                      {Number(date.slice(8))}
                      <span className="relative z-[1] flex items-center gap-[2px] h-[4px]" aria-hidden="true">
                        {Array.from({ length: dots }, (_, i) => <i key={i} className={`w-[4px] h-[4px] rounded-[50%] ${i < done ? '[background:#3b82f6]' : '[background:#22c55e]'}`} />)}
                        {more > 0 && <em className="not-italic text-[8px] text-muted">+{more}</em>}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {children && <div className="flex-1 mt-[10px] pt-[10px] border-t border-line">{children}</div>}
    </div>
  );
}

const WHEEL_ROW = 32;
const WHEEL_MONTH_NAMES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1).padStart(2, '0'),
  label: new Intl.DateTimeFormat('en-PH', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, i, 1))),
}));

function WheelColumn({ items, selected, onSelect }) {
  const listRef = useRef(null);
  const index = Math.max(0, items.findIndex((item) => item.value === selected));
  // Scroll the selected item into view when the popup opens or the value changes.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = index * WHEEL_ROW - WHEEL_ROW * 2;
  }, [index]);
  return (
    <div ref={listRef} className="flex-1 h-[160px] overflow-y-auto overscroll-contain scroll-smooth [scrollbar-width:thin]">
      {items.map((item) => (
        <button key={item.value} type="button" aria-pressed={item.value === selected} onClick={() => onSelect(item.value)} className={`block w-full h-[32px] border-0 [background:transparent] text-[13px] font-[650] uppercase tracking-[.04em] ${item.value === selected ? 'text-accent' : 'text-muted hover:text-text'}`}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Month-mode Custom picker: a month wheel and a year wheel, no day grid. */
export function MonthYearWheel({ month, todayYear, onPick }) {
  const [year, monthNo] = month.split('-');
  const years = Array.from({ length: 11 }, (_, i) => ({ value: String(todayYear - 5 + i), label: String(todayYear - 5 + i) }));
  return (
    <div className="flex gap-[8px] rounded-[8px] border border-line p-[10px] [background:#070A13]">
      <WheelColumn items={WHEEL_MONTH_NAMES} selected={monthNo} onSelect={(value) => onPick(`${year}-${value}`)} />
      <WheelColumn items={years} selected={year} onSelect={(value) => onPick(`${value}-${monthNo}`)} />
    </div>
  );
}

/** Minimalist Week side box: uppercase title with a rule, then label/value rows. */
function WeekSideBox({ title, rows, className = '' }) {
  return (
    <div className={`rounded-[4px] border border-[#3a4560] px-[14px] py-[12px] [background:#070b14] ${className}`}>
      <h3 className="text-[#e5e7eb] text-[15px] font-[800] uppercase pb-[7px] mb-[8px] border-b border-[#3a4560]">{title}</h3>
      <ul className="grid gap-[8px] list-none p-0 m-0">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between">
            {row.onClick ? (
              <button type="button" aria-pressed={row.active} onClick={row.onClick} className={`w-full flex items-center justify-between [background:transparent] border-0 p-0 cursor-pointer text-[#9ca3af] hover:text-[#e5e7eb] ${row.active ? 'text-[#e5e7eb]' : ''}`}>
                <span className="text-[13px] font-[600] uppercase">{row.label}:</span>
                <strong className="text-[#e5e7eb] text-[17px] font-[800]">{row.value}</strong>
              </button>
            ) : (
              <>
                <span className="text-[13px] font-[600] uppercase text-[#9ca3af]">{row.label}:</span>
                <strong className="text-[#e5e7eb] text-[17px] font-[800]">{row.value}</strong>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Week side panels: Activities counts, then Status counts (same data as the Day status list). */
export function WeekSidePanels({ activityCounts, statusCounts, showCompleted = false, onToggleCompleted }) {
  return (
    <div className="flex flex-col gap-[12px] h-full">
      <WeekSideBox
        title="Activities"
        rows={[
          { key: 'orientation', label: 'Orientation/Tasting', value: activityCounts?.orientation ?? 0 },
          { key: 'training', label: 'Training', value: activityCounts?.training ?? 0 },
        ]}
      />
      <WeekSideBox
        className="flex-1"
        title="Status"
        rows={SESSION_STATUSES.map((item) => ({
          key: item.value,
          label: item.label,
          value: statusCounts?.[item.value] ?? 0,
          ...(item.value === 'completed' && onToggleCompleted ? { onClick: onToggleCompleted, active: showCompleted } : {}),
        }))}
      />
    </div>
  );
}

/** Status legend with counts for the displayed month. Counts come from the summary endpoint, or the client fallback. */
export function StatusPanel({ counts, showCompleted = false, onToggleCompleted }) {
  return (
    <div>
      <h3 className="text-muted text-[12px] font-[750] tracking-[.07em] uppercase mb-[8px]">Status</h3>
      <ul className="grid gap-[6px] list-none p-0 m-0">
        {SESSION_STATUSES.map((item) => {
          const toggles = item.value === 'completed' && onToggleCompleted;
          const content = (
            <>
              <span className="inline-flex items-center gap-[6px]"><i className="w-[8px] h-[8px] rounded-[50%]" style={{ background: STATUS_COLORS[item.value] }} aria-hidden="true" />{item.label}</span>
              <strong className="text-text text-[14px]">{counts?.[item.value] ?? 0}</strong>
            </>
          );
          // Completed is a toggle: hidden from the chart by default, shown when clicked.
          return (
            <li key={item.value} className="text-[14px] text-text-secondary">
              {toggles ? (
                <button type="button" aria-pressed={showCompleted} onClick={onToggleCompleted} className={`w-full flex items-center justify-between [background:transparent] border-0 p-0 cursor-pointer text-[14px] hover:text-text ${showCompleted ? 'text-text' : ''}`}>
                  {content}
                </button>
              ) : (
                <div className="flex items-center justify-between">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
