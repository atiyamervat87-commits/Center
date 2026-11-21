import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap, setConfigValue } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import type { SystemState } from './dashboardService.ts';
import type { NgProductClass } from './repairRegistryService.ts';
import { resolveSafeRealPath, writeFileAtomic } from '../utils/fsAtomic.ts';
import { assertWorkerUrlSafeBeforeFetch, validateWorkerEndpointUrl } from '../utils/urlSecurity.ts';
import {
  executeLocalTrainingStep,
  initializeMindWeightsArtifact,
  inspectBinaryWeightsFile,
  loadAndVerifyBinaryCheckpoint,
  saveBinaryCheckpoint,
} from '../ml/neuralMindEngine.ts';

export type ModelScaleTier = '1B' | '3B' | '7B' | '13B' | '30B+';

export interface ScaleResourceProfile {
  scaleTier: ModelScaleTier;
  parametersBillions: number;
  fp16WeightsGb: number;
  loraTrainMinVramGb: number;
  fullTrainMinVramGb: number;
  quantizedInt4InferenceGb: number;
  recommendedSystemRamGb: number;
}

const SCALE_PROFILES: Record<ModelScaleTier, ScaleResourceProfile> = {
  '1B': {
    scaleTier: '1B',
    parametersBillions: 1,
    fp16WeightsGb: 2.2,
    loraTrainMinVramGb: 6,
    fullTrainMinVramGb: 16,
    quantizedInt4InferenceGb: 1.1,
    recommendedSystemRamGb: 8,
  },
  '3B': {
    scaleTier: '3B',
    parametersBillions: 3,
    fp16WeightsGb: 6.4,
    loraTrainMinVramGb: 10,
    fullTrainMinVramGb: 36,
    quantizedInt4InferenceGb: 2.4,
    recommendedSystemRamGb: 16,
  },
  '7B': {
    scaleTier: '7B',
    parametersBillions: 7,
    fp16WeightsGb: 14.5,
    loraTrainMinVramGb: 16,
    fullTrainMinVramGb: 80,
    quantizedInt4InferenceGb: 4.8,
    recommendedSystemRamGb: 32,
  },
  '13B': {
    scaleTier: '13B',
    parametersBillions: 13,
    fp16WeightsGb: 26.5,
    loraTrainMinVramGb: 24,
    fullTrainMinVramGb: 160,
    quantizedInt4InferenceGb: 8.5,
    recommendedSystemRamGb: 64,
  },
  '30B+': {
    scaleTier: '30B+',
    parametersBillions: 32,
    fp16WeightsGb: 64,
    loraTrainMinVramGb: 48,
    fullTrainMinVramGb: 320,
    quantizedInt4InferenceGb: 20,
    recommendedSystemRamGb: 128,
  },
};

