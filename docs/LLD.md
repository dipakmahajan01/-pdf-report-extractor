# Low-Level Design (LLD) – PDF Report Data Extractor

This document describes the implemented code: files, classes, methods, database schema, algorithms and tests. The overview is in the [HLD](./HLD.md).

| Item | Choice |
|---|---|
| Language | TypeScript everywhere (backend is ESM: relative imports end in `.js`) |
| Backend | NestJS 12 · TypeORM 1.x · PostgreSQL (tested on 19) |
| PDF text | `pdfjs-dist` (legacy build for Node) |
| Page → image | `pdfjs-dist` + `@napi-rs/canvas` (image clean-up done on the canvas) |
| OCR | `tesseract.js` (LSTM, `eng` model from the `@tesseract.js-data/eng` npm package) |
| Uploads | Multer (memory storage) via `@nestjs/platform-express` |
| Frontend | Next.js 16 (App Router, `cacheComponents`) · Tailwind CSS 4 |
| Tests | Vitest (unit + sample-PDF tests); UI checked with Playwright against installed Chrome |

---

## 1. Repository Layout

```
pdf-report-extractor/
├── backend/
│   ├── src/
│   │   ├── main.ts                          bootstrap: /api prefix, CORS, helmet, exception filter
│   │   ├── app.module.ts                    Config + Database + Documents modules, request logger
│   │   ├── app.controller.ts                GET /api/health
│   │   ├── common/
│   │   │   ├── app.exception.ts             AppException(code, message, status, extra)
│   │   │   ├── all-exceptions.filter.ts     one JSON error shape for every error
│   │   │   └── request-logger.middleware.ts method, URL, status, duration, X-Request-Id
│   │   ├── database/
│   │   │   ├── database.module.ts           TypeORM connection (DATABASE_URL), runs migrations at startup
│   │   │   ├── enums.ts                     DocumentStatus, AttemptStatus, ExtractionStage, ExtractionMethod
│   │   │   ├── numeric.transformer.ts       NUMERIC (string from pg) -> number
│   │   │   ├── entities/                    document, extraction-attempt, report, report-parameter
│   │   │   └── migrations/1763800000000-init-schema.ts   plain SQL CREATE TABLE / TYPE / INDEX
│   │   ├── documents/
│   │   │   ├── documents.module.ts
│   │   │   ├── documents.controller.ts      /api/documents endpoints
│   │   │   ├── documents.service.ts         upload, retry, list, detail, file, delete, restart recovery
│   │   │   ├── documents.mapper.ts          entity -> response (hides file path and hash)
│   │   │   ├── documents.constants.ts       MAX_ATTEMPTS = 3
│   │   │   ├── file-storage.service.ts      storage/<sha256>.pdf on local disk
│   │   │   └── pdf-file.pipe.ts             extension + MIME + %PDF- check
│   │   └── extraction/
│   │       ├── extraction.module.ts
│   │       ├── extraction.service.ts        pipeline: text vs OCR, retry, quality checks
│   │       ├── extraction.service.spec.ts   runs the engine on every sample PDF
│   │       ├── types.ts                     Word, Line, PageContent, ParsedRow, ExtractionResult, ExtractionError
│   │       ├── pdf/pdf-reader.ts            loadPdf, extractPageWords, renderPage, cleanScan
│   │       ├── ocr/ocr-provider.ts          OcrProvider interface + OCR_PROVIDER token
│   │       ├── ocr/tesseract-ocr.provider.ts
│   │       └── parsing/
│   │           ├── dictionaries.ts          column synonyms, stop/skip phrases, units, test-name synonyms
│   │           ├── line-builder.ts          words -> lines
│   │           ├── metadata-parser.ts       report ID, patient, date, lab
│   │           ├── table-parser.ts          header + line-pattern strategies, cleanRows, scoring
│   │           ├── value-parsers.ts         values, ranges, flags, units, name normalisation
│   │           └── business-rules.spec.ts   52 unit tests (BL-01 ... BL-52)
│   ├── storage/                             uploaded PDFs (git-ignored)
│   ├── vitest.config.ts
│   └── .env.example
├── frontend/
│   ├── app/
│   │   ├── layout.tsx                       header + page container
│   │   ├── page.tsx                         "/" upload card + documents list
│   │   └── documents/[id]/page.tsx          Suspense wrapper for the report view
│   ├── components/
│   │   ├── UploadCard.tsx
│   │   ├── DocumentsTable.tsx
│   │   ├── DocumentView.tsx
│   │   ├── ParametersTable.tsx
│   │   └── StatusBadge.tsx                  StatusBadge + MethodBadge
│   ├── lib/api.ts                           typed API client + response types
│   └── .env.example
├── samples/                                 12 sample PDFs + generate-samples.js
├── docs/                                    HLD.md, LLD.md, Test_Cases.xlsx
└── README.md
```

