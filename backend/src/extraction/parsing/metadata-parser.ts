import type { Line, ReportMetadata } from '../types.js';

const ID_PATTERN =
  /\b(?:report\s*id|sample\s*id|sample\s*no|lab\s*no|accession\s*no|reg(?:istration)?\s*no|barcode|specimen\s*id)\b\.?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9\-/]{2,99})/i;

const PATIENT_PATTERN =
  /\b(?:patient\s*name|patient|name)\s*[:-]\s*(?:(?:mr|mrs|ms|miss|master|baby)\.?\s+)?([A-Za-z][A-Za-z .']{1,60}?)(?=\s+(?:age|sex|gender|sample|lab|accession|report|reg|date|referred|ref\.?)\b|\s{2,}|$)/i;

const DATE_PATTERN =
  /\b(?:report(?:ed)?\s*(?:on|date)|collected\s*on|date)\s*[:-]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{4}|\d{4}-\d{2}-\d{2})/i;

const LAB_KEYWORDS = /\b(lab|labs|laboratory|diagnostic|diagnostics|pathology|clinic|hospital|health|path)\b/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Reads report ID, patient name, report date and lab name from the lines above the table. */
export function parseMetadata(lines: Line[]): ReportMetadata {
  const meta: ReportMetadata = {};
  for (const line of lines) {
    meta.reportId ??= line.text.match(ID_PATTERN)?.[1]?.toUpperCase();
    meta.patientName ??= line.text.match(PATIENT_PATTERN)?.[1]?.trim();
    meta.reportDate ??= toIsoDate(line.text.match(DATE_PATTERN)?.[1]);
  }
  const labLine = lines.slice(0, 4).find((l) => LAB_KEYWORDS.test(l.text));
  if (labLine) meta.labName = labLine.text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return meta;
}

/** Day-first dates (Indian format). Returns undefined for impossible or future dates. */
export function toIsoDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  let day: number;
  let month: number;
  let year: number;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const numeric = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  const named = raw.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (numeric) [day, month, year] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
  else if (named) {
    day = Number(named[1]);
    month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    year = Number(named[3]);
  } else return undefined;

  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    month >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    year >= 1900 &&
    date.getTime() <= Date.now() + 24 * 3600 * 1000;
  return valid ? date.toISOString().slice(0, 10) : undefined;
}