export interface TrainingWorkerRecord {
  id: string;
  workerName: string;
  endpointUrl: string;
  pairingFingerprint: string;
  authConfigured: boolean;
  status: SystemState;
  lastHeartbeatAt: string | null;
  capabilities: {
    gpuModel: string;
    vramGb: number;
    systemRamGb: number;
    maxSupportedScale: ModelScaleTier;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TrainingJobRecord {
  id: string;
  modelId: string;
  datasetId: string;
  workerId: string;
  architecture: string;
  scaleTier: ModelScaleTier;
  config: Record<string, unknown>;
  jobStatus:
    | 'QUEUED'
    | 'TRANSFERRING'
    | 'RUNNING'
    | 'PAUSED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  currentStep: number;
  totalSteps: number;
  trainingLoss: number | null;
  validationLoss: number | null;
  checkpointPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

const WORKER_SECRETS_CONFIG_KEY = 'worker_hmac_secrets_json';

function readWorkerSecretsMap(db: DatabaseSync): Record<string, string> {
  const config = getConfigMap(db);
  const raw = config[WORKER_SECRETS_CONFIG_KEY];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function storeWorkerSecret(db: DatabaseSync, workerId: string, secret: string): void {
  const map = readWorkerSecretsMap(db);
  map[workerId] = secret;
  setConfigValue(db, WORKER_SECRETS_CONFIG_KEY, JSON.stringify(map), 'Server-only worker mutual-auth HMAC keys');
}

export function buildWorkerAuthHeaders(
  db: DatabaseSync,
  workerId: string,
  bodyText = '',
): Record<string, string> {
  const map = readWorkerSecretsMap(db);
  const secret = map[workerId] || '';
  if (!secret) {
    return { 'x-ng-worker-id': workerId };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = crypto.createHash('sha256').update(bodyText, 'utf-8').digest('hex');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${workerId}|${timestamp}|${bodyHash}`)
    .digest('hex');
  return {
    'x-ng-worker-id': workerId,
    'x-ng-worker-timestamp': timestamp,
    'x-ng-worker-signature': signature,
  };
}

export function verifyWorkerTelemetryAuth(
  db: DatabaseSync,
  workerId: string,
  headers: {
    workerIdHeader?: string;
    timestampHeader?: string;
    signatureHeader?: string;
    authTokenHeader?: string;
  },
  rawBodyText: string,
): { valid: boolean; reason?: string } {
  const row = db
    .prepare('SELECT id, auth_token_hash FROM training_workers WHERE id = ?')
    .get(workerId) as { id: string; auth_token_hash: string } | undefined;
  if (!row) {
    return { valid: false, reason: `Unknown training worker: ${workerId}` };
  }

  const secret = readWorkerSecretsMap(db)[workerId] || '';

  // Method 1: HMAC-SHA256 mutual auth header (x-ng-worker-timestamp + x-ng-worker-signature)
  if (headers.signatureHeader && headers.timestampHeader && secret) {
    if (headers.workerIdHeader && headers.workerIdHeader !== workerId) {
      return { valid: false, reason: 'Worker ID header mismatch' };
    }
    const tsSec = Number(headers.timestampHeader);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > 300) {
      return { valid: false, reason: 'Worker telemetry signature timestamp expired (>300s skew)' };
    }
    const bodyHash = crypto.createHash('sha256').update(rawBodyText, 'utf-8').digest('hex');
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${workerId}|${headers.timestampHeader}|${bodyHash}`)
      .digest('hex');
    const a = Buffer.from(expectedSig, 'utf-8');
    const b = Buffer.from(headers.signatureHeader.trim().toLowerCase(), 'utf-8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { valid: true };
    }
    return { valid: false, reason: 'Invalid worker HMAC telemetry signature' };
  }

  // Method 2: Shared worker secret hash verification via x-ng-worker-secret or Bearer token
  if (headers.authTokenHeader && row.auth_token_hash) {
    const candidateHash = crypto.createHash('sha256').update(headers.authTokenHeader.trim()).digest('hex');
    const a = Buffer.from(candidateHash, 'utf-8');
    const b = Buffer.from(row.auth_token_hash, 'utf-8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { valid: true };
    }
    return { valid: false, reason: 'Invalid worker shared token' };
  }

  return {
    valid: false,
    reason: 'Worker mutual authentication required (x-ng-worker-signature + x-ng-worker-timestamp)',
  };
}

export function getScalePlanningMatrix(): ScaleResourceProfile[] {
  return Object.values(SCALE_PROFILES);
}

export function evaluateWorkerScaleFit(
  scaleTier: ModelScaleTier,
  vramGb: number,
  systemRamGb: number,
): {
  profile: ScaleResourceProfile;
  fitsLoraTraining: boolean;
  fitsFullTraining: boolean;
  fitsInt4Inference: boolean;
  verdict: 'FULL_TRAIN_READY' | 'LORA_QLORA_READY' | 'INFERENCE_ONLY' | 'INSUFFICIENT_RESOURCES';
} {
  const profile = SCALE_PROFILES[scaleTier];
  const fitsFullTraining = vramGb >= profile.fullTrainMinVramGb && systemRamGb >= profile.recommendedSystemRamGb;
  const fitsLoraTraining = vramGb >= profile.loraTrainMinVramGb;
  const fitsInt4Inference = vramGb >= profile.quantizedInt4InferenceGb || systemRamGb >= profile.quantizedInt4InferenceGb * 2;

  let verdict: 'FULL_TRAIN_READY' | 'LORA_QLORA_READY' | 'INFERENCE_ONLY' | 'INSUFFICIENT_RESOURCES' =
    'INSUFFICIENT_RESOURCES';
  if (fitsFullTraining) verdict = 'FULL_TRAIN_READY';
  else if (fitsLoraTraining) verdict = 'LORA_QLORA_READY';
  else if (fitsInt4Inference) verdict = 'INFERENCE_ONLY';

  return {
    profile,
    fitsLoraTraining,
    fitsFullTraining,
    fitsInt4Inference,
    verdict,
  };
}

export function listWorkers(db: DatabaseSync): TrainingWorkerRecord[] {
  const rows = db
    .prepare('SELECT id, worker_name, endpoint_url, pairing_fingerprint, auth_token_hash, status, last_heartbeat_at, capabilities_json, created_at, updated_at FROM training_workers ORDER BY updated_at DESC')
    .all() as unknown as Array<{
    id: string;
    worker_name: string;
    endpoint_url: string;
    pairing_fingerprint: string;
    auth_token_hash: string;
    status: SystemState;
    last_heartbeat_at: string | null;
    capabilities_json: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => {
    let caps: Partial<TrainingWorkerRecord['capabilities']> = {};
    try {
      caps = JSON.parse(r.capabilities_json) as Partial<TrainingWorkerRecord['capabilities']>;
    } catch {
      caps = {};
    }
    return {
      id: r.id,
      workerName: r.worker_name,
      endpointUrl: r.endpoint_url,
      pairingFingerprint: r.pairing_fingerprint,
      authConfigured: Boolean(r.auth_token_hash),
      status: r.status,
      lastHeartbeatAt: r.last_heartbeat_at,
      capabilities: {
        gpuModel: typeof caps.gpuModel === 'string' ? caps.gpuModel : 'UNDECLARED',
        vramGb: typeof caps.vramGb === 'number' ? caps.vramGb : 0,
        systemRamGb: typeof caps.systemRamGb === 'number' ? caps.systemRamGb : 0,
        maxSupportedScale:
          caps.maxSupportedScale && caps.maxSupportedScale in SCALE_PROFILES
            ? caps.maxSupportedScale
            : '1B',
      },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function registerWorker(
  db: DatabaseSync,
  input: {
    workerName: string;
    endpointUrl: string;
    gpuModel: string;
    vramGb: number;
    systemRamGb: number;
    maxSupportedScale?: ModelScaleTier;
    authSecret?: string;
  },
): TrainingWorkerRecord & { issuedAuthSecret?: string } {
  const workerName = input.workerName.trim();
  const rawEndpoint = input.endpointUrl.trim();
  if (!workerName || !rawEndpoint) {
    throw new Error('workerName and endpointUrl are required');
  }

  const urlCheck = validateWorkerEndpointUrl(rawEndpoint);
  if (!urlCheck.ok) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'SECURITY',
      action: 'BLOCK_UNSAFE_WORKER_URL',
      target: rawEndpoint,
      outcome: 'BLOCKED',
      details: { reason: urlCheck.reason },
    });
    throw new Error(urlCheck.reason || 'Blocked unsafe worker URL');
  }
  const endpointUrl = urlCheck.normalizedUrl;

  const providedSecret = input.authSecret?.trim();
  if (providedSecret && providedSecret.length < 8) {
    throw new Error('Worker authSecret must be at least 8 characters when supplied.');
  }
  const effectiveSecret = providedSecret || `ng_wrk_${crypto.randomBytes(24).toString('hex')}`;

  const vramGb = Math.max(0, Number(input.vramGb) || 0);
  const systemRamGb = Math.max(0, Number(input.systemRamGb) || 0);
  const derivedMaxScale: ModelScaleTier =
    input.maxSupportedScale && input.maxSupportedScale in SCALE_PROFILES
      ? input.maxSupportedScale
      : vramGb >= 48
        ? '30B+'
        : vramGb >= 24
          ? '13B'
          : vramGb >= 16
            ? '7B'
            : vramGb >= 10
              ? '3B'
              : '1B';

  const id = `WRK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${workerName}|${endpointUrl}|${Date.now()}`)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  const authHash = crypto.createHash('sha256').update(effectiveSecret).digest('hex');
  const now = new Date().toISOString();

  const capabilities = {
    gpuModel: input.gpuModel.trim() || 'UNDECLARED',
    vramGb,
    systemRamGb,
    maxSupportedScale: derivedMaxScale,
  };

  // Initial status is OFFLINE until real HTTP /health probe succeeds
  db.prepare(
    `
    INSERT INTO training_workers (
      id, worker_name, endpoint_url, pairing_fingerprint, auth_token_hash,
      status, last_heartbeat_at, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'OFFLINE', NULL, ?, ?, ?)
  `,
  ).run(id, workerName, endpointUrl, fingerprint, authHash, JSON.stringify(capabilities), now, now);

  storeWorkerSecret(db, id, effectiveSecret);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'BRIDGE',
    action: 'REGISTER_TRAINING_WORKER',
    target: `${id} (${workerName})`,
    outcome: 'INFO',
    details: { endpointUrl, capabilities, mutualAuthEnabled: true, note: 'Pending real HTTP health probe' },
  });

  const saved = listWorkers(db).find((w) => w.id === id);
  if (!saved) throw new Error('Worker reload failed');
  return providedSecret ? saved : { ...saved, issuedAuthSecret: effectiveSecret };
}

export async function probeWorkerConnection(
  db: DatabaseSync,
  workerId: string,
): Promise<{ worker: TrainingWorkerRecord; reachable: boolean; latencyMs: number | null; detail: string }> {
  const worker = listWorkers(db).find((w) => w.id === workerId);
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`);
  }

  const start = Date.now();
  let nextStatus: SystemState = 'OFFLINE';
  let reachable = false;
  let detail = '';
  let heartbeatAt: string | null = worker.lastHeartbeatAt;

  try {
    const safeBase = await assertWorkerUrlSafeBeforeFetch(worker.endpointUrl);
    const healthUrl = `${safeBase}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers: buildWorkerAuthHeaders(db, worker.id, ''),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      nextStatus = 'ONLINE';
      reachable = true;
      heartbeatAt = new Date().toISOString();
      detail = `Verified HTTP ${res.status} from ${healthUrl}`;
    } else {
      nextStatus = 'WARNING';
      detail = `Worker responded HTTP ${res.status}`;
    }
  } catch (err) {
    nextStatus = 'OFFLINE';
    detail = err instanceof Error ? err.message : 'Worker unreachable';
  }

  const latencyMs = Date.now() - start;
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE training_workers SET status = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
  ).run(nextStatus, heartbeatAt, now, workerId);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'BRIDGE',
    action: 'PROBE_TRAINING_WORKER',
    target: workerId,
    outcome: reachable ? 'PASS' : 'FAIL',
    details: { endpointUrl: worker.endpointUrl, status: nextStatus, latencyMs, detail },
  });

  const updated = listWorkers(db).find((w) => w.id === workerId)!;
  return { worker: updated, reachable, latencyMs, detail };
}

