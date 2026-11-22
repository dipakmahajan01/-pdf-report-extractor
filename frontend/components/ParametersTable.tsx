import type { Parameter } from '@/lib/api';

/** Shows the tests in the same order and grouping as the PDF. */
export function ParametersTable({ parameters }: { parameters: Parameter[] }) {
  const hasMethod = parameters.some((p) => p.extra?.method);
  const columns = hasMethod ? 5 : 4;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-medium">Test</th>
            <th className="px-3 py-2.5 font-medium">Result</th>
            <th className="px-3 py-2.5 font-medium">Unit</th>
            <th className="px-3 py-2.5 font-medium">Reference range</th>
            {hasMethod && <th className="px-3 py-2.5 font-medium">Method</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {parameters.map((p) =>
            p.isSection ? (
              <tr key={p.rowOrder} className="bg-slate-50/70">
                <td colSpan={columns} className="px-4 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {p.name}
                </td>
              </tr>
            ) : (
              <tr key={p.rowOrder}>
                <td className="px-4 py-2 text-slate-800">
                  {p.name}
                  {p.nameNormalized !== p.name && !p.name.startsWith(p.nameNormalized) && (
                    <span className="ml-1.5 text-xs text-slate-400">({p.nameNormalized})</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Value p={p} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{p.unit ?? <Empty />}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{p.refRangeRaw ?? <Empty />}</td>
                {hasMethod && <td className="px-3 py-2 text-slate-600">{p.extra?.method ?? <Empty />}</td>}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function Value({ p }: { p: Parameter }) {
  if (!p.valueRaw) return <Empty />;
  const lowConfidence = p.ocrConfidence !== null && p.ocrConfidence < 80;
  const color = p.flag === 'H' ? 'text-red-700' : p.flag === 'L' ? 'text-blue-700' : 'text-slate-900';
  return (
    <span
      className={`font-medium tabular-nums ${color} ${lowConfidence ? 'underline decoration-amber-500 decoration-dotted underline-offset-4' : ''}`}
      title={lowConfidence ? `Low OCR confidence (${Math.round(p.ocrConfidence!)}%) — please verify` : undefined}
    >
      {p.valueRaw}
      {p.flag && (
        <span className="ml-1 text-xs font-semibold">
          {p.flag === 'H' ? '▲ H' : '▼ L'}
        </span>
      )}
    </span>
  );
}

function Empty() {
  return <span className="text-slate-300">—</span>;
}
