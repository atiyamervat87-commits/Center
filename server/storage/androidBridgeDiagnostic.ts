import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap, setConfigValue } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';

export interface AndroidSafProbeAttestation {
  isNativeAndroidExecution: boolean;
  uri: string;
  testFileName?: string;
  state: string;
  storageReady: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  contentMatched: boolean;
  cleanupCompleted: boolean;
  failureReason?: string;
  verifiedAt?: string;
}

export interface AndroidNativeAttestation {
  isNativeAndroid: boolean;
  manufacturer?: string;
  model: string;
  androidRelease: string;
  sdkInt: number;
  termuxPackageInstalled: boolean;
  safUri: string;
  persistedRead: boolean;
  persistedWrite: boolean;
  revoked: boolean;
  safProbeReport?: AndroidSafProbeAttestation | null;
  attestedAt: string;
}

export interface AndroidBridgeDiagnostics {
  flags: {
    HOST_ONLY: boolean;
    ANDROID_CONNECTED: boolean;
    TERMUX_CONNECTED: boolean;
    SD_AUTHORIZED: boolean;
    SD_READ_WRITE_VERIFIED: boolean;
  };
  runtimeHost: string;
  nativeBridgeDetectedOnServer: boolean;
  safUri: string;
  safUriValidScheme: boolean;
  permissionRevoked: boolean;
  attestation: AndroidNativeAttestation | null;
  diagnosticNote: string;
}

export function isValidContentSafUri(uri: string): boolean {
  return uri.trim().startsWith('content://');
}

export function computeAndroidBridgeDiagnostics(
  config: Record<string, string>,
): AndroidBridgeDiagnostics {
  const osAndroidPresent =
    Boolean(process.env.ANDROID_ROOT) || fs.existsSync('/system/build.prop');
  const osTermuxPresent =
    Boolean(process.env.TERMUX_VERSION) || fs.existsSync('/data/data/com.termux');

  let attestation: AndroidNativeAttestation | null = null;
  if (config.android_native_attestation_json) {
    try {
      const parsed = JSON.parse(
        config.android_native_attestation_json,
      ) as AndroidNativeAttestation;
      if (parsed && parsed.isNativeAndroid === true && typeof parsed.sdkInt === 'number') {
        attestation = parsed;
      }
    } catch {
      attestation = null;
    }
  }

  const safUri = (attestation?.safUri || config.android_saf_uri || '').trim();
  const safUriValidScheme = isValidContentSafUri(safUri);
  const permissionRevoked = Boolean(attestation?.revoked);

  // ANDROID_CONNECTED requires real Android OS runtime OR verified native Android Wrapper attestation
  const ANDROID_CONNECTED = osAndroidPresent || Boolean(attestation?.isNativeAndroid);
  const TERMUX_CONNECTED =
    osTermuxPresent || Boolean(ANDROID_CONNECTED && attestation?.termuxPackageInstalled);

  // SD_AUTHORIZED requires ANDROID_CONNECTED + content:// URI + persisted R/W + not revoked
  const SD_AUTHORIZED =
    ANDROID_CONNECTED &&
    safUriValidScheme &&
    !permissionRevoked &&
    Boolean(attestation?.persistedRead) &&
    Boolean(attestation?.persistedWrite);

  // SD_READ_WRITE_VERIFIED requires real native SAF SHA-256 read/write/compare/cleanup test
  const safProbe = attestation?.safProbeReport;
  const SD_READ_WRITE_VERIFIED =
    SD_AUTHORIZED &&
    Boolean(safProbe) &&
    safProbe?.isNativeAndroidExecution === true &&
    safProbe?.uri === safUri &&
    safProbe?.storageReady === true &&
    safProbe?.contentMatched === true &&
    safProbe?.cleanupCompleted === true &&
    Boolean(safProbe?.expectedSha256) &&
    safProbe?.expectedSha256 === safProbe?.actualSha256;

  const HOST_ONLY = !ANDROID_CONNECTED && !TERMUX_CONNECTED;

  let diagnosticNote = '';
  if (HOST_ONLY) {
    diagnosticNote =
      'Running strictly inside Host Linux/Node environment. No native Android APK bridge or Termux session is connected.';
  } else if (ANDROID_CONNECTED && !SD_AUTHORIZED) {
    diagnosticNote = permissionRevoked
      ? 'Android device connected, but SAF URI permission was revoked or missing.'
      : 'Android device connected, awaiting ACTION_OPEN_DOCUMENT_TREE content:// URI authorization.';
  } else if (SD_AUTHORIZED && !SD_READ_WRITE_VERIFIED) {
    diagnosticNote =
      'SAF URI authorized, awaiting native SHA-256 read/write/compare/delete verification.';
  } else if (SD_READ_WRITE_VERIFIED) {
    diagnosticNote =
      'Native Android SAF URI verified with real SHA-256 read/write/cleanup cycle.';
  }

  return {
    flags: {
      HOST_ONLY,
      ANDROID_CONNECTED,
      TERMUX_CONNECTED,
      SD_AUTHORIZED,
      SD_READ_WRITE_VERIFIED,
    },
    runtimeHost: `${process.platform} ${process.arch} · Node ${process.version}`,
    nativeBridgeDetectedOnServer: osAndroidPresent,
    safUri,
    safUriValidScheme,
    permissionRevoked,
    attestation,
    diagnosticNote,
  };
}

