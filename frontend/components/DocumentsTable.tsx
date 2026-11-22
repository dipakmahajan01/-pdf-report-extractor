'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError, formatDate, type DocumentSummary } from '@/lib/api';
import { MethodBadge, StatusBadge } from './StatusBadge';

export function DocumentsTable({
  documents,
  loading,
  error,
  onChanged,
}: {
  documents: DocumentSummary[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
      onChanged();
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="text-base font-semibold text-slate-900">Uploaded reports</h2>
        <span className="text-sm text-slate-500">{documents.length} total</span>
      </div>

      {actionError && <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-sm text-red-700">{actionError}</p>}
      {error && <p className="px-5 py-6 text-sm text-red-700">{error}</p>}
      {!error && loading && documents.length === 0 && <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>}
      {!error && !loading && documents.length === 0 && (
        <p className="px-5 py-6 text-sm text-slate-500">No reports yet. Upload a PDF to get started.</p>
      )}

      {documents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Report ID</th>
                <th className="px-3 py-2.5 font-medium">Patient</th>
                <th className="px-3 py-2.5 font-medium">Lab</th>
                <th className="px-3 py-2.5 font-medium">Report date</th>
                <th className="px-3 py-2.5 text-right font-medium">Tests</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Uploaded</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documents.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <Link href={`/documents/${d.id}`} className="font-medium text-sky-700 hover:underline">
                      {d.report?.reportId ?? d.fileName}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                      {d.report && <MethodBadge method={d.report.extractionMethod} />}
                      <span className="max-w-[220px] truncate">{d.report ? d.fileName : ''}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-700">{d.report?.patientName ?? '—'}</td>
                  <td className="max-w-[180px] truncate px-3 py-3 text-slate-700">{d.report?.labName ?? '—'}</td>
                  <td className="px-3 py-3 text-slate-700">{formatDate(d.report?.reportDate ?? null)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-slate-700">{d.report?.parameterCount ?? '—'}</td>
                  <td className="px-3 py-3">
                    <StatusBadge status={d.status} />
                    {d.status === 'failed' && d.lastErrorMessage && (
                      <p className="mt-1 max-w-[260px] text-xs text-red-700">{d.lastErrorMessage}</p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-500">{formatDate(d.createdAt)}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right">
                    {d.canRetry && (
                      <button
                        type="button"
                        disabled={busyId === d.id}
                        onClick={() => act(d.id, () => api.retry(d.id))}
                        className="mr-2 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                      >
                        {busyId === d.id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === d.id}
                      onClick={() => act(d.id, () => api.remove(d.id))}
                      className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
