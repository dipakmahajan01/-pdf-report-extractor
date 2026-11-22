# Low-Level Design (LLD) – PDF Report Data Extractor

This document turns the [HLD](./HLD.md) into concrete files, classes, method signatures, database schema, algorithms and an implementation order.

| Item | Choice |
|---|---|
| Language | TypeScript everywhere |
| Backend | NestJS 10 · Prisma · PostgreSQL 16 |
| PDF text | `pdfjs-dist` (legacy build for Node) |
| Page → image | `pdfjs-dist` + `@napi-rs/canvas` |
| Image cleanup | `sharp` |
| OCR | `tesseract.js` (LSTM, `eng` model bundled in `backend/tessdata/`) |
| Frontend | Next.js 14 (App Router) · Tailwind CSS |
| Tests | Jest (unit + e2e with Supertest) |


> **Implementation notes (final build vs. this plan)**
> - **TypeORM** replaced Prisma: npm resolved a Prisma 8 release candidate with a mismatched 7.x client. The schema is a plain-SQL migration in `backend/src/database/migrations`.
> - The schema has **4 tables**: `documents` (uploaded file + retry state) and `extraction_attempts` (history of every run) were added in front of `reports` / `report_parameters`, so a failed PDF can be retried without re-uploading. Endpoints are under `/api/documents`.
> - `report_parameters.name_normalized` was added for test-name normalisation.
> - OCR uses the `eng` model from the `@tesseract.js-data/eng` package (no separate `tessdata/` folder, no `sharp`); image clean-up is done on the canvas.
> - Tests use **Vitest** (NestJS 12 is ESM-only). The gap-detection strategy and rate limiting are listed as future improvements.
---

## 1. Repository Layout

```
pdf-report-extractor/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── src/
│   │   ├── main.ts                         bootstrap: helmet, CORS, global pipe/filter, timeout
│   │   ├── app.module.ts
│   │   ├── config/
│   │   │   └── app.config.ts               typed env config
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts
│   │   │   └── prisma.service.ts
│   │   ├── common/
│   │   │   ├── errors/
│   │   │   │   ├── error-codes.ts          ErrorCode enum
│   │   │   │   └── app.exception.ts        AppException (code + status + extra)
│   │   │   ├── filters/
│   │   │   │   └── all-exceptions.filter.ts
│   │   │   ├── middleware/
│   │   │   │   └── request-logger.middleware.ts
│   │   │   ├── pipes/
│   │   │   │   └── pdf-file-validation.pipe.ts
│   │   │   └── utils/
│   │   │       └── hash.util.ts            sha256(buffer)
│   │   ├── storage/
│   │   │   ├── storage.module.ts
│   │   │   └── file-storage.service.ts     save / read / delete PDFs on disk
│   │   ├── extraction/
│   │   │   ├── extraction.module.ts
│   │   │   ├── extraction.service.ts       orchestrates the pipeline
│   │   │   ├── types.ts                    Word, Line, PageContent, ParsedRow, ExtractionResult
│   │   │   ├── pdf/
│   │   │   │   ├── pdf-loader.ts           open PDF, detect corrupted / password
│   │   │   │   ├── text-extractor.ts       words + positions from text layer
│   │   │   │   └── page-renderer.ts        page → PNG buffer at N DPI
│   │   │   ├── ocr/
│   │   │   │   ├── ocr-provider.interface.ts
│   │   │   │   ├── tesseract-ocr.provider.ts
│   │   │   │   └── image-preprocessor.ts   sharp: greyscale, normalise, threshold
│   │   │   └── parsing/
│   │   │       ├── header-synonyms.ts      synonym dictionary + footer/stop words
│   │   │       ├── line-builder.ts         words → lines (group by y)
│   │   │       ├── metadata-parser.ts      report ID, patient, date, lab
│   │   │       ├── header-table.strategy.ts   strategy 1
│   │   │       ├── line-regex.strategy.ts     strategy 2
│   │   │       ├── row-postprocessor.ts    sections, wrapped names, flags, OCR fixes
│   │   │       ├── value-parser.ts         "<5", "128 H", "Positive"
│   │   │       ├── range-parser.ts         "13 - 17", "< 200", "Up to 5"
│   │   │       └── table-parser.ts         runs strategies, scores, picks best
│   │   ├── reports/
│   │   │   ├── reports.module.ts
│   │   │   ├── reports.controller.ts
│   │   │   ├── reports.service.ts
│   │   │   ├── reports.repository.ts       all Prisma queries for reports
│   │   │   └── dto/
│   │   │       ├── list-reports.query.dto.ts
│   │   │       └── report.response.ts      response mappers
│   │   └── health/
│   │       └── health.controller.ts
│   ├── storage/                            uploaded PDFs (git-ignored)
│   ├── tessdata/eng.traineddata            bundled OCR model
│   ├── test/
│   │   ├── unit/                           parser tests
│   │   └── e2e/reports.e2e-spec.ts
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                        upload page
│   │   └── reports/
│   │       ├── page.tsx                    list
│   │       └── [id]/page.tsx               detail (side-by-side)
│   ├── components/
│   │   ├── UploadDropzone.tsx
│   │   ├── ReportsTable.tsx
│   │   ├── ReportHeader.tsx
│   │   ├── StatusBanner.tsx
│   │   ├── ParametersTable.tsx
│   │   ├── PdfViewer.tsx
│   │   └── RawTextDialog.tsx
│   ├── lib/
│   │   ├── api.ts                          typed API client
│   │   └── types.ts                        shared response types
│   ├── .env.example
│   └── package.json
├── samples/
│   ├── generate-samples.js
│   └── *.pdf
├── docs/  HLD.md · LLD.md
├── .gitignore
└── README.md
```

