import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { ExtractionMethod } from '../database/enums.js';
import { ExtractionService } from './extraction.service.js';
import { TesseractOcrProvider } from './ocr/tesseract-ocr.provider.js';
import type { ExtractionResult, ParsedRow } from './types.js';

const SAMPLES = path.join(import.meta.dirname, '../../../samples');
const sample = (file: string) => readFileSync(path.join(SAMPLES, file));
const dataRows = (r: ExtractionResult) => r.rows.filter((row) => !row.isSection);
const row = (r: ExtractionResult, name: string) => r.rows.find((x) => x.name === name) as ParsedRow;

describe('ExtractionService on the sample PDFs', () => {
  const ocr = new TesseractOcrProvider();
  const service = new ExtractionService(ocr, { get: () => undefined } as unknown as ConfigService);

  afterAll(() => ocr.onModuleDestroy());

  it('01 basic: 8 parameters and report details', async () => {
    const r = await service.extract(sample('01-basic-8-params.pdf'));
    expect(r.method).toBe(ExtractionMethod.Text);
    expect(dataRows(r)).toHaveLength(8);
    expect(r.metadata).toMatchObject({
      reportId: 'SMP-20481',
      patientName: 'Ramesh Patil',
      reportDate: '2026-11-18',
      labName: 'CITY DIAGNOSTIC LABORATORY',
    });
    expect(row(r, 'Creatinine')).toMatchObject({ valueNumeric: 0.9, unit: 'mg/dL', refLow: 0.6, refHigh: 1.3 });
  });

  it('02 lipid: 10 parameters, printed H/L flags and "< 200" ranges', async () => {
    const r = await service.extract(sample('02-lipid-10-params-flags.pdf'));
    expect(dataRows(r)).toHaveLength(10);
    expect(r.metadata.reportDate).toBe('2026-11-19');
    expect(row(r, 'Total Cholesterol')).toMatchObject({ valueRaw: '245', valueNumeric: 245, flag: 'H', refHigh: 200 });
    expect(row(r, 'HDL Cholesterol')).toMatchObject({ flag: 'L', refLow: 40 });
  });

  it('03 CBC: other header names, Indian number format, Lab No.', async () => {
    const r = await service.extract(sample('03-cbc-12-params-other-headers.pdf'));
    expect(dataRows(r)).toHaveLength(12);
    expect(r.metadata.reportId).toBe('SPL/2026/7781');
    expect(r.metadata.patientName).toBe('Anil Joshi');
    expect(row(r, 'Haemoglobin')).toMatchObject({ nameNormalized: 'Hemoglobin', valueNumeric: 13.8, unit: 'g/dL' });
    expect(row(r, 'Platelet Count')).toMatchObject({ valueNumeric: 185000 });
  });

  it('04 different column order with an extra Method column', async () => {
    const r = await service.extract(sample('04-different-column-order-with-method.pdf'));
    expect(dataRows(r)).toHaveLength(9);
    expect(r.metadata.reportId).toBe('MHD-55120');
    expect(row(r, 'TSH')).toMatchObject({ valueNumeric: 5.9, unit: 'µIU/mL', refRangeRaw: '0.27 - 4.2', flag: 'H' });
    expect(row(r, 'Iron').extra).toEqual({ method: 'Ferrozine' });
  });

  it('05 special values are kept as text', async () => {
    const r = await service.extract(sample('05-special-values.pdf'));
    expect(dataRows(r)).toHaveLength(10);
    expect(row(r, 'C-Reactive Protein')).toMatchObject({ valueRaw: '<5', valueNumeric: 5, comparator: '<' });
    expect(row(r, 'Ferritin')).toMatchObject({ valueRaw: '>1000', comparator: '>' });
    expect(row(r, 'Dengue NS1 Antigen')).toMatchObject({ valueRaw: 'Positive' });
    expect(row(r, 'Dengue NS1 Antigen').valueNumeric).toBeUndefined();
    expect(row(r, 'Urine Sugar')).toMatchObject({ valueRaw: 'Nil' });
    expect(row(r, 'HIV I & II Antibody')).toMatchObject({ valueRaw: 'Non Reactive' });
  });

  it('06 missing values, units and ranges stay empty', async () => {
    const r = await service.extract(sample('06-missing-fields.pdf'));
    expect(dataRows(r)).toHaveLength(8);
    expect(row(r, 'Bilirubin Indirect')).toMatchObject({ valueRaw: '0.6' });
    expect(row(r, 'Bilirubin Indirect').unit).toBeUndefined();
    expect(row(r, 'Alkaline Phosphatase').valueRaw).toBeUndefined();
    expect(row(r, 'GGT').refRangeRaw).toBeUndefined();
  });

  it('07 report without an ID', async () => {
    const r = await service.extract(sample('07-no-report-id.pdf'));
    expect(dataRows(r)).toHaveLength(7);
    expect(r.metadata.reportId).toBeUndefined();
    expect(r.metadata.labName).toBe('SUNRISE CLINIC LAB');
  });

  it('08 multi-page table with sections and wrapped names', async () => {
    const r = await service.extract(sample('08-multipage-sections-27-params.pdf'));
    expect(r.pageCount).toBeGreaterThan(1);
    expect(dataRows(r)).toHaveLength(27);
    expect(r.rows.filter((x) => x.isSection).map((x) => x.name)).toContain('LIPID PROFILE');
    const fasting = r.rows.find((x) => x.name.startsWith('Glucose Fasting'))!;
    expect(fasting.name).toBe('Glucose Fasting (Plasma, Hexokinase)');
    expect(fasting).toMatchObject({ nameNormalized: 'Glucose, Fasting', sectionName: 'DIABETES', flag: 'H' });
    expect(r.warnings.map((w) => w.code)).toContain('MULTI_PAGE_TABLE');
  });

  it('09 clean scan is read with OCR', async () => {
    const r = await service.extract(sample('09-scanned-clean.pdf'));
    expect(r.method).toBe(ExtractionMethod.Ocr);
    expect(dataRows(r).length).toBeGreaterThanOrEqual(7);
    expect(r.metadata.reportId).toBe('SMP-20590');
    expect(row(r, 'Sodium')).toMatchObject({ valueNumeric: 139 });
  }, 120_000);

  it('10 tilted, noisy scan fails safely instead of storing guessed values', async () => {
    await expect(service.extract(sample('10-scanned-tilted-noisy.pdf'))).rejects.toMatchObject({
      code: 'OCR_LOW_CONFIDENCE',
      stage: 'ocr',
      retryable: true,
    });
  }, 180_000);

  it('12 corrupted PDF fails at the load stage and is not retryable', async () => {
    await expect(service.extract(sample('12-corrupted.pdf'))).rejects.toMatchObject({
      code: 'CORRUPTED_PDF',
      stage: 'load',
      retryable: false,
    });
  });
});
