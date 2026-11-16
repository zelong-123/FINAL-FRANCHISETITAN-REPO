import { useEffect, useMemo, useRef, useState } from 'react';
import { FaFilePdf, FaImage } from 'react-icons/fa6';
/** A small preview for a picked image file (object URL, revoked on unmount). */
function FileThumb({ file }) {
  const url = useMemo(() => (file && /^image\//.test(file.type || '') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return (
    <span className="grid flex-none place-items-center w-[38px] h-[38px] overflow-hidden rounded-[7px] border border-[#2b344c] bg-[#151c2c] text-[#9aa6c4] text-[15px]" aria-hidden="true">
      {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : (/pdf/i.test(file?.type || file?.name || '') ? <FaFilePdf /> : <FaImage />)}
    </span>
  );
}

/**
 * The requirement file uploader (drag and drop + Choose file), shared by the Qualification requirements
 * and the Payment Record receipts. Optional: `max` files in total, `saved` files already on record (kept
 * unless removed), per-file Replace, and a `validate(file)` check that refuses a file with a message.
 */
export default function RequirementFileDrop({
  label, required, accept, multiple, files, onChange,
  max = null, saved = [], onSavedChange = null, onViewSaved = null, replaceable = false, validate = null, hint = null, disabled = false,
}) {
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState('');
  const [replacing, setReplacing] = useState(null);
  const inputRef = useRef(null);
  const replaceRef = useRef(null);
  const total = files.length + saved.length;
  const full = max != null && total >= max;
  const accepted = (list) => {
    for (const file of list) {
      const issue = validate ? validate(file) : '';
      if (issue) { setProblem(issue); return null; }
    }
    return list;
  };
  const addFiles = (list) => {
    setProblem('');
    if (!list.length || disabled) return;
    const ok = accepted(list);
    if (!ok) return;
    if (!multiple) { onChange(ok.slice(0, 1)); return; }
    let next = [...files, ...ok];
    if (max != null && saved.length + next.length > max) {
      setProblem(`You can attach at most ${max} files. Remove or replace one first.`);
      next = next.slice(0, Math.max(0, max - saved.length));
    }
    onChange(next);
  };
  const replaceWith = (file) => {
    setProblem('');
    if (!file || !replacing) return;
    if (!accepted([file])) { setReplacing(null); return; }
    if (replacing.kind === 'new') onChange(files.map((f, i) => (i === replacing.index ? file : f)));
    else { onSavedChange?.(saved.filter((d) => d.id !== replacing.id)); onChange([...files, file]); }
    setReplacing(null);
  };
  const startReplace = (target) => { setReplacing(target); window.setTimeout(() => replaceRef.current?.click(), 0); };
  const viewFile = (file) => {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const action = 'text-[12px] font-[600] bg-transparent border-0 cursor-pointer hover:underline disabled:opacity-50';
  const row = 'flex items-center gap-[10px] p-[6px_10px] border border-[#2b344c] rounded-[8px] bg-[#0c111d] text-[13px] text-[#c9d0e0]';
  return (
    <div className="grid gap-[6px] content-start">
      <span className="text-[12px] font-[650] text-[#c9d0e0]">{label}{required && <span className="text-[#f87171]"> *</span>}</span>
      <div
        onDragOver={(e) => { e.preventDefault(); if (!full && !disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (full) { setProblem(`You can attach at most ${max} files. Remove or replace one first.`); return; } addFiles([...(e.dataTransfer.files || [])]); }}
        className={`grid place-items-center gap-[8px] p-[16px] border border-dashed rounded-[10px] text-[13px] text-[#9aa6c4] ${dragging ? 'border-[#7b88ff] bg-[rgba(123,136,255,0.08)]' : 'border-[#2b344c] bg-[#101626]'} ${full || disabled ? 'opacity-60' : ''}`}
      >
        <span>{full ? `Maximum of ${max} files attached` : 'Select a file or drag and drop it here'}</span>
        <button type="button" disabled={full || disabled} className="min-h-[30px] p-[0_12px] border border-[#2b344c] rounded-[8px] bg-[#1a2133] text-[#c9d0e0] text-[12px] font-[600] cursor-pointer hover:border-[#7b88ff] disabled:cursor-not-allowed" onClick={() => inputRef.current?.click()}>Choose file</button>
        <input ref={inputRef} type="file" className="hidden" multiple={Boolean(multiple)} accept={accept} onChange={(e) => { addFiles([...(e.target.files || [])]); e.target.value = ''; }} />
        <input ref={replaceRef} type="file" className="hidden" accept={accept} onChange={(e) => { replaceWith(e.target.files?.[0] || null); e.target.value = ''; }} />
      </div>
      {hint && <small className="text-[#8f9bbd] text-[12px]">{hint}</small>}
      {problem && <small className="text-[#ff9ca3] text-[12px]" role="alert">{problem}</small>}
      {total > 0 && (
        <ul className="m-0 p-0 [list-style:none] grid gap-[6px]">
          {saved.map((doc) => (
            <li key={`saved-${doc.id}`} className={row}>
              <span className="grid flex-none place-items-center w-[38px] h-[38px] rounded-[7px] border border-[#2b344c] bg-[#151c2c] text-[#9aa6c4] text-[15px]" aria-hidden="true">
                {/pdf/i.test(doc.mime_type || doc.original_name || '') ? <FaFilePdf /> : <FaImage />}
              </span>
              <span className="flex-1 min-w-0"><span className="block truncate">{doc.original_name}</span><small className="text-[#8f9bbd]">Attached earlier</small></span>
              {onViewSaved && <button type="button" className={`${action} text-[#8fb4ff]`} onClick={() => onViewSaved(doc)}>View</button>}
              {replaceable && onSavedChange && <button type="button" disabled={disabled} className={`${action} text-[#c9d0e0]`} onClick={() => startReplace({ kind: 'saved', id: doc.id })}>Replace</button>}
              {onSavedChange && <button type="button" disabled={disabled} className={`${action} text-[#f87171]`} onClick={() => { setProblem(''); onSavedChange(saved.filter((d) => d.id !== doc.id)); }}>Remove</button>}
            </li>
          ))}
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className={row}>
              {replaceable && <FileThumb file={file} />}
              <span className="flex-1 min-w-0 truncate">{file.name}</span>
              <button type="button" className={`${action} text-[#8fb4ff]`} onClick={() => viewFile(file)}>View</button>
              {replaceable && <button type="button" disabled={disabled} className={`${action} text-[#c9d0e0]`} onClick={() => startReplace({ kind: 'new', index })}>Replace</button>}
              <button type="button" disabled={disabled} className={`${action} text-[#f87171]`} onClick={() => { setProblem(''); onChange(files.filter((_, i) => i !== index)); }}>{replaceable ? 'Remove' : 'Delete'}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
