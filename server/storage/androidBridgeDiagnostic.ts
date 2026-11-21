import crypto from 'node:crypto';
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
  challengeId?: string;
  challengeVerified?: boolean;
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

interface StoredChallenge {
  id: string;
  challenge: string;
  expiresAt: string;
  used: boolean;
}

const CHALLENGE_CONFIG_KEY = 'android_attestation_challenges_json';

export function isValidContentSafUri(uri: string): boolean {
  return uri.trim().startsWith('content://');
}

export function issueAndroidAttestationChallenge(db: DatabaseSync): {
  challengeId: string;
  challenge: string;
  expiresAt: string;
} {
  const config = getConfigMap(db);
  let existing: StoredChallenge[] = [];
  if (config[CHALLENGE_CONFIG_KEY]) {
    try {
      const parsed = JSON.parse(config[CHALLENGE_CONFIG_KEY]) as StoredChallenge[];
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
  }

  const nowMs = Date.now();
  const active = existing
    .filter((c) => !c.used && new Date(c.expiresAt).getTime() > nowMs)
    .slice(-9);

  const challengeId = `ACH-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const challenge = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(nowMs + 5 * 60 * 1000).toISOString();

  active.push({ id: challengeId, challenge, expiresAt, used: false });
  setConfigValue(db, CHALLENGE_CONFIG_KEY, JSON.stringify(active), 'Single-use Android bridge attestation challenges');

  return { challengeId, challenge, expiresAt };
}

function consumeAndVerifyAndroidChallenge(
  db: DatabaseSync,
  payload: {
    challengeId?: string;
    challenge?: string;
    proofSignature?: string;
    model: string;
    sdkInt: number;
    safUri: string;
    expectedSha256?: string;
  },
): boolean {
  const config = getConfigMap(db);
  let list: StoredChallenge[] = [];
  if (config[CHALLENGE_CONFIG_KEY]) {
    try {
      const parsed = JSON.parse(config[CHALLENGE_CONFIG_KEY]) as StoredChallenge[];
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }

  const matchIdx = list.findIndex(
    (c) => c.id === payload.challengeId && !c.used,
  );
  if (matchIdx === -1) {
    throw new Error('Rejected: Unknown, expired, or already-consumed Android attestation challengeId.');
  }

  const entry = list[matchIdx];
  if (new Date(entry.expiresAt).getTime() <= Date.now()) {
    throw new Error('Rejected: Android attestation challenge expired. Request a new challenge.');
  }

  if (!payload.challenge) {
    throw new Error('Rejected: Challenge nonce mismatch.');
  }
  const a = Buffer.from(entry.challenge, 'utf-8');
  const b = Buffer.from(payload.challenge.trim(), 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Rejected: Challenge nonce mismatch.');
  }

  const expectedProofMessage = `${payload.model}|${payload.sdkInt}|${payload.safUri}|${payload.expectedSha256 ?? ''}|${entry.challenge}`;
  const expectedSig = crypto
    .createHmac('sha256', entry.challenge)
    .update(expectedProofMessage)
    .digest('hex');

  const suppliedSig = (payload.proofSignature ?? '').trim().toLowerCase();
  const sigBufA = Buffer.from(expectedSig, 'utf-8');
  const sigBufB = Buffer.from(suppliedSig, 'utf-8');
  if (sigBufA.length !== sigBufB.length || !crypto.timingSafeEqual(sigBufA, sigBufB)) {
    throw new Error('Rejected: Invalid Android bridge HMAC challenge signature.');
  }

  // Mark challenge as consumed (anti-replay)
  list[matchIdx] = { ...entry, used: true };
  const retained = list.filter((c) => new Date(c.expiresAt).getTime() > Date.now()).slice(-10);
  setConfigValue(db, CHALLENGE_CONFIG_KEY, JSON.stringify(retained));
  return true;
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

  const ANDROID_CONNECTED = osAndroidPresent || Boolean(attestation?.isNativeAndroid);
  const TERMUX_CONNECTED =
    osTermuxPresent || Boolean(ANDROID_CONNECTED && attestation?.termuxPackageInstalled);

  const SD_AUTHORIZED =
    ANDROID_CONNECTED &&
    safUriValidScheme &&
    !permissionRevoked &&
    Boolean(attestation?.persistedRead) &&
    Boolean(attestation?.persistedWrite);

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
  payload: Partial<AndroidNativeAttestation> & {
    challengeId?: string;
    challenge?: string;
    proofSignature?: string;
  },
  options: { requireChallenge?: boolean } = {},
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

  const model = (payload.model ?? 'Unknown Android').trim();
  let challengeVerified = false;
  if (options.requireChallenge || payload.challengeId || payload.challenge || payload.proofSignature) {
    challengeVerified = consumeAndVerifyAndroidChallenge(db, {
      challengeId: payload.challengeId,
      challenge: payload.challenge,
      proofSignature: payload.proofSignature,
      model,
      sdkInt: payload.sdkInt,
      safUri,
      expectedSha256: payload.safProbeReport?.expectedSha256,
    });
  }

  const normalized: AndroidNativeAttestation = {
    isNativeAndroid: true,
    manufacturer: (payload.manufacturer ?? '').trim(),
    model,
    androidRelease: (payload.androidRelease ?? '').trim(),
    sdkInt: payload.sdkInt,
    termuxPackageInstalled: Boolean(payload.termuxPackageInstalled),
    safUri,
    persistedRead: Boolean(payload.persistedRead),
    persistedWrite: Boolean(payload.persistedWrite),
    revoked: Boolean(payload.revoked),
    challengeId: payload.challengeId,
    challengeVerified,
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
      challengeVerified,
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