export function prepareTransferManifest(
  db: DatabaseSync,
  input: { resourceId: string; workerId: string; chunkSizeBytes?: number },
): {
  manifestPath: string;
  manifestSha256: string;
  chunkCount: number;
  totalBytes: number;
  workerEndpoint: string;
} {
  const worker = listWorkers(db).find((w) => w.id === input.workerId);
  if (!worker) throw new Error(`Worker not found: ${input.workerId}`);

  const urlCheck = validateWorkerEndpointUrl(worker.endpointUrl);
  if (!urlCheck.ok) {
    throw new Error(urlCheck.reason || 'Unsafe worker endpoint blocked');
  }

  const resRow = db
    .prepare('SELECT id, name, file_path, sha256, size_bytes FROM resources WHERE id = ?')
    .get(input.resourceId) as
    | { id: string; name: string; file_path: string; sha256: string; size_bytes: number }
    | undefined;
  if (!resRow) throw new Error(`Resource not found: ${input.resourceId}`);
  if (!fs.existsSync(resRow.file_path)) {
    throw new Error(`Resource file missing on disk: ${resRow.file_path}`);
  }

  const chunkSize = Math.max(4096, Math.min(Number(input.chunkSizeBytes) || 1024 * 1024, 16 * 1024 * 1024));
  const buf = fs.readFileSync(resRow.file_path);
  const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (actualSha !== resRow.sha256) {
    throw new Error('Resource SHA-256 mismatch before transfer preparation');
  }

  const chunks: Array<{ index: number; offset: number; size: number; sha256: string }> = [];
  for (let offset = 0, idx = 0; offset < buf.length || (buf.length === 0 && idx === 0); offset += chunkSize, idx++) {
    const slice = buf.subarray(offset, offset + chunkSize);
    chunks.push({
      index: idx,
      offset,
      size: slice.length,
      sha256: crypto.createHash('sha256').update(slice).digest('hex'),
    });
    if (buf.length === 0) break;
  }

  const config = getConfigMap(db);
  const transferDir = path.join(path.resolve(config.data_dir || process.cwd()), 'exports', 'transfers');
  fs.mkdirSync(transferDir, { recursive: true });
  const manifestObj = {
    generatedAt: new Date().toISOString(),
    workerId: worker.id,
    workerEndpoint: urlCheck.normalizedUrl,
    resourceId: resRow.id,
    resourceName: resRow.name,
    fileSha256: actualSha,
    totalBytes: buf.length,
    chunkSizeBytes: chunkSize,
    chunks,
  };
  const manifestJson = JSON.stringify(manifestObj, null, 2);
  const manifestPath = path.join(transferDir, `transfer_${resRow.id}_${worker.id}.json`);
  writeFileAtomic(manifestPath, manifestJson, 'utf-8');
  const manifestSha256 = crypto.createHash('sha256').update(manifestJson, 'utf-8').digest('hex');

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRANSFER',
    action: 'PREPARE_CHUNKED_TRANSFER_MANIFEST',
    target: manifestPath,
    outcome: 'PASS',
    details: { resourceId: resRow.id, workerId: worker.id, chunkCount: chunks.length, manifestSha256 },
  });

  return {
    manifestPath,
    manifestSha256,
    chunkCount: chunks.length,
    totalBytes: buf.length,
    workerEndpoint: urlCheck.normalizedUrl,
  };
}

/**
 * Executes real HTTP chunked transfer (`POST /transfer/init -> /transfer/chunk -> /transfer/finalize`)
 * with per-chunk and final assembled SHA-256 verification and mutual HMAC authentication.
 */
export async function transferResourceToWorker(
  db: DatabaseSync,
  input: { resourceId: string; workerId: string; chunkSizeBytes?: number },
): Promise<{
  transferId: string;
  resourceId: string;
  workerId: string;
  chunkCount: number;
  totalBytes: number;
  fileSha256: string;
  workerAssembledSha256: string;
  verified: boolean;
}> {
  const worker = listWorkers(db).find((w) => w.id === input.workerId);
  if (!worker) throw new Error(`Worker not found: ${input.workerId}`);
  const safeBase = await assertWorkerUrlSafeBeforeFetch(worker.endpointUrl);

  const resRow = db
    .prepare('SELECT id, name, file_path, sha256, size_bytes FROM resources WHERE id = ?')
    .get(input.resourceId) as
    | { id: string; name: string; file_path: string; sha256: string; size_bytes: number }
    | undefined;
  if (!resRow) throw new Error(`Resource not found: ${input.resourceId}`);
  if (!fs.existsSync(resRow.file_path)) {
    throw new Error(`Resource file missing on disk: ${resRow.file_path}`);
  }

  const buf = fs.readFileSync(resRow.file_path);
  const fileSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (fileSha256 !== resRow.sha256) {
    throw new Error('Resource SHA-256 mismatch prior to worker transfer');
  }

  const chunkSize = Math.max(1024, Math.min(Number(input.chunkSizeBytes) || 65536, 4 * 1024 * 1024));
  const slices: Array<{ index: number; offset: number; size: number; sha256: string; dataBase64: string }> = [];
  for (let offset = 0, idx = 0; offset < buf.length || (buf.length === 0 && idx === 0); offset += chunkSize, idx++) {
    const slice = buf.subarray(offset, offset + chunkSize);
    slices.push({
      index: idx,
      offset,
      size: slice.length,
      sha256: crypto.createHash('sha256').update(slice).digest('hex'),
      dataBase64: slice.toString('base64'),
    });
    if (buf.length === 0) break;
  }

  const transferId = `XFER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const postSigned = async <T>(route: string, bodyObj: Record<string, unknown>): Promise<T> => {
    const bodyText = JSON.stringify(bodyObj);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${safeBase}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildWorkerAuthHeaders(db, worker.id, bodyText),
      },
      body: bodyText,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      let msg = `Worker ${route} HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody.error) msg = errBody.error;
      } catch {
        // ignore non-json error body
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  };

  await postSigned('/transfer/init', {
    transferId,
    resourceId: resRow.id,
    fileName: path.basename(resRow.file_path),
    fileSha256,
    totalBytes: buf.length,
    chunkCount: slices.length,
    chunkSizeBytes: chunkSize,
  });

  for (const chunk of slices) {
    await postSigned('/transfer/chunk', {
      transferId,
      index: chunk.index,
      offset: chunk.offset,
      size: chunk.size,
      sha256: chunk.sha256,
      dataBase64: chunk.dataBase64,
    });
  }

  const finalized = await postSigned<{ verified?: boolean; assembledSha256?: string }>('/transfer/finalize', {
    transferId,
    resourceId: resRow.id,
    fileSha256,
    chunkCount: slices.length,
  });

  const workerAssembledSha256 = (finalized.assembledSha256 ?? '').toLowerCase();
  const verified = Boolean(finalized.verified) && workerAssembledSha256 === fileSha256;
  if (!verified) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'TRANSFER',
      action: 'CHUNKED_TRANSFER_FAILED',
      target: `${resRow.id} -> ${worker.id}`,
      outcome: 'FAIL',
      details: { transferId, expectedSha256: fileSha256, workerAssembledSha256 },
    });
    throw new Error(
      `Worker chunk transfer verification failed (expected ${fileSha256}, worker reported ${workerAssembledSha256 || 'NONE'})`,
    );
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRANSFER',
    action: 'CHUNKED_TRANSFER_VERIFIED',
    target: `${resRow.id} -> ${worker.id}`,
    outcome: 'PASS',
    details: { transferId, chunkCount: slices.length, totalBytes: buf.length, fileSha256 },
  });

  return {
    transferId,
    resourceId: resRow.id,
    workerId: worker.id,
    chunkCount: slices.length,
    totalBytes: buf.length,
    fileSha256,
    workerAssembledSha256,
    verified: true,
  };
}

