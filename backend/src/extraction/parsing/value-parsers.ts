import { KNOWN_UNITS, TEST_NAME_SYNONYMS, UNIT_ALIASES } from './dictionaries.js';

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;

export interface ParsedValue {
  valueNumeric?: number;
  comparator?: string;
}

/** "13.5" -> 13.5, "1,85,000" -> 185000, "<5" -> 5 with comparator "<". Words ("Positive", "Nil") stay text only. */
export function parseValue(raw?: string): ParsedValue {
  if (!raw) return {};
  const match = raw.replace(/,/g, '').trim().match(new RegExp(`^([<>]=?)?\\s*(${NUMBER})$`));
  if (!match) return {};
  return { valueNumeric: Number(match[2]), comparator: match[1] || undefined };
}

export interface ParsedRange {
  refLow?: number;
  refHigh?: number;
  invalid?: boolean;
}

/** "13 - 17", "4 to 11", "< 200", "Up to 5", "> 40". Text ranges ("Negative", gender-specific) return nothing. */
export function parseRange(raw?: string): ParsedRange {
  if (!raw) return {};
  const text = raw.replace(/,/g, '').trim();

  let m = text.match(new RegExp(`^(${NUMBER})\\s*(?:-|–|—|to)\\s*(${NUMBER})$`, 'i'));
  if (m) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    return low <= high ? { refLow: low, refHigh: high } : { invalid: true };
  }
  m = text.match(new RegExp(`^(?:<=?|≤|up\\s*to|upto|below|less\\s+than)\\s*(${NUMBER})$`, 'i'));
  if (m) return { refHigh: Number(m[1]) };
  m = text.match(new RegExp(`^(?:>=?|≥|above|more\\s+than|greater\\s+than)\\s*(${NUMBER})$`, 'i'));
  if (m) return { refLow: Number(m[1]) };
  return {};
}

const FLAG_PATTERN = /^(.*?\d)\s*(H|L|\*|↑|↓)$/;
const NUMERIC_CELL = /^[<>]?=?\s*[\d.,]+$/;

/** "128 H" -> { value: "128", flag: "H" }. Only applied when the rest is a number. */
export function splitFlag(raw: string): { value: string; flag?: 'H' | 'L' } {
  const m = raw.trim().match(FLAG_PATTERN);
  if (!m || !NUMERIC_CELL.test(m[1])) return { value: raw.trim() };
  const flag = m[2] === 'L' || m[2] === '↓' ? 'L' : 'H';
  return { value: m[1].trim(), flag };
}

/** "13.5g/dL" -> { value: "13.5", unit: "g/dL" }. */
export function splitValueUnit(raw: string): { value: string; unit?: string } {
  const m = raw.trim().match(/^((?:[<>]=?)?\s*\d[\d.,]*)\s*([A-Za-zµμ%/][A-Za-zµμ%/^.\d]*)$/);
  if (!m || !isUnit(m[2])) return { value: raw.trim() };
  return { value: m[1].trim(), unit: m[2] };
}

/** OCR often reads 0 as O and 1 as l/I inside numbers. Fixed only when the cell is otherwise numeric. */
export function fixOcrDigits(raw: string): string {
  if (!/\d/.test(raw) || !/^[<>]?=?\s*[\dOoIlS.,]+(\s*[HL])?$/.test(raw)) return raw;
  return raw.replace(/[Oo]/g, '0').replace(/[Il](?!$)/g, '1').replace(/S/g, '5');
}

export function isUnit(text: string): boolean {
  const t = text.toLowerCase().replace(/μ/g, 'µ');
  return KNOWN_UNITS.includes(t) || /^[a-zµ%]+\/[a-zµ\d^]+$/i.test(t);
}

export function normalizeUnit(unit?: string): string | undefined {
  if (!unit) return undefined;
  const micro = unit.replace(/μ/g, 'µ'); // Greek mu -> micro sign
  return UNIT_ALIASES[micro.toLowerCase()] ?? micro;
}

const NAME_LOOKUP = new Map<string, string>();
for (const [canonical, variants] of Object.entries(TEST_NAME_SYNONYMS)) {
  for (const v of variants) NAME_LOOKUP.set(v, canonical);
}

export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Haemoglobin (Hb)" -> "Hemoglobin". Unknown names are only tidied. */
export function normalizeTestName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim();
  const key = nameKey(cleaned);
  const withoutNotes = nameKey(cleaned.replace(/\(.*?\)/g, ' '));
  return (
    NAME_LOOKUP.get(key) ??
    NAME_LOOKUP.get(withoutNotes) ??
    NAME_LOOKUP.get(withoutNotes.replace(/\b(serum|plasma|blood)\b/g, ' ').replace(/\s+/g, ' ').trim()) ??
    cleaned
  );
}