---

## 2. Configuration

### backend/.env.example
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pdf_reports?schema=public
PORT=4000
FRONTEND_URL=http://localhost:3000
MAX_UPLOAD_MB=10
STORAGE_DIR=./storage
TESSDATA_DIR=./tessdata
OCR_DPI=300
OCR_RETRY_DPI=400
UPLOAD_TIMEOUT_MS=120000
THROTTLE_UPLOADS_PER_MIN=10
```

### frontend/.env.example
```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

### Tunable constants (`extraction/parsing/constants.ts`)
| Constant | Value | Meaning |
|---|---|---|
| `TEXT_PAGE_MIN_CHARS` | 20 | Fewer characters on a page → treat page as scanned |
| `LINE_Y_TOLERANCE` | 3 pt (text) / 0.5 × median word height (OCR) | Words within this y-distance are on the same line |
| `OCR_MIN_CONFIDENCE` | 60 | Below this average confidence → retry OCR |
| `REVIEW_SCORE_THRESHOLD` | 0.7 | Parse score below this → `needs_review` |
| `MIN_ROWS` | 1 | Fewer rows → no table found |

---

## 3. Database Schema (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ReportStatus {
  completed
  needs_review
  extraction_failed
}

enum ExtractionMethod {
  text
  ocr
  mixed
}

model Report {
  id               String           @id @default(uuid()) @db.Uuid
  reportId         String           @map("report_id") @db.VarChar(100)
  idAutoGenerated  Boolean          @default(false) @map("id_auto_generated")
  patientName      String?          @map("patient_name") @db.VarChar(200)
  reportDate       DateTime?        @map("report_date") @db.Date
  labName          String           @default("UNKNOWN") @map("lab_name") @db.VarChar(200)
  fileName         String           @map("file_name") @db.VarChar(255)
  filePath         String           @map("file_path") @db.VarChar(500)
  fileHash         String           @unique @map("file_hash") @db.Char(64)
  fileSizeBytes    Int              @map("file_size_bytes")
  pageCount        Int              @map("page_count")
  extractionMethod ExtractionMethod @map("extraction_method")
  status           ReportStatus
  failureReason    String?          @map("failure_reason")
  parseScore       Decimal?         @map("parse_score") @db.Decimal(4, 3)
  warnings         Json             @default("[]")
  rawText          String           @map("raw_text")
  createdAt        DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime         @updatedAt @map("updated_at") @db.Timestamptz

  parameters ReportParameter[]

  @@unique([labName, reportId])
  @@index([createdAt])
  @@map("reports")
}

model ReportParameter {
  id            String   @id @default(uuid()) @db.Uuid
  reportFk      String   @map("report_fk") @db.Uuid
  rowOrder      Int      @map("row_order")
  pageNumber    Int      @map("page_number")
  isSection     Boolean  @default(false) @map("is_section")
  sectionName   String?  @map("section_name") @db.VarChar(200)
  name          String   @db.VarChar(300)
  valueRaw      String?  @map("value_raw") @db.VarChar(200)
  valueNumeric  Decimal? @map("value_numeric") @db.Decimal(18, 6)
  comparator    String?  @db.VarChar(2)
  unit          String?  @db.VarChar(50)
  refRangeRaw   String?  @map("ref_range_raw") @db.VarChar(200)
  refLow        Decimal? @map("ref_low") @db.Decimal(18, 6)
  refHigh       Decimal? @map("ref_high") @db.Decimal(18, 6)
  flag          String?  @db.VarChar(2)
  ocrConfidence Decimal? @map("ocr_confidence") @db.Decimal(5, 2)
  extra         Json?

  report Report @relation(fields: [reportFk], references: [id], onDelete: Cascade)

  @@index([reportFk, rowOrder])
  @@index([name])
  @@map("report_parameters")
}
```

**Design notes**
- `labName` is **NOT NULL with default `UNKNOWN`**. PostgreSQL treats NULLs as distinct in unique indexes, so a nullable `lab_name` would let duplicate `(NULL, report_id)` pairs through.
- `Decimal` (not `Float`) for values and ranges, so `0.1` stays exactly `0.1`.
- `warnings` is a JSON array of `{ code, message }`, e.g. `{ "code": "ID_AUTO_GENERATED", "message": "…" }`.

---

## 4. Shared Types (`extraction/types.ts`)

```ts
export interface Word {
  text: string;
  x: number;          // left edge, top-left origin, PDF points
  y: number;          // top edge
  width: number;
  height: number;
  confidence?: number; // 0–100, OCR only
}