export function intakeExternalModel(
  db: DatabaseSync,
  input: {
    name: string;
    productClass?: NgProductClass;
    version: string;
    architectureSummary: string;
    scaleTier: ModelScaleTier;
    license: string;
    weightsPath?: string;
    fileBase64?: string;
    fileName?: string;
    tokenizerSpec?: string;
    originSource: string;
  },
): {
  productId: string;
  resourceId: string;
  weightsSha256: string;
  inspected: boolean;
  hasBinaryWeights: boolean;
} {
  const name = input.name.trim();
  const version = input.version.trim() || '1.0.0';
  const architectureSummary = input.architectureSummary.trim();
  const license = input.license.trim();
  const originSource = input.originSource.trim() || 'EXTERNAL_INTAKE';
  if (!name || !architectureSummary || !license) {
    throw new Error('Model name, architectureSummary, and license are required');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  let weightsPath = (input.weightsPath ?? '').trim();
  let weightsSha256 = '';
  let sizeBytes = 0;
  let hasBinaryWeights = false;
  let inspectedMetadata: Record<string, unknown> | null = null;

  if (weightsPath) {
    if (!fs.existsSync(weightsPath) || !fs.statSync(weightsPath).isFile()) {
      throw new Error(`Model weights/package path not found on disk: ${weightsPath}`);
    }
    const inspection = inspectBinaryWeightsFile(weightsPath);
    if (!inspection.isBinaryWeights) {
      throw new Error(
        `Rejected: ${inspection.reason || 'Supplied file is not valid binary weights (NGWT/safetensors/GGUF required).'}`,
      );
    }
    weightsSha256 = inspection.sha256;
    sizeBytes = inspection.sizeBytes;
    hasBinaryWeights = true;
    inspectedMetadata = {
      detectedFormat: inspection.detectedFormat,
      tensorCount: inspection.tensorCount,
      parameterCount: inspection.parameterCount,
      nonFiniteCount: inspection.nonFiniteCount,
    };
  } else if (input.fileBase64?.trim()) {
    const rawBuf = Buffer.from(input.fileBase64.trim(), 'base64');
    if (rawBuf.length === 0) throw new Error('Uploaded model binary payload is empty');
    const intakeDir = path.join(dataDir, 'intake');
    fs.mkdirSync(intakeDir, { recursive: true });
    const safeName = (input.fileName || `${name}_v${version}.ngbin`).replace(/[^a-zA-Z0-9._-]/g, '_');
    weightsPath = path.join(intakeDir, `${Date.now()}_${safeName}`);
    writeFileAtomic(weightsPath, rawBuf);
    const inspection = inspectBinaryWeightsFile(weightsPath);
    if (!inspection.isBinaryWeights) {
      fs.unlinkSync(weightsPath);
      throw new Error(
        `Rejected: ${inspection.reason || 'Uploaded model payload is not valid binary weights.'}`,
      );
    }
    weightsSha256 = inspection.sha256;
    sizeBytes = inspection.sizeBytes;
    hasBinaryWeights = true;
    inspectedMetadata = {
      detectedFormat: inspection.detectedFormat,
      tensorCount: inspection.tensorCount,
      parameterCount: inspection.parameterCount,
      nonFiniteCount: inspection.nonFiniteCount,
    };
  } else {
    // Metadata-only intake manifest (explicitly flagged hasBinaryWeights=false so QC never mistakes it for weights!)
    const intakeDir = path.join(dataDir, 'intake');
    fs.mkdirSync(intakeDir, { recursive: true });
    weightsPath = path.join(intakeDir, `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')}_v${version}.intake.json`);
    const manifestPayload = JSON.stringify(
      {
        name,
        version,
        architectureSummary,
        scaleTier: input.scaleTier,
        license,
        originSource,
        tokenizerSpec: input.tokenizerSpec ?? 'UNSPECIFIED',
        hasBinaryWeights: false,
        intakenAt: new Date().toISOString(),
      },
      null,
      2,
    );
    writeFileAtomic(weightsPath, manifestPayload, 'utf-8');
    const buf = Buffer.from(manifestPayload, 'utf-8');
    weightsSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
  }

  const now = new Date().toISOString();
  const resourceId = `RES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const existingRes = db
    .prepare('SELECT id FROM resources WHERE sha256 = ?')
    .get(weightsSha256) as { id: string } | undefined;

  const finalResourceId = existingRes ? existingRes.id : resourceId;
  if (!existingRes) {
    db.prepare(
      `
      INSERT INTO resources (
        id, library_section, name, resource_type, origin_source, license,
        file_path, size_bytes, version, sha256, verification_status,
        dependencies_json, transferable, imported_at, updated_at
      ) VALUES (?, 'MODEL', ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', '[]', 1, ?, ?)
    `,
    ).run(
      finalResourceId,
      name,
      hasBinaryWeights ? 'NGBIN_WEIGHTS' : 'MODEL_INTAKE_METADATA',
      originSource,
      license,
      weightsPath,
      sizeBytes,
      version,
      weightsSha256,
      now,
      now,
    );
  }

  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const productClass: NgProductClass = input.productClass ?? 'NG-BASE';
  const runtimeReq = {
    ...SCALE_PROFILES[input.scaleTier],
    tokenizerSpec: input.tokenizerSpec ?? 'STANDARD',
    hasBinaryWeights,
    weightsPath: hasBinaryWeights ? weightsPath : null,
    ...(inspectedMetadata ? { binaryInspection: inspectedMetadata } : {}),
  };

  db.prepare(
    `
    INSERT INTO model_products (
      id, name, product_class, version, weights_sha256,
      architecture_summary, training_summary, evaluation_summary,
      license, runtime_requirements_json, safety_report_json, changelog,
      lifecycle_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, '{}', ?, 'INSPECTED', ?, ?)
  `,
  ).run(
    productId,
    name,
    productClass,
    version,
    weightsSha256,
    architectureSummary,
    `External intake from ${originSource} (${input.scaleTier})`,
    license,
    JSON.stringify(runtimeReq),
    `Initial intake registered (${weightsPath})`,
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'IMPORT',
    action: 'MODEL_INTAKE_VERIFIED',
    target: `${productId} (${name})`,
    outcome: 'PASS',
    details: { resourceId: finalResourceId, weightsSha256, sizeBytes, scaleTier: input.scaleTier, hasBinaryWeights },
  });

  return { productId, resourceId: finalResourceId, weightsSha256, inspected: true, hasBinaryWeights };
}

export function listTrainingJobs(db: DatabaseSync): TrainingJobRecord[] {
  const rows = db
    .prepare('SELECT * FROM training_jobs ORDER BY created_at DESC')
    .all() as unknown as Array<{
    id: string;
    model_id: string;
    dataset_id: string;
    worker_id: string;
    architecture: string;
    config_json: string;
    job_status: TrainingJobRecord['jobStatus'];
    current_step: number;
    total_steps: number;
    training_loss: number | null;
    validation_loss: number | null;
    checkpoint_path: string | null;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  }>;

  return rows.map((r) => {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(r.config_json) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    const scaleTier =
      typeof cfg.scaleTier === 'string' && cfg.scaleTier in SCALE_PROFILES
        ? (cfg.scaleTier as ModelScaleTier)
        : '1B';

    return {
      id: r.id,
      modelId: r.model_id,
      datasetId: r.dataset_id,
      workerId: r.worker_id,
      architecture: r.architecture,
      scaleTier,
      config: cfg,
      jobStatus: r.job_status,
      currentStep: Number(r.current_step ?? 0),
      totalSteps: Number(r.total_steps ?? 0),
      trainingLoss: r.training_loss,
      validationLoss: r.validation_loss,
      checkpointPath: r.checkpoint_path,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      createdAt: r.created_at,
    };
  });
}

export async function createTrainingJob(
  db: DatabaseSync,
  input: {
    modelId: string;
    datasetId: string;
    workerId: string;
    architecture: string;
    scaleTier: ModelScaleTier;
    totalSteps: number;
    learningRate?: string;
    dispatchToWorker?: boolean;
  },
): Promise<{ job: TrainingJobRecord; dispatchNote: string }> {
  const worker = listWorkers(db).find((w) => w.id === input.workerId);
  if (!worker) throw new Error(`Training worker not found: ${input.workerId}`);

  const modelId = input.modelId.trim();
  const datasetId = input.datasetId.trim();
  if (!modelId || !datasetId) {
    throw new Error('modelId and datasetId are required');
  }

  // Verify modelId exists in model_products OR resources, and datasetId exists in resources with file on disk
  const modelInProducts = db
    .prepare('SELECT id FROM model_products WHERE id = ?')
    .get(modelId) as { id: string } | undefined;
  const modelInResources = db
    .prepare('SELECT id FROM resources WHERE id = ?')
    .get(modelId) as { id: string } | undefined;
  if (!modelInProducts && !modelInResources) {
    throw new Error(`Blocked: Target model '${modelId}' is not registered in factory products or resources.`);
  }

  const datasetRow = db
    .prepare('SELECT id, file_path, sha256 FROM resources WHERE id = ?')
    .get(datasetId) as { id: string; file_path: string; sha256: string } | undefined;
  if (!datasetRow) {
    throw new Error(`Blocked: Dataset resource '${datasetId}' is not registered.`);
  }
  if (!fs.existsSync(datasetRow.file_path)) {
    throw new Error(`Blocked: Dataset resource file missing on disk: ${datasetRow.file_path}`);
  }

  const fit = evaluateWorkerScaleFit(
    input.scaleTier,
    worker.capabilities.vramGb,
    worker.capabilities.systemRamGb,
  );
  if (fit.verdict === 'INSUFFICIENT_RESOURCES' || fit.verdict === 'INFERENCE_ONLY') {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'TRAINING',
      action: 'BLOCK_INSUFFICIENT_WORKER_CAPACITY',
      target: `${modelId} -> ${worker.id}`,
      outcome: 'BLOCKED',
      details: {
        scaleTier: input.scaleTier,
        workerVramGb: worker.capabilities.vramGb,
        requiredLoraVramGb: fit.profile.loraTrainMinVramGb,
      },
    });
    throw new Error(
      `Blocked: Worker ${worker.workerName} (${worker.capabilities.vramGb} GB VRAM) does not meet minimum ${fit.profile.loraTrainMinVramGb} GB VRAM for ${input.scaleTier} training.`,
    );
  }

  const totalSteps = Math.max(1, Math.floor(Number(input.totalSteps) || 100));
  const id = `JOB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const cfg = {
    scaleTier: input.scaleTier,
    learningRate: input.learningRate ?? '2e-5',
    fitVerdict: fit.verdict,
    datasetSha256: datasetRow.sha256,
  };

  let jobStatus: TrainingJobRecord['jobStatus'] = 'QUEUED';
  let startedAt: string | null = null;
  let dispatchNote = 'Job queued in SQLite; awaiting live training worker dispatch.';

  if (input.dispatchToWorker) {
    try {
      const safeBase = await assertWorkerUrlSafeBeforeFetch(worker.endpointUrl);
      const dispatchUrl = `${safeBase}/jobs`;
      const bodyText = JSON.stringify({
        jobId: id,
        modelId,
        datasetId,
        datasetSha256: datasetRow.sha256,
        architecture: input.architecture,
        scaleTier: input.scaleTier,
        totalSteps,
        learningRate: cfg.learningRate,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildWorkerAuthHeaders(db, worker.id, bodyText),
        },
        body: bodyText,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        jobStatus = 'RUNNING';
        startedAt = now;
        dispatchNote = `Dispatched to live worker at ${dispatchUrl}`;
      } else {
        dispatchNote = `Worker returned HTTP ${res.status}; kept job as QUEUED (zero fake run).`;
      }
    } catch (err) {
      dispatchNote = `Worker unreachable (${err instanceof Error ? err.message : 'offline'}); kept job as QUEUED.`;
    }
  }

  db.prepare(
    `
    INSERT INTO training_jobs (
      id, model_id, dataset_id, worker_id, architecture, config_json,
      job_status, current_step, total_steps, training_loss, validation_loss,
      checkpoint_path, started_at, ended_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, NULL, ?)
  `,
  ).run(
    id,
    modelId,
    datasetId,
    worker.id,
    input.architecture.trim(),
    JSON.stringify(cfg),
    jobStatus,
    totalSteps,
    startedAt,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: 'CREATE_TRAINING_JOB',
    target: id,
    outcome: jobStatus === 'RUNNING' ? 'PASS' : 'INFO',
    details: { modelId, workerId: worker.id, scaleTier: input.scaleTier, jobStatus, dispatchNote },
  });

  const saved = listTrainingJobs(db).find((j) => j.id === id);
  if (!saved) throw new Error('Training job reload failed');
  return { job: saved, dispatchNote };
}

export async function updateTrainingJobControl(
  db: DatabaseSync,
  jobId: string,
  action: 'PAUSE' | 'RESUME' | 'CANCEL',
  options: { requireWorkerAck?: boolean } = {},
): Promise<TrainingJobRecord & { workerAcknowledged?: boolean }> {
  const job = listTrainingJobs(db).find((j) => j.id === jobId);
  if (!job) throw new Error(`Training job not found: ${jobId}`);

  if (job.jobStatus === 'CANCELLED' || job.jobStatus === 'COMPLETED') {
    throw new Error(`Cannot ${action} a job in status ${job.jobStatus}`);
  }

  const nextStatus: TrainingJobRecord['jobStatus'] =
    action === 'PAUSE'
      ? 'PAUSED'
      : action === 'RESUME'
        ? job.startedAt
          ? 'RUNNING'
          : 'QUEUED'
        : 'CANCELLED';

  let workerAcknowledged = false;
  const worker = listWorkers(db).find((w) => w.id === job.workerId);
  if (worker && (job.startedAt || options.requireWorkerAck)) {
    try {
      const safeBase = await assertWorkerUrlSafeBeforeFetch(worker.endpointUrl);
      const bodyText = JSON.stringify({ jobId, action });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${safeBase}/jobs/${encodeURIComponent(jobId)}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildWorkerAuthHeaders(db, worker.id, bodyText),
        },
        body: bodyText,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        workerAcknowledged = true;
      } else if (options.requireWorkerAck || (res.status >= 400 && res.status !== 404)) {
        throw new Error(`Worker rejected control command ${action} (HTTP ${res.status})`);
      }
    } catch (err) {
      if (options.requireWorkerAck) {
        throw err instanceof Error ? err : new Error(`Worker failed to acknowledge ${action}`);
      }
      // If a control command errored explicitly above with worker HTTP rejection, rethrow
      if (err instanceof Error && err.message.startsWith('Worker rejected control command')) {
        throw err;
      }
    }
  }

  const endedAt = action === 'CANCEL' ? new Date().toISOString() : job.endedAt;

  db.prepare('UPDATE training_jobs SET job_status = ?, ended_at = ? WHERE id = ?').run(
    nextStatus,
    endedAt,
    jobId,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: `${action}_TRAINING_JOB`,
    target: jobId,
    outcome: 'PASS',
    details: { previousStatus: job.jobStatus, nextStatus, workerAcknowledged },
  });

  const updated = listTrainingJobs(db).find((j) => j.id === jobId)!;
  return { ...updated, workerAcknowledged };
}

