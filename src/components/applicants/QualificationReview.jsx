import React, { useState } from 'react';

/** Admin-only review layout for the Qualification requirements (checklist + detail). */
export default function QualificationReview({ items, selectedKey, onSelect, renderDetail, header }) {
  const [activeKey, setActiveKey] = useState(selectedKey);
  const current = activeKey || items[0]?.key;

  return (
    <div className="flex flex-col gap-[10px]">
      {header}
      <div className="grid grid-cols-[340px_minmax(0,_1fr)] items-start gap-[12px]">
      <ul className="m-0 p-0 [list-style:none] grid content-start gap-[8px]">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => { setActiveKey(item.key); onSelect?.(item.key); }}
              className={`w-full text-left p-[10px_12px] rounded-[10px] border transition-[border-color,background-color] duration-300 ease-out ${current === item.key ? 'border-[#7b88ff] bg-[#141a28]' : 'border-[#2b344c] bg-[#0c111d]'} text-[#edf0fa]`}
            >
              <span className="flex items-start justify-between gap-[8px]">
                <strong className="block">{item.label}</strong>
                {item.status && (
                  <small className="flex-none font-[600]" style={{ color: item.status.color }}>{item.status.label}</small>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div key={current} className="min-w-0 flex flex-col [animation:qual-slide-in_.35s_cubic-bezier(.2,_.8,_.2,_1)_both] motion-reduce:[animation:none]">{renderDetail?.(current)}</div>
      </div>
    </div>
  );
}
