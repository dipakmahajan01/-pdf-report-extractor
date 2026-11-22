# Lab Report Extractor

Upload a lab report PDF (digital **or scanned**), extract every test parameter, store it in PostgreSQL against the report's Report/Sample ID, and view it as a table next to the original PDF.

**Stack:** NestJS 12 (backend) · Next.js 16 (frontend) · PostgreSQL · TypeORM · pdf.js · Tesseract OCR

> **Demo video:** _add link here_ (3–5 min: upload, digital + scanned PDF, duplicate, bad file, failed scan + retry)

Design documents: [High-Level Design](docs/HLD.md) · [Low-Level Design](docs/LLD.md) · [Test case sheet](docs/Test_Cases.xlsx)

---

## 1. What I built

- **Upload page:** drag-and-drop a PDF, see upload progress, then the extracted report opens automatically.
- **Report list:** every uploaded file with its Report ID, patient, lab, date, number of tests and status (`completed`, `needs_review`, `failed`), with **Retry** and **Delete** buttons.
- **Report page:** the **original PDF on the left, the extracted table on the right**, in the same order and sections as the PDF. High/low values are highlighted, OCR values with low confidence are marked, and warnings are shown at the top. Below are the processing history (every attempt) and the raw extracted text.
- **REST API** (NestJS) that validates, extracts, stores and serves the data.
- **12 sample PDFs** in [`samples/`](samples) covering every edge case, plus the script that generated them.

### Screens / flow

```
Upload PDF ──► validate ──► save file + document row ──► extract (text layer or OCR)
                                                     ──► parse table ──► save report + parameters (1 transaction)
                                                     └─► on failure: record the attempt, keep the file, allow Retry
```

---

## 2. How the PDF is read

The logic lives in [`backend/src/extraction/`](backend/src/extraction).

1. **Open the PDF** with `pdf.js`. If it cannot be opened, it is `CORRUPTED_PDF`; if it is encrypted, `PASSWORD_PROTECTED`.
2. **Digital or scanned? (per page).** pdf.js returns the text layer with the **x/y position of every word**. A page with fewer than 20 characters is an image (a scan).
3. **Scanned pages → OCR.** The page is rendered to an image at 300 DPI and read by **Tesseract 5 (LSTM English model)** via `tesseract.js`. The model ships inside `node_modules`, so OCR works offline with no extra install. Tesseract also returns word positions and a confidence score.
   - **One retry:** if OCR confidence is below 75%, the page is rendered again, converted to black and white and cleaned of specks (median filter), then read with a different page mode. The better result is kept.
   - If confidence is **still below 70%**, extraction **fails on purpose** (`OCR_LOW_CONFIDENCE`) instead of saving guessed lab values.
4. **Rebuild lines:** words with almost the same vertical position are one row.
5. **Find the table: two strategies; the more complete result wins.**
   - **Header strategy (main):** find the header line using a dictionary of synonyms, e.g. `Test / Investigation / Parameter`, `Result / Observed Value`, `Unit / Units`, `Reference Range / Biological Ref. Interval`, plus `Method` and `Flag`. The x-position of each header word becomes a column boundary, so **column order does not matter** and **extra columns are kept**.
   - **Line-pattern strategy (fallback):** a regex per line, `<name> <value> [H/L] [unit] [range]`, for reports without a recognisable header.
   - The table ends at `End of Report`, `Pathologist`, etc. On the next page, the repeated header and "continued" lines are skipped, so **tables spanning several pages** are joined.
6. **Clean every row:**
   - Name-only lines in CAPITALS become **section headings** (`HAEMATOLOGY`); other name-only lines are the **second line of the previous name**.
   - `128 H` becomes value `128` + flag `H`; `13.5g/dL` becomes value + unit.
   - `<5` / `>1000` become a number + comparator; `Positive`, `Nil` and `Non Reactive` stay as text.
   - Ranges `13 - 17`, `< 200`, `Up to 5`, `> 40` become low/high limits; anything else stays as text.
   - H/L is calculated when the PDF did not print it (digital PDFs only, because a misread OCR range would give a wrong flag).
   - Test names are normalised for search (`Haemoglobin`, `Hb` → `Hemoglobin`); units are standardised (`gm/dl` → `g/dL`).
7. **Report details** (Report/Sample ID, patient name, report date, lab name) come from the lines **above the table** using patterns for common labels: `Sample ID`, `Report ID`, `Lab No.`, `Accession No`, `Reg. No`.

---

## 3. Database design

Four tables, migration in plain SQL: [`backend/src/database/migrations`](backend/src/database/migrations).

```
documents (1) ──< extraction_attempts (many)        every run: success or failure, stage, error, timing
    │
    └──(0..1) reports (1) ──< report_parameters (many)
               created only when extraction succeeds; one row per test
```

