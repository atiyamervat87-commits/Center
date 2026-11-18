import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { t } from '../../i18n/translations';
import type { AuditLogEntry, Locale } from '../../types/commandCenter';
import { fetchAuditLogs } from '../../services/apiClient';
import { formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';

interface AuditLogViewProps {
  locale: Locale;
}

const OUTCOME_FILTERS = ['ALL', 'PASS', 'PARTIAL', 'INFO', 'WARNING', 'FAIL', 'ERROR'] as const;

export function AuditLogView({ locale }: AuditLogViewProps) {
  const copy = t(locale);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchAuditLogs({ limit: 100, outcome, search })
      .then((res) => {
        if (!active) return;
        setLogs(res.logs);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load audit log');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [outcome, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <h1 className="text-xl sm:text-2xl font-bold text-[#26170F]">{copy.auditTitle}</h1>

        <div className="relative w-full md:w-80">
          <Search
            className="h-4 w-4 text-[#523624] absolute top-1/2 -translate-y-1/2 start-3"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={copy.auditSearchPlaceholder}
            className="w-full min-h-[44px] ps-9 pe-3 py-2 rounded-lg bg-white/80 border border-[#523624]/25 text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
          />
        </div>
      </div>

      {/* Interactive Filter Segmented Controls */}
      <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#3B2419]/10 rounded-lg w-fit">
        {OUTCOME_FILTERS.map((item) => {
          const active = outcome === item;
          return (
            <button
              key={item}
              type="button"
              onClick={() => setOutcome(item)}
              className={`min-h-[36px] px-3 py-1.5 rounded-md font-mono text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                active
                  ? 'bg-[#26170F] text-[#F3D989]'
                  : 'text-[#523624] hover:text-[#26170F]'
              }`}
            >
              {item === 'ALL' ? copy.auditFilterAll : item}
            </button>
          );
        })}
      </div>

      {/* Audit Table */}
      <div className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-9 bg-[#523624]/10 rounded animate-pulse" />
            <div className="h-9 bg-[#523624]/10 rounded animate-pulse" />
            <div className="h-9 bg-[#523624]/10 rounded animate-pulse" />
          </div>
        ) : error ? (
          <div className="p-6 text-xs text-red-800 font-mono">{error}</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-sm text-[#523624] text-center">{copy.emptyAudit}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                <tr>
                  <th className="py-3 px-4 text-start font-semibold">{copy.colTime}</th>
                  <th className="py-3 px-4 text-start font-semibold">{copy.colActor}</th>
                  <th className="py-3 px-4 text-start font-semibold">{copy.colCategory}</th>
                  <th className="py-3 px-4 text-start font-semibold">{copy.colAction}</th>
                  <th className="py-3 px-4 text-start font-semibold">{copy.colTarget}</th>
                  <th className="py-3 px-4 text-end font-semibold">{copy.colOutcome}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#523624]/10">
                {logs.map((row) => (
                  <tr key={row.id} className="hover:bg-[#D4AF37]/5">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-[#523624] whitespace-nowrap">
                      {formatTimestamp(row.created_at, locale)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[#523624] whitespace-nowrap">
                      {row.actor}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[#26170F] whitespace-nowrap">
                      {row.category}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-[#26170F] whitespace-nowrap">
                      {row.action}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[#523624] max-w-[260px] truncate">
                      {row.target || '—'}
                    </td>
                    <td className="py-2.5 px-4 text-end">
                      <StatusIndicator state={row.outcome} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
