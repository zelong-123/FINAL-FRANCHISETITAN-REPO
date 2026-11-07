import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Download a table as CSV (Excel-friendly, BOM-prefixed). */
export function downloadCsv(filename, headers, rows) {
  const csv = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => row.map(csvCell).join(',')),
  ].join('\r\n');
  triggerDownload(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' }), `${filename}-${stamp()}.csv`);
}

/** Download a table as a styled PDF document. */
export function downloadPdf(filename, headers, rows, title = filename, subtitle = '') {
  const landscape = headers.length > 5;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(17, 24, 39);
  doc.text(title, 40, 38);
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    doc.text(subtitle, 40, 54);
  }

  autoTable(doc, {
    head: [headers],
    body: rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))),
    startY: 68,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 6, textColor: [31, 41, 55], lineColor: [229, 231, 235], lineWidth: 0.5 },
    headStyles: { fillColor: [72, 105, 235], textColor: 255, fontStyle: 'bold', halign: 'left' },
    alternateRowStyles: { fillColor: [246, 248, 252] },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      const { pageSize } = doc.internal;
      doc.setFontSize(7.5);
      doc.setTextColor(156, 163, 175);
      doc.text(
        `Franchise Titan · exported ${new Date().toLocaleString()}`,
        40,
        pageSize.getHeight() - 18,
      );
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, pageWidth - 40, pageSize.getHeight() - 18, { align: 'right' });
    },
  });

  doc.save(`${filename}-${stamp()}.pdf`);
}