| Table | Purpose | Key constraints |
|---|---|---|
| `documents` | One row per uploaded file: name, stored path, SHA-256 hash, status, attempt count, last error, retryable flag | `UNIQUE(file_hash)` |
| `extraction_attempts` | History of every extraction run | `UNIQUE(document_fk, attempt_no)`, FK cascade |
| `reports` | Report header: Report ID, patient, date, lab, method, warnings, raw text | `UNIQUE(document_fk)`, `UNIQUE(lab_name, report_id)` |
| `report_parameters` | **One row per test line**: name, normalised name, value (raw text + number + comparator), unit, range (raw + low/high), flag, section, page, order, OCR confidence, extra columns (JSONB) | FK cascade, index `(report_fk, row_order)` and on `name_normalized` |

### Why this design
- **A varying number of parameters → rows, not columns.** A report with 8 tests has 8 rows and one with 27 has 27. No schema change is ever needed for a new test. One column per test (`hemoglobin`, `glucose`…) would break with every new test; one JSONB blob would be hard to query and validate.
- **Keep the original and the parsed value.** `value_raw` always stores exactly what the PDF says (`<5`, `Positive`, `13.5`); `value_numeric` is filled only when it is a real number. Nothing is lost, and numeric queries still work (e.g. "all reports where glucose > 110").
- **The file is separate from the report.** `documents` is saved **before** extraction, so a failure at any stage still leaves the file and an attempt record, and the whole flow can be **retried** without uploading again.
- **Duplicates are blocked by the database**, not by "check then insert" (which two simultaneous requests could both pass): `UNIQUE(file_hash)` and `UNIQUE(lab_name, report_id)`. `lab_name` is `NOT NULL DEFAULT 'UNKNOWN'` on purpose, because PostgreSQL treats NULLs as distinct, which would bypass the unique check.
- **Normalised to 3NF:** patient/lab/date are stored once per report, not on every test row. JSONB is used only for small, unstructured data (`warnings`, extra columns like `Method`).
- **Exact decimals** (`numeric`) for values and ranges.

---

## 4. Edge cases handled

| Edge case | How it is handled | Result |
|---|---|---|
| **Scanned (image) PDF** | Per-page detection → Tesseract OCR; one retry with image clean-up | `201`, method `OCR`; warning to verify values |
| **Very poor scan** | OCR confidence < 70% after the retry → fail instead of storing guesses; file kept | `422 OCR_LOW_CONFIDENCE`, document `failed`, **Retry** available (max 3 attempts) |
| **Missing value / unit / range** | Stored as NULL, shown as "—"; rows are kept | `201` |
| **Non-numeric values** (`<5`, `>1000`, `Positive`, `Nil`, `Non Reactive`, `2-4`) | `value_raw` keeps the text; number + comparator only when possible | `201` |
| **Same PDF uploaded twice** | SHA-256 hash, `UNIQUE(file_hash)` | `409 DUPLICATE_FILE` with a link to the existing document |
| **Different file, same Report ID** (same lab) | `UNIQUE(lab_name, report_id)`; the extra file is removed | `409 DUPLICATE_REPORT_ID` |
| **Report/Sample ID missing** | `AUTO-<yyyymmdd>-<hash>` is generated, `id_auto_generated = true`, warning shown | `201` |
| **Table continues across pages** | All pages parsed; repeated headers and "continued" lines skipped; `page_number` stored | `201`, warning "table spans N pages" |
| **Non-PDF file** | Extension + MIME type + `%PDF-` magic bytes (also checked in the browser) | `400 INVALID_FILE_TYPE` |
| **Corrupted PDF** | pdf.js cannot open it → not retryable | `422 CORRUPTED_PDF` |
| **Password-protected PDF** | Detected separately → not retryable | `422 PASSWORD_PROTECTED` |
| No file / file > 10 MB | Validation pipe / Multer limit | `400 FILE_MISSING` / `413` |
| No table found in a digital PDF | Nothing usable → attempt recorded | `422 NO_PARAMETERS_FOUND` |
| Different layouts | Header synonyms, any column order, extra `Method` column, `Lab No.` / `Accession No` labels | `201` |
| Sections and two-line test names | Section headings stored as section rows; wrapped names joined | `201` |
| Low parse quality / medium OCR confidence | Saved with status `needs_review` + warning | `201` |
| Server stopped mid-processing | On startup, documents stuck in `processing` > 10 min become `failed` (retryable) | — |
| Two retry clicks at once | Atomic `UPDATE … WHERE status <> 'processing'` claim | `409 ALREADY_PROCESSING` |
| DB error while saving | Report + parameters in one transaction → full rollback, attempt marked failed at stage `save` | `422 SAVE_FAILED`, retryable |

Every error has the same JSON shape: `{ statusCode, code, message, ...details, path, timestamp }`.

---

## 5. Run locally

**Requirements:** Node.js 22+ (tested on 24), PostgreSQL 14+ (tested on 19). Nothing else: OCR runs inside Node.

### 1. Database
```bash
psql -U postgres -c "CREATE DATABASE pdf_reports;"
```

### 2. Backend (port 4000)
```bash
cd backend
cp .env.example .env        # set DATABASE_URL: user, password and port of your PostgreSQL
npm install
npm run build
npm run start:prod          # or: npm run start:dev
```
Tables are created automatically on start by the migration. Check: <http://localhost:4000/api/health>