---

## 2. Configuration

### backend/.env.example
```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/pdf_reports
PORT=4000
FRONTEND_URL=http://localhost:3000
MAX_UPLOAD_MB=10
STORAGE_DIR=./storage
OCR_DPI=300
```

### frontend/.env.example
```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

### Constants in code

| Constant | File | Value | Meaning |
|---|---|---|---|
| `TEXT_PAGE_MIN_CHARS` | extraction.service.ts | 20 | Fewer characters in a page's text layer → page is scanned |
| `PSM_FIRST` / `PSM_RETRY` | extraction.service.ts | 6 / 4 | Tesseract page segmentation: one block / one column |
| `OCR_RETRY_CONFIDENCE` | extraction.service.ts | 75 | Below this (or no rows) → one OCR retry with clean-up |
| `OCR_RETRY_DPI` | extraction.service.ts | 300 | Render resolution for the retry |
| `OCR_MIN_CONFIDENCE` | extraction.service.ts | 70 | Below this after the retry → extraction fails |
| `MIN_WORD_CONFIDENCE` | tesseract-ocr.provider.ts | 30 | OCR words below this are dropped as noise |
| Line tolerance | line-builder.ts | max(3 pt, 0.5 × median word height) | Words this close vertically form one line |
| Column slack | table-parser.ts | 8 pt | A word belongs to the right-most column starting at or before `x + 8` |
| `REVIEW_SCORE` | documents.service.ts | 0.7 | Parse score below this → `needs_review` |
| `REVIEW_OCR_CONFIDENCE` | documents.service.ts | 85 | OCR confidence below this → `needs_review` |
| `STALE_PROCESSING_MINUTES` | documents.service.ts | 10 | `processing` older than this at startup → interrupted |
| `MAX_ATTEMPTS` | documents.constants.ts | 3 | Extraction attempts per document (upload included) |

---

## 3. Database Schema

TypeORM entities map camelCase fields to snake_case columns. The schema is created by one plain-SQL migration (`InitSchema1763800000000`), run automatically at startup (`migrationsRun: true`, `synchronize: false`).

```sql
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
```

**Design notes**
- `lab_name` is `NOT NULL DEFAULT 'UNKNOWN'`: PostgreSQL treats NULLs as distinct, so a nullable column would let duplicate `(NULL, report_id)` pairs through the unique constraint.
- `numeric` (not float) keeps `0.1` exactly `0.1`. The `pg` driver returns NUMERIC as a string; `numericTransformer` converts it to a number on read.
- Relation fields use TypeORM's `Relation<T>` wrapper, which avoids circular-import problems between entities in ESM.
- `warnings` is a JSON array of `{ code, message }`; `extra` holds extra columns such as `{ "method": "CLIA" }`.

---

## 4. Shared Types (`extraction/types.ts`)

```ts
interface Word { text: string; x: number; y: number; width: number; height: number; confidence?: number }
// PDF points, top-left origin. OCR pixel coordinates are converted with × 72 / dpi.

interface Line { page: number; y: number; words: Word[] /* sorted by x */; text: string }

interface PageContent { page: number; source: 'text' | 'ocr'; lines: Line[]; ocrConfidence?: number }

interface ParsedRow {
  page: number; isSection: boolean; sectionName?: string;
  name: string; nameNormalized: string;
  valueRaw?: string; valueNumeric?: number; comparator?: string;
  unit?: string; refRangeRaw?: string; refLow?: number; refHigh?: number;
  flag?: 'H' | 'L'; ocrConfidence?: number; extra?: Record<string, string>;
}

interface ReportMetadata { reportId?: string; patientName?: string; reportDate?: string /* yyyy-mm-dd */; labName?: string }

interface ExtractionResult {
  pageCount: number; method: ExtractionMethod; metadata: ReportMetadata;
  rows: ParsedRow[]; score: number; ocrConfidence?: number; rawText: string;
  warnings: { code: string; message: string }[];
}