export interface Line {
  words: Word[];      // sorted by x
  y: number;          // average y
  text: string;       // words joined by single space
  page: number;       // 1-based
}

export interface PageContent {
  page: number;
  source: 'text' | 'ocr';
  lines: Line[];
  ocrConfidence?: number;
}

export interface ParsedRow {
  page: number;
  isSection: boolean;
  sectionName?: string;
  name: string;
  valueRaw?: string;
  valueNumeric?: number;
  comparator?: '<' | '>' | '<=' | '>=';
  unit?: string;
  refRangeRaw?: string;
  refLow?: number;
  refHigh?: number;
  flag?: 'H' | 'L';
  ocrConfidence?: number;
  extra?: Record<string, string>;
}

export interface ReportMetadata {
  reportId?: string;
  patientName?: string;
  reportDate?: Date;
  labName?: string;
}

export interface Warning { code: string; message: string; }

export interface ExtractionResult {
  pageCount: number;
  method: 'text' | 'ocr' | 'mixed';
  metadata: ReportMetadata;
  rows: ParsedRow[];
  score: number;                    // 0–1
  rawText: string;
  warnings: Warning[];
  failureReason?: string;           // set only when nothing could be parsed
}
```

---

## 5. Error Handling

### 5.1 Error codes (`common/errors/error-codes.ts`)
| ErrorCode | HTTP | When |
|---|---|---|
| `FILE_MISSING` | 400 | No file in the request |
| `INVALID_FILE_TYPE` | 400 | Wrong extension / MIME / missing `%PDF-` bytes |
| `INVALID_ID` | 400 | `:id` is not a UUID |
| `FILE_TOO_LARGE` | 413 | Over `MAX_UPLOAD_MB` |
| `DUPLICATE_FILE` | 409 | Same SHA-256 already stored (response includes `existingReportId`) |
| `DUPLICATE_REPORT_ID` | 409 | Same `(lab_name, report_id)` from a different file |
| `CORRUPTED_PDF` | 422 | pdfjs cannot open the file |
| `PASSWORD_PROTECTED` | 422 | pdfjs `PasswordException` |
| `NO_PARAMETERS_FOUND` | 422 | Digital PDF with no table rows (nothing saved) |
| `REPORT_NOT_FOUND` | 404 | Unknown report id |
| `TOO_MANY_REQUESTS` | 429 | Throttler limit hit |
| `INTERNAL_ERROR` | 500 | Anything unexpected |

### 5.2 `AppException`
```ts
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    public readonly extra: Record<string, unknown> = {},
  ) { super({ code, message, ...extra }, status); }
}
```

### 5.3 `AllExceptionsFilter` mapping
| Caught | Response |
|---|---|
| `AppException` | its status + code |
| `Prisma.PrismaClientKnownRequestError` `P2002` | 409 `DUPLICATE_REPORT_ID` |
| `P2025` | 404 `REPORT_NOT_FOUND` |
| `MulterError` `LIMIT_FILE_SIZE` | 413 `FILE_TOO_LARGE` |
| `ThrottlerException` | 429 `TOO_MANY_REQUESTS` |
| Other `HttpException` | pass through |
| Anything else | 500 `INTERNAL_ERROR` (message hidden, full stack logged with request ID) |

Response body:
```json
{ "statusCode": 409, "code": "DUPLICATE_FILE", "message": "This PDF has already been uploaded.",
  "existingReportId": "…", "requestId": "…", "timestamp": "…" }
