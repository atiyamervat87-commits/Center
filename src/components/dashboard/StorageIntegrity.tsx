import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  fetchResourceLibraryIntegrityStatus,
  triggerResourceLibraryIntegrityCheck,
} from '../../services/apiClient';
import type {
  Locale,
  ResourceLibraryIntegrityStatus,
} from '../../types/commandCenter';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';

interface StorageIntegrityProps {
  locale: Locale;
  syncSequence?: number;
  totalResourcesHint?: number;
  onOpenDataFactory?: () => void;
  onIntegrityCompleted?: () => void;
}

export function StorageIntegrity({
  locale,
  syncSequence,
  totalResourcesHint,
  onOpenDataFactory,
  onIntegrityCompleted,
}: StorageIntegrityProps) {
  const isAr = locale === 'ar';
  const [status, setStatus] = useState<ResourceLibraryIntegrityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasRunningRef = useRef(false);
  const onCompletedRef = useRef(onIntegrityCompleted);
  onCompletedRef.current = onIntegrityCompleted;

  const loadStatus = useCallback(async (silent = false) => {
    if (!silent) {
      setError(null);
    }
    try {
      const next = await fetchResourceLibraryIntegrityStatus();
      setStatus(next);
      setError(null);
      if (wasRunningRef.current && !next.running) {
        wasRunningRef.current = false;
        onCompletedRef.current?.();
      } else if (next.running) {
        wasRunningRef.current = true;
      }
    } catch (err) {
      if (!silent) {
        setError(
          err instanceof Error
            ? err.message
            : isAr
              ? 'تعذر قراءة حالة سلامة تخزين مكتبة الموارد.'
              : 'Failed to load resource library storage integrity status.',
        );
      }
    } finally {
      setLoading(false);
    }
  }, [isAr]);

  useEffect(() => {
    void loadStatus(true);
  }, [loadStatus, syncSequence, totalResourcesHint]);

  useEffect(() => {
    if (!status?.running) {
      return;
    }
    wasRunningRef.current = true;
    const timer = window.setInterval(() => {
      void loadStatus(true);
    }, 300);
    return () => window.clearInterval(timer);
  }, [status?.running, loadStatus]);

  const handleCheckIntegrity = async () => {
    if (triggering || status?.running) return;
    setTriggering(true);
    setError(null);
    try {
      const res = await triggerResourceLibraryIntegrityCheck();
      wasRunningRef.current = res.status.running;
      setStatus(res.status);
      if (!res.status.running) {
        onCompletedRef.current?.();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر بدء فحص البصمات SHA-256 في الخلفية.'
            : 'Failed to trigger background SHA-256 integrity verification.',
      );
    } finally {
      setTriggering(false);
    }
  };

  const isChecking = triggering || Boolean(status?.running);
  const indicatorState = isChecking
    ? 'CHECKING'
    : (status?.overallStatus ?? 'HEALTHY');

  return (
    <section
      aria-label={isAr ? 'سلامة التخزين' : 'Storage Integrity'}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-bold text-[#26170F] inline-flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-[#B8860B] shrink-0" aria-hidden="true" />
              <span>
                {isAr ? 'سلامة التخزين (Storage Integrity)' : 'Storage Integrity'}
              </span>
            </h2>
            {!loading && status && (
              <StatusIndicator state={indicatorState} />
            )}
          </div>

          {status && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[#523624] tabular-nums">
              <span>
                {isAr ? 'الموارد' : 'Resources'}: {status.totalResources}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {isAr ? 'موثقة SHA-256' : 'Verified'}: {status.verifiedCount}
              </span>
              <span aria-hidden="true">·</span>
              <span className={status.corruptedCount > 0 ? 'text-red-800 font-semibold' : ''}>
                {isAr ? 'تالفة/غير متطابقة' : 'Corrupted'}: {status.corruptedCount}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {isAr ? 'الحجم الإجمالي' : 'Total Size'}: {formatBytes(status.totalBytes, locale)}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {isAr ? 'آخر فحص' : 'Last Check'}:{' '}
                {status.lastCheckedAt
                  ? formatTimestamp(status.lastCheckedAt, locale)
                  : isAr
                    ? 'لم يُفحص بعد'
                    : 'Not run yet'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {onOpenDataFactory && (
            <button
              type="button"
              onClick={onOpenDataFactory}
              className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-[#3B2419] hover:text-[#26170F] inline-flex items-center gap-1.5 underline underline-offset-4 decoration-[#B8860B] cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>{isAr ? 'فتح مصنع البيانات' : 'Data Factory'}</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleCheckIntegrity()}
            disabled={isChecking || loading}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] hover:bg-[#3B2419] disabled:opacity-60 text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>
              {isChecking
                ? isAr
                  ? `جارٍ فحص SHA-256 (${status?.checkedCount ?? 0}/${status?.checkTotalCount ?? 0})`
                  : `Checking SHA-256 (${status?.checkedCount ?? 0}/${status?.checkTotalCount ?? 0})`
                : isAr
                  ? 'فحص السلامة (Check Integrity)'
                  : 'Check Integrity'}
            </span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-300 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-red-900">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadStatus(false)}
            className="min-h-[34px] px-3 py-1 rounded-lg border border-red-400 bg-white hover:bg-red-100 text-red-900 font-semibold whitespace-nowrap cursor-pointer"
          >
            {isAr ? 'إعادة المحاولة' : 'Retry'}
          </button>
        </div>
      )}

      <div className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3" aria-busy="true">
            <div className="h-4 w-48 rounded bg-[#3B2419]/10 animate-pulse" />
            <div className="h-10 w-full rounded bg-[#3B2419]/10 animate-pulse" />
            <div className="h-10 w-full rounded bg-[#3B2419]/10 animate-pulse" />
          </div>
        ) : !status || status.totalResources === 0 ? (
          <div className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[#26170F]">
                {isAr
                  ? 'لا توجد موارد مسجلة في مكتبة الموارد حتى الآن.'
                  : 'No registered resources found in the Resource Library yet.'}
              </div>
              <p className="text-xs text-[#523624]">
                {isAr
                  ? 'الحالة الحالية HEALTHY (0 ملفات تالفة). يمكنك تسجيل مجموعات البيانات أو النماذج عبر جناح DATA FACTORY ثم تشغيل فحص SHA-256.'
                  : 'Current integrity state is HEALTHY (0 corrupted entries). Register datasets, models, software, or knowledge files in DATA FACTORY to verify SHA-256 digests.'}
              </p>
            </div>
            {onOpenDataFactory && (
              <button
                type="button"
                onClick={onOpenDataFactory}
                className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-[#523624]/30 bg-white hover:bg-[#3B2419]/5 text-xs font-semibold text-[#26170F] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>{isAr ? 'إضافة مورد في DATA FACTORY' : 'Open DATA FACTORY'}</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                <tr>
                  <th className="py-2.5 px-4 text-start font-semibold">ID</th>
                  <th className="py-2.5 px-4 text-start font-semibold">
                    {isAr ? 'المورد' : 'Resource'}
                  </th>
                  <th className="py-2.5 px-4 text-start font-semibold">
                    {isAr ? 'القسم' : 'Section'}
                  </th>
                  <th className="py-2.5 px-4 text-end font-semibold">
                    {isAr ? 'الحجم' : 'Size'}
                  </th>
                  <th className="py-2.5 px-4 text-start font-semibold">SHA-256</th>
                  <th className="py-2.5 px-4 text-end font-semibold">
                    {isAr ? 'التحقق' : 'Verification'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#523624]/10">
                {status.resources.map((item) => (
                  <tr key={item.id} className="hover:bg-[#D4AF37]/5">
                    <td className="py-2.5 px-4 font-mono font-semibold text-[#26170F] whitespace-nowrap">
                      {item.id}
                    </td>
                    <td className="py-2.5 px-4 text-[#26170F] max-w-[220px] truncate font-medium">
                      {item.name}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[#523624] whitespace-nowrap">
                      {item.librarySection}
                    </td>
                    <td className="py-2.5 px-4 text-end font-mono tabular-nums text-[#523624] whitespace-nowrap">
                      {formatBytes(item.sizeBytes, locale)}
                    </td>
                    <td
                      className="py-2.5 px-4 font-mono tabular-nums text-[#523624] whitespace-nowrap"
                      title={item.sha256}
                    >
                      {item.sha256.slice(0, 14)}…
                    </td>
                    <td className="py-2.5 px-4 text-end">
                      <StatusIndicator state={item.verificationStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