class ExtractionError extends Error {
  constructor(code: string, stage: ExtractionStage, message: string, retryable: boolean, method?: ExtractionMethod)
}
```

---

## 5. Error Handling

### 5.1 Error codes

| Code | HTTP | Where | When |
|---|---|---|---|
| `FILE_MISSING` | 400 | PdfFilePipe | No file in the request |
| `INVALID_FILE_TYPE` | 400 | PdfFilePipe | Wrong extension / MIME / missing `%PDF-` bytes |
| `BAD_REQUEST` | 400 | ParseUUIDPipe / ParseIntPipe | Invalid `:id`, `page` or `limit` |
| `FILE_TOO_LARGE` | 413 | Multer limit | Over `MAX_UPLOAD_MB` |
| `DUPLICATE_FILE` | 409 | DocumentsService | Same SHA-256 already stored (`documentId`, `documentStatus`, `retryable` in body) |
| `DUPLICATE_REPORT_ID` | 409 | DocumentsService | Unique violation on `(lab_name, report_id)` |
| `ALREADY_PROCESSING` | 409 | DocumentsService.retry | Document is being processed |
| `CORRUPTED_PDF` | 422 | pdf-reader | pdf.js cannot open the file (not retryable) |
| `PASSWORD_PROTECTED` | 422 | pdf-reader | `PasswordException` (not retryable) |
| `NO_PARAMETERS_FOUND` | 422 | ExtractionService | Digital PDF without table rows |
| `OCR_NO_TABLE` | 422 | ExtractionService | Scanned PDF without table rows |
| `OCR_LOW_CONFIDENCE` | 422 | ExtractionService | OCR confidence < 70% after the retry |
| `EXTRACTION_ERROR` | 422 | ExtractionService | Unexpected error inside a stage |
| `SAVE_FAILED` | 422 | DocumentsService | Database error while saving (transaction rolled back) |
| `NOT_RETRYABLE` | 422 | DocumentsService.retry | Document failed with a non-retryable error |
| `MAX_ATTEMPTS_REACHED` | 422 | DocumentsService.retry | Already tried 3 times |
| `DOCUMENT_NOT_FOUND` | 404 | DocumentsService | Unknown id |
| `DATABASE_DOWN` | 503 | AppController | Health check cannot reach PostgreSQL |
| `INTERNAL_ERROR` | 500 | AllExceptionsFilter | Anything unexpected (details logged, not returned) |

Every 422 from an extraction carries `documentId`, `stage` and `retryable`, so the UI can link to the document and show Retry.

### 5.2 `AppException`
```ts
class AppException extends HttpException {
  constructor(readonly code: string, message: string, status: HttpStatus, readonly extra: Record<string, unknown> = {})
  // response body: { code, message, ...extra }
}
```

### 5.3 `AllExceptionsFilter`
- `HttpException` → its status; body gets `code` (default by status: 400 `BAD_REQUEST`, 404 `NOT_FOUND`, 409 `CONFLICT`, 413 `FILE_TOO_LARGE`, 422 `UNPROCESSABLE`); array messages joined.
- Anything else → 500 `INTERNAL_ERROR` with a generic message; the stack is logged.
- Final body: `{ statusCode, code, message, ...extra, path, timestamp }`.

---

## 6. Backend Classes and Methods

### 6.1 `main.ts`
- `app.setGlobalPrefix('api')`
- `app.enableCors({ origin: FRONTEND_URL, exposedHeaders: ['X-Request-Id'] })`
- `helmet({ crossOriginResourcePolicy: 'cross-origin', frameguard: false, CSP frame-ancestors 'self' FRONTEND_URL })` – the frontend (another origin) embeds the PDF in an iframe.
- `app.useGlobalFilters(new AllExceptionsFilter())`, `app.enableShutdownHooks()`.

### 6.2 `RequestLoggerMiddleware`
Reuses `X-Request-Id` or creates a UUID, returns it as a response header, and on `finish` logs `METHOD url status ms [requestId]`. Applied to every route in `AppModule.configure`.

### 6.3 `PdfFilePipe`
```
!file                                                   → 400 FILE_MISSING
name ends with .pdf AND mimetype in [application/pdf, application/x-pdf, application/octet-stream]
  AND first 5 bytes == '%PDF-'                          → ok, else 400 INVALID_FILE_TYPE