```

---

## 6. Backend Classes and Methods

### 6.1 `main.ts`
- `app.setGlobalPrefix('api')`
- `app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))` (PDF iframe from another port)
- `app.enableCors({ origin: FRONTEND_URL })`
- `app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`
- `app.useGlobalFilters(new AllExceptionsFilter())`
- `server.setTimeout(UPLOAD_TIMEOUT_MS)` for long OCR requests

### 6.2 `RequestLoggerMiddleware`
```ts
use(req, res, next): void
// requestId = req.headers['x-request-id'] ?? randomUUID(); set on req + response header
// on res 'finish': log `${method} ${url} ${status} ${ms}ms [${requestId}]`
```

### 6.3 `PdfFileValidationPipe`
```ts
transform(file?: Express.Multer.File): Express.Multer.File
// 1. !file                                   → FILE_MISSING
// 2. !originalname.toLowerCase().endsWith('.pdf') → INVALID_FILE_TYPE
// 3. mimetype not in ['application/pdf','application/x-pdf','application/octet-stream'] → INVALID_FILE_TYPE
// 4. buffer.subarray(0,5).toString() !== '%PDF-'                                      → INVALID_FILE_TYPE
```

### 6.4 `ReportsController`
```ts
@Controller('reports')
class ReportsController {
  @Post('upload') @UseGuards(ThrottlerGuard)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize } }))
  upload(@UploadedFile(PdfFileValidationPipe) file): Promise<ReportDetailResponse>     // 201

  @Get()            list(@Query() q: ListReportsQueryDto): Promise<Paginated<ReportSummary>>
  @Get(':id')       get(@Param('id', ParseUUIDPipe) id): Promise<ReportDetailResponse>
  @Get(':id/raw-text') rawText(@Param('id', ParseUUIDPipe) id): Promise<{ rawText: string }>
  @Get(':id/file')  file(@Param('id', ParseUUIDPipe) id, @Res() res): Promise<void> // stream, Content-Type application/pdf, inline
  @Post(':id/reprocess') reprocess(@Param('id', ParseUUIDPipe) id): Promise<ReportDetailResponse>
  @Delete(':id') @HttpCode(204) remove(@Param('id', ParseUUIDPipe) id): Promise<void>
}
```

`ListReportsQueryDto`: `page` (int ≥ 1, default 1), `limit` (int 1–100, default 20).

### 6.5 `ReportsService`

```ts
async upload(file): Promise<ReportDetailResponse>
```
```
1. hash = sha256(file.buffer)
2. existing = repo.findByHash(hash)
   if existing → throw DUPLICATE_FILE { existingReportId: existing.id }
3. result = extraction.extract(file.buffer)          // may throw CORRUPTED_PDF / PASSWORD_PROTECTED
4. isScanned = result.method !== 'text'
   if result.rows.length === 0:
       if !isScanned → throw NO_PARAMETERS_FOUND (nothing saved)
       status = extraction_failed
   else status = result.score < REVIEW_SCORE_THRESHOLD ? needs_review : completed
5. { reportId, idAutoGenerated } = resolveReportId(result.metadata.reportId, hash)
   if idAutoGenerated → warnings.push(ID_AUTO_GENERATED)
6. labName = metadata.labName ?? 'UNKNOWN'
   if repo.existsByLabAndReportId(labName, reportId) → throw DUPLICATE_REPORT_ID
7. filePath = storage.save(hash, file.buffer)        // storage/<hash>.pdf
8. try   report = repo.createWithParameters({...}, rows)   // one transaction
   catch → storage.delete(filePath); rethrow             // no orphan files
9. return toDetailResponse(report)
```

```ts
resolveReportId(found: string | undefined, hash: string): { reportId: string; idAutoGenerated: boolean }
// found → { found.trim().toUpperCase(), false }
// else  → { `AUTO-${yyyymmdd(now)}-${hash.slice(0, 6)}`, true }
```

```ts
async reprocess(id): Promise<ReportDetailResponse>
// load report (404) → buffer = storage.read(filePath) → extraction.extract(buffer)
// recompute status / metadata / warnings as in upload
// repo.replaceParameters(id, reportFields, rows)   // transaction: update report, deleteMany params, createMany params
```

`list`, `get`, `getRawText`, `getFile`, `remove` are thin calls to the repository (`remove` also deletes the stored file).

### 6.6 `ReportsRepository`
```ts
findByHash(hash: string): Promise<Report | null>
existsByLabAndReportId(lab: string, reportId: string, excludeId?: string): Promise<boolean>
createWithParameters(data: ReportCreateInput, rows: ParsedRow[]): Promise<ReportWithParams>  // $transaction
replaceParameters(id: string, data: ReportUpdateInput, rows: ParsedRow[]): Promise<ReportWithParams>
findPage(page: number, limit: number): Promise<{ items: ReportSummary[]; total: number }>   // includes _count.parameters
findById(id: string): Promise<ReportWithParams | null>   // parameters ordered by rowOrder asc
delete(id: string): Promise<void>
```
Row → DB mapping: `rowOrder` = index in `rows`.

### 6.7 `FileStorageService`
```ts
save(hash: string, buffer: Buffer): Promise<string>   // writes STORAGE_DIR/<hash>.pdf, returns relative path
read(path: string): Promise<Buffer>
createReadStream(path: string): ReadStream
delete(path: string): Promise<void>                   // ignores ENOENT
```

---

## 7. Extraction Engine

### 7.1 `ExtractionService.extract(buffer): Promise<ExtractionResult>`
```
doc = pdfLoader.load(buffer)                       // throws CORRUPTED_PDF / PASSWORD_PROTECTED
pages: PageContent[] = []
for p in 1..doc.numPages:
    words = textExtractor.getWords(doc, p)
    if totalChars(words) >= TEXT_PAGE_MIN_CHARS:
        pages.push({ page: p, source: 'text', lines: lineBuilder.build(words, p, 'text') })
    else:
        pages.push(ocrPage(doc, p, attempt = 1))

method   = all text → 'text' | all ocr → 'ocr' | else 'mixed'
rawText  = pages.flatMap(lines).map(l => l.text).join('\n')   (with "--- page N ---" markers)
metadata = metadataParser.parse(first page lines)
{ rows, score } = tableParser.parse(pages)

