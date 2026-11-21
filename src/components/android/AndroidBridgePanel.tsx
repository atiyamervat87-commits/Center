import { useState } from 'react';
import {
  CheckCircle2,
  FolderOpen,
  PowerOff,
  ShieldCheck,
  Smartphone,
  Unlink,
} from 'lucide-react';
import { t } from '../../i18n/translations';
import type { AndroidBridgeDiagnostics, Locale } from '../../types/commandCenter';
import {
  getNativeAndroidDiagnostics,
  isNativeAndroidWrapperAvailable,
  launchAndroidDocumentTreePicker,
  revokeNativeSafUri,
  runNativeSafSha256ProbeAsync,
  signNativeAttestationChallenge,
  verifyNativeSafUri,
  type SafSha256ProbeResult,
} from '../../bridge/androidBridge';
import {
  requestAndroidBridgeChallenge,
  revokeAndroidSafPermission,
  submitAndroidBridgeAttestation,
} from '../../services/apiClient';

interface AndroidBridgePanelProps {
  locale: Locale;
  diagnostics: AndroidBridgeDiagnostics;
  onUpdated: () => Promise<void>;
}

export function AndroidBridgePanel({
  locale,
  diagnostics,
  onUpdated,
}: AndroidBridgePanelProps) {
  const copy = t(locale);
  const nativeAvailable = isNativeAndroidWrapperAvailable();

  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);
  const [safProbe, setSafProbe] = useState<SafSha256ProbeResult | null>(null);

  const submitSignedAttestation = async (
    nativeDiag: NonNullable<ReturnType<typeof getNativeAndroidDiagnostics>>,
    safUri: string,
    permCheck: { readable?: boolean; writable?: boolean; revoked?: boolean; authorized?: boolean },
    probeResult: SafSha256ProbeResult | null,
  ) => {
    const ch = await requestAndroidBridgeChallenge();
    const signed = signNativeAttestationChallenge(
      ch.challenge,
      safUri,
      probeResult?.expectedSha256,
    );
    if (!signed?.proofSignature) {
      throw new Error('Native Android APK bridge failed to sign server attestation challenge.');
    }
    await submitAndroidBridgeAttestation({
      isNativeAndroid: nativeDiag.isNativeAndroid,
      manufacturer: nativeDiag.manufacturer,
      model: nativeDiag.model,
      androidRelease: nativeDiag.androidRelease,
      sdkInt: nativeDiag.sdkInt,
      termuxPackageInstalled: nativeDiag.termuxPackageInstalled,
      safUri,
      persistedRead: Boolean(permCheck.readable),
      persistedWrite: Boolean(permCheck.writable),
      revoked: Boolean(permCheck.revoked || !permCheck.authorized),
      safProbeReport: probeResult,
      challengeId: ch.challengeId,
      challenge: ch.challenge,
      proofSignature: signed.proofSignature,
    });
  };

  const handlePickArchiveFolder = async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const pickerResult = await launchAndroidDocumentTreePicker();
      if (!pickerResult.authorized || !pickerResult.uri) {
        setStatusMessage({
          type: 'warn',
          text: pickerResult.reason || 'Folder picker did not return an authorized content:// URI.',
        });
        return;
      }

      const nativeDiag = getNativeAndroidDiagnostics();
      if (!nativeDiag || !nativeDiag.isNativeAndroid) {
        setStatusMessage({
          type: 'err',
          text: 'Native Android diagnostics unavailable; refusing to forge attestation.',
        });
        return;
      }

      const probeResult = await runNativeSafSha256ProbeAsync(pickerResult.uri);
      setSafProbe(probeResult);

      await submitSignedAttestation(nativeDiag, pickerResult.uri, pickerResult, probeResult);

      await onUpdated();
      setStatusMessage({
        type: probeResult.storageReady ? 'ok' : 'err',
        text: probeResult.storageReady
          ? `SD_READ_WRITE_VERIFIED (${pickerResult.uri})`
          : probeResult.failureReason || `SAF Probe State: ${probeResult.state}`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Android SAF picker failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyExistingSaf = async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const targetUri = diagnostics.safUri;
      if (!nativeAvailable) {
        setStatusMessage({
          type: 'warn',
          text: copy.androidWrapperMissing,
        });
        return;
      }

      const nativeDiag = getNativeAndroidDiagnostics();
      if (!nativeDiag || !nativeDiag.isNativeAndroid || !targetUri) {
        setStatusMessage({
          type: 'warn',
          text: 'No native Android SAF URI available to verify.',
        });
        return;
      }

      const permCheck = verifyNativeSafUri(targetUri);
      const probeResult = permCheck.authorized
        ? await runNativeSafSha256ProbeAsync(targetUri)
        : null;
      if (probeResult) setSafProbe(probeResult);

      await submitSignedAttestation(nativeDiag, targetUri, permCheck, probeResult);

      await onUpdated();
    } catch (err) {
      setStatusMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'SAF verification failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeSaf = async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      if (nativeAvailable && diagnostics.safUri) {
        revokeNativeSafUri(diagnostics.safUri);
      }
      await revokeAndroidSafPermission();
      setSafProbe(null);
      await onUpdated();
      setStatusMessage({
        type: 'warn',
        text: 'Persisted SAF URI authorization revoked.',
      });
    } catch (err) {
      setStatusMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to revoke SAF URI',
      });
    } finally {
      setBusy(false);
    }
  };

  const flagEntries: Array<{ key: keyof AndroidBridgeDiagnostics['flags']; value: boolean }> = [
    { key: 'HOST_ONLY', value: diagnostics.flags.HOST_ONLY },
    { key: 'ANDROID_CONNECTED', value: diagnostics.flags.ANDROID_CONNECTED },
    { key: 'TERMUX_CONNECTED', value: diagnostics.flags.TERMUX_CONNECTED },
    { key: 'SD_AUTHORIZED', value: diagnostics.flags.SD_AUTHORIZED },
    { key: 'SD_READ_WRITE_VERIFIED', value: diagnostics.flags.SD_READ_WRITE_VERIFIED },
  ];

  return (
    <section className="rounded-xl bg-white/85 border border-[#523624]/25 p-5 sm:p-6 space-y-5">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 border-b border-[#523624]/15 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-base font-bold text-[#26170F]">
            <Smartphone className="h-5 w-5 text-[#B8860B]" aria-hidden="true" />
            <h2>{copy.androidBridgeTitle}</h2>
          </div>
          <p className="text-xs text-[#523624] max-w-3xl">{copy.androidBridgeSubtitle}</p>
        </div>

        <div className="font-mono text-xs font-semibold shrink-0">
          {nativeAvailable ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-800">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <span>{copy.androidWrapperPresent}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-amber-800">
              <PowerOff className="h-4 w-4" aria-hidden="true" />
              <span>HOST_ONLY</span>
            </span>
          )}
        </div>
      </div>

      {/* Exact 5 Diagnostic Flags */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-[#3B2419]">{copy.androidDiagnosticFlagsTitle}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {flagEntries.map((item) => {
            const isPositive =
              item.key === 'HOST_ONLY' ? !item.value : item.value;
            return (
              <div
                key={item.key}
                className="rounded-lg bg-[#FFF8E8] border border-[#523624]/20 px-3 py-2.5 flex items-center justify-between gap-2"
              >
                <span className="font-mono text-[11px] font-semibold text-[#26170F] truncate">
                  {item.key}
                </span>
                <span
                  className={`font-mono text-xs font-bold ${
                    item.key === 'HOST_ONLY'
                      ? item.value
                        ? 'text-amber-800'
                        : 'text-emerald-800'
                      : isPositive
                        ? 'text-emerald-800'
                        : 'text-[#523624]'
                  }`}
                >
                  {item.value ? 'TRUE' : 'FALSE'}
                </span>
              </div>
            );
          })}
        </div>
        <div className="text-xs font-mono text-[#523624] pt-1">
          {nativeAvailable ? copy.androidWrapperPresent : copy.androidWrapperMissing} ·{' '}
          {diagnostics.diagnosticNote}
        </div>
      </div>

      {/* Persisted content:// URI Display */}
      <div className="space-y-1 text-xs">
        <div className="font-semibold text-[#3B2419]">{copy.androidSafUriLabel}</div>
        <div className="font-mono text-[#26170F] break-all bg-[#FFF8E8] border border-[#523624]/15 rounded-lg px-3 py-2">
          {diagnostics.safUri || copy.notAvailable}
        </div>
      </div>

      {/* Actions: ACTION_OPEN_DOCUMENT_TREE, Verify, Revoke */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handlePickArchiveFolder()}
          className="min-h-[44px] px-4 py-2 rounded-lg bg-[#26170F] hover:bg-[#3B2419] disabled:opacity-60 text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          <span>{copy.androidPickFolderBtn}</span>
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void handleVerifyExistingSaf()}
          className="min-h-[44px] px-4 py-2 rounded-lg border border-[#523624]/30 bg-[#FFF8E8] hover:bg-[#F3D989]/30 text-[#26170F] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          <span>{copy.androidVerifySafBtn}</span>
        </button>

        {diagnostics.safUri && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRevokeSaf()}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-red-800/35 text-red-900 hover:bg-red-50 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
          >
            <Unlink className="h-4 w-4" aria-hidden="true" />
            <span>{copy.androidRevokeSafBtn}</span>
          </button>
        )}
      </div>

      {statusMessage && (
        <div
          className={`text-xs font-mono px-3 py-2 rounded-lg border ${
            statusMessage.type === 'ok'
              ? 'border-emerald-800/30 text-emerald-900 bg-emerald-50/60'
              : statusMessage.type === 'warn'
                ? 'border-amber-800/30 text-amber-900 bg-amber-50/60'
                : 'border-red-800/30 text-red-900 bg-red-50/60'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {safProbe && (
        <div className="rounded-lg bg-[#FFF8E8] border border-[#523624]/20 p-3 text-xs font-mono space-y-1">
          <div>
            SAF SHA-256 Probe: {safProbe.state} · Matched: {String(safProbe.contentMatched)} · Cleanup: {String(safProbe.cleanupCompleted)}
          </div>
          {safProbe.actualSha256 && <div className="break-all">SHA-256: {safProbe.actualSha256}</div>}
          {safProbe.failureReason && <div className="text-red-800">{safProbe.failureReason}</div>}
        </div>
      )}
    </section>
  );
}