```

### 6.4 `DocumentsController` (`/api/documents`)
```ts
@Post('upload') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
upload(@UploadedFile(PdfFilePipe) file)                                     // 201 DocumentDetail

@Get() list(@Query('page', DefaultValuePipe(1), ParseIntPipe) page,
            @Query('limit', DefaultValuePipe(20), ParseIntPipe) limit)     // limit clamped to 1..100

@Get(':id')        findOne(@Param('id', ParseUUIDPipe) id)
@Get(':id/file')   file(id, @Res() res)   // streams the PDF, Content-Type application/pdf, inline,
                                          // CSP only "frame-ancestors" so the browser PDF viewer works
@Post(':id/retry') @HttpCode(200) retry(id)
@Delete(':id')     @HttpCode(204) remove(id)
```

### 6.5 `DocumentsService`

**`upload(file)`**
```
1. fileHash = sha256(buffer)
2. existing = findOneBy({ fileHash }) → 409 DUPLICATE_FILE { documentId, documentStatus, retryable }
3. filePath = storage.save(fileHash, buffer)                 // storage/<hash>.pdf
4. INSERT documents (status processing, attemptCount 1)
     unique violation (same file at the same moment) → 409 DUPLICATE_FILE for the winner
5. return runAttempt(document, 1, buffer)
```

**`retry(id)`**
```
1. document = findDocument(id)                                   → 404
2. !isRetryable                → 422 NOT_RETRYABLE
3. attemptCount >= MAX_ATTEMPTS → 422 MAX_ATTEMPTS_REACHED
4. UPDATE documents SET status='processing', attempt_count = attempt_count + 1
   WHERE id = $1 AND status <> 'processing' AND attempt_count < 3 RETURNING attempt_count
   no row → 409 ALREADY_PROCESSING                              // atomic claim
5. buffer = storage.read(filePath); return runAttempt(document, attemptNo, buffer)
```

**`runAttempt(document, attemptNo, buffer)`**
```
attempt = INSERT extraction_attempts (attemptNo, running)
try result = extraction.extract(buffer)
catch → markFailed(stage, code, message, retryable) ; throw 422 { documentId, stage, retryable }

{ reportId, idAutoGenerated } = resolveReportId(metadata.reportId, fileHash)
warnings: ID_AUTO_GENERATED (if generated) + extraction warnings
needsReview = score < 0.7 OR ocrConfidence < 85 → add NEEDS_REVIEW warning

TRANSACTION:
  DELETE reports WHERE document_fk = id           // a retry replaces the old report (params cascade)
  INSERT reports (...)
  INSERT report_parameters (rowOrder = index in rows, ...)
  UPDATE extraction_attempts → success, method, rowsFound, parseScore, durationMs, finishedAt
  UPDATE documents → completed | needs_review, clear last error
on unique violation (lab_name, report_id) → delete the new document + file, 409 DUPLICATE_REPORT_ID
on other DB error → markFailed(stage save, SAVE_FAILED, retryable) ; 422
return findOne(id)
```

**`markFailed`** updates the attempt (failed, stage, code, message, method, duration) and the document (failed, last error, `is_retryable`).

**`onApplicationBootstrap()`** – restart recovery: attempts `running` and documents `processing` older than 10 minutes become `failed` / `INTERRUPTED` (retryable).

**`list(page, limit)`** – `findAndCount` with the report relation, newest first; parameter counts per report from one `GROUP BY report_fk` query (sections excluded).

**`findOne(id)`** – document with report, parameters ordered by `row_order`, attempts ordered by `attempt_no`; mapped by `toDocumentDetail`.

**`remove(id)`** – delete the document (attempts, report and parameters cascade) and the stored file.

**`resolveReportId(found, fileHash)`** – found → trimmed, upper-case, max 100 chars; else `AUTO-<yyyymmdd>-<first 6 of hash, upper-case>`.

### 6.6 `FileStorageService`
```ts
save(hash, buffer): Promise<string>   // mkdir -p STORAGE_DIR; write <hash>.pdf; return relative path
read(relative): Promise<Buffer>
stream(relative): ReadStream
delete(relative): Promise<void>       // force: no error if already gone
// resolve() refuses any path that would leave STORAGE_DIR
```

### 6.7 `documents.mapper.ts`
`toDocumentSummary(document, parameterCount)` and `toDocumentDetail(document)` build the response objects explicitly, so `file_path` and `file_hash` never reach the client. `canRetry = status failed AND is_retryable AND attempt_count < 3`.

---

## 7. Extraction Engine

### 7.1 `ExtractionService.extract(buffer)`
```
{ doc, close } = loadPdf(buffer)                      // CORRUPTED_PDF / PASSWORD_PROTECTED, not retryable
for each page:
    words = extractPageWords(doc, p)
    chars >= 20 → text page: buildLines(words)
    else        → scanned page
