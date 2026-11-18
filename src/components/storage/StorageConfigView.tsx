import { useState, type FormEvent } from 'react';
import { CheckSquare, Cpu, HardDrive, Save, ShieldCheck, Smartphone, Terminal } from 'lucide-react';
import { t } from '../../i18n/translations';
import type {
  AndroidBridgeDiagnostics,
  Locale,
  SeparatedEnvironmentProbe,
  StorageProviderId,
  StorageVerificationReport,
} from '../../types/commandCenter';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';
import { AndroidBridgePanel } from '../android/AndroidBridgePanel';
import {
  approveArchiveLocation,
  updateRuntimeConfig,
  verifyStorageProbe,
} from '../../services/apiClient';

interface StorageConfigViewProps {
  locale: Locale;
  config: Record<string, string>;
  environment: SeparatedEnvironmentProbe;
  androidDiagnostics: AndroidBridgeDiagnostics;
  storageReady: boolean;
  onUpdated: () => Promise<void>;
}

export function StorageConfigView({
  locale,
  config,
  environment,
  androidDiagnostics,
  storageReady,
  onUpdated,
}: StorageConfigViewProps) {
  const copy = t(locale);

  const [selectedProvider, setSelectedProvider] = useState<StorageProviderId>(
    environment.selectedArchiveProvider,
  );
  const [initializeSdFolder, setInitializeSdFolder] = useState(false);

  const [formState, setFormState] = useState({
    data_dir: config.data_dir ?? '',
    sd_archive_path: config.sd_archive_path ?? '',
    termux_prefix: config.termux_prefix ?? '',
    termux_shared_path: config.termux_shared_path ?? '',
    android_saf_uri: config.android_saf_uri ?? '',
    target_device_model: config.target_device_model ?? '',
    android_version: config.android_version ?? '',
    bridge_endpoint: config.bridge_endpoint ?? '',
  });

  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [activeReport, setActiveReport] = useState<StorageVerificationReport | null>(
    environment.lastVerificationReport,
  );

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await updateRuntimeConfig({
        ...formState,
        selected_archive_provider: selectedProvider,
      });
      await onUpdated();
      setActiveReport(null);
      setFeedback({ type: 'ok', text: copy.configSavedMsg });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyProvider = async (providerId: StorageProviderId) => {
    setProbing(true);
    setFeedback(null);
    try {
      const result = await verifyStorageProbe(providerId);
      setActiveReport(result.report);
      await onUpdated();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Probe failed',
      });
    } finally {
      setProbing(false);
    }
  };

  const handleApproveLocation = async () => {
    setApproving(true);
    setFeedback(null);
    try {
      const archivePath =
        selectedProvider === 'external_sd'
          ? formState.sd_archive_path
          : selectedProvider === 'termux'
            ? formState.termux_shared_path
            : selectedProvider === 'android_saf'
              ? formState.android_saf_uri
              : formState.data_dir;

      const res = await approveArchiveLocation({
        providerId: selectedProvider,
        archivePath,
        ownerConfirmed: true,
        initializeDirectory: initializeSdFolder,
      });
      setActiveReport(res.report);
      await onUpdated();
      setFeedback({
        type: res.approved ? 'ok' : 'err',
        text: res.approved
          ? `${copy.storageReadyLabel}: ${res.report.configuredPath}`
          : res.report.failureReason || `Blocked (${res.report.state})`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Approval failed',
      });
    } finally {
      setApproving(false);
    }
  };

  const providerCards = [
    {
      id: 'host_dev' as const,
      title: copy.hostEnvTitle,
      icon: Cpu,
      probe: environment.hostEnvironment.provider,
      extra: `${environment.hostEnvironment.label} · ${copy.hostEnvNotice}`,
    },
    {
      id: 'android_saf' as const,
      title: copy.androidEnvTitle,
      icon: Smartphone,
      probe: environment.androidDeviceEnvironment.provider,
      extra: `${environment.androidDeviceEnvironment.targetDeviceModel} · ${environment.androidDeviceEnvironment.targetAndroidVersion}`,
    },
    {
      id: 'termux' as const,
      title: copy.termuxEnvTitle,
      icon: Terminal,
      probe: environment.termuxEnvironment.provider,
      extra: `Termux Detected: ${environment.termuxEnvironment.termuxDetected ? copy.yes : copy.no}`,
    },
    {
      id: 'external_sd' as const,
      title: copy.sdEnvTitle,
      icon: HardDrive,
      probe: environment.externalSdStorage.provider,
      extra: `Owner Confirmed: ${environment.externalSdStorage.archiveLocationConfirmedByOwner ? copy.yes : copy.no}`,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#26170F]">{copy.storageSectionTitle}</h1>
          <p className="text-sm text-[#523624] mt-1">{copy.providerSelectorDesc}</p>
        </div>
        <div className="font-mono text-xs font-bold px-3 py-2 rounded-lg border border-[#523624]/25 bg-white/80 shrink-0">
          <span className="text-[#523624]">ARCHIVE GATE: </span>
          <span className={storageReady ? 'text-emerald-800' : 'text-red-800'}>
            {storageReady ? copy.storageReadyLabel : copy.storageNotReadyLabel}
          </span>
        </div>
      </div>

      {/* 4 Separated Environment Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {providerCards.map((card) => {
          const Icon = card.icon;
          const isSelected = selectedProvider === card.id;
          return (
            <div
              key={card.id}
              className={`rounded-xl border p-5 space-y-3 ${
                isSelected
                  ? 'bg-white border-[#B8860B] ring-1 ring-[#D4AF37]/40'
                  : 'bg-white/70 border-[#523624]/20'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                  <Icon className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                  <span>{card.title}</span>
                </div>
                <StatusIndicator state={card.probe.state} />
              </div>

              <p className="text-xs text-[#523624]">{card.extra}</p>

              <div className="space-y-1 text-xs">
                <div className="text-[#523624]">{copy.pathLabel}</div>
                <div className="font-mono text-[#26170F] break-all bg-[#FFF8E8] border border-[#523624]/15 rounded px-2.5 py-1.5">
                  {card.probe.configuredPath || copy.notAvailable}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div>
                  <span className="text-[#523624]">{copy.permissionsLabel}: </span>
                  <span className="font-mono font-semibold">
                    R:{card.probe.readable ? 'YES' : 'NO'} / W:{card.probe.writable ? 'YES' : 'NO'}
                  </span>
                </div>
                <div>
                  <span className="text-[#523624]">{copy.freeSpaceLabel}: </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {formatBytes(card.probe.availableBytes, locale)}
                  </span>
                </div>
              </div>

              {card.probe.failureReason && (
                <div className="text-xs font-mono text-red-800 pt-1">
                  {card.probe.failureReason}
                </div>
              )}

              <div className="pt-2 border-t border-[#523624]/15 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedProvider(card.id)}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#26170F] text-[#F3D989]'
                      : 'bg-[#3B2419]/10 text-[#3B2419] hover:bg-[#3B2419]/20'
                  }`}
                >
                  {isSelected ? 'Selected Provider' : 'Select Provider'}
                </button>

                <button
                  type="button"
                  onClick={() => void handleVerifyProvider(card.id)}
                  disabled={probing}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#523624]/25 bg-[#FFF8E8] hover:bg-[#F3D989]/30 text-[#26170F] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{copy.runSha256TestBtn}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Android Integration Bridge & ACTION_OPEN_DOCUMENT_TREE */}
      <AndroidBridgePanel
        locale={locale}
        diagnostics={androidDiagnostics}
        onUpdated={onUpdated}
      />

      {/* Owner Archive Location Confirmation */}
      <section className="rounded-xl bg-[#3B2419] text-[#FFF8E8] border border-[#D4AF37]/40 p-5 sm:p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-bold text-[#F3D989]">{copy.providerSelectorTitle}</h2>
            <p className="text-xs text-[#FFF8E8]/80">{copy.providerSelectorDesc}</p>
          </div>

          <button
            type="button"
            onClick={handleApproveLocation}
            disabled={approving}
            className="min-h-[44px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] disabled:opacity-60 text-[#26170F] text-xs font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CheckSquare className="h-4 w-4" aria-hidden="true" />
            <span>{copy.approveLocationBtn}</span>
          </button>
        </div>

        <label className="flex items-center gap-2.5 text-xs text-[#FFF8E8]/90 cursor-pointer">
          <input
            type="checkbox"
            checked={initializeSdFolder}
            onChange={(e) => setInitializeSdFolder(e.target.checked)}
            className="h-4 w-4 accent-[#D4AF37]"
          />
          <span>{copy.initSdFolderLabel}</span>
        </label>
      </section>

      {/* Detailed Real Storage Verification Report */}
      {activeReport && (
        <section className="rounded-xl bg-white/85 border border-[#523624]/25 p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#523624]/15 pb-3">
            <div>
              <h2 className="text-base font-bold text-[#26170F]">{copy.reportTitle}</h2>
              <div className="font-mono text-xs text-[#523624] tabular-nums mt-0.5">
                {formatTimestamp(activeReport.executedAt, locale)}
              </div>
            </div>
            <StatusIndicator state={activeReport.state} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <div className="text-[#523624]">{copy.reportEnvType}</div>
              <div className="font-mono font-semibold text-[#26170F] mt-0.5">
                {activeReport.environmentType} ({activeReport.providerId})
              </div>
            </div>
            <div>
              <div className="text-[#523624]">{copy.reportPermissions}</div>
              <div className="font-mono font-semibold text-[#26170F] mt-0.5">
                Readable: {activeReport.readable ? copy.yes : copy.no} · Writable: {activeReport.writable ? copy.yes : copy.no}
              </div>
            </div>
            <div className="md:col-span-2">
              <div className="text-[#523624]">{copy.reportDiscovered}</div>
              <div className="font-mono text-[#26170F] mt-0.5 break-all">
                {activeReport.discoveredPaths.length > 0
                  ? activeReport.discoveredPaths.join(' , ')
                  : copy.notAvailable}
              </div>
            </div>
            <div className="md:col-span-2">
              <div className="text-[#523624]">{copy.reportSha256}</div>
              <div className="font-mono text-[#26170F] mt-0.5 break-all">
                {activeReport.actualSha256 || activeReport.expectedSha256 || copy.notAvailable}
              </div>
            </div>
            <div>
              <div className="text-[#523624]">{copy.reportCleanup}</div>
              <div className="font-mono font-semibold text-[#26170F] mt-0.5">
                {activeReport.cleanupCompleted ? copy.yes : copy.no}
              </div>
            </div>
            <div>
              <div className="text-[#523624]">{copy.reportState}</div>
              <div className="font-mono font-semibold text-[#26170F] mt-0.5">
                {activeReport.storageReady ? copy.storageReadyLabel : copy.storageNotReadyLabel}
              </div>
            </div>
            {activeReport.failureReason && (
              <div className="md:col-span-2">
                <div className="text-[#523624]">{copy.reportFailureReason}</div>
                <div className="font-mono text-red-800 mt-0.5 break-all">
                  {activeReport.failureReason}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Configurable Runtime Paths Form */}
      <form
        onSubmit={handleSave}
        className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 sm:p-6 space-y-5"
      >
        <h2 className="text-base font-bold text-[#26170F]">{copy.configFormTitle}</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldDataDir}</span>
            <input
              type="text"
              dir="ltr"
              value={formState.data_dir}
              onChange={(e) => setFormState((s) => ({ ...s, data_dir: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>

          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldSdPath}</span>
            <input
              type="text"
              dir="ltr"
              value={formState.sd_archive_path}
              onChange={(e) => setFormState((s) => ({ ...s, sd_archive_path: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>

          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldTermuxPrefix}</span>
            <input
              type="text"
              dir="ltr"
              value={formState.termux_prefix}
              onChange={(e) => setFormState((s) => ({ ...s, termux_prefix: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>

          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldTermuxShared}</span>
            <input
              type="text"
              dir="ltr"
              value={formState.termux_shared_path}
              onChange={(e) => setFormState((s) => ({ ...s, termux_shared_path: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>

          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldAndroidSafUri}</span>
            <input
              type="text"
              dir="ltr"
              placeholder="content://com.android.externalstorage.documents/tree/..."
              value={formState.android_saf_uri}
              onChange={(e) => setFormState((s) => ({ ...s, android_saf_uri: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>

          <label className="block space-y-1.5 text-xs">
            <span className="font-semibold text-[#3B2419]">{copy.fieldBridgeUrl}</span>
            <input
              type="text"
              dir="ltr"
              placeholder="http://192.168.1.50:8700"
              value={formState.bridge_endpoint}
              onChange={(e) => setFormState((s) => ({ ...s, bridge_endpoint: e.target.value }))}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
            />
          </label>
        </div>

        {feedback && (
          <div
            className={`text-xs font-medium ${
              feedback.type === 'ok' ? 'text-emerald-800' : 'text-red-800'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="min-h-[44px] px-5 py-2.5 rounded-lg bg-[#D4AF37] hover:bg-[#B8860B] hover:text-[#FFF8E8] disabled:opacity-60 text-[#26170F] text-xs font-bold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            <span>{saving ? copy.savingConfigBtn : copy.saveConfigBtn}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
