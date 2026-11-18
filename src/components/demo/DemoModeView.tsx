import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Lock,
  LogOut,
  Play,
  Presentation,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { t } from '../../i18n/translations';
import type { DemoCatalogSnapshot, Locale, SecuritySnapshot } from '../../types/commandCenter';
import { formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';
import {
  fetchDemoCatalog,
  fetchSecurityStatus,
  loginOwnerSession,
  resetDemoSandbox,
  runDemoInference,
} from '../../services/apiClient';

interface DemoModeViewProps {
  locale: Locale;
  onExitDemoMode: () => void;
}

export function DemoModeView({ locale, onExitDemoMode }: DemoModeViewProps) {
  const copy = t(locale);

  const [catalog, setCatalog] = useState<DemoCatalogSnapshot | null>(null);
  const [security, setSecurity] = useState<SecuritySnapshot | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // If Owner Lock is configured and user is not authenticated, require passkey to exit showcase mode
  const [unlockPromptOpen, setUnlockPromptOpen] = useState(false);
  const [unlockPasskey, setUnlockPasskey] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const loadDemo = useCallback(async () => {
    try {
      const [cat, sec] = await Promise.all([fetchDemoCatalog(), fetchSecurityStatus()]);
      setCatalog(cat);
      setSecurity(sec);
      if (cat.approvedProducts.length > 0 && !selectedProductId) {
        setSelectedProductId(cat.approvedProducts[0].id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.errorLoading);
    }
  }, [copy.errorLoading, selectedProductId]);

  useEffect(() => {
    void loadDemo();
  }, [loadDemo]);

  const handleRunInference = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !prompt.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const res = await runDemoInference(selectedProductId, prompt);
      setOutput(res.output);
      setLatencyMs(res.latencyMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inference unavailable');
      setOutput(null);
    } finally {
      setRunning(false);
    }
  };

  const handleReset = async () => {
    setPrompt('');
    setOutput(null);
    setLatencyMs(null);
    setError(null);
    try {
      await resetDemoSandbox();
      await loadDemo();
    } catch {
      // ignore audit failure in showcase
    }
  };

  const handleRequestExit = () => {
    if (security?.ownerLockConfigured && !security.sessionAuthenticated) {
      setUnlockPromptOpen(true);
      return;
    }
    onExitDemoMode();
  };

  const handleUnlockAndExit = async (e: FormEvent) => {
    e.preventDefault();
    setUnlockError(null);
    try {
      await loginOwnerSession({ passkey: unlockPasskey, deviceLabel: 'Owner Exit From Demo' });
      setUnlockPasskey('');
      setUnlockPromptOpen(false);
      onExitDemoMode();
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Invalid owner passkey');
    }
  };

  return (
    <div className="space-y-6">
      {/* Isolated Client Showcase Header */}
      <section className="rounded-xl bg-[#26170F] text-[#FFF8E8] border border-[#D4AF37]/50 p-5 sm:p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[#F3D989] font-mono text-xs font-bold">
              <Presentation className="h-4 w-4" aria-hidden="true" />
              <span>ISOLATED CLIENT SANDBOX</span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold">{copy.demoTitle}</h1>
            <p className="text-xs sm:text-sm text-[#FFF8E8]/80 max-w-3xl">{copy.demoSubtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void handleReset()}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#D4AF37]/40 bg-[#3B2419] hover:bg-[#523624] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              <span>{copy.demoResetBtn}</span>
            </button>

            <button
              type="button"
              onClick={handleRequestExit}
              className="min-h-[44px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>{copy.demoExitBtn}</span>
            </button>
          </div>
        </div>

        {/* Strict Isolation Guarantees */}
        <div className="pt-4 border-t border-[#D4AF37]/25 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 text-[#F3D989]">
            <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{copy.demoWeightsBlocked}</span>
          </div>
          <div className="flex items-center gap-2 text-[#F3D989]">
            <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{copy.demoArchiveBlocked}</span>
          </div>
          <div className="flex items-center gap-2 text-[#F3D989]">
            <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{copy.demoSettingsBlocked}</span>
          </div>
        </div>
      </section>

      {unlockPromptOpen && (
        <form
          onSubmit={handleUnlockAndExit}
          className="rounded-xl bg-white border-2 border-[#B8860B] p-5 space-y-3"
        >
          <div className="text-sm font-bold text-[#26170F]">{copy.demoUnlockToExit}</div>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="password"
              required
              autoComplete="off"
              value={unlockPasskey}
              onChange={(e) => setUnlockPasskey(e.target.value)}
              placeholder="••••••"
              className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-xs"
            />
            <button
              type="submit"
              className="min-h-[44px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold cursor-pointer"
            >
              {copy.secLoginSubmit}
            </button>
            <button
              type="button"
              onClick={() => setUnlockPromptOpen(false)}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#523624]/30 text-xs font-semibold cursor-pointer"
            >
              {copy.pmCancel}
            </button>
          </div>
          {unlockError && <div className="text-xs font-mono text-red-800">{unlockError}</div>}
        </form>
      )}

      {/* Approved / Released Products Only */}
      <section className="rounded-xl bg-white/85 border border-[#523624]/20 p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-base font-bold text-[#26170F]">
            <ShieldCheck className="h-5 w-5 text-[#B8860B]" aria-hidden="true" />
            <h2>{copy.demoCatalogTitle}</h2>
          </div>
          {catalog && (
            <span className="font-mono text-xs text-[#523624] tabular-nums">
              {formatTimestamp(catalog.generatedAt, locale)}
            </span>
          )}
        </div>

        {!catalog || catalog.approvedProducts.length === 0 ? (
          <div className="rounded-lg bg-[#FFF8E8] border border-[#523624]/20 p-5 text-xs text-[#523624]">
            {copy.demoCatalogEmpty}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {catalog.approvedProducts.map((prod) => {
              const selected = prod.id === selectedProductId;
              return (
                <button
                  key={prod.id}
                  type="button"
                  onClick={() => setSelectedProductId(prod.id)}
                  className={`text-start rounded-xl border p-4 space-y-2 transition-colors cursor-pointer ${
                    selected
                      ? 'bg-white border-[#B8860B] ring-1 ring-[#D4AF37]/40'
                      : 'bg-[#FFF8E8] border-[#523624]/20'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm text-[#26170F]">{prod.name}</span>
                    <span className="font-mono text-xs font-bold text-emerald-800">
                      {prod.lifecycleState}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-[#523624]">
                    {prod.productClass} · v{prod.version} · {prod.license}
                  </div>
                  <p className="text-xs text-[#3B2419]">{prod.architectureSummary}</p>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Inference Sandbox (Honest Engine Gate) */}
      <section className="rounded-xl bg-white/85 border border-[#523624]/20 p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#523624]/15 pb-3">
          <h2 className="text-base font-bold text-[#26170F]">{copy.demoInferTitle}</h2>
          {catalog && (
            <StatusIndicator
              state={
                catalog.inferenceEngine.available
                  ? 'ONLINE'
                  : (catalog.inferenceEngine.status as 'OFFLINE' | 'NOT CONFIGURED')
              }
            />
          )}
        </div>

        {catalog && !catalog.inferenceEngine.available && (
          <div className="rounded-lg bg-[#FFF8E8] border border-amber-800/30 p-3 flex items-start gap-2.5 text-xs text-amber-900 font-mono">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{catalog.inferenceEngine.detail}</span>
          </div>
        )}

        <form onSubmit={handleRunInference} className="space-y-3">
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={copy.demoPromptPlaceholder}
            className="w-full rounded-lg bg-[#FFF8E8] border border-[#523624]/25 p-3 text-xs text-[#26170F] focus:outline-2 focus:outline-[#B8860B]"
          />

          <button
            type="submit"
            disabled={running || !catalog?.inferenceEngine.available || !selectedProductId}
            className="min-h-[44px] px-4 py-2 rounded-lg bg-[#26170F] hover:bg-[#3B2419] disabled:opacity-50 text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            <span>{copy.demoRunInferBtn}</span>
          </button>
        </form>

        {error && <div className="text-xs font-mono text-red-800">{error}</div>}
        {output !== null && (
          <div className="rounded-lg bg-[#FFF8E8] border border-[#523624]/20 p-4 space-y-1 text-xs">
            <div className="font-mono text-[#523624] tabular-nums">Latency: {latencyMs} ms</div>
            <div className="text-[#26170F] whitespace-pre-wrap">{output}</div>
          </div>
        )}
      </section>
    </div>
  );
}
