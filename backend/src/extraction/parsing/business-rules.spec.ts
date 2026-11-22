// Unit tests for the business rules of the parser. Test names start with the rule ID
// used in docs/Test_Cases.xlsx ("Business Rules" sheet).
import { resolveReportId } from '../../documents/documents.service.js';
import type { Line } from '../types.js';
import { parseMetadata, toIsoDate } from './metadata-parser.js';
import { cleanRows, matchHeader } from './table-parser.js';
import {
  fixOcrDigits,
  normalizeTestName,
  normalizeUnit,
  parseRange,
  parseValue,
  splitFlag,
  splitValueUnit,
} from './value-parsers.js';

/** A line whose words are spaced 100 pt apart (enough for header matching). */
function line(text: string, page = 1): Line {
  const words = text.split(' ').map((t, i) => ({ text: t, x: 50 + i * 100, y: 100, width: 40, height: 10 }));
  return { page, y: 100, words, text };
}

type Cells = Partial<Record<'name' | 'value' | 'unit' | 'range' | 'flag' | 'method', string>>;
const raw = (cells: Cells, source: 'text' | 'ocr' = 'text', page = 1) => ({ page, source, cells });

describe('Value parsing', () => {
  it('BL-01 plain number', () => expect(parseValue('13.5')).toEqual({ valueNumeric: 13.5, comparator: undefined }));
  it('BL-02 Indian digit grouping', () => expect(parseValue('1,85,000').valueNumeric).toBe(185000));
  it('BL-03 less-than value', () => expect(parseValue('<5')).toEqual({ valueNumeric: 5, comparator: '<' }));
  it('BL-04 less-or-equal with space', () => expect(parseValue('<= 5')).toEqual({ valueNumeric: 5, comparator: '<=' }));
  it('BL-05 greater-than value', () => expect(parseValue('>1000')).toEqual({ valueNumeric: 1000, comparator: '>' }));
  it('BL-06 result words stay text only', () => {
    for (const word of ['Positive', 'Negative', 'Nil', 'Non Reactive', 'Trace']) expect(parseValue(word)).toEqual({});
  });
  it('BL-07 value range like "2-4" stays text', () => expect(parseValue('2-4')).toEqual({}));
  it('BL-08 empty value', () => {
    expect(parseValue(undefined)).toEqual({});
    expect(parseValue('')).toEqual({});
  });
});

describe('Reference range parsing', () => {
  it('BL-09 "low - high"', () => expect(parseRange('13.0 - 17.0')).toEqual({ refLow: 13, refHigh: 17 }));
  it('BL-10 en dash', () => expect(parseRange('13–17')).toEqual({ refLow: 13, refHigh: 17 }));
  it('BL-11 "low to high"', () => expect(parseRange('4 to 11')).toEqual({ refLow: 4, refHigh: 11 }));
  it('BL-12 "< high"', () => expect(parseRange('< 200')).toEqual({ refHigh: 200 }));
  it('BL-13 "Up to high"', () => expect(parseRange('Up to 5')).toEqual({ refHigh: 5 }));
  it('BL-14 "> low"', () => expect(parseRange('> 40')).toEqual({ refLow: 40 }));
  it('BL-15 reversed range is rejected', () => expect(parseRange('17 - 13')).toEqual({ invalid: true }));
  it('BL-16 gender-specific range kept as text only', () => expect(parseRange('M: 13-17 F: 12-15')).toEqual({}));
  it('BL-17 text range kept as text only', () => expect(parseRange('Negative')).toEqual({}));
  it('BL-18 commas in range numbers', () => expect(parseRange('1,50,000 - 4,10,000')).toEqual({ refLow: 150000, refHigh: 410000 }));
});

describe('Flags and value clean-up', () => {
  it('BL-19 "128 H" -> value 128, flag H', () => expect(splitFlag('128 H')).toEqual({ value: '128', flag: 'H' }));
  it('BL-20 "38 L" -> flag L', () => expect(splitFlag('38 L')).toEqual({ value: '38', flag: 'L' }));
  it('BL-21 "245*" and arrows', () => {
    expect(splitFlag('245*')).toEqual({ value: '245', flag: 'H' });
    expect(splitFlag('3.1 ↓')).toEqual({ value: '3.1', flag: 'L' });
  });
  it('BL-22 words are never split into a flag', () => expect(splitFlag('Non Reactive')).toEqual({ value: 'Non Reactive' }));
  it('BL-23 value and unit stuck together', () => expect(splitValueUnit('13.5g/dL')).toEqual({ value: '13.5', unit: 'g/dL' }));
  it('BL-24 unknown suffix is not treated as a unit', () => expect(splitValueUnit('12abc')).toEqual({ value: '12abc' }));
  it('BL-25 OCR digit fixes only in numeric cells', () => {
    expect(fixOcrDigits('1O.5')).toBe('10.5');
    expect(fixOcrDigits('Nil')).toBe('Nil');
    expect(fixOcrDigits('Positive')).toBe('Positive');
  });
});

