export type ColumnKey = 'name' | 'value' | 'unit' | 'range' | 'flag' | 'method';

/** Header words different labs use for the same column. Matched case-insensitively, punctuation ignored. */
export const COLUMN_SYNONYMS: Record<ColumnKey, string[]> = {
  name: [
    'test name',
    'test description',
    'test',
    'tests',
    'investigation',
    'investigations',
    'parameter',
    'parameters',
    'examination',
    'analyte',
  ],
  value: ['observed value', 'your value', 'result value', 'results', 'result', 'value', 'observation', 'reading'],
  unit: ['units', 'unit', 'uom'],
  range: [
    'biological ref interval',
    'biological reference interval',
    'biological reference range',
    'reference interval',
    'reference range',
    'reference value',
    'normal range',
    'normal value',
    'normal values',
    'ref range',
    'ref interval',
    'reference',
  ],
  flag: ['flag', 'status'],
  method: ['method', 'methodology', 'technique'],
};

/** A line containing one of these ends the table. */
export const STOP_PHRASES = [
  'end of report',
  'pathologist',
  'interpretation',
  'authorised by',
  'authorized by',
  'signature',
  'disclaimer',
  'note:',
];

/** Lines containing these are skipped but do not end the table. */
export const SKIP_PHRASES = ['continued on next page', 'continued...', 'page '];

export const KNOWN_UNITS = [
  'g/dl', 'mg/dl', 'mg/l', 'ng/ml', 'ng/dl', 'pg/ml', 'µg/dl', 'ug/dl', 'µg/l', 'mmol/l', 'µmol/l', 'umol/l',
  'meq/l', 'iu/l', 'iu/ml', 'u/l', 'miu/l', 'µiu/ml', 'uiu/ml', 'miu/ml', '%', 'fl', 'pg', 'ratio',
  'mill/cumm', 'cells/cumm', 'cells/µl', 'cells/ul', '/cumm', '/hpf', '/lpf', 'lakh/cumm', '10^3/µl',
  '10^6/µl', 'mm/hr', 'sec', 'secs', 'mg/24hr', 'gm/dl', 'gm%',
];

/** Spellings normalised to one standard unit. */
export const UNIT_ALIASES: Record<string, string> = {
  'gm/dl': 'g/dL',
  'g/dl': 'g/dL',
  'mg/dl': 'mg/dL',
  'ng/dl': 'ng/dL',
  'ug/dl': 'µg/dL',
  'µg/dl': 'µg/dL',
  'mg/l': 'mg/L',
  'mmol/l': 'mmol/L',
  'umol/l': 'µmol/L',
  'µmol/l': 'µmol/L',
  'u/l': 'U/L',
  'iu/l': 'IU/L',
  'iu/ml': 'IU/mL',
  'ng/ml': 'ng/mL',
  'pg/ml': 'pg/mL',
  'uiu/ml': 'µIU/mL',
  'µiu/ml': 'µIU/mL',
  fl: 'fL',
};

/** Different names for the same test, mapped to one canonical name (used for search and comparison). */
export const TEST_NAME_SYNONYMS: Record<string, string[]> = {
  Hemoglobin: ['hb', 'hgb', 'haemoglobin', 'hemoglobin', 'hemoglobin hb', 'haemoglobin hb'],
  'Glucose, Fasting': ['fbs', 'glucose fasting', 'fasting blood sugar', 'fasting glucose', 'blood sugar fasting'],
  'Glucose, Post Prandial': ['ppbs', 'glucose post prandial', 'post prandial blood sugar', 'glucose pp'],
  'Total Cholesterol': ['cholesterol', 'total cholesterol', 'serum cholesterol', 'cholesterol total'],
  'HDL Cholesterol': ['hdl', 'hdl cholesterol', 'hdl c', 'cholesterol hdl'],
  'LDL Cholesterol': ['ldl', 'ldl cholesterol', 'ldl c', 'cholesterol ldl'],
  Triglycerides: ['tg', 'triglycerides', 'triglyceride', 'serum triglycerides'],
  Creatinine: ['creatinine', 'serum creatinine', 's creatinine'],
  Urea: ['urea', 'blood urea', 'serum urea'],
  'SGOT (AST)': ['sgot', 'ast', 'sgot ast', 'aspartate aminotransferase'],
  'SGPT (ALT)': ['sgpt', 'alt', 'sgpt alt', 'alanine aminotransferase'],
  'Platelet Count': ['platelet count', 'platelets', 'plt'],
  'Total WBC Count': ['total wbc count', 'wbc', 'wbc count', 'total leucocyte count', 'tlc'],
  'C-Reactive Protein': ['crp', 'c reactive protein', 'c-reactive protein'],
  TSH: ['tsh', 'thyroid stimulating hormone'],
};
