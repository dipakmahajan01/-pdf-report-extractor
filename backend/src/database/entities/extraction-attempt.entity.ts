import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import { AttemptStatus, ExtractionMethod, ExtractionStage } from '../enums.js';
import { numericTransformer } from '../numeric.transformer.js';
import { Document } from './document.entity.js';

/** History of every extraction run (first upload and each retry) for a document. */
@Entity('extraction_attempts')
@Unique(['documentFk', 'attemptNo'])
export class ExtractionAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_fk', type: 'uuid' })
  documentFk: string;

  @ManyToOne(() => Document, (document) => document.attempts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_fk' })
  document: Relation<Document>;

  @Column({ name: 'attempt_no', type: 'int' })
  attemptNo: number;

  @Column({ type: 'enum', enum: AttemptStatus, enumName: 'attempt_status', default: AttemptStatus.Running })
  status: AttemptStatus;

  @Column({ name: 'failed_stage', type: 'enum', enum: ExtractionStage, enumName: 'extraction_stage', nullable: true })
  failedStage: ExtractionStage | null;

  @Column({ name: 'error_code', type: 'varchar', length: 50, nullable: true })
  errorCode: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({
    name: 'extraction_method',
    type: 'enum',
    enum: ExtractionMethod,
    enumName: 'extraction_method',
    nullable: true,
  })
  extractionMethod: ExtractionMethod | null;

  @Column({ name: 'rows_found', type: 'int', nullable: true })
  rowsFound: number | null;

  @Column({
    name: 'parse_score',
    type: 'numeric',
    precision: 4,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  parseScore: number | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