describe('Normalisation', () => {
  it('BL-26 unit spellings', () => {
    expect(normalizeUnit('gm/dl')).toBe('g/dL');
    expect(normalizeUnit('MG/DL')).toBe('mg/dL');
    expect(normalizeUnit('μIU/mL')).toBe('µIU/mL'); // Greek mu -> micro sign
    expect(normalizeUnit('cells/cumm')).toBe('cells/cumm'); // unknown spellings are kept
  });
  it('BL-27 test name synonyms', () => {
    expect(normalizeTestName('Haemoglobin')).toBe('Hemoglobin');
    expect(normalizeTestName('Hb')).toBe('Hemoglobin');
    expect(normalizeTestName('SGPT (ALT)')).toBe('SGPT (ALT)');
    expect(normalizeTestName('FBS')).toBe('Glucose, Fasting');
  });
  it('BL-28 notes in brackets and specimen words are ignored', () => {
    expect(normalizeTestName('Glucose Fasting (Plasma, Hexokinase)')).toBe('Glucose, Fasting');
    expect(normalizeTestName('Serum Creatinine')).toBe('Creatinine');
  });
  it('BL-29 unknown names are only tidied', () => expect(normalizeTestName('  Vitamin   B12 : ')).toBe('Vitamin B12'));
});

describe('Report details', () => {
  it('BL-30 dates are day-first (Indian format)', () => {
    expect(toIsoDate('18/11/2026')).toBe('2026-11-18');
    expect(toIsoDate('05.03.2025')).toBe('2025-03-05');
  });
  it('BL-31 month names and ISO dates', () => {
    expect(toIsoDate('19-Nov-2026')).toBe('2026-11-19');
    expect(toIsoDate('2026-11-20')).toBe('2026-11-20');
  });
  it('BL-32 impossible and future dates are rejected', () => {
    expect(toIsoDate('31/02/2026')).toBeUndefined();
    expect(toIsoDate('01/01/2099')).toBeUndefined();
    expect(toIsoDate('01/01/1850')).toBeUndefined();
  });
  it('BL-33 report ID labels used by different labs', () => {
    expect(parseMetadata([line('Patient Name: Ramesh Patil Sample ID: SMP-20481')]).reportId).toBe('SMP-20481');
    expect(parseMetadata([line('Lab No.: SPL/2026/7781')]).reportId).toBe('SPL/2026/7781');
    expect(parseMetadata([line('Accession No: mhd-55120')]).reportId).toBe('MHD-55120');
    expect(parseMetadata([line('Report ID: R-1001')]).reportId).toBe('R-1001');
  });
  it('BL-34 patient name without title and next label', () => {
    expect(parseMetadata([line('Name: Mr. Anil Joshi Lab No.: SPL/1')]).patientName).toBe('Anil Joshi');
    expect(parseMetadata([line('Patient: Priya Nair Accession No: X-1')]).patientName).toBe('Priya Nair');
  });
  it('BL-35 lab name from the top lines, only when it looks like a lab', () => {
    expect(parseMetadata([line('SHREE PATHOLOGY LAB'), line('Kothrud, Pune')]).labName).toBe('SHREE PATHOLOGY LAB');
    expect(parseMetadata([line('Kothrud, Pune')]).labName).toBeUndefined();
  });
  it('BL-36 report ID from the PDF is trimmed and upper-cased', () =>
    expect(resolveReportId(' smp-1 ', 'a'.repeat(64))).toEqual({ reportId: 'SMP-1', idAutoGenerated: false }));
  it('BL-37 missing report ID -> AUTO-<date>-<hash>', () => {
    const { reportId, idAutoGenerated } = resolveReportId(undefined, 'abc123def'.padEnd(64, '0'));
    expect(idAutoGenerated).toBe(true);
    expect(reportId).toMatch(/^AUTO-\d{8}-ABC123$/);
  });
});

