import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { DocumentStatus } from '../enums.js';
import { ExtractionAttempt } from './extraction-attempt.entity.js';
import { Report } from './report.entity.js';

/** One row per uploaded PDF file. Saved before extraction starts, so failures can be retried. */
@Entity('documents')
@Index(['status', 'updatedAt'])
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'file_path', type: 'varchar', length: 500 })
  filePath: string;

  @Column({ name: 'file_hash', type: 'char', length: 64, unique: true })
  fileHash: string;

  @Column({ name: 'file_size_bytes', type: 'int' })
  fileSizeBytes: number;

  @Column({ type: 'enum', enum: DocumentStatus, enumName: 'document_status', default: DocumentStatus.Processing })
  status: DocumentStatus;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  @Column({ name: 'last_error_code', type: 'varchar', length: 50, nullable: true })
  lastErrorCode: string | null;

  @Column({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage: string | null;

  @Column({ name: 'is_retryable', type: 'boolean', default: true })
  isRetryable: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ExtractionAttempt, (attempt) => attempt.document)
  attempts: Relation<ExtractionAttempt[]>;

  @OneToOne(() => Report, (report) => report.document)
  report: Relation<Report> | null;
}
