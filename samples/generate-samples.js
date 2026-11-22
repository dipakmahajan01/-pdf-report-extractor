// Generates the sample lab reports used for testing and the demo.
// All patient data is fictional.
//
//   npm install && npm run generate
//
// Each report is described once (layout below) and rendered either as a digital
// PDF with real text (pdfkit) or as a "scanned" PDF that only contains an image
// of the page (@napi-rs/canvas), optionally tilted and noisy.

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createCanvas } from '@napi-rs/canvas';

const OUT_DIR = import.meta.dirname;
const PAGE_W = 595; // A4 in points
const PAGE_H = 842;
const TABLE_BOTTOM = 770;
const ROW_H = 18;

// ---------------------------------------------------------------------------
// Layout: turns a report description into positioned text items and lines.
// ---------------------------------------------------------------------------

function layout(report) {
  const pages = [];
  let items;
  let y;

  const newPage = (withHeader) => {
    items = [];
    pages.push(items);
    y = 50;
    items.push({ type: 'text', text: report.lab, x: 50, y, size: 16, bold: true });
    y += 22;
    items.push({ type: 'text', text: report.labAddress ?? 'Andheri East, Mumbai - 400069', x: 50, y, size: 9 });
    y += 26;
    if (withHeader) {
      for (const [i, [label, value]] of report.meta.entries()) {
        const col = i % 2;
        items.push({ type: 'text', text: `${label}: ${value}`, x: col === 0 ? 50 : 320, y, size: 10 });
        if (col === 1 || i === report.meta.length - 1) y += 16;
      }
      y += 10;
      if (report.title) {
        items.push({ type: 'text', text: report.title, x: 50, y, size: 12, bold: true });
        y += 22;
      }
    }
    items.push({ type: 'line', x1: 50, x2: 545, y: y - 4 });
    for (const col of report.columns) {
      items.push({ type: 'text', text: col.title, x: col.x, y, size: 10, bold: true });
    }
    y += 16;
    items.push({ type: 'line', x1: 50, x2: 545, y: y - 2 });
    y += 4;
  };

  newPage(true);
  for (const row of report.rows) {
    const needed = row.wrap ? ROW_H * 2 : ROW_H;
    if (y + needed > TABLE_BOTTOM) {
      items.push({ type: 'text', text: 'Continued on next page...', x: 50, y: TABLE_BOTTOM + 10, size: 8 });
      newPage(false);
    }
    if (row.section) {
      items.push({ type: 'text', text: row.section, x: 50, y, size: 10, bold: true });
      y += ROW_H;
      continue;
    }
    report.columns.forEach((col, i) => {
      const value = row.cells[i];
      if (value) items.push({ type: 'text', text: value, x: col.x, y, size: 10 });
    });
    y += ROW_H;
    if (row.wrap) {
      items.push({ type: 'text', text: row.wrap, x: report.columns[0].x, y: y - 4, size: 10 });
      y += ROW_H - 4;
    }
  }
  y += 10;
  items.push({ type: 'line', x1: 50, x2: 545, y });
  items.push({ type: 'text', text: '*** End of Report ***', x: 230, y: y + 12, size: 9 });
  items.push({ type: 'text', text: 'Dr. A. Kulkarni, MD (Pathology) - Consultant Pathologist', x: 50, y: y + 50, size: 9 });
  return pages;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderDigital(report, file) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: report.lab } });
  doc.pipe(fs.createWriteStream(path.join(OUT_DIR, file)));
  layout(report).forEach((items, i) => {
    if (i > 0) doc.addPage({ size: 'A4', margin: 0 });
    for (const it of items) {
      if (it.type === 'line') {
        doc.moveTo(it.x1, it.y).lineTo(it.x2, it.y).lineWidth(0.5).stroke('#555555');
      } else {
        doc.font(it.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(it.size).fillColor('#000000');
        doc.text(it.text, it.x, it.y, { lineBreak: false });
      }
    }
  });
  doc.end();
}