// OCR retry: if any page is OCR and (rows empty OR avg OCR confidence < OCR_MIN_CONFIDENCE)
if needsRetry:
    re-run ocrPage(doc, p, attempt = 2) for the OCR pages, parse again
    keep whichever attempt has the higher score (tie → more rows)

if rows empty and method != 'text':
    failureReason = `Could not read a table from the scanned PDF (OCR confidence ${conf}%). The image quality may be too low.`

warnings: OCR_USED, OCR_RETRIED, LOW_CONFIDENCE_ROWS(n), MULTI_PAGE_TABLE(n pages), NEEDS_REVIEW
return result
```

`ocrPage(doc, p, attempt)`:
| | Attempt 1 | Attempt 2 (retry) |
|---|---|---|
| Render DPI | `OCR_DPI` (300) | `OCR_RETRY_DPI` (400) |
| Pre-processing | greyscale + normalise | greyscale + normalise + threshold (binarise) + median(1) |
| Tesseract PSM | 6 (single uniform block) | 4 (single column of variable sizes) |

OCR word coordinates are converted from pixels to PDF points (`× 72 / dpi`) so the same parser thresholds apply.

### 7.2 `PdfLoader.load(buffer): Promise<PDFDocumentProxy>`
- `pdfjs-dist/legacy/build/pdf.mjs` is ESM, so it is loaded with a cached dynamic `import()` from the CommonJS NestJS build.
- `getDocument({ data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false })`
- `PasswordException` → `PASSWORD_PROTECTED`; any other error → `CORRUPTED_PDF`.

### 7.3 `TextExtractor.getWords(doc, pageNo): Promise<Word[]>`
```
page = doc.getPage(pageNo); viewport = page.getViewport({ scale: 1 })
content = page.getTextContent()
for item in content.items where item.str.trim() != '':
    [ , , , , tx, ty] = item.transform
    x = tx; height = item.height || abs(item.transform[3])
    y = viewport.height - ty - height           // flip to top-left origin
    split item.str on 2+ spaces into separate Words (x advanced proportionally by char width)
```
Splitting on 2+ spaces matters because some PDFs put a whole row into one text item.

### 7.4 `PageRenderer.render(doc, pageNo, dpi): Promise<Buffer>`
`scale = dpi / 72` → `@napi-rs/canvas` `createCanvas(w, h)` → `page.render({ canvasContext, viewport })` → `canvas.toBuffer('image/png')`.

### 7.5 `ImagePreprocessor`
```ts
basic(png: Buffer): Promise<Buffer>   // sharp(png).greyscale().normalise().png()
strong(png: Buffer): Promise<Buffer>  // sharp(png).greyscale().normalise().median(1).threshold(170).png()
```

### 7.6 OCR provider
```ts
export interface OcrProvider {
  recognize(image: Buffer, opts: { psm: number }): Promise<{ words: Word[]; confidence: number }>;
}
```
`TesseractOcrProvider` (implements `OnModuleInit`, `OnModuleDestroy`):
- `onModuleInit`: `createWorker('eng', OEM.LSTM_ONLY, { langPath: TESSDATA_DIR, cacheMethod: 'none', gzip: false })` – created **once**, reused.
- `recognize`: `worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' })` → `worker.recognize(image, {}, { blocks: true })` → flatten `blocks → paragraphs → lines → words` into `Word { text, x: bbox.x0, y: bbox.y0, width, height, confidence }`; drop words with confidence < 30 and empty text.
- `onModuleDestroy`: `worker.terminate()`.
- Registered under an injection token `OCR_PROVIDER`, so a different provider can be swapped in.

---

## 8. Parsing Algorithms

### 8.1 `LineBuilder.build(words, page, source): Line[]`
```
tolerance = source === 'text' ? 3 : 0.5 * median(word.height)
sort words by y, then x
for each word: put into the current line if |word.centerY - line.centerY| <= tolerance, else start a new line
sort each line's words by x; line.text = words.map(text).join(' ')
```

### 8.2 `header-synonyms.ts`
```ts
export const COLUMN_SYNONYMS: Record<ColumnKey, string[]> = {
  name:  ['test', 'test name', 'test description', 'investigation', 'parameter', 'examination', 'analyte'],
  value: ['result', 'results', 'value', 'observed value', 'observation', 'your value', 'reading'],
  unit:  ['unit', 'units', 'uom'],
  range: ['reference range', 'ref range', 'ref. range', 'normal range', 'normal value',
          'biological ref', 'biological reference interval', 'reference interval', 'reference'],
  flag:  ['flag', 'status'],
  method:['method', 'methodology'],
};
export const STOP_WORDS = ['end of report', 'pathologist', 'interpretation', 'authorised by',
                           'authorized by', 'signature', 'note:', 'comments', '*** end'];
export const KNOWN_UNITS = ['g/dl','mg/dl','mmol/l','µmol/l','umol/l','iu/l','u/l','%','fl','pg',
                            'cells/µl','cells/cumm','/cumm','10^3/µl','10^6/µl','mill/cumm',
                            'lakh/cumm','mg/l','ng/ml','pg/ml','µiu/ml','miu/l','meq/l','mm/hr','sec','ratio'];
```
Matching normalises text: lower-case, remove `.`, `:`, `()`, collapse spaces.