describe('Table rules', () => {
  it('BL-38 header synonyms from another lab', () => {
    const cols = matchHeader(line('Investigation Observed Value Units Biological Ref. Interval'));
    expect(cols?.map((c) => c.key)).toEqual(['name', 'value', 'unit', 'range']);
  });
  it('BL-39 any column order and extra Method column', () => {
    const cols = matchHeader(line('Parameter Reference Range Result Unit Method'));
    expect(cols?.map((c) => c.key)).toEqual(['name', 'range', 'value', 'unit', 'method']);
  });
  it('BL-40 a line without a name AND a value column is not a header', () => {
    expect(matchHeader(line('Test Name Unit'))).toBeUndefined();
    expect(matchHeader(line('Patient Name: Ramesh'))).toBeUndefined();
  });
  it('BL-41 capitalised name-only line is a section; following tests belong to it', () => {
    const { rows } = cleanRows([raw({ name: 'HAEMATOLOGY' }), raw({ name: 'Hemoglobin', value: '14.2', unit: 'g/dL' })]);
    expect(rows[0]).toMatchObject({ isSection: true, name: 'HAEMATOLOGY' });
    expect(rows[1]).toMatchObject({ isSection: false, sectionName: 'HAEMATOLOGY' });
  });
  it('BL-42 name continued on the next line is joined', () => {
    const { rows } = cleanRows([raw({ name: 'Glucose Fasting', value: '118' }), raw({ name: '(Plasma, Hexokinase)' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Glucose Fasting (Plasma, Hexokinase)');
  });
  it('BL-43 junk rows (no letters in the name) are dropped', () => {
    expect(cleanRows([raw({ name: '12', value: '5' }), raw({ name: '--', value: '3' })]).rows).toHaveLength(0);
  });
  it('BL-44 H/L is calculated from the range when not printed', () => {
    const { rows } = cleanRows([
      raw({ name: 'WBC', value: '11800', range: '4000 - 11000' }),
      raw({ name: 'HDL', value: '38', range: '> 40' }),
      raw({ name: 'Urea', value: '28', range: '15 - 45' }),
    ]);
    expect(rows.map((r) => r.flag)).toEqual(['H', 'L', undefined]);
  });
  it('BL-45 printed flag wins over calculation', () => {
    const { rows } = cleanRows([raw({ name: 'TSH', value: '3.0 H', range: '0.27 - 4.2' })]);
    expect(rows[0]).toMatchObject({ valueRaw: '3.0', flag: 'H' });
  });
  it('BL-46 no calculated flag for "<5" style values', () => {
    const { rows } = cleanRows([raw({ name: 'CRP', value: '<5', range: '0 - 5' })]);
    expect(rows[0].flag).toBeUndefined();
  });
  it('BL-47 no calculated flag for OCR rows (a misread range would give a wrong flag)', () => {
    const { rows } = cleanRows([raw({ name: 'Creatinine', value: '0.9', range: '06-13' }, 'ocr')]);
    expect(rows[0].flag).toBeUndefined();
  });
  it('BL-48 OCR rows need a real value (number or result word)', () => {
    const { rows } = cleanRows([
      raw({ name: 'Cholesterol', value: 'CT' }, 'ocr'),
      raw({ name: 'HBsAg', value: 'Negative' }, 'ocr'),
      raw({ name: 'Urea', value: '28' }, 'ocr'),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['HBsAg', 'Urea']);
  });
  it('BL-49 missing value is kept when unit or range exists (text PDFs)', () => {
    const { rows } = cleanRows([raw({ name: 'Alkaline Phosphatase', unit: 'U/L', range: '40 - 129' })]);
    expect(rows[0]).toMatchObject({ name: 'Alkaline Phosphatase', unit: 'U/L', refLow: 40, refHigh: 129 });
    expect(rows[0].valueRaw).toBeUndefined();
  });
  it('BL-50 invalid range produces a warning, raw text is kept', () => {
    const { rows, warnings } = cleanRows([raw({ name: 'Hemoglobin', value: '14', range: '17 - 13' })]);
    expect(rows[0]).toMatchObject({ refRangeRaw: '17 - 13', refLow: undefined, refHigh: undefined });
    expect(warnings[0]).toContain('looks invalid');
  });
  it('BL-51 Method column goes to extra', () => {
    const { rows } = cleanRows([raw({ name: 'Iron', value: '64', method: 'Ferrozine' })]);
    expect(rows[0].extra).toEqual({ method: 'Ferrozine' });
  });
  it('BL-52 long values are cut to the column size', () => {
    const { rows } = cleanRows([raw({ name: 'Comment', value: '1'.padEnd(250, '0') })]);
    expect(rows[0].valueRaw).toHaveLength(200);
  });
});