export function recordNativeAndroidAttestation(
  db: DatabaseSync,
  payload: Partial<AndroidNativeAttestation>,
): AndroidBridgeDiagnostics {
  if (payload.isNativeAndroid !== true || typeof payload.sdkInt !== 'number' || payload.sdkInt < 29) {
    throw new Error(
      'Rejected: Android attestation requires genuine native Android runtime (isNativeAndroid=true, sdkInt>=29). Host simulation is not permitted.',
    );
  }

  const safUri = (payload.safUri ?? '').trim();
  if (safUri && !isValidContentSafUri(safUri)) {
    throw new Error(
      'Rejected: Raw filesystem path strings (e.g. /storage/...) are not valid SAF authorization. Only content:// URIs from ACTION_OPEN_DOCUMENT_TREE are accepted.',
    );
  }

  const normalized: AndroidNativeAttestation = {
    isNativeAndroid: true,
    manufacturer: (payload.manufacturer ?? '').trim(),
    model: (payload.model ?? 'Unknown Android').trim(),
    androidRelease: (payload.androidRelease ?? '').trim(),
    sdkInt: payload.sdkInt,
    termuxPackageInstalled: Boolean(payload.termuxPackageInstalled),
    safUri,
    persistedRead: Boolean(payload.persistedRead),
    persistedWrite: Boolean(payload.persistedWrite),
    revoked: Boolean(payload.revoked),
    safProbeReport: payload.safProbeReport ?? null,
    attestedAt: new Date().toISOString(),
  };

  setConfigValue(db, 'android_native_attestation_json', JSON.stringify(normalized));
  if (safUri && !normalized.revoked) {
    setConfigValue(db, 'android_saf_uri', safUri);
  }
  if (normalized.revoked) {
    setConfigValue(db, 'archive_location_confirmed', 'false');
  }

  const diagnostics = computeAndroidBridgeDiagnostics(getConfigMap(db));

  if (diagnostics.flags.SD_READ_WRITE_VERIFIED) {
    setConfigValue(db, 'selected_archive_provider', 'android_saf');
    setConfigValue(db, 'archive_location_confirmed', 'true');
  }

  recordAuditEvent(db, {
    actor: 'ANDROID_BRIDGE',
    category: 'ANDROID_SAF',
    action: normalized.revoked
      ? 'SAF_URI_PERMISSION_REVOKED'
      : diagnostics.flags.SD_READ_WRITE_VERIFIED
        ? 'ANDROID_SAF_SHA256_VERIFIED'
        : 'ANDROID_BRIDGE_ATTESTATION',
    target: safUri || `${normalized.model} (API ${normalized.sdkInt})`,
    outcome: normalized.revoked
      ? 'WARNING'
      : diagnostics.flags.SD_READ_WRITE_VERIFIED
        ? 'PASS'
        : 'INFO',
    details: {
      flags: diagnostics.flags,
      model: normalized.model,
      sdkInt: normalized.sdkInt,
    },
  });

  return diagnostics;
}

export function revokeAndroidSafAuthorization(db: DatabaseSync): AndroidBridgeDiagnostics {
  const existingConfig = getConfigMap(db);
  const previousUri = existingConfig.android_saf_uri || '';

  setConfigValue(db, 'android_saf_uri', '');
  setConfigValue(db, 'archive_location_confirmed', 'false');

  if (existingConfig.android_native_attestation_json) {
    try {
      const prev = JSON.parse(
        existingConfig.android_native_attestation_json,
      ) as AndroidNativeAttestation;
      prev.revoked = true;
      prev.persistedRead = false;
      prev.persistedWrite = false;
      prev.safProbeReport = null;
      setConfigValue(db, 'android_native_attestation_json', JSON.stringify(prev));
    } catch {
      setConfigValue(db, 'android_native_attestation_json', '');
    }
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'ANDROID_SAF',
    action: 'REVOKE_SAF_URI_PERMISSION',
    target: previousUri || 'NONE',
    outcome: 'INFO',
    details: { revoked: true },
  });

  return computeAndroidBridgeDiagnostics(getConfigMap(db));
}
