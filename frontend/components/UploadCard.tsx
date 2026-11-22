'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

const MAX_MB = 10;

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number; fileName: string }
  | { kind: 'processing'; fileName: string }
  | { kind: 'error'; message: string; documentId?: string; linkLabel?: string };

export function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const busy = state.kind === 'uploading' || state.kind === 'processing';

  async function handle(file: File | undefined) {
    if (!file || busy) return;
    // Quick checks in the browser; the server validates again.
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setState({ kind: 'error', message: `"${file.name}" is not a PDF file.` });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setState({ kind: 'error', message: `The file is larger than ${MAX_MB} MB.` });
      return;
    }

    setState({ kind: 'uploading', percent: 0, fileName: file.name });
    try {
      const doc = await api.upload(file, (percent) =>
        setState(percent < 100 ? { kind: 'uploading', percent, fileName: file.name } : { kind: 'processing', fileName: file.name }),
      );
      onUploaded();
      router.push(`/documents/${doc.id}`);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Upload failed');
      const documentId = typeof err.body.documentId === 'string' ? err.body.documentId : undefined;
      setState({
        kind: 'error',
        message: err.message,
        documentId,
        linkLabel: err.code === 'DUPLICATE_FILE' ? 'Open the existing document' : 'Open document (retry possible)',
      });
      onUploaded();
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Upload a lab report</h2>
      <p className="mt-1 text-sm text-slate-500">Digital or scanned PDF, up to {MAX_MB} MB. Scanned PDFs are read with OCR.</p>

      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handle(e.dataTransfer.files[0]);
        }}
        className={`mt-4 flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-10 text-center transition ${
          dragging ? 'border-sky-500 bg-sky-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'
        } disabled:cursor-wait disabled:opacity-80`}
      >
        {state.kind === 'uploading' && (
          <>
            <span className="text-sm font-medium text-slate-700">Uploading {state.fileName}… {state.percent}%</span>
            <span className="mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-slate-200">
              <span className="block h-full bg-sky-600 transition-all" style={{ width: `${state.percent}%` }} />
            </span>
          </>
        )}
        {state.kind === 'processing' && (
          <>
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-sky-600 border-t-transparent" />
            <span className="mt-3 text-sm font-medium text-slate-700">Reading {state.fileName}…</span>
            <span className="mt-1 text-xs text-slate-500">Scanned PDFs can take up to 30 seconds.</span>
          </>
        )}
        {(state.kind === 'idle' || state.kind === 'error') && (
          <>
            <span className="text-sm font-medium text-slate-700">Drop a PDF here or click to choose</span>
            <span className="mt-1 text-xs text-slate-500">.pdf only</span>
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0])}
      />

      {state.kind === 'error' && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {state.message}
          {state.documentId && (
            <>
              {' '}
              <Link href={`/documents/${state.documentId}`} className="font-medium underline">
                {state.linkLabel}
              </Link>
            </>
          )}
        </div>
      )}
    </section>
  );
}