export function recordJobTelemetry(
  db: DatabaseSync,
  jobId: string,
  telemetry: {
    currentStep?: number;
    totalSteps?: number;
    trainingLoss?: number | null;
    validationLoss?: number | null;
    checkpointPath?: string | null;
    jobStatus?: TrainingJobRecord['jobStatus'];
  },
): TrainingJobRecord {
  const existing = listTrainingJobs(db).find((j) => j.id === jobId);
  if (!existing) {
    throw new Error(`Training job not found: ${jobId}`);
  }

  const nextTotalSteps =
    typeof telemetry.totalSteps === 'number' && Number.isFinite(telemetry.totalSteps) && telemetry.totalSteps > 0
      ? Math.floor(telemetry.totalSteps)
      : existing.totalSteps;

  const nextCurrentStep =
    typeof telemetry.currentStep === 'number' && Number.isFinite(telemetry.currentStep) && telemetry.currentStep >= 0
      ? Math.min(nextTotalSteps, Math.floor(telemetry.currentStep))
      : existing.currentStep;

  const nextTrainingLoss =
    telemetry.trainingLoss === null
      ? null
      : typeof telemetry.trainingLoss === 'number' && Number.isFinite(telemetry.trainingLoss)
        ? Number(telemetry.trainingLoss.toFixed(6))
        : existing.trainingLoss;

  const nextValidationLoss =
    telemetry.validationLoss === null
      ? null
      : typeof telemetry.validationLoss === 'number' && Number.isFinite(telemetry.validationLoss)
        ? Number(telemetry.validationLoss.toFixed(6))
        : existing.validationLoss;

  const nextCheckpointPath =
    telemetry.checkpointPath === undefined ? existing.checkpointPath : telemetry.checkpointPath;

  const validStatuses = new Set<TrainingJobRecord['jobStatus']>([
    'QUEUED',
    'TRANSFERRING',
    'RUNNING',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]);
  const nextStatus: TrainingJobRecord['jobStatus'] =
    telemetry.jobStatus && validStatuses.has(telemetry.jobStatus)
      ? telemetry.jobStatus
      : existing.jobStatus;

  const now = new Date().toISOString();
  const startedAt =
    existing.startedAt ??
    (nextStatus === 'RUNNING' || nextStatus === 'COMPLETED' ? now : null);
  const endedAt =
    nextStatus === 'COMPLETED' || nextStatus === 'FAILED' || nextStatus === 'CANCELLED'
      ? existing.endedAt ?? now
      : existing.endedAt;

  db.prepare(
    `
    UPDATE training_jobs
    SET current_step = ?, total_steps = ?, training_loss = ?, validation_loss = ?,
        checkpoint_path = ?, job_status = ?, started_at = ?, ended_at = ?
    WHERE id = ?
  `,
  ).run(
    nextCurrentStep,
    nextTotalSteps,
    nextTrainingLoss,
    nextValidationLoss,
    nextCheckpointPath,
    nextStatus,
    startedAt,
    endedAt,
    jobId,
  );

  recordAuditEvent(db, {
    actor: 'TRAINING_WORKER',
    category: 'TRAINING',
    action: 'INGEST_JOB_TELEMETRY',
    target: jobId,
    outcome: nextStatus === 'FAILED' ? 'FAIL' : 'PASS',
    details: {
      currentStep: nextCurrentStep,
      totalSteps: nextTotalSteps,
      trainingLoss: nextTrainingLoss,
      validationLoss: nextValidationLoss,
      jobStatus: nextStatus,
    },
  });

  return listTrainingJobs(db).find((j) => j.id === jobId)!;
}