### 8.3 `MetadataParser.parse(lines): ReportMetadata`
Searches the lines **above the table header** (or the first 25 lines):
| Field | Pattern (case-insensitive) |
|---|---|
| reportId | `(report\s*id\|sample\s*id\|sample\s*no\|lab\s*no\|accession\s*no\|reg(istration)?\.?\s*no\|barcode)\s*[:#.-]?\s*([A-Z0-9][A-Z0-9\-/]{2,})` |
| patientName | `(patient\s*name\|patient\|name)\s*[:.-]\s*(?:mr\.?\|mrs\.?\|ms\.?)?\s*([A-Za-z .]{2,60}?)(?=\s{2,}\|age\|sex\|$)` |
| reportDate | label `(report(ed)?\s*date\|date)` followed by `dd/mm/yyyy`, `dd-mm-yyyy`, `dd-Mon-yyyy` or `yyyy-mm-dd`; parsed as day-first; invalid dates ignored |
| labName | first non-empty line on page 1 that contains `lab`, `diagnostic`, `pathology` or `clinic`; else `UNKNOWN` |

### 8.4 Strategy 1 – `HeaderTableStrategy.parse(pages): ParsedRow[]`
```
for each page:
    headerLine = first line where matchColumns(line) contains both 'name' and 'value'
    if none and this page continues a table from the previous page → reuse previous column layout
    if none and no previous layout → skip page
    columns = for each matched header word: { key, xStart: word.x }
              sorted by xStart; column boundary = midpoint between neighbours' xStart
              (first column starts at 0, last ends at +∞)
    for each line after headerLine:
        if line matches a STOP_WORD → stop table (for this and later pages)
        if line is a repeat of the header → skip
        cells = assign each word to the column whose [start, end) contains word.x; join words per column
        row = { name: cells.name, valueRaw: cells.value, unit: cells.unit, refRangeRaw: cells.range,
                extra: { method: cells.method }, page }
        rows.push(row)
return rowPostprocessor.process(rows)
```
`matchColumns(line)` tries 1-, 2- and 3-word windows against the synonym list, so multi-word headers like `Biological Ref. Interval` match.

### 8.5 Strategy 2 – `LineRegexStrategy.parse(pages): ParsedRow[]`
For each line (between the first and last plausible row, stopping at STOP_WORDS):
```
^(?<name>[A-Za-z][A-Za-z0-9 ()/,.&%+-]*?)\s+
 (?<value>[<>]=?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?|positive|negative|reactive|non[- ]reactive|nil|absent|present|trace|detected|not detected)
 (?:\s*(?<flag>\bH\b|\bL\b|\*|↑|↓))?
 (?:\s+(?<unit>[A-Za-zµ%/^0-9.]+(?:\/[A-Za-zµ0-9.^]+)?))?
 (?:\s+(?<range>.+))?$                                         (case-insensitive)
```
`unit` is accepted only if it is in `KNOWN_UNITS` or looks like `x/y`; otherwise that text is treated as the start of the range.

### 8.6 `RowPostprocessor.process(rows): ParsedRow[]`
Applied in this order:
1. **Trim** every cell; empty strings → `undefined`.
2. **Section headings** – a row with a name, no value, no unit, no range, and (all upper-case **or** ends with `:`) → `isSection = true`. Following rows get `sectionName`.
3. **Wrapped names** – a row with only a name, not a section, directly after a data row on the same page → append to that row's name (`Glucose Fasting` + `(Plasma)`).
4. **Unit stuck to value** – `^([<>]=?\s*\d+(?:\.\d+)?)\s*([A-Za-zµ%/].*)$` on `valueRaw` with no unit → split.
5. **Flag** – trailing ` H`, ` L`, `*`, `↑`, `↓` on `valueRaw` → `flag` (`*`/`↑` → `H`, `↓` → `L`). A separate `flag` column is also respected.
6. **OCR fixes** (OCR rows only, value column only) – `O/o → 0`, `l/I → 1`, `S → 5` **only when** the rest of the cell is numeric.
7. **Parse** value with `ValueParser` and range with `RangeParser`.
8. **Drop junk** – rows whose name is empty or is just digits/punctuation.
9. **Compute flag** when none was printed but `valueNumeric` and the range exist (`> refHigh` → `H`, `< refLow` → `L`).

