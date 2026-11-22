'use client';

import { useCallback, useEffect, useState } from 'react';
import { DocumentsTable } from '@/components/DocumentsTable';
import { UploadCard } from '@/components/UploadCard';
import { api, ApiError, type DocumentSummary } from '@/lib/api';

export default function HomePage() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api.list(1, 100);
      setDocuments(page.items);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load reports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="grid gap-6">
      <UploadCard onUploaded={load} />
      <DocumentsTable documents={documents} loading={loading} error={error} onChanged={load} />
    </div>
  );
}
