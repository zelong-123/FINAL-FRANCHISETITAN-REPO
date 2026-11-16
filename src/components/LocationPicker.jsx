import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import useLocationReference from '../lib/useLocationReference';
import { chooseCity, chooseProvince, cityOptions, provinceOptions } from '../lib/locations';
import { Field } from './ApiUi';

/** A text input that filters a list as you type; Enter/arrow keys/Escape work, × clears. */
function SearchSelect({ value, options, onQuery, onPick, placeholder, disabled, required, invalid, label }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef(null);
  const shown = open ? query : (value || '');
  useEffect(() => { onQuery(open ? query : ''); }, [open, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  const pick = (option) => { onPick(option); setOpen(false); setQuery(''); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); if (options[active]) pick(options[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); setQuery(''); }
  };
  return (
    <span className="relative block">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        className="w-full"
        value={shown}
        placeholder={value || placeholder}
        disabled={disabled}
        required={required && !value}
        onFocus={() => { setOpen(true); setQuery(''); setActive(0); }}
        onBlur={() => { setOpen(false); setQuery(''); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
      />
      {value && !disabled && (
        <button type="button" aria-label={`Clear ${label}`} className="absolute right-[8px] top-1/2 -translate-y-1/2 border-0 bg-transparent text-muted cursor-pointer text-[15px] leading-none p-[4px]"
          onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null)}>×</button>
      )}
      {open && (
        <ul id={listId} ref={listRef} role="listbox" aria-label={label}
          className="absolute top-[calc(100%_+_4px)] left-0 right-0 z-30 m-0 p-1 [list-style:none] max-h-[232px] overflow-y-auto [background:var(--panel)] border border-[color:var(--border-strong)] rounded-[10px] [box-shadow:var(--shadow-md)]">
          {options.length ? options.map((option, index) => (
            <li key={option.code} role="option" aria-selected={index === active}
              className={`p-[8px_11px] rounded-[7px] cursor-pointer text-[13px] text-text hover:[background:var(--active)] ${index === active ? '[background:var(--active)]' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(option)}>
              {option.label ?? option.name}
            </li>
          )) : <li className="p-[8px_11px] text-[13px] text-muted">No match</li>}
        </ul>
      )}
    </span>
  );
}

/**
 * Province (searchable) -> City/Municipality (searchable, filtered by the province) -> Barangay text
 * (-> Street text). A city picked first fills in its province; changing the province clears a city
 * that is not in it. `value` is { province_code, province, city_code, city, barangay, street }.
 */
export default function LocationPicker({
  value, onChange, required = false, disabled = false, street = false, full = false,
  labels = {}, barangayPlaceholder = 'Barangay (Optional)', streetPlaceholder = 'Street/details (Optional)', errors = {},
}) {
  const ref = useLocationReference();
  const [provinceQuery, setProvinceQuery] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const v = value || {};
  const provinces = useMemo(() => provinceOptions(ref, provinceQuery), [ref, provinceQuery]);
  const cities = useMemo(() => cityOptions(ref, v.province_code, cityQuery), [ref, v.province_code, cityQuery]);
  const loading = !ref;
  const set = (next) => onChange({ ...v, ...next });
  return (
    <>
      <Field label={labels.province || 'Province'} required={required} full={full} hint={errors.province_code}>
        <SearchSelect
          label={labels.province || 'Province'} value={v.province} options={provinces} disabled={disabled || loading} required={required}
          placeholder={loading ? 'Loading…' : 'Type to search'} onQuery={setProvinceQuery} invalid={Boolean(errors.province_code)}
          onPick={(p) => onChange(chooseProvince(ref, v, p?.code ?? null))}
        />
      </Field>
      <Field label={labels.city || 'City/Municipality'} required={required} full={full} hint={errors.city_code}>
        <SearchSelect
          label={labels.city || 'City/Municipality'} value={v.city} options={cities} disabled={disabled || loading} required={required}
          placeholder={loading ? 'Loading…' : v.province_code ? 'Type to search' : 'Type to search all cities'} onQuery={setCityQuery} invalid={Boolean(errors.city_code)}
          onPick={(c) => onChange(c ? chooseCity(ref, v, c.code) : { ...v, city_code: null, city: null })}
        />
      </Field>
      <Field label={labels.barangay || 'Barangay'} full={full}>
        <input value={v.barangay || ''} disabled={disabled} placeholder={barangayPlaceholder} maxLength={255} onChange={(e) => set({ barangay: e.target.value })} />
      </Field>
      {street && (
        <Field label={labels.street || 'Street/details'} full={full}>
          <input value={v.street || ''} disabled={disabled} placeholder={streetPlaceholder} maxLength={255} onChange={(e) => set({ street: e.target.value })} />
        </Field>
      )}
    </>
  );
}
