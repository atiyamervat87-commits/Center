import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Cpu,
  HardDrive,
  KeyRound,
  Lock,
  Network,
  Package,
  Presentation,
  RefreshCw,
  Shield,
  ShieldAlert,
  Terminal,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { t } from '../../i18n/translations';
import type {
  DeviceManagerSnapshot,
  Locale,
  SecurityPermissions,
  SecuritySnapshot,
} from '../../types/commandCenter';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';
import {
  executeApprovedCleanup,
  fetchDeviceManagerStatus,
  fetchSecurityStatus,
  loginOwnerSession,
  revokeOwnerSession,
  setOwnerToken,
  setupOwnerPasskey,
  updateSecurityPermissions,
} from '../../services/apiClient';
import type { NavTabId } from '../layout/CommandShell';

interface DeviceSecurityViewProps {
  locale: Locale;
  onEnterDemoMode: () => void;
  onNavigate: (tab: NavTabId) => void;
  onDataChanged: () => Promise<void>;
}

export function DeviceSecurityView({
  locale,
  onEnterDemoMode,
  onNavigate,
  onDataChanged,
}: DeviceSecurityViewProps) {
  const copy = t(locale);

  const [device, setDevice] = useState<DeviceManagerSnapshot | null>(null);
  const [security, setSecurity] = useState<SecuritySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [confirmCleanupId, setConfirmCleanupId] = useState<string | null>(null);
  const [busyCleanupPath, setBusyCleanupPath] = useState<string | null>(null);
  const [showDeps, setShowDeps] = useState(false);

  // Owner Security Auth Form State (no hardcoded default passkey!)
  const [passkeyInput, setPasskeyInput] = useState('');
  const [deviceLabelInput, setDeviceLabelInput] = useState('OPPO CPH1911 Console');
  const [authBusy, setAuthBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [devSnap, secSnap] = await Promise.all([
        fetchDeviceManagerStatus(),
        fetchSecurityStatus(),
      ]);
      setDevice(devSnap);
      setSecurity(secSnap);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.errorLoading);
    } finally {
      setLoading(false);
    }
  }, [copy.errorLoading]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleCleanupExecute = async (filePath: string) => {
    setBusyCleanupPath(filePath);
    setFeedback(null);
    try {
      const res = await executeApprovedCleanup(filePath, true);
      setConfirmCleanupId(null);
      setFeedback({
        type: 'ok',
        text: `Deleted ${res.result.deletedPath} (${formatBytes(res.result.sizeBytes, locale)}) · SHA-256: ${res.result.sha256BeforeDelete}`,
      });
      await loadAll();
      await onDataChanged();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Cleanup failed',
      });
    } finally {
      setBusyCleanupPath(null);
    }
  };

  const handleSetupOrRotatePasskey = async (e: FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setFeedback(null);
    try {
      const res = await setupOwnerPasskey({
        passkey: passkeyInput,
        deviceLabel: deviceLabelInput,
      });
      setSecurity(res.snapshot);
      setPasskeyInput('');
      setFeedback({
        type: 'ok',
        text: `Owner Lock Active · Session ${res.sessionId}`,
      });
      await onDataChanged();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Passkey setup failed',
      });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleOwnerLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setFeedback(null);
    try {
      const res = await loginOwnerSession({
        passkey: passkeyInput,
        deviceLabel: deviceLabelInput,
      });
      setSecurity(res.snapshot);
      setPasskeyInput('');
      setFeedback({
        type: 'ok',
        text: `Authenticated · Session ${res.sessionId}`,
      });
      await onDataChanged();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Authentication failed',
      });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRevokeSession = async (sessionId: string, isCurrent: boolean) => {
    setFeedback(null);
    try {
      const res = await revokeOwnerSession(sessionId);
      if (isCurrent) {
        setOwnerToken(null);
      }
      setSecurity(res.snapshot);
      await loadAll();
      await onDataChanged();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to revoke session',
      });
    }
  };

  const handleTogglePermission = async (key: keyof SecurityPermissions, nextVal: boolean) => {
    setFeedback(null);
    try {
      const res = await updateSecurityPermissions({ [key]: nextVal });
      setSecurity(res.snapshot);
      await onDataChanged();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to update permission',
      });
    }
  };

  if (loading && !device) {
    return (
      <div className="space-y-4">
        <div className="h-32 rounded-xl bg-[#3B2419]/15 animate-pulse" />
        <div className="h-64 rounded-xl bg-[#523624]/10 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header & Mode Actions */}
      <section className="rounded-xl bg-[#3B2419] text-[#FFF8E8] border border-[#D4AF37]/40 p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[#F3D989]">
              <Shield className="h-5 w-5" aria-hidden="true" />
              <span className="font-mono text-xs tracking-wider">PHASE 8 · ACTIVE</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold">{copy.devSecTitle}</h1>
            <p className="text-xs sm:text-sm text-[#FFF8E8]/80 max-w-3xl">{copy.devSecSubtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void loadAll()}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#D4AF37]/40 bg-[#26170F] hover:bg-[#523624] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>{copy.actionRefresh}</span>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('roadmap')}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#D4AF37]/40 bg-[#26170F] hover:bg-[#523624] text-[#FFF8E8] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <span>{copy.navRoadmap}</span>
            </button>

            <button
              type="button"
              onClick={onEnterDemoMode}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
            >
              <Presentation className="h-4 w-4" aria-hidden="true" />
              <span>{copy.devEnterDemoBtn}</span>
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-800/30 p-4 text-xs font-mono text-red-900">
          {error}
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-xl border p-4 text-xs font-mono break-all ${
            feedback.type === 'ok'
              ? 'bg-emerald-50/70 border-emerald-800/30 text-emerald-900'
              : 'bg-red-50/80 border-red-800/30 text-red-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* 1. Device & Resource Telemetry Grid */}
      {device && (
        <section className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Internal & SD Storage */}
            <div className="rounded-xl bg-white/80 border border-[#523624]/20 p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                  <HardDrive className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                  <span>{copy.navStorage}</span>
                </div>
                <StatusIndicator state={device.internalStorage.state as 'AVAILABLE'} />
              </div>

              <div className="space-y-2 text-xs">
                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15 space-y-1">
                  <div className="font-semibold text-[#3B2419]">Internal Workspace</div>
                  <div className="font-mono text-[11px] text-[#523624] break-all">
                    {device.internalStorage.path}
                  </div>
                  <div className="font-mono font-bold tabular-nums text-[#26170F]">
                    {formatBytes(device.internalStorage.availableBytes, locale)} /{' '}
                    {formatBytes(device.internalStorage.totalBytes, locale)}
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[#3B2419]">External SD / SAF</span>
                    <span className="font-mono text-[11px] text-[#523624]">
                      {device.externalSdStorage.state}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[#523624] break-all">
                    {device.externalSdStorage.path}
                  </div>
                </div>
              </div>
            </div>

            {/* Memory & Active Process */}
            <div className="rounded-xl bg-white/80 border border-[#523624]/20 p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Cpu className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.devMemoryTitle}</span>
              </div>
              {device.memory.isHostMemory && (
                <p className="text-xs text-amber-900 font-medium">{copy.devMemoryHostNotice}</p>
              )}
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15">
                  <div className="text-[#523624]">Host Free / Total</div>
                  <div className="font-mono font-bold tabular-nums mt-0.5">
                    {formatBytes(device.memory.freeBytes, locale)} /{' '}
                    {formatBytes(device.memory.totalBytes, locale)}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15">
                  <div className="text-[#523624]">Process RSS / Heap</div>
                  <div className="font-mono font-bold tabular-nums mt-0.5">
                    {formatBytes(device.memory.processRssBytes, locale)} /{' '}
                    {formatBytes(device.memory.processHeapUsedBytes, locale)}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15">
                  <div className="text-[#523624]">{copy.devProcessPid}</div>
                  <div className="font-mono font-bold tabular-nums mt-0.5">
                    {device.activeProcess.pid} ({device.activeProcess.nodeVersion})
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/15">
                  <div className="text-[#523624]">{copy.devProcessUptime}</div>
                  <div className="font-mono font-bold tabular-nums mt-0.5">
                    {device.activeProcess.uptimeSeconds}s · {device.activeProcess.platform}/
                    {device.activeProcess.arch}
                  </div>
                </div>
              </div>
            </div>

            {/* Services, Termux & Cache */}
            <div className="rounded-xl bg-white/80 border border-[#523624]/20 p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Terminal className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>{copy.devServicesTitle}</span>
              </div>

              <div className="space-y-2 text-xs">
                {device.localServices.map((svc) => (
                  <div
                    key={svc.name}
                    className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/15"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#26170F]">{svc.name}</div>
                      <div className="font-mono text-[11px] text-[#523624] truncate">
                        {svc.detail}
                      </div>
                    </div>
                    <StatusIndicator state={svc.status} />
                  </div>
                ))}

                <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/15">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#26170F]">Termux Runtime</div>
                    <div className="font-mono text-[11px] text-[#523624] truncate">
                      {device.termuxStatus.prefixPath}
                    </div>
                  </div>
                  <span className="font-mono text-xs font-bold text-[#523624]">
                    {device.termuxStatus.state}
                  </span>
                </div>

                <div className="p-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/15 flex items-center justify-between">
                  <span className="text-[#523624]">{copy.devCacheSummaryTitle}</span>
                  <span className="font-mono font-bold tabular-nums text-[#26170F]">
                    {formatBytes(
                      device.cacheSummary.cacheDirBytes + device.cacheSummary.exportsDirBytes,
                      locale,
                    )}{' '}
                    ({device.cacheSummary.trackedFilesCount})
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Network & Installed Dependencies */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl bg-white/80 border border-[#523624]/20 p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <Network className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>Network Interfaces</span>
              </div>
              <div className="max-h-40 overflow-y-auto divide-y divide-[#523624]/10 text-xs font-mono">
                {device.networkInterfaces.map((ni, idx) => (
                  <div key={`${ni.name}-${ni.address}-${idx}`} className="py-1.5 flex justify-between gap-2">
                    <span className="font-semibold text-[#26170F]">
                      {ni.name} ({ni.family})
                    </span>
                    <span className="text-[#523624] tabular-nums">
                      {ni.address} {ni.internal ? '· loopback' : '· LAN'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl bg-white/80 border border-[#523624]/20 p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                  <Package className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                  <span>
                    {copy.devDepsTitle} ({device.installedDependencies.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeps((v) => !v)}
                  className="text-xs font-semibold underline decoration-[#B8860B] text-[#3B2419] cursor-pointer"
                >
                  {showDeps ? 'Hide' : 'Inspect'}
                </button>
              </div>
              {showDeps && (
                <div className="max-h-40 overflow-y-auto divide-y divide-[#523624]/10 text-xs font-mono">
                  {device.installedDependencies.map((dep) => (
                    <div key={`${dep.scope}-${dep.name}`} className="py-1.5 flex justify-between gap-2">
                      <span className="text-[#26170F]">{dep.name}</span>
                      <span className="text-[#523624] tabular-nums">
                        {dep.version} ({dep.scope})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Safe Cleanup Suggestions (Owner Approved Only) */}
          <div className="rounded-xl bg-white/85 border border-[#523624]/25 p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 text-base font-bold text-[#26170F]">
              <Trash2 className="h-5 w-5 text-[#B8860B]" aria-hidden="true" />
              <h2>{copy.devCleanupTitle}</h2>
            </div>

            {device.cleanupSuggestions.length === 0 ? (
              <div className="rounded-lg bg-[#FFF8E8] border border-[#523624]/15 p-4 text-xs text-[#523624]">
                {copy.devCleanupEmpty}
              </div>
            ) : (
              <div className="space-y-3">
                {device.cleanupSuggestions.map((item) => {
                  const isConfirming = confirmCleanupId === item.id;
                  const isBusy = busyCleanupPath === item.path;
                  return (
                    <div
                      key={item.id}
                      className="rounded-lg bg-[#FFF8E8] border border-[#523624]/20 p-4 space-y-2"
                    >
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono font-bold text-[#26170F]">
                            <span>{item.id}</span>
                            <span>·</span>
                            <span>{item.fileType}</span>
                            <span>·</span>
                            <span className="tabular-nums">{formatBytes(item.sizeBytes, locale)}</span>
                            <span>·</span>
                            <span>inUse={String(item.inUse)}</span>
                          </div>
                          <div className="font-mono text-xs text-[#3B2419] break-all">{item.path}</div>
                          <div className="text-xs text-[#523624]">
                            {item.reason} — {item.expectedImpact}
                          </div>
                        </div>

                        {!isConfirming && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmCleanupId(item.id)}
                            className="min-h-[40px] px-4 py-2 rounded-lg border border-red-800/35 text-red-900 hover:bg-red-50 text-xs font-bold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{copy.devCleanupApproveBtn}</span>
                          </button>
                        )}
                      </div>

                      {isConfirming && (
                        <div className="pt-2 border-t border-red-800/20 flex flex-wrap items-center justify-between gap-3">
                          <span className="text-xs font-semibold text-red-900">
                            {copy.devCleanupConfirmPrompt}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmCleanupId(null)}
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#523624]/30 text-xs font-semibold text-[#26170F] cursor-pointer"
                            >
                              {copy.pmCancel}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleCleanupExecute(item.path)}
                              className="min-h-[38px] px-3 py-1.5 rounded-lg bg-red-800 hover:bg-red-900 text-white text-xs font-bold cursor-pointer"
                            >
                              {isBusy ? '...' : copy.devCleanupApproveBtn}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2. Owner Security Center & RBAC Permissions */}
      {security && (
        <section className="rounded-xl bg-white/85 border border-[#523624]/25 p-5 sm:p-6 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-[#523624]/15 pb-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-base font-bold text-[#26170F]">
                <Lock className="h-5 w-5 text-[#B8860B]" aria-hidden="true" />
                <h2>{copy.secTitle}</h2>
              </div>
              <p className="text-xs text-[#523624]">
                {security.ownerLockConfigured ? copy.secLockConfigured : copy.secLockUnconfigured}
              </p>
            </div>

            <div className="flex items-center gap-3 font-mono text-xs font-bold">
              {security.sessionAuthenticated ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-800">
                  <UserCheck className="h-4 w-4" aria-hidden="true" />
                  <span>SESSION AUTHENTICATED ({security.activeSessionId})</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-amber-800">
                  <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {security.ownerLockConfigured ? 'LOCKED (SIGN IN REQUIRED)' : 'OPEN (NO PASSKEY SET)'}
                  </span>
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Passkey Setup / Sign-in Form */}
            <form
              onSubmit={
                !security.ownerLockConfigured || security.sessionAuthenticated
                  ? handleSetupOrRotatePasskey
                  : handleOwnerLogin
              }
              className="rounded-xl bg-[#FFF8E8] border border-[#523624]/20 p-4 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-[#26170F]">
                <KeyRound className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                <span>
                  {!security.ownerLockConfigured || security.sessionAuthenticated
                    ? copy.secSetupPasskeyTitle
                    : copy.secLoginTitle}
                </span>
              </div>

              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[#3B2419]">{copy.secPasskeyLabel}</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete="off"
                  value={passkeyInput}
                  onChange={(e) => setPasskeyInput(e.target.value)}
                  placeholder="••••••"
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-white border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
                />
              </label>

              <label className="block space-y-1 text-xs">
                <span className="font-semibold text-[#3B2419]">{copy.secDeviceLabel}</span>
                <input
                  type="text"
                  value={deviceLabelInput}
                  onChange={(e) => setDeviceLabelInput(e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-white border border-[#523624]/25 font-mono text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
                />
              </label>

              <button
                type="submit"
                disabled={authBusy}
                className="min-h-[44px] px-4 py-2 rounded-lg bg-[#26170F] hover:bg-[#3B2419] disabled:opacity-60 text-[#F3D989] text-xs font-bold cursor-pointer"
              >
                {!security.ownerLockConfigured || security.sessionAuthenticated
                  ? copy.secSetupSubmit
                  : copy.secLoginSubmit}
              </button>
            </form>

            {/* Permission Controls */}
            <div className="rounded-xl bg-[#FFF8E8] border border-[#523624]/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-[#26170F]">{copy.secPermissionsTitle}</h3>

              <label className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-white border border-[#523624]/15 text-xs cursor-pointer">
                <span className="font-medium text-[#26170F]">{copy.secPermExport}</span>
                <input
                  type="checkbox"
                  checked={security.permissions.exportRequiresAuth}
                  onChange={(e) =>
                    void handleTogglePermission('exportRequiresAuth', e.target.checked)
                  }
                  className="h-4 w-4 accent-[#26170F]"
                />
              </label>

              <label className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-white border border-[#523624]/15 text-xs cursor-pointer">
                <span className="font-medium text-[#26170F]">{copy.secPermDelete}</span>
                <input
                  type="checkbox"
                  checked={security.permissions.deleteRequiresAuth}
                  onChange={(e) =>
                    void handleTogglePermission('deleteRequiresAuth', e.target.checked)
                  }
                  className="h-4 w-4 accent-[#26170F]"
                />
              </label>

              <label className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-white border border-[#523624]/15 text-xs cursor-pointer">
                <span className="font-medium text-[#26170F]">{copy.secPermPairing}</span>
                <input
                  type="checkbox"
                  checked={security.permissions.pairingRequiresAuth}
                  onChange={(e) =>
                    void handleTogglePermission('pairingRequiresAuth', e.target.checked)
                  }
                  className="h-4 w-4 accent-[#26170F]"
                />
              </label>
            </div>
          </div>

          {/* Active & Historical Sessions Table */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold text-[#26170F]">{copy.secSessionsTitle}</h3>
            {security.sessions.length === 0 ? (
              <div className="text-xs text-[#523624] font-mono">No sessions recorded yet.</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-[#523624]/20">
                <table className="w-full text-xs">
                  <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                    <tr>
                      <th className="py-2 px-3 text-start font-semibold">ID</th>
                      <th className="py-2 px-3 text-start font-semibold">{copy.secDeviceLabel}</th>
                      <th className="py-2 px-3 text-start font-semibold">Expires</th>
                      <th className="py-2 px-3 text-start font-semibold">Status</th>
                      <th className="py-2 px-3 text-end font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#523624]/10 font-mono">
                    {security.sessions.map((ses) => (
                      <tr key={ses.id}>
                        <td className="py-2 px-3 font-semibold text-[#26170F]">
                          {ses.id} {ses.isCurrent ? '(CURRENT)' : ''}
                        </td>
                        <td className="py-2 px-3 text-[#523624]">{ses.deviceLabel}</td>
                        <td className="py-2 px-3 text-[#523624] tabular-nums">
                          {formatTimestamp(ses.expiresAt, locale)}
                        </td>
                        <td className="py-2 px-3">
                          <span className={ses.revoked ? 'text-red-800' : 'text-emerald-800'}>
                            {ses.revoked ? 'REVOKED' : 'ACTIVE'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-end">
                          {!ses.revoked && (
                            <button
                              type="button"
                              onClick={() => void handleRevokeSession(ses.id, ses.isCurrent)}
                              className="px-2.5 py-1 rounded border border-red-800/35 text-red-900 hover:bg-red-50 font-sans font-semibold cursor-pointer"
                            >
                              {copy.secRevokeBtn}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
