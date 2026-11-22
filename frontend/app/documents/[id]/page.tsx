import { Suspense } from 'react';
import { DocumentView } from '@/components/DocumentView';

// useParams suspends for dynamic ids under cacheComponents, so the view needs a Suspense boundary.
export default function DocumentPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <DocumentView />
    </Suspense>
  );
}
