import type { DocumentStatus } from '@/lib/api';

const STYLES: Record<DocumentStatus, { label: string; className: string }> = {
  completed: { label: 'Completed', className: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  needs_review: { label: 'Needs review', className: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-700 ring-red-600/20' },
  processing: { label: 'Processing', className: 'bg-sky-50 text-sky-700 ring-sky-600/20' },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const { label, className } = STYLES[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}>
      {label}
    </span>
  );
}

export function MethodBadge({ method }: { method: string }) {
  return (
    <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600">
      {method === 'ocr' ? 'OCR' : method === 'mixed' ? 'Text + OCR' : 'Text'}
    </span>
  );
}
