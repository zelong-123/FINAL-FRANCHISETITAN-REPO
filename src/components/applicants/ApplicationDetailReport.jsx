import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaChevronLeft, FaChevronRight, FaFileCsv, FaFileLines, FaFilePdf, FaImage, FaLock, FaPrint, FaXmark } from 'react-icons/fa6';
import { API_BASE_URL, authToken } from '../../lib/api';
import { downloadCsv, downloadPdf } from '../../lib/export';
import { formatDate, manilaDateTimeLabel, titleCase } from '../../lib/format';

/*
 * Application Detail: ONE read-only modal, one stage per page. Every page reads what the database
 * recorded (Addition B) — status, who did it and when, the data, the files and the remarks.
 */
const PAGES = [
  { key: 'overview', label: 'Overview' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'activities', label: 'Scheduled Activities' },
  { key: 'loi', label: 'LOI' },
  { key: 'payment', label: 'Payment Record' },
  { key: 'approval', label: 'Approval' },
  { key: 'history', label: 'History' },
];
const STAGE_ORDER = ['converted', 'qualified', 'scheduled', 'loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee'];
// The applicant stage at which each page starts (Overview and History always apply).
const PAGE_FROM = { qualification: 'converted', activities: 'scheduled', loi: 'loi_submitted', payment: 'payment_submitted', approval: 'for_approval' };
const ACTIVITY_LABELS = { orientation: 'Orientation', product_tasting: 'Product Tasting', training: 'Training' };
const REQ_STATUS = { pending: 'Pending', submitted: 'Submitted', accepted: 'Accepted', returned: 'Returned' };
const TONE = {
  done: 'text-[#45d991] border-[rgba(69,_217,_145,_.45)]',
  current: 'text-[#8fb4ff] border-[rgba(143,_180,_255,_.45)]',
  waiting: 'text-[#9aa6c4] border-[#3a4256]',
  warn: 'text-[#fbbf24] border-[rgba(251,_191,_36,_.45)]',
  bad: 'text-[#ff888e] border-[rgba(255,_136,_142,_.5)]',
};
const peso = (v) => (v === null || v === undefined ? null : `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (v) => (v ? manilaDateTimeLabel(v) : null);
const day = (v) => (v ? formatDate(v) : null);
const nameOf = (person) => person?.full_name || null;
const isImage = (mime, name) => /^image\//.test(String(mime || '')) || /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''));

function Badge({ tone = 'waiting', children }) {
  return <span className={`inline-flex items-center gap-[6px] p-[2px_10px] rounded-[999px] border text-[13px] font-[700] ${TONE[tone] || TONE.waiting}`}>{children}</span>;
}

/** A titled card of label/value pairs; an empty value reads "—" rather than a blank. */
function Card({ title, children, tone }) {
  return (
    <section className={`p-[14px_16px] border rounded-[12px] [background:#141a28] break-inside-avoid ${tone === 'warn' ? 'border-[rgba(251,_191,_36,_.4)]' : 'border-[#2a3041]'}`}>
      {title && <h4 className="m-[0_0_10px] text-[13px] tracking-[.06em] uppercase text-[#9aa6c4]">{title}</h4>}
      {children}
    </section>
  );
}
function Pairs({ rows }) {
  const shown = rows.filter(Boolean);
  return (
    <dl className="grid grid-cols-[minmax(140px,_220px)_minmax(0,_1fr)] gap-[8px_14px] m-0 text-[14px] leading-[1.5] max-[640px]:grid-cols-1 max-[640px]:gap-[2px_0] [&_dt]:text-[#9aa6c4] [&_dd]:m-0 [&_dd]:text-[#edf0fa] max-[640px]:[&_dd]:mb-2">
      {shown.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
function NotStarted({ note }) {
  return (
    <Card>
      <p className="m-0 text-[15px] text-[#c9d0e0]"><strong>Not started yet</strong></p>
      {note && <p className="m-[6px_0_0] text-[14px] text-[#9aa6c4]">{note}</p>}
    </Card>
  );
}

/** One attached file: images preview on a ~2s hover (tap to open/close on touch); others open on click. */
function Attachment({ name, mime, path, note }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const timer = useRef(null);
  const urlRef = useRef(null);
  const pointer = useRef('mouse');
  const image = isImage(mime, name);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);
  const load = async () => {
    if (urlRef.current) return urlRef.current;
    const token = await authToken.get();
    const response = await fetch(`${API_BASE_URL}${path}`, { headers: { Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) throw new Error('The file could not be opened.');
    urlRef.current = URL.createObjectURL(await response.blob());
    return urlRef.current;
  };
  const show = () => load().then(setPreview).catch((e) => setError(e.message));
  const open = () => load().then((url) => window.open(url, '_blank', 'noopener')).catch((e) => setError(e.message));
  const onEnter = (event) => {
    pointer.current = event.pointerType;
    if (!image || event.pointerType === 'touch') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(show, 2000);
  };
  const onLeave = (event) => {
    if (event.pointerType === 'touch') return;
    window.clearTimeout(timer.current);
    setPreview(null);
  };
  const onUp = (event) => {
    pointer.current = event.pointerType;
    if (event.pointerType !== 'touch') return;
    if (!image) { open(); return; }
    if (preview) setPreview(null);
    else show();
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className="inline-flex items-center gap-2 p-[6px_10px] border border-[#353e57] rounded-[9px] [background:#1a2133] text-[#dfe3f5] text-[14px] cursor-pointer print:p-0 print:border-0"
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onPointerUp={onUp}
        onClick={() => { if (pointer.current !== 'touch') open(); }}
        title={image ? 'Hold the pointer here to preview; click to open' : 'Click to open'}
      >
        {image ? <FaImage aria-hidden="true" /> : <FaFileLines aria-hidden="true" />}
        <span className="max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
        {note && <small className="text-[#fbbf24]">{note}</small>}
      </button>
      {error && <small className="text-[#ff9ca3]" role="alert">{error}</small>}
      {preview && createPortal(
        <div className="fixed inset-0 z-[2147483200] grid place-items-center p-6 pointer-events-none print:hidden" onPointerUp={() => setPreview(null)}>
          <img src={preview} alt={name} className="max-w-[min(90vw,_960px)] max-h-[80vh] rounded-[12px] border border-[#3a4256] [box-shadow:0_20px_60px_rgba(0,_0,_0,_.6)] [background:#0c111d] pointer-events-auto" />
        </div>,
        document.body,
      )}
    </span>
  );
}
function Files({ items, label = 'Files' }) {
  if (items === null) return <p className="m-[8px_0_0] text-[13px] text-[#9aa6c4]">{label}: visible to Admin and the assigned Sales user only.</p>;
  if (!items?.length) return null;
  return (
    <div className="mt-[10px] flex flex-wrap gap-2 items-start">
      {items.map((file) => <Attachment key={file.key || file.path} {...file} />)}
    </div>
  );
}

/** Who did the last recorded action of a page, and when. */
function LastAction({ entry }) {
  if (!entry) return null;
  return <span className="text-[14px] text-[#9aa6c4]">Last action: {entry.action} · {entry.by || 'System'}{entry.role ? ` (${titleCase(entry.role)})` : ''} · {when(entry.at)}</span>;
}

function changeText(entry) {
  const oldV = entry.old_values || {};
  const newV = entry.new_values || {};
  const keys = [...new Set([...Object.keys(oldV), ...Object.keys(newV)])].filter((k) => typeof (newV[k] ?? oldV[k]) !== 'object');
  return keys.slice(0, 6).map((k) => `${titleCase(k.replace(/_/g, ' '))}: ${oldV[k] ?? '—'} → ${newV[k] ?? '—'}`).join(' · ');
}

export default function ApplicationDetailReport({ report, onClose }) {
  const data = report?.data;
  const [index, setIndex] = useState(0);
  const [historyPage, setHistoryPage] = useState('');
  const [printAll, setPrintAll] = useState(false);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [onClose]);

  // Printing: the app is hidden (body.ap-print-report) and only this report is printed.
  useEffect(() => {
    if (!printAll) return undefined;
    const done = () => { document.body.classList.remove('ap-print-report'); setPrintAll(false); };
    window.addEventListener('afterprint', done, { once: true });
    const timer = window.setTimeout(() => window.print(), 50);
    return () => { window.clearTimeout(timer); window.removeEventListener('afterprint', done); };
  }, [printAll]);
  const printPage = () => {
    document.body.classList.add('ap-print-report');
    window.addEventListener('afterprint', () => document.body.classList.remove('ap-print-report'), { once: true });
    window.print();
  };
  const printEverything = () => { document.body.classList.add('ap-print-report'); setPrintAll(true); };

  const a = data?.applicant;
  const stageIndex = a ? STAGE_ORDER.indexOf(a.status) : -1;
  const history = data?.history || [];
  const lastOf = (key) => [...history].reverse().find((h) => h.page === key) || null;
  const reached = (key) => {
    if (!PAGE_FROM[key]) return true;
    if (stageIndex >= STAGE_ORDER.indexOf(PAGE_FROM[key])) return true;
    return history.some((h) => h.page === key); // e.g. a rejected applicant who got this far
  };
  const pageState = (key) => {
    if (key === 'overview' || key === 'history') return null;
    if (!reached(key)) return { tone: 'waiting', label: 'Not started yet' };
    const next = { qualification: 'qualified', activities: 'loi_submitted', loi: 'payment_submitted', payment: 'for_approval', approval: 'active_franchisee' }[key];
    if (a.status === 'rejected') return { tone: 'bad', label: 'Rejected' };
    if (stageIndex >= STAGE_ORDER.indexOf(next)) return { tone: 'done', label: 'Done' };
    return { tone: 'current', label: 'In progress' };
  };
  const reqItems = (stage) => {
    const config = data?.requirements?.config?.requirements?.filter((r) => r.stage === stage) || [];
    return config.map((def) => ({ def, item: data.requirements.items.find((i) => i.key === def.key) || { status: 'pending', data: {} } }));
  };
  const reqFiles = (def, item) => (item.files === null ? null : (item.files || []).map((d) => ({
    key: `r${d.id}`, name: d.original_name, mime: d.mime_type, note: d.replaced_at ? 'Replaced' : '',
    path: `/applicants/${a.id}/requirements/${def.key}/documents/${d.id}/download`,
  })));

  const renderRequirementCards = (stage) => reqItems(stage).map(({ def, item }) => (
    <Card key={def.key} title={def.label} tone={item.status === 'returned' ? 'warn' : undefined}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Badge tone={{ accepted: 'done', submitted: 'current', returned: 'warn' }[item.status] || 'waiting'}>{REQ_STATUS[item.status] || item.status}</Badge>
      </div>
      <Pairs rows={[
        ...def.fields.map((field) => [field.label, field.type === 'date' ? day(item.data?.[field.key]) : (field.options?.find((o) => o.value === item.data?.[field.key])?.label ?? item.data?.[field.key])]),
        ['Submitted by', item.submitted_at ? `${nameOf(item.submitted_by) || '—'} · ${when(item.submitted_at)}` : 'Not submitted yet'],
        item.reviewed_at && [item.status === 'returned' ? 'Returned by' : 'Accepted by', `${nameOf(item.reviewed_by) || '—'} · ${when(item.reviewed_at)}`],
        item.status === 'returned' && ['Return reason', item.return_reason],
      ]} />
      <Files items={reqFiles(def, item)} />
    </Card>
  ));

  const pages = {
    overview: () => (
      <>
        <Card title="Applicant">
          <Pairs rows={[
            ['Name', a.full_name], ['Applicant ID', a.applicant_code], ['Lead ID', a.lead_code || 'No source lead (added directly)'],
            ['Email', a.email], ['Phone', a.phone], ['Address', a.address], ['Date applied', day(a.application_date)],
            ['Brand', a.preferred_brand?.name ? (
              <span className="inline-flex items-center gap-2">{a.preferred_brand.name}{data.brand_confirmation?.locked && <><FaLock aria-hidden="true" /> {data.brand_confirmation.legacy ? 'Locked (legacy)' : 'Locked'}</>}</span>
            ) : null],
            ['Assigned Sales', nameOf(data.people?.assigned_sales) || 'Unassigned'],
            ['Current stage', a.status_label],
            ['Time in this stage', data.monitor ? (
              <span>{data.monitor.days_in_stage} day{data.monitor.days_in_stage === 1 ? '' : 's'}{data.monitor.overdue && <> · <Badge tone="bad">Overdue</Badge></>}</span>
            ) : null],
            ['Notes', a.notes],
          ]} />
        </Card>
        <Card title={`Follow-ups (${(data.follow_ups || []).length})`}>
          {!(data.follow_ups || []).length ? <p className="m-0 text-[14px] text-[#9aa6c4]">No follow-up logged yet.</p> : (
            <ul className="m-0 p-0 [list-style:none] grid gap-2 text-[14px]">
              {data.follow_ups.map((f) => (
                <li key={f.id} className="p-[8px_10px] border border-[#2b344c] rounded-[9px]">
                  <strong className="text-[#edf0fa]">{titleCase(f.outcome.replace(/_/g, ' '))}</strong> · {titleCase(f.channel.replace(/_/g, ' '))} · {when(f.contacted_at)} · {f.by_name || '—'}
                  <div>{f.notes}</div>
                  {f.next_follow_up_at && <small className="text-[#9aa6c4]">Next follow-up: {when(f.next_follow_up_at)}</small>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    ),
    qualification: () => {
      const summary = data.requirements?.summary?.qualification;
      if (!reached('qualification')) return <NotStarted />;
      return (
        <>
          <Card title="Qualification">
            <Pairs rows={[
              ['Status', summary?.legacy ? 'Legacy record - requirements not captured' : summary?.complete ? 'Every requirement accepted' : `Missing: ${(summary?.missing || []).join(', ')}`],
              ['Confirmed Qualified by', data.people?.qualified_by ? `${nameOf(data.people.qualified_by)} · ${when(data.qualification?.qualified_at) || ''}` : null],
            ]} />
          </Card>
          {!summary?.legacy && renderRequirementCards('qualification')}
          {summary?.legacy && (
            <Card title="Older checklist (history)">
              <Pairs rows={(data.qualification?.items || []).map((item) => [item.label, item.completed ? `Checked${item.recorded_by ? ` · ${item.recorded_by}` : ''}${item.completed_at ? ` · ${item.completed_at}` : ''}` : 'Not checked'])} />
            </Card>
          )}
        </>
      );
    },
    activities: () => {
      if (!reached('activities')) return <NotStarted note="Activities start once Admin clicks Set Schedule." />;
      const rows = data.activity_rows || [];
      const bc = data.brand_confirmation;
      return (
        <>
          {['orientation', 'product_tasting', 'training'].map((type) => {
            const own = rows.filter((r) => r.activity_type === type && r.approval_status !== 'rejected');
            return (
              <Card key={type} title={ACTIVITY_LABELS[type]}>
                {!own.length && <p className="m-0 text-[14px] text-[#c9d0e0]"><strong>Not started yet</strong></p>}
                {own.map((r) => (
                  <div key={r.id} className="grid gap-2 [&+&]:mt-3 [&+&]:pt-3 [&+&]:border-t [&+&]:border-t-[#2a3041]">
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={r.status === 'completed' ? (r.review_status === 'accepted' || r.legacy_completion ? 'done' : 'current') : r.status === 'no_show' ? 'bad' : r.review_status === 'returned' ? 'warn' : 'waiting'}>
                        {r.status === 'no_show' ? 'No Show' : r.review_status === 'accepted' ? 'Attended (accepted)' : r.review_status === 'returned' ? 'Returned to Sales' : titleCase(r.status)}
                      </Badge>
                      {r.completed_before_schedule && <Badge tone="warn">Completed before schedule (legacy)</Badge>}
                    </div>
                    <Pairs rows={[
                      ['Scheduled', when(r.starts_at)], ['Venue', r.venue],
                      r.actual_started_at && ['Actual date and time', when(r.actual_started_at)],
                      r.handler_name && ['Handled by', r.handler_name],
                      r.tasted_brand_name && ['Brand tasted', r.tasted_brand_name],
                      r.result_notes && ['Notes', r.result_notes],
                      r.no_show_reason && ['No Show reason', r.no_show_reason],
                      r.completion_submitted_at && ['Completed by (Sales)', `${nameOf(r.completion_submitted_by) || '—'} · ${when(r.completion_submitted_at)}`],
                      r.reviewed_at && [r.review_status === 'returned' ? 'Returned by (Admin)' : 'Marked Attended by (Admin)', `${nameOf(r.reviewed_by) || '—'} · ${when(r.reviewed_at)}`],
                      r.review_status === 'returned' && ['Return reason', r.return_reason],
                    ]} />
                    <Files label="Attendance proof" items={r.proof_documents === null ? null : (r.proof_documents || []).map((d) => ({
                      key: `p${d.id}`, name: d.original_name, mime: d.mime_type, note: d.replaced_at ? 'Replaced' : '', path: `/activities/${r.id}/documents/${d.id}/download`,
                    }))} />
                  </div>
                ))}
              </Card>
            );
          })}
          <Card title="Brand Confirmation">
            {bc?.legacy && <p className="m-0 text-[14px] text-[#fbbf24]">Legacy - brand confirmation not captured. The brand is locked.</p>}
            {!bc?.legacy && !bc?.current && <p className="m-0 text-[14px] text-[#c9d0e0]"><strong>Not started yet</strong></p>}
            {bc?.current && (
              <Pairs rows={[
                ['Status', bc.confirmed ? <span className="inline-flex items-center gap-2"><FaLock aria-hidden="true" /> Confirmed and locked</span> : REQ_STATUS[bc.current.status] || titleCase(bc.current.status)],
                ['Final brand', bc.current.final_brand?.name], ['Brand tasted', bc.current.tasted_brand?.name],
                ['How the applicant confirmed', titleCase(String(bc.current.confirmation_method || '').replace(/_/g, ' '))], ['Date confirmed', day(bc.current.confirmed_on)],
                ['Notes', bc.current.notes], bc.current.change_reason && ['Reason for the change', bc.current.change_reason],
                ['Submitted by (Sales)', `${nameOf(bc.current.submitted_by) || '—'} · ${when(bc.current.submitted_at)}`],
                bc.confirmed && ['Confirmed by (Admin)', `${bc.locked_by || '—'} · ${when(bc.locked_at)}`],
                bc.current.status === 'returned' && ['Return reason', bc.current.return_reason],
              ]} />
            )}
          </Card>
        </>
      );
    },
    loi: () => {
      if (!reached('loi')) return <NotStarted />;
      const loi = data.loi || {};
      const req = data.requirements?.loi;
      return (
        <>
          <Card title="Letter of Intent">
            <Pairs rows={[
              ['Scanned LOI', req ? (req.legacy ? 'Legacy record - not captured' : REQ_STATUS[req.status] || req.status) : null],
              req?.status === 'returned' && ['Return reason', req.return_reason],
              ['Submission date', day(loi.submission_date)], ['Received by', loi.received_by],
              ['Submission type', { physical: 'Hard copy', digital: 'Soft copy', email: 'Email' }[loi.submission_type] || loi.submission_type],
              ['Verification', titleCase(String(loi.verification_status || '').replace(/_/g, ' '))],
              ['LOI status', loi.status ? titleCase(loi.status) : null],
              ['Verified by (Admin)', loi.verified_by ? `${loi.verified_by} · ${when(loi.verified_at) || ''}` : null],
              ['Remarks', loi.remarks],
            ]} />
            <Files label="LOI scans" items={data.loi_documents === null ? null : (data.loi_documents || []).map((d) => ({
              key: `l${d.id}`, name: d.original_name, mime: d.mime_type, path: `/applicants/${a.id}/documents/${d.id}/download`,
              note: d.removed_at ? `Removed${d.removed_reason ? `: ${d.removed_reason}` : ''}` : d.replaced_at ? 'Replaced' : '',
            }))} />
          </Card>
        </>
      );
    },
    payment: () => {
      if (!reached('payment')) return <NotStarted />;
      const record = data.payment_record;
      if (!record) return <NotStarted />;
      return (
        <>
          <Card title="Payment Record">
            <p className="m-[0_0_10px] text-[13px] text-[#9aa6c4]">Payments made outside the system, recorded here. The status comes only from Verified entries.</p>
            <Pairs rows={[
              ['Status', <Badge key="s" tone={{ fully_paid: 'done', partially_paid: 'current' }[record.status] || 'waiting'}>{record.status_label}</Badge>],
              ['Agreed Package Amount', record.agreed_amount === null ? 'Not set yet' : `${peso(record.agreed_amount)}${record.package_name ? ` · ${record.package_name}` : ''}${record.source ? ` · from ${record.source}` : ''}`],
              ['Verified', peso(record.verified_amount)], ['Waiting for review', peso(record.pending_amount)], ['Remaining', peso(record.remaining_amount)],
              record.legacy_discount && ['Earlier discount (read-only)', `${record.legacy_discount.discount_percent}% off ${peso(record.legacy_discount.original_amount)}`],
              ['Confirmed by (Admin)', data.people?.payment_confirmed_by ? nameOf(data.people.payment_confirmed_by) : null],
            ]} />
          </Card>
          {(record.entries || []).map((p, i) => (
            <Card key={p.id} title={`Entry ${i + 1} · ${peso(p.amount)}`} tone={p.status === 'returned' ? 'warn' : undefined}>
              <Pairs rows={[
                ['Status', p.status_label], ['Date paid', day(p.payment_date)], ['Method', p.payment_method_label],
                ['OR / AR number', p.or_number], ['Reference number', p.reference_number],
                ['Recorded by (Sales)', `${p.recorded_by || '—'}${p.recorded_at ? ` · ${when(p.recorded_at)}` : ''}`],
                p.verified_by && ['Verified by (Admin)', `${p.verified_by} · ${when(p.verified_at)}`],
                p.status === 'returned' && ['Returned by (Admin)', `${p.returned_by || '—'} · ${when(p.returned_at)}`],
                p.status === 'returned' && ['Return reason', p.returned_reason],
                p.remarks && ['Remarks', p.remarks],
              ]} />
              {p.legacy_no_receipt
                ? <p className="m-[8px_0_0] text-[13px] text-[#fbbf24]">Legacy - no receipt captured</p>
                : <Files label="Receipt" items={p.receipts === null ? null : (p.receipts || []).map((d) => ({ key: `pay${d.id}`, name: d.original_name, mime: d.mime_type, path: `/applicants/${a.id}/payments/${p.id}/documents/${d.id}/download` }))} />}
            </Card>
          ))}
          {!(record.entries || []).length && <Card><p className="m-0 text-[14px] text-[#c9d0e0]">No payment recorded yet.</p></Card>}
        </>
      );
    },
    approval: () => {
      if (!reached('approval')) return <NotStarted />;
      const ap = data.approval || {};
      const different = data.people?.prepared_and_approved_by_different_people;
      return (
        <>
          <Card title="Approval">
            <Pairs rows={[
              ...(ap.checkpoints || []).map((point) => [point.label, point.done ? 'Verified' : 'Pending']),
              ['Reviewed by (Admin)', ap.reviewed_by ? `${ap.reviewed_by} · ${when(ap.reviewed_at)}` : 'Not reviewed yet'],
              ap.review_remarks && ['Review remarks', ap.review_remarks],
              ['Approved by (Admin)', ap.approved_by ? `${ap.approved_by} · ${when(ap.approved_at)}` : 'Not approved yet'],
              ap.remarks && ['Approval remarks', ap.remarks],
              ['Prepared by (assigned Sales)', nameOf(data.people?.assigned_sales) || 'Unassigned'],
              different !== null && different !== undefined && ['Prepared and approved by different people', different ? 'Yes' : 'No'],
            ]} />
          </Card>
          {data.requirements?.summary?.activation?.legacy
            ? <Card title="Signed franchise agreement"><p className="m-0 text-[14px] text-[#fbbf24]">Legacy record - requirements not captured.</p></Card>
            : renderRequirementCards('activation')}
        </>
      );
    },
    history: () => {
      const shown = history.filter((h) => !historyPage || h.page === historyPage);
      return (
        <>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <label className="grid gap-1 text-[14px] text-[#9aa6c4]">Show
              <select value={historyPage} onChange={(e) => setHistoryPage(e.target.value)} className="h-[38px] p-[0_10px] rounded-[9px] border border-[#353e57] [background:#0c111d] text-[#edf0fa]">
                <option value="">Every stage</option>
                {PAGES.filter((p) => p.key !== 'history').map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </label>
            <small className="text-[#9aa6c4]">{shown.length} action(s), oldest first</small>
          </div>
          {!shown.length && <Card><p className="m-0 text-[14px]">Nothing recorded for this stage yet.</p></Card>}
          <ol className="m-0 p-0 [list-style:none] grid gap-2">
            {shown.map((h) => (
              <li key={h.id} className="p-[10px_12px] border border-[#2a3041] rounded-[10px] [background:#141a28] text-[14px] leading-[1.5] break-inside-avoid">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong className="text-[#edf0fa]">{h.action}</strong>
                  <span className="text-[#9aa6c4]">{when(h.at)}</span>
                </div>
                <div className="text-[#c9d0e0]">{h.by || 'System'}{h.role ? ` (${titleCase(h.role)})` : ''} · {PAGES.find((p) => p.key === h.page)?.label}</div>
                {h.reason && <div>Reason / remarks: {h.reason}</div>}
                {changeText(h) && <div className="text-[#9aa6c4]">{changeText(h)}</div>}
                {(h.attachments || []).length > 0 && (
                  <div className="text-[#9aa6c4]">Files: {h.attachments.map((f) => (f.hidden ? 'a file (private)' : `${f.original_name}${f.state ? ` (${titleCase(f.state)})` : ''}`)).join(', ')}</div>
                )}
              </li>
            ))}
          </ol>
        </>
      );
    },
  };

  const exportReport = (kind) => {
    if (!data) return;
    const rows = [['Overview', 'Applicant ID', a.applicant_code || ''], ['Overview', 'Name', a.full_name], ['Overview', 'Current stage', a.status_label],
      ['Overview', 'Assigned Sales', nameOf(data.people?.assigned_sales) || 'Unassigned']];
    reqItems('qualification').forEach(({ def, item }) => rows.push(['Qualification', def.label, REQ_STATUS[item.status] || item.status]));
    (data.activity_rows || []).forEach((r) => rows.push(['Scheduled Activities', ACTIVITY_LABELS[r.activity_type] || r.activity_type, `${titleCase(r.status)}${r.review_status ? ` / ${r.review_status}` : ''} · ${when(r.starts_at) || ''}`]));
    if (data.loi) rows.push(['LOI', 'Verification', titleCase(String(data.loi.verification_status || '').replace(/_/g, ' '))]);
    if (data.payment_record) {
      rows.push(['Payment Record', 'Status', data.payment_record.status_label], ['Payment Record', 'Agreed Package Amount', peso(data.payment_record.agreed_amount) || '']);
      data.payment_record.entries.forEach((p) => rows.push(['Payment Record', `OR ${p.or_number || '—'}`, `${peso(p.amount)} · ${p.status_label}`]));
    }
    rows.push(['Approval', 'Approved by', data.approval?.approved_by || 'Not approved yet']);
    history.forEach((h) => rows.push(['History', `${when(h.at)} · ${h.by || 'System'}`, `${h.action}${h.reason ? ` — ${h.reason}` : ''}`]));
    const name = `${a.applicant_code || `applicant-${a.id}`}-${a.full_name}`.replace(/[^\w-]+/g, '-').toLowerCase();
    if (kind === 'pdf') downloadPdf(name, ['Page', 'Item', 'Value'], rows, 'Application Detail', `${a.full_name} · ${a.applicant_code || ''} · ${a.status_label}`);
    else downloadCsv(name, ['Page', 'Item', 'Value'], rows);
  };

  const page = PAGES[index];
  const renderPrintHeader = (title) => (
    <header className="hidden print:block mb-3 pb-2 border-b border-[#999]">
      <strong className="block text-[18px]">{a.full_name} · {a.applicant_code || '—'}</strong>
      <span className="text-[13px]">{title} · Application Detail · Printed {manilaDateTimeLabel(new Date())}</span>
    </header>
  );
  const renderPage = (item) => {
    const state = pageState(item.key);
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="m-0 text-[18px] text-[#edf0fa]">{item.label}</h3>
          {state && <Badge tone={state.tone}>{state.label}</Badge>}
          {item.key !== 'history' && <LastAction entry={lastOf(item.key)} />}
        </div>
        {pages[item.key]()}
      </div>
    );
  };

  return createPortal(
    <div className="contents print:[body.ap-print-report_&]:block!">
      <div className="fixed inset-0 z-[2147482100] flex items-center justify-center p-5 [background:rgba(4,_7,_14,_.72)] [backdrop-filter:blur(3px)] max-[640px]:p-0 print:static print:p-0 print:[background:none]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div role="dialog" aria-modal="true" aria-label="Application Detail" className="flex flex-col w-[min(980px,_100%)] max-h-[calc(100dvh_-_40px)] overflow-hidden border border-[#2a3550] rounded-[12px] [background:#0f1626] text-[#e7e9f2] text-[14px] max-[640px]:max-h-[100dvh] max-[640px]:h-[100dvh] max-[640px]:rounded-none print:max-h-none print:overflow-visible print:border-0 print:[background:none] print:**:text-black! print:**:[background:none]! print:**:border-[#bbb]!">
          <header className="flex flex-none items-start justify-between gap-4 p-[16px_20px] border-b border-b-[#1f2842] print:hidden">
            <div className="min-w-0">
              <span className="block text-[#8f9bbd] text-[12px] font-[700] tracking-[.12em] uppercase">Application Detail{a ? ` · Current stage: ${a.status_label}` : ''}</span>
              <h2 className="m-[2px_0_0] text-[19px] text-[#f1f3fb]">{a ? `${a.full_name}${a.applicant_code ? ` · ${a.applicant_code}` : ''}` : 'Loading…'}</h2>
            </div>
            <button type="button" aria-label="Close" onClick={onClose} className="grid place-items-center w-[36px] h-[36px] rounded-[10px] border border-[#353e57] [background:#1a2133]"><FaXmark aria-hidden="true" /></button>
          </header>
          {data && (
            <nav className="flex-none p-[10px_20px] border-b border-b-[#1f2842] print:hidden" aria-label="Report pages">
              <div className="flex flex-wrap gap-[6px] max-[640px]:hidden" role="tablist">
                {PAGES.map((item, i) => (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    onClick={() => setIndex(i)}
                    className={`min-h-[36px] p-[0_12px] rounded-[9px] border text-[14px] ${i === index ? 'border-[color:var(--accent)] text-[#fff] [background:color-mix(in_srgb,_var(--accent)_22%,_transparent)]' : 'border-[#2a3041] text-[#c9d0e0] [background:#141a28]'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <select className="hidden max-[640px]:block w-full h-[42px] p-[0_10px] rounded-[10px] border border-[#353e57] [background:#0c111d] text-[#edf0fa] text-[15px]" value={index} onChange={(e) => setIndex(Number(e.target.value))} aria-label="Report page">
                {PAGES.map((item, i) => <option key={item.key} value={i}>{i + 1}. {item.label}</option>)}
              </select>
            </nav>
          )}
          <div className="flex-[1_1_auto] min-h-0 overflow-y-auto p-[16px_20px] print:overflow-visible">
            {report?.loading && <p className="text-[15px]">Loading the Application Detail…</p>}
            {report?.error && <p className="text-[15px] text-[#ff9ca3]" role="alert">{report.error}</p>}
            {data && !printAll && (
              <>
                {renderPrintHeader(page.label)}
                {renderPage(page)}
              </>
            )}
            {data && printAll && PAGES.map((item, i) => (
              <div key={item.key} className={i > 0 ? 'print:[break-before:page] mt-6' : ''}>
                {renderPrintHeader(item.label)}
                {renderPage(item)}
              </div>
            ))}
          </div>
          {data && (
            <footer className="flex flex-none flex-wrap items-center justify-between gap-[10px] p-[12px_20px] border-t border-t-[#1f2842] [background:rgba(8,_12,_22,_.45)] print:hidden">
              <span className="flex items-center gap-2">
                <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)} className="inline-flex items-center gap-2 min-h-[38px] p-[0_12px]"><FaChevronLeft aria-hidden="true" /> Back</button>
                <span className="text-[14px] text-[#9aa6c4]" aria-live="polite">{index + 1} of {PAGES.length}</span>
                <button type="button" disabled={index === PAGES.length - 1} onClick={() => setIndex(index + 1)} className="inline-flex items-center gap-2 min-h-[38px] p-[0_12px]">Next <FaChevronRight aria-hidden="true" /></button>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={printPage} className="inline-flex items-center gap-2"><FaPrint aria-hidden="true" /> Print this page</button>
                <button type="button" onClick={printEverything} className="inline-flex items-center gap-2 text-[13px] opacity-90">Print all pages</button>
                <button type="button" onClick={() => exportReport('csv')} className="inline-flex items-center gap-2"><FaFileCsv aria-hidden="true" /> CSV</button>
                <button type="button" onClick={() => exportReport('pdf')} className="inline-flex items-center gap-2"><FaFilePdf aria-hidden="true" /> PDF</button>
              </span>
            </footer>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