### 3. Frontend (port 3000)
```bash
cd frontend
cp .env.example .env.local  # NEXT_PUBLIC_API_URL=http://localhost:4000/api
npm install
npm run dev
```
Open <http://localhost:3000> and upload any file from [`samples/`](samples).

### Tests
```bash
cd backend
npm test                    # 63 tests: every sample PDF + 52 business-rule unit tests
```

### Regenerate the sample PDFs (optional)
```bash
cd samples && npm install && npm run generate
```

### API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/documents/upload` | Upload (`multipart/form-data`, field `file`) → 201 document + report, or 400/409/413/422 |
| `GET` | `/api/documents?page=1&limit=20` | List documents with report summary |
| `GET` | `/api/documents/:id` | Document, report, parameters (PDF order) and attempt history |
| `GET` | `/api/documents/:id/file` | The original PDF |
| `POST` | `/api/documents/:id/retry` | Run the whole extraction again on the stored file |
| `DELETE` | `/api/documents/:id` | Delete document, report, parameters and file |
| `GET` | `/api/health` | API + database status |

---

## 6. Sample PDFs

All patient data is fictional. Generated by [`samples/generate-samples.js`](samples/generate-samples.js).

| File | Tests |
|---|---|
| `01-basic-8-params.pdf` | Simple layout, 8 parameters |
| `02-lipid-10-params-flags.pdf` | Printed H/L flags, `< 200` / `> 40` ranges, date `19-Nov-2026` |
| `03-cbc-12-params-other-headers.pdf` | Other lab: `Investigation / Observed Value / Units / Biological Ref. Interval`, `Lab No.`, `1,85,000` |
| `04-different-column-order-with-method.pdf` | Columns in another order + extra `Method` column, `Accession No` |
| `05-special-values.pdf` | `<5`, `>1000`, `Positive`, `Nil`, `Non Reactive`, `Trace`, `2-4` |
| `06-missing-fields.pdf` | Missing values, units and ranges |
| `07-no-report-id.pdf` | No Report/Sample ID → auto-generated |
| `08-multipage-sections-27-params.pdf` | 2 pages, 8 sections, wrapped test names, repeated header |
| `09-scanned-clean.pdf` | Image-only scan → OCR |
| `10-scanned-tilted-noisy.pdf` | Tilted, dusty, blurred scan → fails safely, retry demo |
| `11-not-a-pdf.pdf` | Text file renamed to `.pdf` → 400 |
| `12-corrupted.pdf` | Truncated PDF → 422 |

---

## 7. Assumptions

1. **No real lab reports were provided**, so realistic samples were generated (including scanned versions). The parser is not tied to them: it uses header synonyms and a fallback pattern rather than fixed positions.
2. Reports are in **English**; dates are **day-first** (Indian format).
3. **One PDF = one report.** If a different file has the same Report ID from the same lab, it is rejected (409) rather than versioned.
4. Lab name is taken from the top lines of the report; if not found it is `UNKNOWN`.
5. Processing is **synchronous**: the user waits a few seconds (up to ~30 s for scans). This is fine at assignment scale.
6. Max upload size **10 MB**, one file per upload.
7. Original PDFs are stored on the server's **local disk** (`backend/storage/`, git-ignored). In production this would be object storage (S3).
8. **No login**: not required by the assignment.
9. At most **3 extraction attempts** per document.

## 8. Future improvements

- Background processing with a queue (BullMQ + Redis) and automatic retries with backoff, instead of a synchronous request.
- Stronger OCR: deskew / auto-rotation, table-line removal, or an optional cloud OCR provider (AWS Textract, Azure Document Intelligence) behind the existing `OcrProvider` interface.
- Per-lab layout profiles for known formats; a gap-detection strategy for tables without a header.
- A `test_catalog` master table (LOINC codes, standard units) for full normalisation and trend charts per patient.
- Editing / approving values for `needs_review` reports; report versioning for corrected reports.
- Authentication and rate limiting.

---

## 9. AI tools used

- **Claude Code (Claude Opus 5.5, by Anthropic)** was used throughout:
  - understanding the assignment and planning (HLD/LLD, database design, edge cases)
  - generating boilerplate and the first version of most modules
  - building the parsing logic and the sample PDF generator
  - debugging (e.g. choosing TypeORM over a pre-release Prisma, tuning the parser against the samples, the PostgreSQL port issue)
  - drafting this README

I reviewed the code, ran every sample through the API, and can explain each design decision.

---

## Project structure

```
backend/
  src/
    database/      entities, enums, SQL migration, TypeORM setup
    extraction/    pdf/ (pdf.js), ocr/ (Tesseract), parsing/ (lines, table, values, metadata)
    documents/     controller, service (upload / retry / list), file storage, PDF validation pipe
    common/        exception filter, request logger
frontend/
  app/             / (upload + list), /documents/[id] (report view)
  components/      UploadCard, DocumentsTable, DocumentView, ParametersTable, StatusBadge
  lib/api.ts       typed API client
samples/           sample PDFs + generator
docs/              HLD.md, LLD.md
```