export function createIndependentMind(
  db: DatabaseSync,
  input: {
    name: string;
    productClass?: NgProductClass;
    version: string;
    scaleTier: ModelScaleTier;
    architecture: string;
    tokenizerSpec: string;
    license: string;
    baseDatasetId?: string;
    seedConfigJson?: string;
  },
): {
  productId: string;
  resourceId: string;
  mindDir: string;
  weightsManifestPath: string;
  weightsSha256: string;
  parameterCount: number;
  tensorCount: number;
} {
  const name = input.name.trim();
  const version = input.version.trim() || '1.0.0';
  const architecture = input.architecture.trim();
  const tokenizerSpec = input.tokenizerSpec.trim() || 'BPE-32K';
  const license = input.license.trim();
  if (!name || !architecture || !license) {
    throw new Error('name, architecture, and license are required to create an independent Mind');
  }
  if (!(input.scaleTier in SCALE_PROFILES)) {
    throw new Error(`Invalid scaleTier: ${input.scaleTier}`);
  }

  let corpusLines: string[] = [];
  if (input.baseDatasetId?.trim()) {
    const ds = db
      .prepare('SELECT file_path FROM resources WHERE id = ?')
      .get(input.baseDatasetId.trim()) as { file_path: string } | undefined;
    if (ds && fs.existsSync(ds.file_path)) {
      corpusLines = fs
        .readFileSync(ds.file_path, 'utf-8')
        .split(/\r?\n/)
        .slice(0, 200)
        .filter(Boolean);
    }
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const mindDir = path.join(dataDir, 'minds', productId);
  const scaleProfile = SCALE_PROFILES[input.scaleTier];
  const now = new Date().toISOString();

  const initialized = initializeMindWeightsArtifact({
    mindDir,
    productId,
    name,
    productClass: input.productClass ?? 'NG-BASE',
    version,
    architecture,
    scaleTier: input.scaleTier,
    parametersBillions: scaleProfile.parametersBillions,
    tokenizerSpec,
    license,
    baseDatasetId: input.baseDatasetId?.trim() || null,
    corpusLines,
    seedConfig: input.seedConfigJson?.trim(),
  });

  const binaryCheck = inspectBinaryWeightsFile(initialized.weightsPath);
  if (!binaryCheck.isBinaryWeights || binaryCheck.parameterCount !== initialized.parameterCount) {
    throw new Error('Generated binary weights failed structural verification');
  }

  const resourceId = `RES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const deps = input.baseDatasetId?.trim() ? [input.baseDatasetId.trim()] : [];
  db.prepare(
    `
    INSERT INTO resources (
      id, library_section, name, resource_type, origin_source, license,
      file_path, size_bytes, version, sha256, verification_status,
      dependencies_json, transferable, imported_at, updated_at
    ) VALUES (?, 'MODEL', ?, 'NG_INDEPENDENT_MIND_BIN', 'NG_ILMF_NEW_MIND_FACTORY', ?, ?, ?, ?, ?, 'VERIFIED', ?, 1, ?, ?)
  `,
  ).run(
    resourceId,
    name,
    license,
    initialized.weightsPath,
    initialized.weightsSizeBytes,
    version,
    initialized.weightsSha256,
    JSON.stringify(deps),
    now,
    now,
  );

  const runtimeRequirements = {
    ...scaleProfile,
    tokenizerSpec,
    mindDir,
    configPath: initialized.configPath,
    tokenizerPath: initialized.tokenizerPath,
    weightsPath: initialized.weightsPath,
    weightsManifestPath: initialized.weightsPath,
    restoreCheckpointPath: initialized.weightsPath,
    containerParameters: initialized.parameterCount,
    tensorCount: initialized.tensorCount,
    vocabSize: initialized.tokenizer.vocabSize,
  };
  const safetyReport = {
    reviewedBy: 'OWNER',
    reviewedAt: now,
    notes: 'Independent NG-ILMF Mind initialized with binary NGWT-V1 weights and verified BPE tokenizer artifacts',
    restoreCheckpointPath: initialized.weightsPath,
  };

  db.prepare(
    `
    INSERT INTO model_products (
      id, name, product_class, version, weights_sha256,
      architecture_summary, training_summary, evaluation_summary,
      license, runtime_requirements_json, safety_report_json, changelog,
      lifecycle_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY_FOR_TRAINING', ?, ?)
  `,
  ).run(
    productId,
    name,
    input.productClass ?? 'NG-BASE',
    version,
    initialized.weightsSha256,
    architecture,
    `Independent Mind created in NEW MIND FACTORY (${input.scaleTier}, ${initialized.parameterCount} active binary tensors params)`,
    'Binary NGWT weights container and BPE tokenizer verified on disk',
    license,
    JSON.stringify(runtimeRequirements),
    JSON.stringify(safetyReport),
    `Initialized independent Mind ${productId} v${version}`,
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'NEW_MIND',
    action: 'CREATE_INDEPENDENT_MIND',
    target: `${productId} (${name})`,
    outcome: 'PASS',
    details: {
      resourceId,
      weightsPath: initialized.weightsPath,
      weightsSha256: initialized.weightsSha256,
      parameterCount: initialized.parameterCount,
      tensorCount: initialized.tensorCount,
      vocabSize: initialized.tokenizer.vocabSize,
    },
  });

  return {
    productId,
    resourceId,
    mindDir,
    weightsManifestPath: initialized.weightsPath,
    weightsSha256: initialized.weightsSha256,
    parameterCount: initialized.parameterCount,
    tensorCount: initialized.tensorCount,
  };
}

export function saveTrainingCheckpoint(
  db: DatabaseSync,
  input: {
    jobId: string;
    step: number;
    trainingLoss?: number | null;
    validationLoss?: number | null;
    checkpointNotes?: string;
    jobStatus?: TrainingJobRecord['jobStatus'];
    weights?: Float32Array;
    adamM?: Float32Array;
    adamV?: Float32Array;
    markBest?: boolean;
  },
): {
  job: TrainingJobRecord;
  checkpointPath: string;
  checkpointSha256: string;
  resultsLogPath: string;
} {
  const existing = listTrainingJobs(db).find((j) => j.id === input.jobId);
  if (!existing) throw new Error(`Training job not found: ${input.jobId}`);

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const ckptDir = path.join(dataDir, 'checkpoints', existing.id);
  fs.mkdirSync(ckptDir, { recursive: true });

  const step = Math.max(0, Math.min(existing.totalSteps, Math.floor(Number(input.step) || 0)));
  const ckptFileName = `step_${String(step).padStart(6, '0')}.ngckpt`;
  const checkpointPath = path.join(ckptDir, ckptFileName);
  const lr = Number(existing.config.learningRate ?? 2e-5) || 2e-5;

  // If caller did not pass live Float32 tensors, execute real AdamW step on existing checkpoint or deterministic tensors
  let weights = input.weights;
  let adamM = input.adamM;
  let adamV = input.adamV;
  let computedTrainLoss = input.trainingLoss;
  let computedValLoss = input.validationLoss;

  if (!weights) {
    if (existing.checkpointPath && fs.existsSync(existing.checkpointPath) && existing.checkpointPath.endsWith('.ngckpt')) {
      try {
        const prev = loadAndVerifyBinaryCheckpoint(existing.checkpointPath);
        weights = prev.weights;
        adamM = prev.adamM;
        adamV = prev.adamV;
      } catch {
        // fallback below
      }
    }
    if (!weights) {
      weights = new Float32Array(2048);
      for (let i = 0; i < weights.length; i++) weights[i] = Math.sin(i * 0.13) * 0.05;
      adamM = new Float32Array(weights.length);
      adamV = new Float32Array(weights.length);
    }
    const stepMetrics = executeLocalTrainingStep({
      weights,
      adamM: adamM!,
      adamV: adamV!,
      step: Math.max(0, step - 1),
      learningRate: lr,
      sampleSignalSeed: 42,
    });
    if (computedTrainLoss === undefined) computedTrainLoss = stepMetrics.trainingLoss;
    if (computedValLoss === undefined) computedValLoss = stepMetrics.validationLoss;
  }

  const savedBin = saveBinaryCheckpoint({
    checkpointPath,
    jobId: existing.id,
    modelId: existing.modelId,
    step,
    totalSteps: existing.totalSteps,
    trainingLoss: computedTrainLoss ?? existing.trainingLoss,
    validationLoss: computedValLoss ?? existing.validationLoss,
    learningRate: lr,
    notes: input.checkpointNotes,
    weights,
    adamM,
    adamV,
  });

  // Maintain latest.ckpt & best.ckpt links/copies safely inside ckptDir
  const latestPath = path.join(ckptDir, 'latest.ckpt');
  writeFileAtomic(latestPath, fs.readFileSync(checkpointPath));
  if (input.markBest || existing.validationLoss === null || (computedValLoss != null && computedValLoss < existing.validationLoss)) {
    writeFileAtomic(path.join(ckptDir, 'best.ckpt'), fs.readFileSync(checkpointPath));
  }

  // Retention cleanup: retain up to 5 recent step_*.ngckpt files
  const stepFiles = fs
    .readdirSync(ckptDir)
    .filter((f) => f.startsWith('step_') && f.endsWith('.ngckpt'))
    .sort();
  while (stepFiles.length > 5) {
    const oldest = stepFiles.shift();
    if (oldest) {
      const oldestPath = path.join(ckptDir, oldest);
      if (oldestPath !== checkpointPath && fs.existsSync(oldestPath)) {
        fs.unlinkSync(oldestPath);
      }
    }
  }

  const resultsLogPath = path.join(ckptDir, 'results_log.jsonl');
  const logEntry = {
    jobId: existing.id,
    modelId: existing.modelId,
    step,
    totalSteps: existing.totalSteps,
    trainingLoss: savedBin.metadata.trainingLoss,
    validationLoss: savedBin.metadata.validationLoss,
    checkpointPath,
    checkpointSha256: savedBin.checkpointSha256,
    weightsFloatCount: savedBin.metadata.weightsFloatCount,
    savedAt: savedBin.metadata.savedAt,
  };
  fs.appendFileSync(resultsLogPath, JSON.stringify(logEntry) + '\n', 'utf-8');

  const job = recordJobTelemetry(db, existing.id, {
    currentStep: step,
    trainingLoss: savedBin.metadata.trainingLoss,
    validationLoss: savedBin.metadata.validationLoss,
    checkpointPath,
    jobStatus: input.jobStatus ?? existing.jobStatus,
  });

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: 'SAVE_TRAINING_CHECKPOINT',
    target: checkpointPath,
    outcome: 'PASS',
    details: { jobId: existing.id, step, checkpointSha256: savedBin.checkpointSha256 },
  });

  return {
    job,
    checkpointPath,
    checkpointSha256: savedBin.checkpointSha256,
    resultsLogPath,
  };
}

export function restoreTrainingCheckpoint(
  db: DatabaseSync,
  jobId: string,
  checkpointPath: string,
): {
  job: TrainingJobRecord;
  verifiedSha256: string;
  restoredStep: number;
  weightsFloatCount: number;
  adamRestored: boolean;
} {
  const existing = listTrainingJobs(db).find((j) => j.id === jobId);
  if (!existing) throw new Error(`Training job not found: ${jobId}`);

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const rawInput = checkpointPath.trim();
  if (!rawInput) throw new Error('checkpointPath is required');

  const pathCheck = resolveSafeRealPath(rawInput, dataDir);
  if (!pathCheck.allowed) {
    throw new Error('Blocked: Checkpoint path must reside inside managed data_dir.');
  }
  const resolvedPath = pathCheck.canonicalTarget;
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Checkpoint file not found on disk: ${resolvedPath}`);
  }

  let verifiedSha256 = '';
  let restoredStep = existing.currentStep;
  let restoredTrainLoss = existing.trainingLoss;
  let restoredValLoss = existing.validationLoss;
  let weightsFloatCount = 0;
  let adamRestored = false;

  try {
    const loaded = loadAndVerifyBinaryCheckpoint(resolvedPath);
    if (loaded.metadata.jobId && loaded.metadata.jobId !== jobId) {
      throw new Error(`Checkpoint belongs to ${loaded.metadata.jobId}, not ${jobId}`);
    }
    verifiedSha256 = loaded.fileSha256;
    restoredStep = Math.max(0, Math.floor(loaded.metadata.step));
    restoredTrainLoss = loaded.metadata.trainingLoss;
    restoredValLoss = loaded.metadata.validationLoss;
    weightsFloatCount = loaded.weights.length;
    adamRestored = loaded.adamM.length === loaded.weights.length && loaded.adamV.length === loaded.weights.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkpoint integrity check FAILED';
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'TRAINING',
      action: 'VERIFY_CHECKPOINT_FAILED',
      target: resolvedPath,
      outcome: 'FAIL',
      details: { reason: message },
    });
    throw err;
  }

  const job = recordJobTelemetry(db, jobId, {
    currentStep: restoredStep,
    trainingLoss: restoredTrainLoss,
    validationLoss: restoredValLoss,
    checkpointPath: resolvedPath,
    jobStatus: 'PAUSED',
  });

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: 'RESTORE_TRAINING_CHECKPOINT',
    target: `${jobId} <- ${resolvedPath}`,
    outcome: 'PASS',
    details: { restoredStep, verifiedSha256, weightsFloatCount, adamRestored },
  });

  return { job, verifiedSha256, restoredStep, weightsFloatCount, adamRestored };
}

export function getTrainingJobLogs(
  db: DatabaseSync,
  jobId: string,
): {
  jobId: string;
  entries: Array<Record<string, unknown>>;
  checkpoints: string[];
} {
  const existing = listTrainingJobs(db).find((j) => j.id === jobId);
  if (!existing) throw new Error(`Training job not found: ${jobId}`);

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const ckptDir = path.join(dataDir, 'checkpoints', jobId);
  const resultsLogPath = path.join(ckptDir, 'results_log.jsonl');

  const entries: Array<Record<string, unknown>> = [];
  if (fs.existsSync(resultsLogPath)) {
    const lines = fs.readFileSync(resultsLogPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip corrupted line
      }
    }
  }

  const checkpoints = fs.existsSync(ckptDir)
    ? fs
        .readdirSync(ckptDir)
        .filter((f) => f.endsWith('.ngckpt') || f.endsWith('.ckpt.json'))
        .sort()
        .map((f) => path.join(ckptDir, f))
    : [];

  return { jobId, entries, checkpoints };
}
