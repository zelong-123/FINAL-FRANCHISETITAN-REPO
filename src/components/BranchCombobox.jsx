import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * One searchable Branch control (combobox): type to filter by branch name or franchisee / business name
 * (case-insensitive); arrow keys move, Enter selects, Escape closes. The brand shows under each option.
 * `extra` options (e.g. "All branches — network view") stay at the top of the list.
 * Same look and keyboard behaviour as the searchable Province / City fields (LocationPicker).
 */
export default function BranchCombobox({ branches, value, onChange, extra = [], label = 'Branch', placeholder = 'Type a branch or franchisee…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef(null);
  const selected = branches.find((b) => String(b.id) === String(value));

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = branches.filter((b) => !needle || `${b.name} ${b.franchisee?.business_name || ''}`.toLowerCase().includes(needle));
    return [
      ...(needle ? [] : extra.map((e) => ({ key: `extra-${e.value}`, value: e.value, name: e.label, extra: true }))),
      ...matches.map((b) => ({
        key: String(b.id), value: String(b.id), name: b.name,
        sub: [b.franchisee?.business_name, b.brand?.name].filter(Boolean).join(' · '),
      })),
    ];
  }, [branches, extra, query]);

  useEffect(() => { listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' }); }, [active]);

  const pick = (option) => {
    setOpen(false);
    setQuery('');
    if (option) onChange(option.value);
  };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter' && open) { event.preventDefault(); if (options[active]) pick(options[active]); }
    else if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); setQuery(''); }
  };
  const activeId = open && options[active] ? `${listId}-${active}` : undefined;

  return (
    <span className="relative block">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        className="w-full"
        value={open ? query : (selected?.name || '')}
        placeholder={selected?.name || placeholder}
        onFocus={() => { setOpen(true); setQuery(''); setActive(0); }}
        onBlur={() => { setOpen(false); setQuery(''); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} ref={listRef} role="listbox" aria-label={label}
          className="absolute top-[calc(100%_+_4px)] left-0 right-0 z-30 m-0 p-1 [list-style:none] max-h-[280px] overflow-y-auto [background:var(--panel)] border border-[color:var(--border-strong)] rounded-[10px] [box-shadow:var(--shadow-md)]">
          {options.length ? options.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={String(option.value) === String(value)}
              className={`p-[8px_11px] rounded-[7px] cursor-pointer text-[13px] text-text hover:[background:var(--active)] ${index === active ? '[background:var(--active)]' : ''} ${option.extra ? 'text-accent-text font-[600]' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              {option.name}
              {option.sub && <small className="block text-muted text-[11.5px]">{option.sub}</small>}
            </li>
          )) : <li className="p-[8px_11px] text-[13px] text-muted" role="option" aria-disabled="true" aria-selected="false">No branch matches</li>}
        </ul>
      )}
    </span>
  );
}