### 8.7 `ValueParser.parse(raw?): { valueNumeric?, comparator? }`
| Input | Output |
|---|---|
| `13.5` | `{ valueNumeric: 13.5 }` |
| `1,50,000` / `150,000` | `{ valueNumeric: 150000 }` (commas removed) |
| `<5`, `< 5`, `<=5` | `{ valueNumeric: 5, comparator: '<' / '<=' }` |
| `>1000` | `{ valueNumeric: 1000, comparator: '>' }` |
| `Positive`, `Nil`, `Reactive`, `Trace` | `{}` (only `valueRaw` is kept) |
| `undefined` / `-` / `--` | `{}` |

### 8.8 `RangeParser.parse(raw?): { refLow?, refHigh? }`
| Pattern | Example | Result |
|---|---|---|
| `a - b` / `a – b` / `a to b` | `13.0 - 17.0` | low 13, high 17 |
| `< b` / `<= b` / `up to b` / `upto b` / `below b` | `< 200` | high 200 |
| `> a` / `>= a` / `above a` | `> 40` | low 40 |
| Gender/age-specific, text, anything else | `M: 13-17 F: 12-15`, `Negative` | nothing (raw text kept) |

### 8.9 `TableParser.parse(pages): { rows, score }`
```
candidates = [headerStrategy.parse(pages), lineRegexStrategy.parse(pages)]
score(rows) = rows.length === 0 ? 0
            : count(r => !r.isSection && r.name && r.valueRaw) / count(r => !r.isSection)
best = candidate with highest score; tie → more rows; tie → header strategy
```

---

## 9. API Contract

### `POST /api/reports/upload` → 201
Request: `multipart/form-data`, field `file`.
```json
{
  "id": "6b1e…",
  "reportId": "SMP-20481",
  "idAutoGenerated": false,
  "patientName": "Ramesh Patil",
  "reportDate": "2026-11-18",
  "labName": "CITY DIAGNOSTIC LAB",
  "fileName": "01-basic-8-params.pdf",
  "pageCount": 1,
  "extractionMethod": "text",
  "status": "completed",
  "failureReason": null,
  "parseScore": 1,
  "warnings": [],
  "createdAt": "2026-11-22T06:30:00.000Z",
  "parameters": [
    { "rowOrder": 0, "page": 1, "isSection": false, "sectionName": null,
      "name": "Hemoglobin", "valueRaw": "13.5", "valueNumeric": 13.5, "comparator": null,
      "unit": "g/dL", "refRangeRaw": "13.0 - 17.0", "refLow": 13, "refHigh": 17,
      "flag": null, "ocrConfidence": null, "extra": null }
  ]
}
```
Decimals are converted to JS numbers in the response mapper.

### `GET /api/reports?page=1&limit=20` → 200
```json
{ "items": [ { "id": "…", "reportId": "SMP-20481", "patientName": "…", "reportDate": "…",
               "labName": "…", "extractionMethod": "text", "status": "completed",
               "parameterCount": 8, "createdAt": "…" } ],
  "page": 1, "limit": 20, "total": 12 }
```

Other endpoints follow the HLD (section 8): `GET /:id`, `GET /:id/raw-text`, `GET /:id/file`, `POST /:id/reprocess`, `DELETE /:id`, `GET /health`.

---

## 10. Frontend Design

### 10.1 `lib/api.ts`
```ts
uploadReport(file: File, onProgress?: (pct: number) => void): Promise<ReportDetail>  // XMLHttpRequest for upload progress
listReports(page = 1, limit = 20): Promise<Paginated<ReportSummary>>
getReport(id: string): Promise<ReportDetail>
getRawText(id: string): Promise<string>
reprocessReport(id: string): Promise<ReportDetail>
deleteReport(id: string): Promise<void>
fileUrl(id: string): string                    // `${API}/reports/${id}/file`
class ApiError extends Error { status; code; extra }
```

### 10.2 Pages
| Page | Type | Behaviour |
|---|---|---|
| `/` (upload) | client component | `UploadDropzone`; on success → redirect to `/reports/[id]`; on 409 `DUPLICATE_FILE` → message with a link to the existing report |
| `/reports` | client component | `ReportsTable` with pagination, status badges, delete button |
| `/reports/[id]` | client component | `ReportHeader` + `StatusBanner` + two-column grid: `PdfViewer` (left) and `ParametersTable` (right); stacks vertically on small screens |

### 10.3 Components
| Component | Props | Notes |
|---|---|---|
| `UploadDropzone` | `onUploaded(report)` | States: `idle → uploading (progress %) → processing ("Reading PDF… scanned PDFs can take up to 30 s") → error`. Client-side check: `.pdf` and ≤ 10 MB before sending. |
| `ReportsTable` | `items, onDelete` | Columns: Report ID, Patient, Date, Lab, Params, Method, Status, Uploaded |
| `ReportHeader` | `report` | Report ID (+ "auto-generated" badge), patient, date, lab, method, pages |
| `StatusBanner` | `status, failureReason, warnings, onReprocess` | green / yellow `needs_review` / red `extraction_failed` with Reprocess button |
| `ParametersTable` | `parameters` | Columns: Test, Result, Unit, Reference Range. Section rows span the full width. `H`/`L` → red/blue + arrow. Missing cell → "—". OCR confidence < 70 → dotted underline + tooltip. |
| `PdfViewer` | `src` | `<iframe src={fileUrl(id)} />` |
| `RawTextDialog` | `reportId` | Loads raw text on open, `<pre>` in a modal |

