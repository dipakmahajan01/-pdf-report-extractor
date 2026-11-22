import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1763800000000 implements MigrationInterface {
  name = 'InitSchema1763800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE document_status   AS ENUM ('processing', 'completed', 'needs_review', 'failed');
      CREATE TYPE attempt_status    AS ENUM ('running', 'success', 'failed');
      CREATE TYPE extraction_stage  AS ENUM ('load', 'text_extract', 'ocr', 'parse', 'save');
      CREATE TYPE extraction_method AS ENUM ('text', 'ocr', 'mixed');

      CREATE TABLE documents (
        id                 uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name          varchar(255)    NOT NULL,
        file_path          varchar(500)    NOT NULL,
        file_hash          char(64)        NOT NULL,
        file_size_bytes    int             NOT NULL,
        status             document_status NOT NULL DEFAULT 'processing',
        attempt_count      int             NOT NULL DEFAULT 0,
        last_error_code    varchar(50),
        last_error_message text,
        is_retryable       boolean         NOT NULL DEFAULT true,
        created_at         timestamptz     NOT NULL DEFAULT now(),
        updated_at         timestamptz     NOT NULL DEFAULT now(),
        CONSTRAINT uq_documents_file_hash UNIQUE (file_hash)
      );
      CREATE INDEX idx_documents_status_updated ON documents (status, updated_at);
      CREATE INDEX idx_documents_created ON documents (created_at DESC);

      CREATE TABLE extraction_attempts (
        id                uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
        document_fk       uuid              NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        attempt_no        int               NOT NULL,
        status            attempt_status    NOT NULL DEFAULT 'running',
        failed_stage      extraction_stage,
        error_code        varchar(50),
        error_message     text,
        extraction_method extraction_method,
        rows_found        int,
        parse_score       numeric(4,3),
        duration_ms       int,
        started_at        timestamptz       NOT NULL DEFAULT now(),
        finished_at       timestamptz,
        CONSTRAINT uq_attempts_document_attempt UNIQUE (document_fk, attempt_no)
      );

      CREATE TABLE reports (
        id                uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
        document_fk       uuid              NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        report_id         varchar(100)      NOT NULL,
        id_auto_generated boolean           NOT NULL DEFAULT false,
        patient_name      varchar(200),
        report_date       date,
        lab_name          varchar(200)      NOT NULL DEFAULT 'UNKNOWN',
        page_count        int               NOT NULL,
        extraction_method extraction_method NOT NULL,
        parse_score       numeric(4,3),
        warnings          jsonb             NOT NULL DEFAULT '[]'::jsonb,
        raw_text          text              NOT NULL DEFAULT '',
        created_at        timestamptz       NOT NULL DEFAULT now(),
        updated_at        timestamptz       NOT NULL DEFAULT now(),
        CONSTRAINT uq_reports_document UNIQUE (document_fk),
        CONSTRAINT uq_reports_lab_report_id UNIQUE (lab_name, report_id)
      );

      CREATE TABLE report_parameters (
        id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        report_fk       uuid          NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
        row_order       int           NOT NULL,
        page_number     int           NOT NULL,
        is_section      boolean       NOT NULL DEFAULT false,
        section_name    varchar(200),
        name            varchar(300)  NOT NULL,
        name_normalized varchar(300)  NOT NULL,
        value_raw       varchar(200),
        value_numeric   numeric(18,6),
        comparator      varchar(2),
        unit            varchar(50),
        ref_range_raw   varchar(200),
        ref_low         numeric(18,6),
        ref_high        numeric(18,6),
        flag            varchar(2),
        ocr_confidence  numeric(5,2),
        extra           jsonb
      );
      CREATE INDEX idx_parameters_report_order ON report_parameters (report_fk, row_order);
      CREATE INDEX idx_parameters_name_normalized ON report_parameters (name_normalized);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE report_parameters;
      DROP TABLE reports;
      DROP TABLE extraction_attempts;
      DROP TABLE documents;
      DROP TYPE extraction_method;
      DROP TYPE extraction_stage;
      DROP TYPE attempt_status;
      DROP TYPE document_status;
    `);
  }
}
