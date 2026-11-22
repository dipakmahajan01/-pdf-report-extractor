export enum DocumentStatus {
  Processing = 'processing',
  Completed = 'completed',
  NeedsReview = 'needs_review',
  Failed = 'failed',
}

export enum AttemptStatus {
  Running = 'running',
  Success = 'success',
  Failed = 'failed',
}

/** Pipeline stage where an extraction attempt failed. */
export enum ExtractionStage {
  Load = 'load',
  TextExtract = 'text_extract',
  Ocr = 'ocr',
  Parse = 'parse',
  Save = 'save',
}

export enum ExtractionMethod {
  Text = 'text',
  Ocr = 'ocr',
  Mixed = 'mixed',
}
