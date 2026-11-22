import type { Line, PageContent, ParsedRow, Word } from '../types.js';
import { COLUMN_SYNONYMS, SKIP_PHRASES, STOP_PHRASES, type ColumnKey } from './dictionaries.js';
import {
  fixOcrDigits,
  isUnit,
  nameKey,
  normalizeTestName,
  normalizeUnit,
  parseRange,
  parseValue,
  splitFlag,
  splitValueUnit,
} from './value-parsers.js';

/** A row before cleaning: raw cell texts keyed by column. */
interface RawRow {
  page: number;
  source: 'text' | 'ocr';
  cells: Partial<Record<ColumnKey, string>>;
  confidence?: number;
}

interface Column {
  key: ColumnKey;
  /** Left edge used as the column boundary. */
  start: number;
}

export interface TableParseResult {
  rows: ParsedRow[];
  score: number;
  strategy: 'header' | 'line-pattern' | 'none';
  /** Index of the header line on the first page that has one (metadata is read above it). */
  headerLineIndex?: number;
  warnings: string[];
}

/** Runs both strategies and keeps the one whose rows look most complete. */
export function parseTable(pages: PageContent[]): TableParseResult {
  const byHeader = headerStrategy(pages);
  const byPattern = linePatternStrategy(pages);

  const candidates = [
    { strategy: 'header' as const, ...cleanRows(byHeader.rows) },
    { strategy: 'line-pattern' as const, ...cleanRows(byPattern) },
  ]
    .map((c) => ({ ...c, score: score(c.rows) }))
    .filter((c) => c.rows.some((r) => !r.isSection));

  if (!candidates.length) {
    return { rows: [], score: 0, strategy: 'none', headerLineIndex: byHeader.headerLineIndex, warnings: [] };
  }
  // The header strategy knows the real columns, so it wins unless the line pattern is clearly better.
  const header = candidates.find((c) => c.strategy === 'header');
  const pattern = candidates.find((c) => c.strategy === 'line-pattern');
  const best = header && (!pattern || header.score >= pattern.score - 0.1) ? header : (pattern ?? header)!;
  return { ...best, headerLineIndex: byHeader.headerLineIndex };
}

function dataRows(rows: ParsedRow[]): number {
  return rows.filter((r) => !r.isSection).length;
}

/** Share of rows that look like real test lines: a name plus a value, unit or range (a value may legitimately be missing). */
function score(rows: ParsedRow[]): number {
  const data = rows.filter((r) => !r.isSection);
  return data.length ? data.filter((r) => r.name && (r.valueRaw || r.unit || r.refRangeRaw)).length / data.length : 0;
}

// ---------------------------------------------------------------------------
// Strategy 1: find the header line, use its word positions as column boundaries.
// ---------------------------------------------------------------------------

const SYNONYM_ENTRIES = (Object.entries(COLUMN_SYNONYMS) as [ColumnKey, string[]][])
  .flatMap(([key, phrases]) => phrases.map((phrase) => ({ key, phrase, length: phrase.split(' ').length })))
  .sort((a, b) => b.length - a.length);