function renderScanned(report, file, { dpi = 200, tiltDeg = 0, noise = 0, blur = 0 } = {}) {
  const scale = dpi / 72;
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(fs.createWriteStream(path.join(OUT_DIR, file)));
  layout(report).forEach((items, i) => {
    const canvas = createCanvas(Math.round(PAGE_W * scale), Math.round(PAGE_H * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (tiltDeg) {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((tiltDeg * Math.PI) / 180);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);
    }
    if (blur) ctx.filter = `blur(${blur}px)`;
    ctx.fillStyle = '#1a1a1a';
    ctx.strokeStyle = '#444444';
    ctx.textBaseline = 'top';
    for (const it of items) {
      if (it.type === 'line') {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(it.x1 * scale, it.y * scale);
        ctx.lineTo(it.x2 * scale, it.y * scale);
        ctx.stroke();
      } else {
        ctx.font = `${it.bold ? 'bold ' : ''}${Math.round(it.size * scale)}px Arial`;
        ctx.fillText(it.text, it.x * scale, it.y * scale);
      }
    }
    ctx.restore();
    // Speckle noise, like dust on a scanner glass.
    for (let n = 0; n < noise; n++) {
      const g = Math.floor(Math.random() * 120);
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    if (i > 0) doc.addPage({ size: 'A4', margin: 0 });
    doc.image(canvas.toBuffer('image/png'), 0, 0, { width: PAGE_W, height: PAGE_H });
  });
  doc.end();
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

const STD_COLUMNS = [
  { title: 'Test Name', x: 50 },
  { title: 'Result', x: 250 },
  { title: 'Unit', x: 330 },
  { title: 'Reference Range', x: 420 },
];

const row = (...cells) => ({ cells });

const basic = {
  lab: 'CITY DIAGNOSTIC LABORATORY',
  meta: [
    ['Patient Name', 'Ramesh Patil'],
    ['Sample ID', 'SMP-20481'],
    ['Age/Sex', '45 Y / M'],
    ['Report Date', '18/11/2026'],
  ],
  title: 'BIOCHEMISTRY',
  columns: STD_COLUMNS,
  rows: [
    row('Glucose Fasting', '96', 'mg/dL', '70 - 110'),
    row('Urea', '28', 'mg/dL', '15 - 45'),
    row('Creatinine', '0.9', 'mg/dL', '0.6 - 1.3'),
    row('Uric Acid', '6.1', 'mg/dL', '3.5 - 7.2'),
    row('Total Protein', '7.2', 'g/dL', '6.0 - 8.3'),
    row('Albumin', '4.4', 'g/dL', '3.5 - 5.2'),
    row('Calcium', '9.6', 'mg/dL', '8.5 - 10.5'),
    row('Sodium', '139', 'mmol/L', '135 - 145'),
  ],
};

const lipid = {
  lab: 'CITY DIAGNOSTIC LABORATORY',
  meta: [
    ['Patient Name', 'Sunita Deshmukh'],
    ['Sample ID', 'SMP-20502'],
    ['Age/Sex', '52 Y / F'],
    ['Report Date', '19-Nov-2026'],
  ],
  title: 'LIPID PROFILE',
  columns: STD_COLUMNS,
  rows: [
    row('Total Cholesterol', '245 H', 'mg/dL', '< 200'),
    row('Triglycerides', '180 H', 'mg/dL', '< 150'),
    row('HDL Cholesterol', '38 L', 'mg/dL', '> 40'),
    row('LDL Cholesterol', '171 H', 'mg/dL', '< 130'),
    row('VLDL Cholesterol', '36', 'mg/dL', '5 - 40'),
    row('Non-HDL Cholesterol', '207 H', 'mg/dL', '< 160'),
    row('Total Chol / HDL Ratio', '6.4 H', 'ratio', '3.5 - 5.0'),
    row('LDL / HDL Ratio', '4.5 H', 'ratio', '1.5 - 3.5'),
    row('Apolipoprotein A1', '118', 'mg/dL', '110 - 205'),
    row('Apolipoprotein B', '132 H', 'mg/dL', '55 - 125'),
  ],
};

const cbc = {
  lab: 'SHREE PATHOLOGY LAB',
  labAddress: 'Kothrud, Pune - 411038',
  meta: [
    ['Name', 'Mr. Anil Joshi'],
    ['Lab No.', 'SPL/2026/7781'],
    ['Age/Gender', '38 Years / Male'],
    ['Reported On', '2026-11-20'],
  ],
  title: 'COMPLETE BLOOD COUNT',
  columns: [
    { title: 'Investigation', x: 50 },
    { title: 'Observed Value', x: 230 },
    { title: 'Units', x: 330 },
    { title: 'Biological Ref. Interval', x: 410 },
  ],
  rows: [
    row('Haemoglobin', '13.8', 'g/dL', '13.0 - 17.0'),
    row('Total RBC Count', '4.9', 'mill/cumm', '4.5 - 5.5'),
    row('Packed Cell Volume', '42.1', '%', '40 - 50'),
    row('MCV', '86', 'fL', '83 - 101'),
    row('MCH', '28.2', 'pg', '27 - 32'),
    row('MCHC', '32.8', 'g/dL', '31.5 - 34.5'),
    row('RDW', '13.1', '%', '11.6 - 14.0'),
    row('Total WBC Count', '11800', 'cells/cumm', '4000 - 11000'),
    row('Neutrophils', '72 H', '%', '40 - 70'),
    row('Lymphocytes', '21', '%', '20 - 40'),
    row('Platelet Count', '1,85,000', 'cells/cumm', '150000 - 410000'),
    row('ESR', '18 H', 'mm/hr', '0 - 15'),
  ],
};

const differentLayout = {
  lab: 'METRO HEALTH DIAGNOSTICS',
  labAddress: 'Vashi, Navi Mumbai - 400703',
  meta: [
    ['Patient', 'Priya Nair'],
    ['Accession No', 'MHD-55120'],
    ['Sex/Age', 'F / 29'],
    ['Date', '20/11/2026'],
  ],
  title: 'THYROID & VITAMIN PANEL',
  columns: [
    { title: 'Parameter', x: 50 },
    { title: 'Reference Range', x: 185 },
    { title: 'Result', x: 300 },
    { title: 'Unit', x: 365 },
    { title: 'Method', x: 445 },
  ],
  rows: [
    row('T3, Total', '80 - 200', '112', 'ng/dL', 'CLIA'),
    row('T4, Total', '5.1 - 14.1', '8.4', 'µg/dL', 'CLIA'),
    row('TSH', '0.27 - 4.2', '5.9', 'µIU/mL', 'CLIA'),
    row('Vitamin D (25-OH)', '30 - 100', '18.2', 'ng/mL', 'CLIA'),
    row('Vitamin B12', '211 - 911', '342', 'pg/mL', 'CLIA'),
    row('Ferritin', '13 - 150', '41', 'ng/mL', 'CLIA'),
    row('Iron', '50 - 170', '64', 'µg/dL', 'Ferrozine'),
    row('HbA1c', '4.0 - 5.6', '5.4', '%', 'HPLC'),
    row('Fasting Insulin', '2.6 - 24.9', '9.8', 'µIU/mL', 'CLIA'),
  ],
};

const specialValues = {
  lab: 'CITY DIAGNOSTIC LABORATORY',
  meta: [
    ['Patient Name', 'Mohan Kale'],
    ['Sample ID', 'SMP-20533'],
    ['Age/Sex', '61 Y / M'],
    ['Report Date', '20/11/2026'],
  ],
  title: 'SEROLOGY & URINE EXAMINATION',
  columns: STD_COLUMNS,
  rows: [
    row('C-Reactive Protein', '<5', 'mg/L', '0 - 5'),
    row('Rheumatoid Factor', '<10', 'IU/mL', '< 14'),
    row('Ferritin', '>1000', 'ng/mL', '30 - 400'),
    row('HIV I & II Antibody', 'Non Reactive', '', 'Non Reactive'),
    row('HBsAg', 'Negative', '', 'Negative'),
    row('Dengue NS1 Antigen', 'Positive', '', 'Negative'),
    row('Urine Sugar', 'Nil', '', 'Nil'),
    row('Urine Albumin', 'Trace', '', 'Nil'),
    row('Pus Cells', '2-4', '/hpf', '0 - 5'),
    row('VDRL', 'Reactive', '', 'Non Reactive'),
  ],
};

const missingFields = {
  lab: 'CITY DIAGNOSTIC LABORATORY',
  meta: [
    ['Patient Name', 'Kavita Shinde'],
    ['Sample ID', 'SMP-20547'],
    ['Age/Sex', '34 Y / F'],
    ['Report Date', '21/11/2026'],
  ],
  title: 'LIVER FUNCTION TEST',
  columns: STD_COLUMNS,
  rows: [
    row('Bilirubin Total', '0.8', 'mg/dL', '0.2 - 1.2'),
    row('Bilirubin Direct', '0.2', 'mg/dL', ''),
    row('Bilirubin Indirect', '0.6', '', ''),
    row('SGOT (AST)', '32', 'U/L', '< 40'),
    row('SGPT (ALT)', '45 H', 'U/L', '< 41'),
    row('Alkaline Phosphatase', '', 'U/L', '40 - 129'),
    row('GGT', '28', 'U/L', ''),
    row('A/G Ratio', '1.6', '', '1.1 - 2.2'),
  ],
};

const noReportId = {
  lab: 'SUNRISE CLINIC LAB',
  labAddress: 'Thane West - 400601',
  meta: [
    ['Patient Name', 'Vijay Pawar'],
    ['Referred By', 'Dr. S. Mehta'],
    ['Age/Sex', '40 Y / M'],
    ['Report Date', '21/11/2026'],
  ],
  title: 'KIDNEY FUNCTION TEST',
  columns: STD_COLUMNS,
  rows: [
    row('Blood Urea', '31', 'mg/dL', '15 - 45'),
    row('BUN', '14.5', 'mg/dL', '7 - 21'),
    row('Serum Creatinine', '1.1', 'mg/dL', '0.7 - 1.3'),
    row('Uric Acid', '7.9 H', 'mg/dL', '3.5 - 7.2'),
    row('Sodium', '141', 'mmol/L', '135 - 145'),
    row('Potassium', '4.3', 'mmol/L', '3.5 - 5.1'),
    row('Chloride', '102', 'mmol/L', '98 - 107'),
  ],
};

const multiPage = {
  lab: 'CITY DIAGNOSTIC LABORATORY',
  meta: [
    ['Patient Name', 'Rahul Kulkarni'],
    ['Sample ID', 'SMP-20560'],
    ['Age/Sex', '47 Y / M'],
    ['Report Date', '21/11/2026'],
  ],
  title: 'FULL BODY CHECK-UP',
  columns: STD_COLUMNS,
  rows: [
    { section: 'HAEMATOLOGY' },
    row('Hemoglobin', '14.2', 'g/dL', '13.0 - 17.0'),
    row('Total WBC Count', '7600', 'cells/cumm', '4000 - 11000'),
    row('Platelet Count', '245000', 'cells/cumm', '150000 - 410000'),
    row('ESR', '9', 'mm/hr', '0 - 15'),
    { section: 'DIABETES' },
    { cells: ['Glucose Fasting', '118 H', 'mg/dL', '70 - 110'], wrap: '(Plasma, Hexokinase)' },
    { cells: ['Glucose Post Prandial', '162 H', 'mg/dL', '70 - 140'], wrap: '(Plasma, 2 hrs after meal)' },
    row('HbA1c', '6.3 H', '%', '4.0 - 5.6'),
    { section: 'LIPID PROFILE' },
    row('Total Cholesterol', '212 H', 'mg/dL', '< 200'),
    row('Triglycerides', '148', 'mg/dL', '< 150'),
    row('HDL Cholesterol', '44', 'mg/dL', '> 40'),
    row('LDL Cholesterol', '138 H', 'mg/dL', '< 130'),
    { section: 'LIVER FUNCTION' },
    row('Bilirubin Total', '0.9', 'mg/dL', '0.2 - 1.2'),
    row('SGOT (AST)', '29', 'U/L', '< 40'),
    row('SGPT (ALT)', '36', 'U/L', '< 41'),
    row('Alkaline Phosphatase', '88', 'U/L', '40 - 129'),
    row('Total Protein', '7.1', 'g/dL', '6.0 - 8.3'),
    row('Albumin', '4.3', 'g/dL', '3.5 - 5.2'),
    { section: 'KIDNEY FUNCTION' },
    row('Blood Urea', '30', 'mg/dL', '15 - 45'),
    row('Serum Creatinine', '1.0', 'mg/dL', '0.7 - 1.3'),
    row('Uric Acid', '6.8', 'mg/dL', '3.5 - 7.2'),
    { section: 'THYROID' },
    row('T3, Total', '118', 'ng/dL', '80 - 200'),
    row('T4, Total', '7.9', 'µg/dL', '5.1 - 14.1'),
    row('TSH', '2.4', 'µIU/mL', '0.27 - 4.2'),
    { section: 'VITAMINS' },
    row('Vitamin D (25-OH)', '22.5 L', 'ng/mL', '30 - 100'),
    row('Vitamin B12', '410', 'pg/mL', '211 - 911'),
    { section: 'ELECTROLYTES' },
    row('Sodium', '140', 'mmol/L', '135 - 145'),
    row('Potassium', '4.6', 'mmol/L', '3.5 - 5.1'),
  ],
};

// Scanned copies use their own IDs so they are not rejected as duplicate report IDs.
const scannedClean = {
  ...basic,
  meta: [
    ['Patient Name', 'Neha Gupta'],
    ['Sample ID', 'SMP-20590'],
    ['Age/Sex', '31 Y / F'],
    ['Report Date', '21/11/2026'],
  ],
};
const scannedNoisy = {
  ...lipid,
  meta: [
    ['Patient Name', 'Arjun Rao'],
    ['Sample ID', 'SMP-20611'],
    ['Age/Sex', '56 Y / M'],
    ['Report Date', '21/11/2026'],
  ],
};

// ---------------------------------------------------------------------------

renderDigital(basic, '01-basic-8-params.pdf');
renderDigital(lipid, '02-lipid-10-params-flags.pdf');
renderDigital(cbc, '03-cbc-12-params-other-headers.pdf');
renderDigital(differentLayout, '04-different-column-order-with-method.pdf');
renderDigital(specialValues, '05-special-values.pdf');
renderDigital(missingFields, '06-missing-fields.pdf');
renderDigital(noReportId, '07-no-report-id.pdf');
renderDigital(multiPage, '08-multipage-sections-33-params.pdf');
renderScanned(scannedClean, '09-scanned-clean.pdf', { dpi: 200 });
renderScanned(scannedNoisy, '10-scanned-tilted-noisy.pdf', { dpi: 150, tiltDeg: 1.2, noise: 6000, blur: 0.6 });

fs.writeFileSync(path.join(OUT_DIR, '11-not-a-pdf.pdf'), 'This is a plain text file renamed to .pdf\n');

// A real PDF cut in half once it has been written.
setTimeout(() => {
  const full = fs.readFileSync(path.join(OUT_DIR, '01-basic-8-params.pdf'));
  fs.writeFileSync(path.join(OUT_DIR, '12-corrupted.pdf'), full.subarray(0, Math.floor(full.length / 2)));
  console.log('Sample PDFs written to', OUT_DIR);
}, 1500);
