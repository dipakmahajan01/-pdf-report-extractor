import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { numericTransformer } from '../numeric.transformer.js';
import { Report } from './report.entity.js';

const decimal = { type: 'numeric', precision: 18, scale: 6, nullable: true, transformer: numericTransformer } as const;

/** One row per test line in a report, so any number of parameters fits without schema changes. */
@Entity('report_parameters')
@Index(['reportFk', 'rowOrder'])
@Index(['nameNormalized'])
export class ReportParameter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'report_fk', type: 'uuid' })
  reportFk: string;

  @ManyToOne(() => Report, (report) => report.parameters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'report_fk' })
  report: Relation<Report>;

  /** Position in the PDF, so the UI shows rows in the same order. */
  @Column({ name: 'row_order', type: 'int' })
  rowOrder: number;

  @Column({ name: 'page_number', type: 'int' })
  pageNumber: number;

  @Column({ name: 'is_section', type: 'boolean', default: false })
  isSection: boolean;

  @Column({ name: 'section_name', type: 'varchar', length: 200, nullable: true })
  sectionName: string | null;

  /** Test name exactly as printed in the PDF. */
  @Column({ type: 'varchar', length: 300 })
  name: string;

  /** Canonical test name used for search and comparison (e.g. "Hb" -> "Hemoglobin"). */
  @Column({ name: 'name_normalized', type: 'varchar', length: 300 })
  nameNormalized: string;

  /** Value exactly as printed: "13.5", "<5", "Positive", "Nil". */
  @Column({ name: 'value_raw', type: 'varchar', length: 200, nullable: true })
  valueRaw: string | null;

  @Column({ name: 'value_numeric', ...decimal })
  valueNumeric: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  comparator: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  unit: string | null;

  @Column({ name: 'ref_range_raw', type: 'varchar', length: 200, nullable: true })
  refRangeRaw: string | null;

  @Column({ name: 'ref_low', ...decimal })
  refLow: number | null;

  @Column({ name: 'ref_high', ...decimal })
  refHigh: number | null;

  @Column({ type: 'varchar', length: 2, nullable: true })
  flag: string | null;

  @Column({
    name: 'ocr_confidence',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  ocrConfidence: number | null;

  /** Extra columns some labs print (Method, Specimen, ...). */
  @Column({ type: 'jsonb', nullable: true })
  extra: Record<string, string> | null;
}
