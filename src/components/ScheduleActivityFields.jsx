import React from 'react';
import { Field } from './ApiUi';
import {
  MINUTES,
  VENUE_OPTIONS,
  isValidStart,
  startHours,
  endTimeLabel,
  hourLabel,
  maxHoursFor,
  pad2,
  resolvedHours,
} from '../lib/scheduleRules';
import { closesMinutes, isWorkingDate, lastStartMinutes, minutesLabel } from '../lib/scheduleConfig';
import useScheduleConfig from '../lib/useScheduleConfig';

/**
 * Starts (date + hour + minute), Duration (whole hours + Custom), Venue and the
 * calculated end time — shared by the Activities page and the Applicant modal
 * (Phase 2) so both use exactly the same whole-hour rules.
 *
 * The applicant pickers stay in the parent: One applicant hides the People
 * attending section, Multiple shows it with the capacity counter.
 */
export default function ScheduleWindowFields({ form, setForm, onError }) {
  // The one scheduling window (same values as the API save check).
  const window_ = useScheduleConfig();
  const closeLabel = minutesLabel(closesMinutes());
  const lastStartLabel = minutesLabel(lastStartMinutes());
  const maxHours = maxHoursFor(form.start_hour, form.start_minute);
  const presets = [1, 2, 3].filter((hours) => hours <= maxHours);
  const customAllowed = maxHours > 3;
  const hours = resolvedHours(form);

  /** Any start change re-validates the chosen duration (it may no longer fit). */
  const updateStart = (patch) => {
    const next = { ...form, ...patch };
    // A different date/time is a different session: the previous Join/Create
    // separate choice no longer applies, so the merge prompt asks again.
    next.join_session_id = '';
    next.separate_session = false;
    let message = '';

    // A minute that falls outside the window (e.g. 5:30 PM with a 6:00 PM close) is reset.
    if (!isValidStart(next.start_hour, next.start_minute)) {
      const fallback = MINUTES.find((minute) => isValidStart(next.start_hour, minute));
      if (fallback !== undefined) {
        message = `Minute reset: ${minutesLabel(Number(next.start_hour) * 60 + Number(next.start_minute))} does not leave room for a whole-hour duration.`;
        next.start_minute = fallback;
      }
    }

    const nextMax = maxHoursFor(next.start_hour, next.start_minute);
    const nextHours = resolvedHours(next);
    if (nextHours > nextMax || (next.duration_choice === 'custom' && !next.custom_hours)) {
      next.duration_choice = String(Math.max(1, Math.min(3, nextMax)));
      next.custom_hours = '';
      message = `Duration reset: it would end after ${closeLabel}. The longest for this start time is ${nextMax} hr${nextMax === 1 ? '' : 's'}.`;
    }

    setForm({ ...next, merge_dismissed: false });
    onError(message);
  };

  const changeDuration = (value) => {
    onError('');
    if (value === 'custom') {
      setForm({
        ...form,
        duration_choice: 'custom',
        custom_hours: form.custom_hours || String(Math.min(Math.max(1, hours), maxHours)),
      });
      return;
    }
    setForm({ ...form, duration_choice: value, custom_hours: '' });
  };

  const today = new Date();
  const minDate = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  return (
    <>
      <Field label="Starts" required full hint={`${window_.days_label} only. The last valid start time is ${lastStartLabel}.`}>
        <div className="grid grid-cols-[minmax(140px,_1.1fr)_minmax(110px,_0.8fr)_minmax(82px,_0.5fr)] gap-2">
          <input
            required
            type="date"
            aria-label="Activity date"
            min={minDate}
            value={form.start_date}
            onChange={(event) => {
              const value = event.target.value;
              if (value && !isWorkingDate(value)) {
                onError(`Activities can only be scheduled ${window_.days_label}.`);
                return;
              }
              updateStart({ start_date: value });
            }}
          />
          <select
            aria-label="Start hour"
            value={form.start_hour}
            onChange={(event) => updateStart({ start_hour: Number(event.target.value) })}
          >
            {startHours().map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
          </select>
          <select
            aria-label="Start minute"
            value={form.start_minute}
            onChange={(event) => updateStart({ start_minute: Number(event.target.value) })}
          >
            {MINUTES.filter((minute) => isValidStart(form.start_hour, minute))
              .map((minute) => <option key={minute} value={minute}>:{pad2(minute)}</option>)}
          </select>
        </div>
      </Field>

      <Field label="Duration" required full hint={`Whole hours only — no minutes. The end time is calculated and never passes ${closeLabel}.`}>
        <div className="flex items-center gap-2 flex-wrap [&_input[type='number']]:max-w-[120px]">
          <select
            aria-label="Duration"
            value={form.duration_choice}
            onChange={(event) => changeDuration(event.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset} value={String(preset)}>{`${preset} hr${preset === 1 ? '' : 's'}`}</option>
            ))}
            {customAllowed && <option value="custom">Custom</option>}
          </select>
          {form.duration_choice === 'custom' && customAllowed && (
            <input
              type="number"
              aria-label="Custom duration in hours"
              min="1"
              max={maxHours}
              step="1"
              placeholder={`1–${maxHours}`}
              value={form.custom_hours}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw === '') {
                  setForm({ ...form, custom_hours: '' });
                  return;
                }
                const value = Math.floor(Number(raw));
                if (!Number.isFinite(value) || value < 1) {
                  onError('Custom duration must be at least 1 hour.');
                  setForm({ ...form, custom_hours: '' });
                  return;
                }
                if (value > maxHours) {
                  onError(`This start time only allows up to ${maxHours} hr${maxHours === 1 ? '' : 's'} before ${closeLabel}.`);
                  setForm({ ...form, custom_hours: String(maxHours) });
                  return;
                }
                onError('');
                setForm({ ...form, custom_hours: String(value) });
              }}
            />
          )}
          {!customAllowed && <span className="muted-note text-muted text-[8px] leading-[1.6]">No custom option: the presets already cover this start time.</span>}
        </div>
        <p className="m-[8px_0_0] text-[12.5px] text-[color:var(--text-muted,_#9aa4b2)] [&_strong]:text-[color:var(--text,_#e8eef8)]" role="status">
          Ends at <strong>{endTimeLabel(form)}</strong>
        </p>
      </Field>

      <Field label="Venue" full>
        <select
          aria-label="Venue"
          value={form.venue}
          onChange={(event) => setForm({ ...form, venue: event.target.value })}
        >
          {VENUE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>

      {form.venue === 'Virtual' && (
        <Field label="Meeting link" full hint="Optional — paste the video-call link for the applicants.">
          <input
            type="url"
            value={form.meeting_link}
            placeholder="https://meet.example.com/session"
            onChange={(event) => setForm({ ...form, meeting_link: event.target.value })}
          />
        </Field>
      )}
    </>
  );
}