method = text | ocr | mixed

pass = runPass(dpi 300, PSM 6, no clean-up)          // OCR only for scanned pages, then parseTable
if scanned pages AND (no rows OR OCR confidence < 75):
    retry = runPass(dpi 300, PSM 4, clean-up)
    add warning OCR_RETRIED
    keep retry if its score is higher (tie: more rows)

ocrConfidence < 70             → ExtractionError OCR_LOW_CONFIDENCE (stage ocr, retryable)
no data rows                   → NO_PARAMETERS_FOUND (digital) / OCR_NO_TABLE (scanned), stage parse, retryable
metadata = parseMetadata(first page lines above the header, or first 25 lines)
warnings: OCR_USED, MULTI_PAGE_TABLE, INVALID_RANGE
rawText = per page "--- page N (text|ocr) ---" + lines
close()
```
`stage(stage, fn)` wraps each step so an unexpected error becomes `EXTRACTION_ERROR` tagged with the stage it happened in.

### 7.2 `pdf-reader.ts`
- **`loadPdf(buffer)`** – `getDocument({ data: new Uint8Array(buffer), disableFontFace: true, verbosity: 0 })`. The buffer is copied because pdf.js can detach it and the same buffer is reused on retry. Returns `{ doc, close }` (`close` destroys the loading task).
- **`extractPageWords(doc, page)`** – for each text item: `x = transform[4]`, `y = pageHeight - transform[5] - height` (top-left origin), then split into single words with an x estimated from the average character width. Splitting makes digital pages look like OCR output, so one parser handles both.
- **`renderPage(doc, page, { dpi, binarize })`** – `@napi-rs/canvas` at `dpi / 72` scale, white background, `page.render`, PNG.
- **`cleanScan(pixels)`** (retry only) – greyscale < 170 → ink, then a 3×3 median filter (a pixel is ink if ≥ 5 of its 9 neighbours are ink). This removes scanner specks but keeps letter strokes.

### 7.3 OCR
```ts
interface OcrProvider {
  recognize(png: Buffer, opts: { dpi: number; page: number; psm: number }): Promise<{ lines: Line[]; confidence: number }>;
}
```
`TesseractOcrProvider` (registered under the `OCR_PROVIDER` token):
- one worker, created on first use: `createWorker('eng', OEM.LSTM_ONLY, { langPath: <@tesseract.js-data/eng>/4.0.0_best_int, cacheMethod: 'none' })`;
- `setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })`, `recognize(png, {}, { blocks: true })`;
- uses Tesseract's own lines (they handle slightly tilted scans better than grouping by y), drops words with confidence < 30, converts pixels to points (× 72 / dpi);
- `confidence` = average word confidence; the worker is terminated in `onModuleDestroy`.

---

## 8. Parsing Algorithms

### 8.1 `buildLines(words, page)`
`tolerance = max(3, 0.5 × median word height)`. Words are sorted by vertical centre; a word joins the current line when its centre is within the tolerance of the line's average centre, otherwise a new line starts. Each line's words are sorted by x and joined with spaces.

### 8.2 `dictionaries.ts`
- `COLUMN_SYNONYMS` – `name` (test, test name, investigation, parameter, examination, analyte…), `value` (result, observed value, value, observation…), `unit` (unit, units, uom), `range` (reference range, biological ref interval, normal range, ref range, reference…), `flag`, `method`.
- `STOP_PHRASES` – end of report, pathologist, interpretation, authorised/authorized by, signature, disclaimer, note:.
- `SKIP_PHRASES` – continued on next page, continued..., page.
- `KNOWN_UNITS`, `UNIT_ALIASES` (gm/dl → g/dL, uiu/ml → µIU/mL…), `TEST_NAME_SYNONYMS` (Hb/Haemoglobin → Hemoglobin, FBS → Glucose, Fasting…).

Matching uses `nameKey()`: lower-case, non-alphanumerics → space, spaces collapsed.

### 8.3 `parseMetadata(lines)`
| Field | Rule |
|---|---|
| reportId | `report id / sample id / sample no / lab no / accession no / reg(istration) no / barcode / specimen id` + optional `:#.-` + `[A-Z0-9][A-Z0-9-/]{2,99}`, upper-cased |
| patientName | `patient name / patient / name` + `:` or `-`, optional title (Mr, Mrs, Ms, Miss, Master, Baby), stops before the next label (age, sex, sample, lab, date, referred…) |
| reportDate | `report(ed) on/date / collected on / date` + `dd/mm/yyyy`, `dd-Mon-yyyy` or `yyyy-mm-dd`; day-first; invalid, before 1900 or future → ignored |
| labName | first of the top 4 lines containing lab, laboratory, diagnostic(s), pathology, clinic, hospital, health |

