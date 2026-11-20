import { useState } from 'react';
import { Globe, HardDrive, Cpu, Server, ArrowUpRight, Smartphone, Terminal, RefreshCw, Activity } from 'lucide-react';
import { t } from '../../i18n/translations';
import type { Locale, MasterDashboardSnapshot, WingId } from '../../types/commandCenter';
import type { RealtimeSyncClientStatus } from '../../services/realtimeSyncClient';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';
import { StorageIntegrity } from './StorageIntegrity';
import type { NavTabId } from '../layout/CommandShell';

interface MasterDashboardProps {
  locale: Locale;
  onToggleLocale: () => void;
  snapshot: MasterDashboardSnapshot;
  syncStatus?: RealtimeSyncClientStatus;
  isSyncing?: boolean;
  onSyncNow?: () => void;
  onNavigate: (tab: NavTabId) => void;
  onOpenWing: (wing: WingId) => void;
}

const CREST_SRC = '/src/assets/images/ng_ilmf_crest_1794980198705.jpg';

export function MasterDashboard({
  locale,
  onToggleLocale,
  snapshot,
  syncStatus,
  isSyncing = false,
  onSyncNow,
  onNavigate,
  onOpenWing,
}: MasterDashboardProps) {
  const copy = t(locale);
  const [crestFailed, setCrestFailed] = useState(false);
  const isAr = locale === 'ar';

  const { environment, counts, bridgeProbe, wingsSummary, performanceMetrics, trainingMetrics } =
    snapshot;
  const {
    hostEnvironment,
    androidDeviceEnvironment,
    termuxEnvironment,
    externalSdStorage,
  } = environment;

  return (
    <div className="space-y-8">
      {/* 1. Royal Command Banner — Hero Anchor */}
      <section className="rounded-xl bg-[#3B2419] text-[#FFF8E8] border border-[#D4AF37]/40 p-5 sm:p-7">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="flex items-start sm:items-center gap-4">
            {!crestFailed ? (
              <img
                src={CREST_SRC}
                alt="NG-ILMF Emblem"
                referrerPolicy="no-referrer"
                onError={() => setCrestFailed(true)}
                className="h-14 w-14 sm:h-16 sm:w-16 rounded-lg object-cover border border-[#D4AF37]/60 shrink-0"
              />
            ) : (
              <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-lg bg-[#26170F] border border-[#D4AF37]/60 flex items-center justify-center text-[#D4AF37] font-mono text-lg font-bold shrink-0">
                NG
              </div>
            )}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#F3D989]/90 font-mono">
                <span>
                  {copy.activeHostPrefix}: {hostEnvironment.label}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {copy.targetDevicePrefix}: {androidDeviceEnvironment.targetDeviceModel} ({androidDeviceEnvironment.targetAndroidVersion})
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {copy.lastProbeLabel}: {formatTimestamp(snapshot.generatedAt, locale)}
                </span>
              </div>
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-[#FFF8E8] tracking-tight">
                {copy.brandFull}
              </h1>
              <p className="text-sm text-[#FFF8E8]/80">{copy.brandSubtitle}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t lg:border-t-0 border-[#D4AF37]/20 pt-4 lg:pt-0">
            <div className="space-y-1">
              <div className="text-xs text-[#F3D989]/80">{copy.factoryStatusTitle}</div>
              <StatusIndicator state={snapshot.factoryStatus} inverted />
            </div>

            <button
              type="button"
              onClick={onToggleLocale}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#D4AF37]/40 bg-[#26170F] hover:bg-[#523624] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
              <span>{copy.languageLabel}</span>
            </button>
          </div>
        </div>

        {/* Subsystem Live State Strip */}
        <div className="mt-6 pt-5 border-t border-[#D4AF37]/20 grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#FFF8E8]/80">
              {copy.archiveStatusTitle} ({environment.selectedArchiveProvider})
            </span>
            <div className="flex items-center gap-2">
              <StatusIndicator state={snapshot.archiveStatus} inverted />
              <span className="font-mono text-[11px] text-[#F3D989]/90">
                · {snapshot.storageReady ? copy.storageReadyLabel : copy.storageNotReadyLabel}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#FFF8E8]/80">{copy.bridgeStatusTitle}</span>
            <StatusIndicator state={snapshot.bridgeStatus} inverted />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#FFF8E8]/80">{copy.trainingEnvTitle}</span>
            <StatusIndicator state={snapshot.externalTrainingEnvStatus} inverted />
          </div>
        </div>
      </section>

      {/* 2. 4-Column Real SQLite KPI Strip */}
      <section aria-label="Core Factory Metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-4 sm:p-5 space-y-2">
          <div className="text-xs font-medium text-[#523624]">{copy.kpiLibraryModels}</div>
          <div className="font-mono text-2xl sm:text-3xl font-bold text-[#26170F] tabular-nums">
            {counts.libraryModels}
          </div>
          <div className="text-xs text-[#523624]/80 font-mono">{copy.kpiUnitModels}</div>
        </div>

        <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-4 sm:p-5 space-y-2">
          <div className="text-xs font-medium text-[#523624]">{copy.kpiImportedModels}</div>
          <div className="font-mono text-2xl sm:text-3xl font-bold text-[#26170F] tabular-nums">
            {counts.importedModels}
          </div>
          <div className="text-xs text-[#523624]/80 font-mono">{copy.kpiUnitModels}</div>
        </div>

        <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-4 sm:p-5 space-y-2">
          <div className="text-xs font-medium text-[#523624]">{copy.kpiApprovedBrains}</div>
          <div className="font-mono text-2xl sm:text-3xl font-bold text-[#8A6204] tabular-nums">
            {counts.approvedBrains}
          </div>
          <div className="text-xs text-[#523624]/80 font-mono">{copy.kpiUnitBrains}</div>
        </div>

        <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-4 sm:p-5 space-y-2">
          <div className="text-xs font-medium text-[#523624]">{copy.kpiTransferOps}</div>
          <div className="font-mono text-2xl sm:text-3xl font-bold text-[#26170F] tabular-nums">
            {counts.transferOperations}
          </div>
          <div className="text-xs text-[#523624]/80 font-mono">{copy.kpiUnitOps}</div>
        </div>
      </section>

      {/* 2.2. Resource Library Storage Integrity */}
      <StorageIntegrity
        locale={locale}
        syncSequence={snapshot.syncMetadata?.sequence}
        totalResourcesHint={counts.totalResources}
        onOpenDataFactory={() => onOpenWing('DATA_FACTORY')}
        onIntegrityCompleted={onSyncNow}
      />

      {/* 2.5. Five Production Wings Executive Matrix */}
      {wingsSummary && (
        <section aria-label={copy.wingsSectionTitle} className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold text-[#26170F]">{copy.wingsSectionTitle}</h2>
            <button
              type="button"
              onClick={() => onOpenWing('DATA_FACTORY')}
              className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-[#3B2419] hover:text-[#26170F] inline-flex items-center gap-1.5 underline underline-offset-4 decoration-[#B8860B] cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>{copy.navWings}</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(
              [
                {
                  id: 'DATA_FACTORY' as WingId,
                  title: copy.wingDataFactory,
                  status: wingsSummary.dataFactory.status,
                  metricText: isAr
                    ? `الموارد: ${wingsSummary.dataFactory.totalResources} · موثقة: ${wingsSummary.dataFactory.verifiedResources} · الأرشيف: ${wingsSummary.dataFactory.archiveEntries}`
                    : `Resources: ${wingsSummary.dataFactory.totalResources} · Verified: ${wingsSummary.dataFactory.verifiedResources} · Archive: ${wingsSummary.dataFactory.archiveEntries}`,
                },
                {
                  id: 'NEW_MIND_FACTORY' as WingId,
                  title: copy.wingNewMindFactory,
                  status: wingsSummary.newMindFactory.status,
                  metricText: isAr
                    ? `العمال: ${wingsSummary.newMindFactory.registeredWorkers} (${wingsSummary.newMindFactory.onlineWorkers} نشط) · المهام: ${wingsSummary.newMindFactory.activeJobs}`
                    : `Workers: ${wingsSummary.newMindFactory.registeredWorkers} (${wingsSummary.newMindFactory.onlineWorkers} online) · Jobs: ${wingsSummary.newMindFactory.activeJobs}`,
                },
                {
                  id: 'MIND_REPAIR_FACTORY' as WingId,
                  title: copy.wingMindRepair,
                  status: wingsSummary.mindRepairFactory.status,
                  metricText: isAr
                    ? `المنتجات: ${wingsSummary.mindRepairFactory.totalProducts} · إصلاح/تقييم: ${wingsSummary.mindRepairFactory.evaluationProducts} · معتمد: ${wingsSummary.mindRepairFactory.approvedProducts}`
                    : `Products: ${wingsSummary.mindRepairFactory.totalProducts} · Eval: ${wingsSummary.mindRepairFactory.evaluationProducts} · Approved: ${wingsSummary.mindRepairFactory.approvedProducts}`,
                },
                {
                  id: 'TRUST_SECURITY_CENTER' as WingId,
                  title: copy.wingTrustSecurity,
                  status: wingsSummary.trustSecurityCenter.status,
                  metricText: isAr
                    ? `فحوصات QC: ${wingsSummary.trustSecurityCenter.qcPassedTotal}/${wingsSummary.trustSecurityCenter.qcReportsTotal} · الجلسات: ${wingsSummary.trustSecurityCenter.activeSessions}`
                    : `QC Passed: ${wingsSummary.trustSecurityCenter.qcPassedTotal}/${wingsSummary.trustSecurityCenter.qcReportsTotal} · Sessions: ${wingsSummary.trustSecurityCenter.activeSessions}`,
                },
                {
                  id: 'NG_IP_SERVICES' as WingId,
                  title: copy.wingNgIpServices,
                  status: wingsSummary.ngIpServices.status,
                  metricText: isAr
                    ? `مُصدرة: ${wingsSummary.ngIpServices.releasedProducts} · حزم التسليم: ${wingsSummary.ngIpServices.deliveryPackages} (${wingsSummary.ngIpServices.verifiedPackages} موثقة)`
                    : `Released: ${wingsSummary.ngIpServices.releasedProducts} · Delivery ZIPs: ${wingsSummary.ngIpServices.deliveryPackages} (${wingsSummary.ngIpServices.verifiedPackages} verified)`,
                },
              ] as const
            ).map((wing) => (
              <div
                key={wing.id}
                className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-bold text-[#26170F]">{wing.title}</div>
                    <StatusIndicator state={wing.status} />
                  </div>
                  <div className="font-mono text-xs text-[#523624] tabular-nums">
                    {wing.metricText}
                  </div>
                </div>
                <div className="pt-2 border-t border-[#523624]/15 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onOpenWing(wing.id)}
                    className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-[#26170F] hover:bg-[#3B2419] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <span>{copy.wingOpenBtn}</span>
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 2.8. Real-Time Training & Host Performance Synchronization */}
      {(performanceMetrics || trainingMetrics) && (
        <section aria-label={copy.liveSyncSectionTitle} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-[#26170F]">{copy.liveSyncSectionTitle}</h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[#523624] tabular-nums">
                <span>
                  {syncStatus?.transport ?? 'SSE'}: {syncStatus?.connectionState ?? 'CONNECTED'}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {copy.liveSyncSeqLabel} #{syncStatus?.sequence ?? snapshot.syncMetadata?.sequence ?? 0}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {formatTimestamp(
                    syncStatus?.lastSyncedAt ?? performanceMetrics?.collectedAt ?? snapshot.generatedAt,
                    locale,
                  )}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {onSyncNow && (
                <button
                  type="button"
                  onClick={onSyncNow}
                  disabled={isSyncing}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-[#26170F] hover:bg-[#3B2419] disabled:opacity-60 text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>{isSyncing ? copy.liveSyncSyncing : copy.liveSyncNowBtn}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenWing('NEW_MIND_FACTORY')}
                className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-[#3B2419] hover:text-[#26170F] inline-flex items-center gap-1.5 underline underline-offset-4 decoration-[#B8860B] cursor-pointer whitespace-nowrap shrink-0"
              >
                <span>{copy.liveSyncOpenMindWing}</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {performanceMetrics && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl bg-white/75 border border-[#523624]/20 p-4 space-y-1.5">
                <div className="text-xs font-medium text-[#523624]">{copy.liveSyncCpuLabel}</div>
                <div className="font-mono text-2xl font-bold text-[#26170F] tabular-nums">
                  {performanceMetrics.hostCpuPercent.toFixed(1)}%
                </div>
                <div className="font-mono text-[11px] text-[#523624]/80 tabular-nums">
                  {copy.liveSyncLoadLabel}: {performanceMetrics.loadAvg1m} / {performanceMetrics.loadAvg5m}
                </div>
              </div>

              <div className="rounded-xl bg-white/75 border border-[#523624]/20 p-4 space-y-1.5">
                <div className="text-xs font-medium text-[#523624]">{copy.liveSyncMemLabel}</div>
                <div className="font-mono text-2xl font-bold text-[#26170F] tabular-nums">
                  {performanceMetrics.memoryUsedPercent.toFixed(1)}%
                </div>
                <div className="font-mono text-[11px] text-[#523624]/80 tabular-nums">
                  {formatBytes(performanceMetrics.memoryUsedBytes, locale)} / {formatBytes(performanceMetrics.memoryTotalBytes, locale)}
                </div>
              </div>

              <div className="rounded-xl bg-white/75 border border-[#523624]/20 p-4 space-y-1.5">
                <div className="text-xs font-medium text-[#523624]">
                  {isAr ? 'ذاكرة عملية الخادم (RSS)' : 'Server Process RSS'}
                </div>
                <div className="font-mono text-2xl font-bold text-[#26170F] tabular-nums">
                  {formatBytes(performanceMetrics.processRssBytes, locale)}
                </div>
                <div className="font-mono text-[11px] text-[#523624]/80 tabular-nums">
                  Heap: {formatBytes(performanceMetrics.processHeapUsedBytes, locale)}
                </div>
              </div>

              <div className="rounded-xl bg-white/75 border border-[#523624]/20 p-4 space-y-1.5">
                <div className="text-xs font-medium text-[#523624]">{copy.liveSyncSqliteLabel}</div>
                <div className="font-mono text-2xl font-bold text-[#26170F] tabular-nums">
                  {formatBytes(performanceMetrics.sqliteDbBytes, locale)}
                </div>
                <div className="font-mono text-[11px] text-[#523624]/80 tabular-nums">
                  Uptime: {performanceMetrics.uptimeSeconds}s
                </div>
              </div>
            </div>
          )}

          {trainingMetrics && (
            <div className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-[#523624]/15 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                  <Activity className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                  <span>{copy.liveSyncTrainingTitle}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[#523624] tabular-nums">
                  <span>Workers: {trainingMetrics.onlineWorkers}/{trainingMetrics.totalWorkers}</span>
                  <span aria-hidden="true">·</span>
                  <span>RUNNING: {trainingMetrics.runningJobs}</span>
                  <span aria-hidden="true">·</span>
                  <span>QUEUED: {trainingMetrics.queuedJobs}</span>
                  <span aria-hidden="true">·</span>
                  <span>COMPLETED: {trainingMetrics.completedJobs}</span>
                </div>
              </div>

              {trainingMetrics.jobs.length === 0 ? (
                <div className="p-5 text-xs text-[#523624]">{copy.liveSyncNoJobs}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                      <tr>
                        <th className="py-2.5 px-4 text-start">Job ID</th>
                        <th className="py-2.5 px-4 text-start">{isAr ? 'النموذج / الفئة' : 'Model / Tier'}</th>
                        <th className="py-2.5 px-4 text-end">{isAr ? 'الخطوات' : 'Steps'}</th>
                        <th className="py-2.5 px-4 text-end">Training Loss</th>
                        <th className="py-2.5 px-4 text-end">{isAr ? 'الحالة' : 'Status'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#523624]/10 font-mono tabular-nums">
                      {trainingMetrics.jobs.map((job) => (
                        <tr key={job.id} className="hover:bg-[#D4AF37]/5">
                          <td className="py-2.5 px-4 font-semibold text-[#26170F] whitespace-nowrap">
                            {job.id}
                          </td>
                          <td className="py-2.5 px-4 whitespace-nowrap text-[#523624]">
                            {job.modelId} · {job.scaleTier} ({job.architecture})
                          </td>
                          <td className="py-2.5 px-4 text-end whitespace-nowrap">
                            {job.currentStep}/{job.totalSteps}
                            {job.progressPercent !== null ? ` (${job.progressPercent}%)` : ''}
                          </td>
                          <td className="py-2.5 px-4 text-end whitespace-nowrap">
                            {job.trainingLoss !== null ? job.trainingLoss.toFixed(4) : '—'}
                          </td>
                          <td className="py-2.5 px-4 text-end">
                            <StatusIndicator state={job.jobStatus} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 3. Strictly Separated Environments Matrix */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold text-[#26170F]">{copy.storageSectionTitle}</h2>
          <button
            type="button"
            onClick={() => onNavigate('storage')}
            className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-[#3B2419] hover:text-[#26170F] inline-flex items-center gap-1.5 underline underline-offset-4 decoration-[#B8860B] cursor-pointer whitespace-nowrap shrink-0"
          >
            <span>{copy.navStorage}</span>
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. Host Development Environment */}
          <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Cpu className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.hostEnvTitle}</span>
              </div>
              <StatusIndicator state={hostEnvironment.provider.state} />
            </div>
            <p className="text-xs text-[#523624]">{copy.hostEnvNotice}</p>
            <div className="font-mono text-xs text-[#26170F] break-all">
              {hostEnvironment.provider.configuredPath}
            </div>
            <div className="pt-2 border-t border-[#523624]/15 grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-[#523624]">{copy.freeSpaceLabel}: </span>
                <span className="font-mono font-semibold tabular-nums">
                  {formatBytes(hostEnvironment.provider.availableBytes, locale)}
                </span>
              </div>
              <div>
                <span className="text-[#523624]">{copy.ramLabel}: </span>
                <span className="font-mono font-semibold tabular-nums">
                  {formatBytes(hostEnvironment.host.freeMemoryBytes, locale)} / {formatBytes(hostEnvironment.host.totalMemoryBytes, locale)}
                </span>
              </div>
            </div>
          </div>

          {/* 2. Android Device Environment */}
          <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Smartphone className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.androidEnvTitle}</span>
              </div>
              <StatusIndicator state={androidDeviceEnvironment.provider.state} />
            </div>
            <div className="font-mono text-xs text-[#523624] break-all">
              {snapshot.androidDiagnostics.safUri || androidDeviceEnvironment.provider.configuredPath}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[#3B2419]">
              <span>HOST_ONLY={String(snapshot.androidDiagnostics.flags.HOST_ONLY)}</span>
              <span>·</span>
              <span>ANDROID_CONNECTED={String(snapshot.androidDiagnostics.flags.ANDROID_CONNECTED)}</span>
              <span>·</span>
              <span>SD_AUTHORIZED={String(snapshot.androidDiagnostics.flags.SD_AUTHORIZED)}</span>
              <span>·</span>
              <span>SD_READ_WRITE_VERIFIED={String(snapshot.androidDiagnostics.flags.SD_READ_WRITE_VERIFIED)}</span>
            </div>
            <div className="pt-2 border-t border-[#523624]/15 text-xs text-red-800 font-mono">
              {androidDeviceEnvironment.provider.failureReason || snapshot.androidDiagnostics.diagnosticNote}
            </div>
          </div>

          {/* 3. Termux Environment */}
          <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Terminal className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.termuxEnvTitle}</span>
              </div>
              <StatusIndicator state={termuxEnvironment.provider.state} />
            </div>
            <div className="font-mono text-xs text-[#523624] break-all">
              {termuxEnvironment.provider.configuredPath}
            </div>
            <div className="pt-2 border-t border-[#523624]/15 text-xs text-red-800 font-mono">
              {termuxEnvironment.provider.failureReason || 'Termux storage accessible'}
            </div>
          </div>

          {/* 4. External SD Card Storage */}
          <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <HardDrive className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.sdEnvTitle}</span>
              </div>
              <StatusIndicator state={externalSdStorage.provider.state} />
            </div>
            <div className="font-mono text-xs text-[#523624] break-all">
              {externalSdStorage.provider.configuredPath}
            </div>
            <div className="pt-2 border-t border-[#523624]/15 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-mono text-red-800">
                {externalSdStorage.provider.failureReason ||
                  `${copy.freeSpaceLabel}: ${formatBytes(externalSdStorage.provider.availableBytes, locale)}`}
              </span>
            </div>
          </div>

          {/* Computer Training Bridge & Database Counters */}
          <div className="lg:col-span-2 rounded-xl bg-white/70 border border-[#523624]/20 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Server className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.bridgeStatusTitle} · {copy.projectsWorkersTitle}</span>
              </div>
              <StatusIndicator state={bridgeProbe.status} />
            </div>
            <div className="text-xs text-[#523624] font-mono break-all">
              {bridgeProbe.configured ? bridgeProbe.endpointUrl : bridgeProbe.detail}
            </div>
            <div className="pt-2 border-t border-[#523624]/15 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-[#523624]">{copy.projectsCountLabel}: </span>
                <button
                  type="button"
                  onClick={() => onNavigate('projects')}
                  className="font-mono font-semibold tabular-nums underline decoration-[#B8860B] cursor-pointer"
                >
                  {counts.projects}
                </button>
              </div>
              <div>
                <span className="text-[#523624]">{copy.resourcesCountLabel}: </span>
                <span className="font-mono font-semibold tabular-nums">{counts.totalResources}</span>
              </div>
              <div>
                <span className="text-[#523624]">{copy.workersCountLabel}: </span>
                <span className="font-mono font-semibold tabular-nums">{counts.registeredWorkers}</span>
              </div>
              <div>
                <span className="text-[#523624]">{copy.errorsCountLabel}: </span>
                <span className="font-mono font-semibold tabular-nums">{counts.errorEvents}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Latest Operations & Errors Table */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold text-[#26170F]">{copy.recentOpsTitle}</h2>
          <div className="flex items-center gap-4 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('roadmap')}
              className="min-h-[40px] px-2 py-1.5 text-xs font-semibold text-[#523624] hover:text-[#26170F] inline-flex items-center gap-1 underline underline-offset-4 decoration-[#B8860B]/60 cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>{copy.navRoadmap}</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-[#3B2419] hover:text-[#26170F] inline-flex items-center gap-1.5 underline underline-offset-4 decoration-[#B8860B] cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>{copy.viewAllAudit}</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
          {snapshot.recentAuditLogs.length === 0 ? (
            <div className="p-6 text-sm text-[#523624] text-center">{copy.emptyAudit}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                  <tr>
                    <th className="py-2.5 px-4 text-start font-semibold">{copy.colTime}</th>
                    <th className="py-2.5 px-4 text-start font-semibold">{copy.colCategory}</th>
                    <th className="py-2.5 px-4 text-start font-semibold">{copy.colAction}</th>
                    <th className="py-2.5 px-4 text-start font-semibold">{copy.colTarget}</th>
                    <th className="py-2.5 px-4 text-end font-semibold">{copy.colOutcome}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#523624]/10">
                  {snapshot.recentAuditLogs.slice(0, 6).map((row) => (
                    <tr key={row.id} className="hover:bg-[#D4AF37]/5">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#523624] whitespace-nowrap">
                        {formatTimestamp(row.created_at, locale)}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[#26170F] whitespace-nowrap">
                        {row.category}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-[#26170F] whitespace-nowrap">
                        {row.action}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[#523624] max-w-[240px] truncate">
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
      </section>
    </div>
  );
}
