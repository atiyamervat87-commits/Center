import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n/translations';
import {
  fetchDashboardSnapshot,
  verifyStorageProbe,
} from './services/apiClient';
import {
  RealtimeDashboardSyncClient,
  type RealtimeSyncClientStatus,
} from './services/realtimeSyncClient';
import type { Locale, MasterDashboardSnapshot, WingId } from './types/commandCenter';
import { CommandShell, type NavTabId } from './components/layout/CommandShell';
import { MasterDashboard } from './components/dashboard/MasterDashboard';
import { FactoryWingsView } from './components/wings/FactoryWingsView';
import { ProjectManagerView } from './components/projects/ProjectManagerView';
import { StorageConfigView } from './components/storage/StorageConfigView';
import { DeviceSecurityView } from './components/device/DeviceSecurityView';
import { DemoModeView } from './components/demo/DemoModeView';
import { AuditLogView } from './components/audit/AuditLogView';
import { ModuleRoadmapView } from './components/modules/ModuleRoadmapView';

export default function App() {
  const [locale, setLocale] = useState<Locale>('ar');
  const [activeTab, setActiveTab] = useState<NavTabId>('dashboard');
  const [activeWing, setActiveWing] = useState<WingId>('DATA_FACTORY');
  const [demoMode, setDemoMode] = useState(false);
  const [snapshot, setSnapshot] = useState<MasterDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<RealtimeSyncClientStatus>({
    connectionState: 'DISCONNECTED',
    transport: 'SSE',
    sequence: 0,
    lastSyncedAt: null,
    lastReason: null,
    error: null,
  });
  const syncClientRef = useRef<RealtimeDashboardSyncClient | null>(null);

  const copy = t(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const loadSnapshot = useCallback(async () => {
    try {
      const data = await fetchDashboardSnapshot();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.errorLoading);
    } finally {
      setLoading(false);
    }
  }, [copy.errorLoading]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (demoMode) {
      syncClientRef.current?.stop();
      return;
    }

    const client = syncClientRef.current ?? new RealtimeDashboardSyncClient();
    syncClientRef.current = client;

    const unsubStatus = client.onStatusChange((nextStatus) => {
      setSyncStatus(nextStatus);
    });
    const unsubSnapshot = client.onSnapshot((syncedSnapshot) => {
      setSnapshot(syncedSnapshot);
      setError(null);
      setLoading(false);
    });

    client.start();

    return () => {
      unsubSnapshot();
      unsubStatus();
      client.stop();
    };
  }, [demoMode]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      if (syncClientRef.current) {
        const updated = await syncClientRef.current.syncNow();
        setSnapshot(updated);
      } else {
        await loadSnapshot();
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.errorLoading);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRunSystemCheck = async () => {
    setChecking(true);
    try {
      await verifyStorageProbe();
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.errorLoading);
    } finally {
      setChecking(false);
    }
  };

  const handleOpenWing = (wing: WingId) => {
    setActiveWing(wing);
    setActiveTab('wings');
  };

  return (
    <CommandShell
      locale={locale}
      activeTab={activeTab}
      demoMode={demoMode}
      onSelectTab={setActiveTab}
      onRunSystemCheck={handleRunSystemCheck}
      isChecking={checking}
    >
      {demoMode ? (
        <DemoModeView
          locale={locale}
          onExitDemoMode={() => {
            setDemoMode(false);
            void loadSnapshot();
          }}
        />
      ) : loading && !snapshot ? (
        <div className="space-y-6">
          <div className="h-44 rounded-xl bg-[#3B2419]/15 animate-pulse" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="h-28 rounded-xl bg-[#523624]/10 animate-pulse" />
            <div className="h-28 rounded-xl bg-[#523624]/10 animate-pulse" />
            <div className="h-28 rounded-xl bg-[#523624]/10 animate-pulse" />
            <div className="h-28 rounded-xl bg-[#523624]/10 animate-pulse" />
          </div>
          <p className="text-xs text-[#523624] font-medium">{copy.loadingDashboard}</p>
        </div>
      ) : error && !snapshot ? (
        <div className="rounded-xl bg-white/80 border border-red-800/30 p-6 space-y-4">
          <div className="text-base font-bold text-red-900">{copy.errorLoading}</div>
          <div className="font-mono text-xs text-red-800">{error}</div>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void loadSnapshot();
            }}
            className="min-h-[44px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-semibold cursor-pointer"
          >
            {copy.retryLabel}
          </button>
        </div>
      ) : snapshot ? (
        <>
          {error && (
            <div className="mb-4 rounded-xl bg-red-50 border border-red-800/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-red-900">
              <span className="font-mono break-all">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="min-h-[32px] px-3 py-1 rounded-md border border-red-800/30 bg-white hover:bg-red-100 text-red-900 font-semibold cursor-pointer shrink-0"
              >
                {locale === 'ar' ? 'إغلاق' : 'Dismiss'}
              </button>
            </div>
          )}
          {activeTab === 'dashboard' && (
            <MasterDashboard
              locale={locale}
              onToggleLocale={() => setLocale((prev) => (prev === 'ar' ? 'en' : 'ar'))}
              snapshot={snapshot}
              syncStatus={syncStatus}
              isSyncing={isSyncing}
              onSyncNow={handleManualSync}
              onNavigate={setActiveTab}
              onOpenWing={handleOpenWing}
            />
          )}

          {activeTab === 'wings' && (
            <FactoryWingsView
              locale={locale}
              initialWing={activeWing}
              onNavigate={setActiveTab}
              onDataChanged={loadSnapshot}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectManagerView locale={locale} onDataChanged={loadSnapshot} />
          )}

          {activeTab === 'storage' && (
            <StorageConfigView
              locale={locale}
              config={snapshot.config}
              environment={snapshot.environment}
              androidDiagnostics={snapshot.androidDiagnostics}
              storageReady={snapshot.storageReady}
              onUpdated={loadSnapshot}
            />
          )}

          {activeTab === 'device' && (
            <DeviceSecurityView
              locale={locale}
              onEnterDemoMode={() => setDemoMode(true)}
              onNavigate={setActiveTab}
              onDataChanged={loadSnapshot}
            />
          )}

          {activeTab === 'audit' && <AuditLogView locale={locale} />}

          {activeTab === 'roadmap' && (
            <ModuleRoadmapView locale={locale} modules={snapshot.modules} />
          )}
        </>
      ) : null}
    </CommandShell>
  );
}