### 8.4 `parseTable(pages)`
Runs both strategies, cleans both results with `cleanRows`, scores them, and keeps the **header strategy unless the line-pattern score is more than 0.1 higher**.
`score = data rows with a name and (value or unit or range) ÷ data rows` (a missing value can be legitimate).

**Strategy 1 – header (`matchHeader` + `headerStrategy`)**
```
matchHeader(line): scan words left to right; at each position try synonym phrases longest first
                   (1-4 words); a header needs a 'name' AND a 'value' column
for each page:
    header found → columns = matched words sorted by x (start = word.x)
    no header but earlier page had one → reuse its columns (table continues)
    for each line after the header:
        STOP phrase → stop the whole table
        SKIP phrase or repeated header → skip
        each word goes to the right-most column whose start <= word.x + 8
        cells = words joined per column; OCR rows keep their average confidence
```
**Strategy 2 – line pattern**
```
start after the header line if the page has one; stop at STOP phrases; skip "Label: value" lines
^<name> <value: [<>]=?number | number | result word> [H|L|*] [rest]$
first word of rest that is a known unit → unit; the remainder → range
lines that do not match but look like a heading / wrapped name are kept as name-only rows
```

### 8.5 `cleanRows(rawRows)`
Applied in order:
1. Trim cells; empty → undefined.
2. **Name-only row:** no digits and (all capitals with ≥ 3 letters, or ends with `:`) → **section** (following rows get `sectionName`); otherwise, if the previous row is a data row on the same page → **appended to its name**.
3. **Junk:** name without two letters in a row → dropped.
4. OCR rows: `fixOcrDigits` on the value (`O→0`, `l/I→1`, `S→5` only when the cell is otherwise numeric).
5. `splitValueUnit` (`13.5g/dL`) when there is no unit column value; `splitFlag` (`128 H`, `245*`, `↑`, `↓`).
6. A printed `flag` column (`H`/`L`) is used when the value had none.
7. `parseValue` → `valueNumeric`, `comparator`. **OCR rows whose value is neither a number nor a result word are dropped** (noise).
8. `parseRange` → `refLow`, `refHigh`; a reversed range adds a warning and keeps only the raw text.
9. **Calculated flag** (text rows only, no comparator): value > `refHigh` → H, value < `refLow` → L.
10. `extra.method` from a Method column; lengths cut to the column sizes (name 300, value 200, unit 50, range 200).
11. `nameNormalized = normalizeTestName(name)` after wrapped names are joined.

### 8.6 `value-parsers.ts`
| Function | Behaviour |
|---|---|
| `parseValue` | commas removed; `^([<>]=?)?\s*-?\d+(\.\d+)?$` → number + comparator; anything else → nothing |
| `parseRange` | `a - b` / `a – b` / `a to b` (rejected if a > b); `< b`, `<= b`, `up to b`, `below b`; `> a`, `>= a`, `above a`; anything else → nothing |
| `splitFlag` | trailing `H`, `L`, `*`, `↑`, `↓` only when the rest is numeric; `*`/`↑` → H, `↓` → L |
| `splitValueUnit` | `^((?:[<>]=?)?\s*\d[\d.,]*)\s*(unit)$` and the unit must pass `isUnit` |
| `isUnit` | in `KNOWN_UNITS` or shaped like `x/y` (Greek μ treated as µ) |
| `normalizeUnit` | Greek μ → micro sign µ, then `UNIT_ALIASES` |
| `normalizeTestName` | synonym lookup on the cleaned name, then without bracket notes, then without serum/plasma/blood; unknown names are only tidied |