---

## 11. Sample PDFs (`samples/generate-samples.js`, uses `pdfkit`)

| File | Layout / purpose |
|---|---|
| `01-basic-8-params.pdf` | Test / Result / Unit / Reference Range |
| `02-lipid-10-params.pdf` | H/L flags, `< 200` style ranges |
| `03-cbc-12-params.pdf` | `Investigation / Observed Value / Units / Biological Ref. Interval` |
| `04-different-layout.pdf` | Column order Name / Range / Value / Unit + `Method` column, `Lab No.` label |
| `05-special-values.pdf` | `<5`, `>1000`, `Positive`, `Nil`, `Reactive` |
| `06-missing-fields.pdf` | Rows without unit or range |
| `07-no-report-id.pdf` | No ID → auto-generated |
| `08-multipage-25-params.pdf` | Sections, wrapped names, repeated header, 3 pages |
| `09-scanned-clean.pdf` | Image-only page (rendered from 01) |
| `10-scanned-noisy.pdf` | Image-only, 1.5° tilt + noise + blur |
| `11-not-a-pdf.pdf` | Text file renamed |
| `12-corrupted.pdf` | Truncated PDF |

Scanned samples: render the digital page with `pdfjs-dist` + `@napi-rs/canvas`, degrade with `sharp` (rotate, noise, blur), embed the PNG into a new PDF with `pdfkit`.

---

## 12. Test Plan

### Unit tests (`backend/test/unit`)
| Suite | Cases |
|---|---|
| `value-parser.spec.ts` | `13.5`, `1,50,000`, `<5`, `<= 5`, `>1000`, `Positive`, `Nil`, empty, `-` |
| `range-parser.spec.ts` | `13 - 17`, `13.0–17.0`, `4 to 11`, `< 200`, `Up to 5`, `> 40`, `M: 13-17 F: 12-15`, `Negative` |
| `metadata-parser.spec.ts` | each ID label, missing ID, date formats, invalid date |
| `line-builder.spec.ts` | words at slightly different y on one line; two close lines kept apart |
| `row-postprocessor.spec.ts` | section detection, wrapped name, `13.5g/dL` split, `128 H` flag, OCR `1O.5` → `10.5`, computed flag |
| `header-table.strategy.spec.ts` | synonyms, different column order, repeated header on page 2, stop words |

### E2E tests (`backend/test/e2e/reports.e2e-spec.ts`, Supertest against a test DB)
| Case | Expected |
|---|---|
| Upload each sample 01–08 | 201, correct parameter count |
| Upload 01 twice | second → 409 `DUPLICATE_FILE` |
| Upload 07 | 201, `idAutoGenerated: true` |
| Upload 09 | 201, `extractionMethod: "ocr"` |
| Upload 11 | 400 `INVALID_FILE_TYPE` |
| Upload 12 | 422 `CORRUPTED_PDF` |
| No file | 400 `FILE_MISSING` |
| `GET /reports/not-a-uuid` | 400 |
| `DELETE` then `GET` | 204 then 404 |

---

## 13. Implementation Order and Commit Plan

| # | Step | Commit message | Est. |
|---|---|---|---|
| 1 | Repo, `.gitignore`, docs, folder skeleton | `chore: initial project structure and design docs` | 15 m |
| 2 | Sample generator + PDFs | `feat(samples): generate sample lab report PDFs` | 45 m |
| 3 | NestJS app, config, Prisma schema, migration, health | `feat(backend): nestjs setup with prisma schema` | 40 m |
| 4 | Errors, filter, logger middleware, validation pipe | `feat(backend): error handling, logging and upload validation` | 30 m |
| 5 | PDF loader + text extractor + line builder | `feat(extraction): read pdf text with positions` | 40 m |
| 6 | Value/range/metadata parsers + unit tests | `feat(parsing): value, range and metadata parsers` | 50 m |
| 7 | Header strategy, regex strategy, post-processor, table parser + tests | `feat(parsing): table detection for varying layouts` | 80 m |
| 8 | Page renderer, preprocessor, Tesseract provider, retry | `feat(ocr): tesseract ocr for scanned pages with retry` | 60 m |
| 9 | Storage, repository, service, controller | `feat(reports): upload, list, detail, reprocess, delete api` | 50 m |
| 10 | Next.js app: upload, list, detail pages | `feat(frontend): upload and report views` | 90 m |
| 11 | E2E tests | `test: e2e tests for upload edge cases` | 30 m |
| 12 | README | `docs: readme with design, edge cases and setup` | 30 m |

**Cut order if time runs short:** throttler → e2e tests → reprocess endpoint → raw-text dialog → OCR retry (keep single attempt + `extraction_failed`).