/** Matches header words to columns, longest phrase first ("reference range" before "reference"). */
export function matchHeader(line: Line): Column[] | undefined {
  const words = line.words;
  const columns: Column[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const { key, phrase, length } of SYNONYM_ENTRIES) {
      if (i + length > words.length) continue;
      const text = nameKey(
        words
          .slice(i, i + length)
          .map((w) => w.text)
          .join(' '),
      );
      if (text === phrase) {
        if (!columns.some((c) => c.key === key)) columns.push({ key, start: words[i].x });
        i += length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  const keys = new Set(columns.map((c) => c.key));
  return keys.has('name') && keys.has('value') && columns.length >= 2 ? columns : undefined;
}

function headerStrategy(pages: PageContent[]): { rows: RawRow[]; headerLineIndex?: number } {
  const rows: RawRow[] = [];
  let columns: Column[] | undefined;
  let headerLineIndex: number | undefined;
  let stopped = false;

  for (const page of pages) {
    if (stopped) break;
    const headerIdx = page.lines.findIndex((l) => matchHeader(l));
    if (headerIdx >= 0) {
      columns = matchHeader(page.lines[headerIdx])!.sort((a, b) => a.start - b.start);
      headerLineIndex ??= page.page === pages[0].page ? headerIdx : undefined;
    }
    if (!columns) continue;

    // Continuation pages without a header reuse the previous page's columns.
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
    for (const line of page.lines.slice(startIdx)) {
      const lower = line.text.toLowerCase();
      if (STOP_PHRASES.some((p) => lower.includes(p))) {
        stopped = true;
        break;
      }
      if (SKIP_PHRASES.some((p) => lower.includes(p)) || matchHeader(line)) continue;
      rows.push(assignCells(line, columns, page.source));
    }
  }
  return { rows, headerLineIndex };
}

function assignCells(line: Line, columns: Column[], source: 'text' | 'ocr'): RawRow {
  const cells: Partial<Record<ColumnKey, Word[]>> = {};
  for (const word of line.words) {
    // A word belongs to the right-most column that starts at or before it (8 pt slack for alignment and OCR skew).
    let column = columns[0];
    for (const c of columns) if (word.x >= c.start - 8) column = c;
    (cells[column.key] ??= []).push(word);
  }
  const confidences = line.words.map((w) => w.confidence).filter((c): c is number => c !== undefined);
  return {
    page: line.page,
    source,
    cells: Object.fromEntries(
      Object.entries(cells).map(([key, words]) => [key, words.map((w) => w.text).join(' ')]),
    ) as RawRow['cells'],
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : undefined,
  };
}

// ---------------------------------------------------------------------------
// Strategy 2: no usable header (or skewed OCR) - read each line with a pattern.
//   <name> <value> [H|L] [unit] [range]
// ---------------------------------------------------------------------------

const VALUE_WORDS =
  'positive|negative|reactive|non[- ]?reactive|nil|absent|present|trace|detected|not detected|normal|abnormal';
const VALUE_WORD_PATTERN = new RegExp(`^(?:${VALUE_WORDS})$`, 'i');
const LINE_PATTERN = new RegExp(
  String.raw`^(?<name>[A-Za-z][A-Za-z0-9 ()/,.&%+'-]*?)\s+` +
    String.raw`(?<value>[<>]=?\s*\d[\d.,]*|\d[\d.,]*|${VALUE_WORDS})` +
    String.raw`(?:\s+(?<flag>H|L|\*))?` +
    String.raw`(?:\s+(?<rest>.+))?$`,
  'i',
);

function linePatternStrategy(pages: PageContent[]): RawRow[] {
  const rows: RawRow[] = [];
  for (const page of pages) {
    // Lines above a header (lab name, address, patient details) are never test rows.
    const headerIdx = page.lines.findIndex((l) => matchHeader(l));
    for (const line of page.lines.slice(headerIdx + 1)) {
      const lower = line.text.toLowerCase();
      if (STOP_PHRASES.some((p) => lower.includes(p))) return rows;
      if (matchHeader(line) || SKIP_PHRASES.some((p) => lower.includes(p))) continue;
      if (/:\s/.test(line.text)) continue; // "Label: value" lines are report details, not tests

      const m = line.text.match(LINE_PATTERN);
      if (!m?.groups) {
        // Keep possible section headings / wrapped names; cleanRows decides what they are.
        if (rows.length && /^[A-Za-z(]/.test(line.text) && line.words.length <= 6) {
          rows.push({ page: page.page, source: page.source, cells: { name: line.text } });
        }
        continue;
      }
      const { name, value, flag, rest } = m.groups;
      let unit: string | undefined;
      let range: string | undefined = rest?.trim();
      if (range) {
        const [first, ...others] = range.split(/\s+/);
        if (isUnit(first)) {
          unit = first;
          range = others.join(' ') || undefined;
        }
      }
      rows.push({
        page: page.page,
        source: page.source,
        cells: { name, value: flag ? `${value} ${flag}` : value, unit, range },
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cleaning: sections, wrapped names, flags, units, value and range parsing.
// ---------------------------------------------------------------------------

export function cleanRows(raw: RawRow[]): { rows: ParsedRow[]; warnings: string[] } {
  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  let section: string | undefined;

  for (const r of raw) {
    const cell = (k: ColumnKey) => r.cells[k]?.trim() || undefined;
    const name = cell('name');
    let value = cell('value');
    let unit = cell('unit');
    const range = cell('range');

    // A line with only a name is a section heading or the second line of the previous name.
    if (name && !value && !unit && !range) {
      const letters = name.replace(/[^A-Za-z]/g, '');
      const isHeading =
        !/\d/.test(name) && ((letters.length >= 3 && letters === letters.toUpperCase()) || name.endsWith(':'));
      const previous = rows.at(-1);
      if (isHeading) {
        section = name.replace(/:$/, '').trim();
        rows.push({ page: r.page, isSection: true, name: section, nameNormalized: section, sectionName: section });
      } else if (previous && !previous.isSection && previous.page === r.page) {
        previous.name = `${previous.name} ${name}`;
      }
      continue;
    }
    if (!name || !/[A-Za-z]{2}/.test(name)) continue; // junk: page numbers, stray symbols

    if (value && r.source === 'ocr') value = fixOcrDigits(value);
    let flag: 'H' | 'L' | undefined;
    if (value) {
      const withUnit = unit ? { value } : splitValueUnit(value);
      value = withUnit.value;
      unit ??= 'unit' in withUnit ? withUnit.unit : undefined;
      const split = splitFlag(value);
      value = split.value;
      flag = split.flag;
    }
    const explicitFlag = cell('flag')?.toUpperCase();
    if (!flag && (explicitFlag === 'H' || explicitFlag === 'L')) flag = explicitFlag;

    const { valueNumeric, comparator } = parseValue(value);
    // OCR noise often looks like a row; keep only rows whose value is a number or a known result word.
    if (r.source === 'ocr' && !(valueNumeric !== undefined || (value && VALUE_WORD_PATTERN.test(value)))) continue;
    const parsedRange = parseRange(range);
    if (parsedRange.invalid) warnings.push(`Reference range "${range}" for ${name} looks invalid and was not parsed.`);

    // Work out H/L when the report did not print it (not for OCR: a misread range would give a wrong flag).
    if (!flag && valueNumeric !== undefined && !comparator && r.source === 'text') {
      if (parsedRange.refHigh !== undefined && valueNumeric > parsedRange.refHigh) flag = 'H';
      else if (parsedRange.refLow !== undefined && valueNumeric < parsedRange.refLow) flag = 'L';
    }

    const extra: Record<string, string> = {};
    const method = cell('method');
    if (method) extra.method = method;

    rows.push({
      page: r.page,
      isSection: false,
      sectionName: section,
      name: name.slice(0, 300),
      nameNormalized: normalizeTestName(name).slice(0, 300),
      valueRaw: value?.slice(0, 200),
      valueNumeric,
      comparator,
      unit: normalizeUnit(unit)?.slice(0, 50),
      refRangeRaw: range?.slice(0, 200),
      refLow: parsedRange.refLow,
      refHigh: parsedRange.refHigh,
      flag,
      ocrConfidence: r.confidence !== undefined ? Math.round(r.confidence * 100) / 100 : undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    });
  }

  // Name normalisation for wrapped names happens after joining.
  for (const row of rows) if (!row.isSection) row.nameNormalized = normalizeTestName(row.name).slice(0, 300);
  return { rows, warnings };
}