---

## 9. API Contract

### `POST /api/documents/upload` → 201
Request: `multipart/form-data`, field `file`.
```json
{
  "id": "61c20f1a-…",
  "fileName": "01-basic-8-params.pdf",
  "fileSizeBytes": 2270,
  "status": "completed",
  "attemptCount": 1,
  "lastErrorCode": null,
  "lastErrorMessage": null,
  "canRetry": false,
  "createdAt": "2026-11-22T09:36:00.000Z",
  "updatedAt": "2026-11-22T09:36:00.000Z",
  "report": {
    "id": "…",
    "reportId": "SMP-20481",
    "idAutoGenerated": false,
    "patientName": "Ramesh Patil",
    "reportDate": "2026-11-18",
    "labName": "CITY DIAGNOSTIC LABORATORY",
    "pageCount": 1,
    "extractionMethod": "text",
    "parseScore": 1,
    "warnings": [],
    "rawText": "--- page 1 (text) ---\n…",
    "parameterCount": 8,
    "createdAt": "…",
    "parameters": [
      { "rowOrder": 2, "pageNumber": 1, "isSection": false, "sectionName": null,
        "name": "Creatinine", "nameNormalized": "Creatinine",
        "valueRaw": "0.9", "valueNumeric": 0.9, "comparator": null,
        "unit": "mg/dL", "refRangeRaw": "0.6 - 1.3", "refLow": 0.6, "refHigh": 1.3,
        "flag": null, "ocrConfidence": null, "extra": null }
    ]
  },
  "attempts": [
    { "attemptNo": 1, "status": "success", "failedStage": null, "errorCode": null, "errorMessage": null,
      "extractionMethod": "text", "rowsFound": 8, "parseScore": 1, "durationMs": 120,
      "startedAt": "…", "finishedAt": "…" }
  ]
}
```

### Failed extraction → 422
```json
{ "statusCode": 422, "code": "OCR_LOW_CONFIDENCE",
  "message": "The scan quality is too low to read reliably (OCR confidence 69%, minimum 70%). Please upload a clearer scan.",
  "documentId": "…", "stage": "ocr", "retryable": true, "path": "/api/documents/upload", "timestamp": "…" }
```

### `GET /api/documents?page=1&limit=20` → 200
```json
{ "items": [ { "id": "…", "fileName": "…", "status": "completed", "canRetry": false, "…": "…",
               "report": { "reportId": "SMP-20481", "patientName": "…", "reportDate": "…", "labName": "…",
                           "extractionMethod": "text", "idAutoGenerated": false, "parameterCount": 8 } } ],
  "page": 1, "limit": 20, "total": 9 }
```

Other endpoints: `GET /api/documents/:id` (same shape as upload), `GET /api/documents/:id/file` (PDF), `POST /api/documents/:id/retry` (same shape as upload), `DELETE /api/documents/:id` (204), `GET /api/health` (`{ status: "ok", database: "up" }`).

---

## 10. Frontend Design

### 10.1 `lib/api.ts`
```ts
api.list(page = 1, limit = 50): Promise<Paginated<DocumentSummary>>
api.get(id): Promise<DocumentDetail>
api.retry(id): Promise<DocumentDetail>
api.remove(id): Promise<void>
api.fileUrl(id): string                                   // `${API_URL}/documents/${id}/file`
api.upload(file, onProgress): Promise<DocumentDetail>     // XMLHttpRequest, because fetch has no upload progress
class ApiError extends Error { status; code; body }       // NETWORK_ERROR when the API cannot be reached
formatDate(iso)                                           // en-IN format
```
All requests use `cache: 'no-store'`.

### 10.2 Pages
| Route | Type | Behaviour |
|---|---|---|
| `/` | client page | `UploadCard` + `DocumentsTable`; loads the list on mount and after every upload or action |
| `/documents/[id]` | server page wrapping a client view in `<Suspense>` | Required by `cacheComponents`: `useParams` suspends for dynamic ids |

### 10.3 Components
| Component | Behaviour |
|---|---|
| `UploadCard` | Drag-and-drop or file picker; browser checks (`.pdf`, ≤ 10 MB); states `idle → uploading (%) → processing ("Reading … Scanned PDFs can take up to 30 seconds") → error`. On success it **resets to idle before** `router.push('/documents/<id>')` – Next.js keeps the previous page mounted, so going back would otherwise show the old spinner. Errors show the API message, with a link to the document for `DUPLICATE_FILE` or a failed extraction. |
| `DocumentsTable` | Report ID (or file name) with method badge, patient, lab, report date, test count, status badge (with the error for failed rows), upload time, Retry (when `canRetry`) and Delete |
| `DocumentView` | Title with status and "auto-generated ID" badge; Retry / Delete; red banner for failed documents; warning banners; details panel (patient, date, lab, tests, pages, method); **original PDF iframe (left) and `ParametersTable` (right)** on wide screens, stacked on small ones; processing history; raw text in a `<details>` |
| `ParametersTable` | Rows in PDF order; section rows span the table; H in red with ▲, L in blue with ▼; OCR values < 80% confidence underlined with a tooltip; Method column only when present; empty cells as "—"; the normalised name shown in brackets when it differs |
| `StatusBadge` / `MethodBadge` | completed / needs_review / failed / processing; TEXT / OCR / TEXT + OCR |

---

## 11. Sample PDFs (`samples/generate-samples.js`)

The script describes each report once and renders it either as a digital PDF (`pdfkit`) or as an image-only "scanned" PDF (`@napi-rs/canvas`, optional tilt, specks and blur). All patient data is fictional.

| File | Purpose |
|---|---|
| `01-basic-8-params.pdf` | Simple layout, 8 parameters |
| `02-lipid-10-params-flags.pdf` | Printed H/L, `< 200` / `> 40` ranges, `19-Nov-2026` |
| `03-cbc-12-params-other-headers.pdf` | `Investigation / Observed Value / Units / Biological Ref. Interval`, `Lab No.`, `1,85,000` |
| `04-different-column-order-with-method.pdf` | Columns in another order + `Method`, `Accession No` |
| `05-special-values.pdf` | `<5`, `>1000`, `Positive`, `Nil`, `Non Reactive`, `Trace`, `2-4` |
| `06-missing-fields.pdf` | Missing values, units and ranges |
| `07-no-report-id.pdf` | No Report/Sample ID |
| `08-multipage-sections-27-params.pdf` | 2 pages, 8 sections, wrapped names, repeated header |
| `09-scanned-clean.pdf` | Image-only page → OCR |
| `10-scanned-tilted-noisy.pdf` | Tilted, specks, blur → fails safely |
| `11-not-a-pdf.pdf` | Text file renamed to `.pdf` |
| `12-corrupted.pdf` | Truncated PDF |

---

## 12. Tests

`cd backend && npm test` runs **63 tests** (Vitest):

| Suite | Tests | What it checks |
|---|---|---|
| `extraction/extraction.service.spec.ts` | 11 | The real engine on samples 01–10 and 12: row counts, report details, flags, special values, missing fields, Method column, multi-page sections, OCR, safe failure of the poor scan, corrupted file |
| `extraction/parsing/business-rules.spec.ts` | 52 | Business rules BL-01…BL-52: value, range and flag parsing, value/unit split, OCR digit fixes, unit and name normalisation, dates, report ID labels, patient name, lab name, `AUTO-` IDs, header synonyms, column order, sections, wrapped names, junk rows, calculated flags, OCR row filtering, invalid ranges, extra columns, length limits |

The full test case sheet (`docs/Test_Cases.xlsx`) lists 43 end-to-end test cases (API, UI in Chrome, database) and 66 business rules, with the result and the way each was verified.

---

## 13. Request Flow Summary

```
POST /api/documents/upload
  → RequestLoggerMiddleware → helmet / CORS
  → FileInterceptor (Multer, memory, 10 MB)
  → PdfFilePipe
  → DocumentsController.upload
  → DocumentsService.upload
       sha256 → duplicate check → FileStorageService.save → INSERT document
       → runAttempt
            INSERT attempt
            → ExtractionService.extract
                 loadPdf → extractPageWords / (renderPage → TesseractOcrProvider) → buildLines
                 → parseTable (headerStrategy + linePatternStrategy → cleanRows → score)
                 → parseMetadata
            → TRANSACTION: report + parameters + attempt success + document status
  → toDocumentDetail → 201 JSON
errors anywhere → AllExceptionsFilter → { statusCode, code, message, … }
```
