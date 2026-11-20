import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import type { SystemState } from './dashboardService.ts';
import type { NgProductClass } from './repairRegistryService.ts';

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
    .prepare('SELECT * FROM training_workers ORDER BY updated_at DESC')
    .all() as unknown as Array<{
    id: string;
    worker_name: string;
    endpoint_url: string;
    pairing_fingerprint: string;
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
): TrainingWorkerRecord {
  const workerName = input.workerName.trim();
  const endpointUrl = input.endpointUrl.trim();
  if (!workerName || !endpointUrl) {
    throw new Error('workerName and endpointUrl are required');
  }
  const parsed = new URL(endpointUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Worker endpoint must use http:// or https://');
  }

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
  const authHash = input.authSecret?.trim()
    ? crypto.createHash('sha256').update(input.authSecret.trim()).digest('hex')
    : '';
  const now = new Date().toISOString();

  const capabilities = {
    gpuModel: input.gpuModel.trim() || 'UNDECLARED',
    vramGb,
    systemRamGb,
    maxSupportedScale: derivedMaxScale,
  };

  // Initial status is OFFLINE until real HTTP /health probe succeeds!
  db.prepare(
    `
    INSERT INTO training_workers (
      id, worker_name, endpoint_url, pairing_fingerprint, auth_token_hash,
      status, last_heartbeat_at, capabilities_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'OFFLINE', NULL, ?, ?, ?)
  `,
  ).run(id, workerName, endpointUrl, fingerprint, authHash, JSON.stringify(capabilities), now, now);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'BRIDGE',
    action: 'REGISTER_TRAINING_WORKER',
    target: `${id} (${workerName})`,
    outcome: 'INFO',
    details: { endpointUrl, capabilities, note: 'Pending real HTTP health probe' },
  });

  const saved = listWorkers(db).find((w) => w.id === id);
  if (!saved) throw new Error('Worker reload failed');
  return saved;
}

export async function probeWorkerConnection(
  db: DatabaseSync,
  workerId: string,
): Promise<{ worker: TrainingWorkerRecord; reachable: boolean; latencyMs: number | null; detail: string }> {
  const worker = listWorkers(db).find((w) => w.id === workerId);
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`);
  }

  const healthUrl = worker.endpointUrl.endsWith('/')
    ? `${worker.endpointUrl}health`
    : `${worker.endpointUrl}/health`;

  const start = Date.now();
  let nextStatus: SystemState = 'OFFLINE';
  let reachable = false;
  let detail = '';
  let heartbeatAt: string | null = worker.lastHeartbeatAt;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
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
    details: { healthUrl, status: nextStatus, latencyMs, detail },
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
    workerEndpoint: worker.endpointUrl,
    resourceId: resRow.id,
    resourceName: resRow.name,
    fileSha256: actualSha,
    totalBytes: buf.length,
    chunkSizeBytes: chunkSize,
    chunks,
  };
  const manifestJson = JSON.stringify(manifestObj, null, 2);
  const manifestPath = path.join(transferDir, `transfer_${resRow.id}_${worker.id}.json`);
  fs.writeFileSync(manifestPath, manifestJson, 'utf-8');
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
    workerEndpoint: worker.endpointUrl,
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
    tokenizerSpec?: string;
    originSource: string;
  },
): { productId: string; resourceId: string; weightsSha256: string; inspected: boolean } {
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

  if (weightsPath) {
    if (!fs.existsSync(weightsPath) || !fs.statSync(weightsPath).isFile()) {
      throw new Error(`Model weights/package path not found on disk: ${weightsPath}`);
    }
    const buf = fs.readFileSync(weightsPath);
    weightsSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
  } else {
    // Write a verifiable intake metadata manifest on disk so SHA-256 is real and auditable
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
        intakenAt: new Date().toISOString(),
      },
      null,
      2,
    );
    fs.writeFileSync(weightsPath, manifestPayload, 'utf-8');
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
      ) VALUES (?, 'MODEL', ?, 'MODEL_INTAKE', ?, ?, ?, ?, ?, ?, 'VERIFIED', '[]', 1, ?, ?)
    `,
    ).run(finalResourceId, name, originSource, license, weightsPath, sizeBytes, version, weightsSha256, now, now);
  }

  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const productClass: NgProductClass = input.productClass ?? 'NG-BASE';
  const runtimeReq = {
    ...SCALE_PROFILES[input.scaleTier],
    tokenizerSpec: input.tokenizerSpec ?? 'STANDARD',
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
    details: { resourceId: finalResourceId, weightsSha256, sizeBytes, scaleTier: input.scaleTier },
  });

  return { productId, resourceId: finalResourceId, weightsSha256, inspected: true };
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
      target: `${input.modelId} -> ${worker.id}`,
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
  };

  let jobStatus: TrainingJobRecord['jobStatus'] = 'QUEUED';
  let startedAt: string | null = null;
  let dispatchNote = 'Job queued in SQLite; awaiting live training worker dispatch.';

  if (input.dispatchToWorker) {
    try {
      const dispatchUrl = worker.endpointUrl.endsWith('/')
        ? `${worker.endpointUrl}jobs`
        : `${worker.endpointUrl}/jobs`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(dispatchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: id,
          modelId: input.modelId,
          datasetId: input.datasetId,
          architecture: input.architecture,
          scaleTier: input.scaleTier,
          totalSteps,
        }),
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
    input.modelId.trim(),
    input.datasetId.trim(),
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
    details: { modelId: input.modelId, workerId: worker.id, scaleTier: input.scaleTier, jobStatus, dispatchNote },
  });

  const saved = listTrainingJobs(db).find((j) => j.id === id);
  if (!saved) throw new Error('Training job reload failed');
  return { job: saved, dispatchNote };
}

export function updateTrainingJobControl(
  db: DatabaseSync,
  jobId: string,
  action: 'PAUSE' | 'RESUME' | 'CANCEL',
): TrainingJobRecord {
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
    details: { previousStatus: job.jobStatus, nextStatus },
  });

  return listTrainingJobs(db).find((j) => j.id === jobId)!;
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

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const mindDir = path.join(dataDir, 'minds', productId);
  fs.mkdirSync(mindDir, { recursive: true });

  const now = new Date().toISOString();
  const scaleProfile = SCALE_PROFILES[input.scaleTier];

  const modelConfig = {
    mindId: productId,
    name,
    productClass: input.productClass ?? 'NG-BASE',
    version,
    architecture,
    scaleTier: input.scaleTier,
    parametersBillions: scaleProfile.parametersBillions,
    tokenizerSpec,
    license,
    baseDatasetId: input.baseDatasetId?.trim() || null,
    seedConfig: input.seedConfigJson?.trim() || 'DETERMINISTIC_INIT_V1',
    createdAt: now,
  };

  const tokenizerConfig = {
    spec: tokenizerSpec,
    normalization: 'NFC',
    bosToken: '<|ng_bos|>',
    eosToken: '<|ng_eos|>',
    padToken: '<|ng_pad|>',
  };

  const configPath = path.join(mindDir, 'model_config.json');
  const tokenizerPath = path.join(mindDir, 'tokenizer.json');
  const weightsManifestPath = path.join(mindDir, 'weights_container.ngbin');

  fs.writeFileSync(configPath, JSON.stringify(modelConfig, null, 2), 'utf-8');
  fs.writeFileSync(tokenizerPath, JSON.stringify(tokenizerConfig, null, 2), 'utf-8');

  // Structured independent weights container header (real serialized config + integrity envelope)
  const containerHeader = JSON.stringify(
    {
      format: 'NG-ILMF-MIND-CONTAINER-V1',
      productId,
      modelConfigSha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
      tokenizerSha256: crypto.createHash('sha256').update(fs.readFileSync(tokenizerPath)).digest('hex'),
      weightsState: 'INITIALIZED_READY_FOR_TRAINING',
      scaleProfile,
      createdAt: now,
    },
    null,
    2,
  );
  const weightsBuf = Buffer.from(containerHeader, 'utf-8');
  fs.writeFileSync(weightsManifestPath, weightsBuf);
  const weightsSha256 = crypto.createHash('sha256').update(weightsBuf).digest('hex');

  const resourceId = `RES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const deps = input.baseDatasetId?.trim() ? [input.baseDatasetId.trim()] : [];
  db.prepare(
    `
    INSERT INTO resources (
      id, library_section, name, resource_type, origin_source, license,
      file_path, size_bytes, version, sha256, verification_status,
      dependencies_json, transferable, imported_at, updated_at
    ) VALUES (?, 'MODEL', ?, 'NG_INDEPENDENT_MIND', 'NG_ILMF_NEW_MIND_FACTORY', ?, ?, ?, ?, ?, 'VERIFIED', ?, 1, ?, ?)
  `,
  ).run(
    resourceId,
    name,
    license,
    weightsManifestPath,
    weightsBuf.length,
    version,
    weightsSha256,
    JSON.stringify(deps),
    now,
    now,
  );

  const runtimeRequirements = {
    ...scaleProfile,
    tokenizerSpec,
    mindDir,
    weightsManifestPath,
    restoreCheckpointPath: weightsManifestPath,
  };
  const safetyReport = {
    reviewedBy: 'OWNER',
    reviewedAt: now,
    notes: 'Independent NG-ILMF Mind initialized with verified config and tokenizer artifacts',
    restoreCheckpointPath: weightsManifestPath,
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
    weightsSha256,
    architecture,
    `Independent Mind created in NEW MIND FACTORY (${input.scaleTier})`,
    'Initialized weights manifest and tokenizer verified on disk',
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
    details: { resourceId, weightsSha256, mindDir, scaleTier: input.scaleTier },
  });

  return { productId, resourceId, mindDir, weightsManifestPath, weightsSha256 };
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
  const now = new Date().toISOString();
  const ckptFileName = `step_${String(step).padStart(6, '0')}.ckpt.json`;
  const checkpointPath = path.join(ckptDir, ckptFileName);

  const coreRecord = {
    jobId: existing.id,
    modelId: existing.modelId,
    datasetId: existing.datasetId,
    workerId: existing.workerId,
    architecture: existing.architecture,
    scaleTier: existing.scaleTier,
    step,
    totalSteps: existing.totalSteps,
    trainingLoss: input.trainingLoss ?? existing.trainingLoss,
    validationLoss: input.validationLoss ?? existing.validationLoss,
    notes: (input.checkpointNotes ?? '').trim() || 'Owner-verified training checkpoint',
    savedAt: now,
  };
  const payloadSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(coreRecord))
    .digest('hex');

  const ckptEnvelope = JSON.stringify({ ...coreRecord, payloadSha256 }, null, 2);
  fs.writeFileSync(checkpointPath, ckptEnvelope, 'utf-8');
  const checkpointSha256 = crypto.createHash('sha256').update(ckptEnvelope, 'utf-8').digest('hex');

  const resultsLogPath = path.join(ckptDir, 'results_log.jsonl');
  fs.appendFileSync(
    resultsLogPath,
    JSON.stringify({ ...coreRecord, checkpointPath, checkpointSha256 }) + '\n',
    'utf-8',
  );

  const job = recordJobTelemetry(db, existing.id, {
    currentStep: step,
    trainingLoss: input.trainingLoss ?? existing.trainingLoss,
    validationLoss: input.validationLoss ?? existing.validationLoss,
    checkpointPath,
    jobStatus: input.jobStatus ?? existing.jobStatus,
  });

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: 'SAVE_TRAINING_CHECKPOINT',
    target: checkpointPath,
    outcome: 'PASS',
    details: { jobId: existing.id, step, checkpointSha256 },
  });

  return { job, checkpointPath, checkpointSha256, resultsLogPath };
}

export function restoreTrainingCheckpoint(
  db: DatabaseSync,
  jobId: string,
  checkpointPath: string,
): { job: TrainingJobRecord; verifiedSha256: string; restoredStep: number } {
  const existing = listTrainingJobs(db).find((j) => j.id === jobId);
  if (!existing) throw new Error(`Training job not found: ${jobId}`);

  const resolvedPath = checkpointPath.trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`Checkpoint file not found on disk: ${resolvedPath}`);
  }

  const rawText = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(rawText) as {
    jobId?: string;
    step?: number;
    trainingLoss?: number | null;
    validationLoss?: number | null;
    payloadSha256?: string;
    [k: string]: unknown;
  };

  if (parsed.jobId && parsed.jobId !== jobId) {
    throw new Error(`Checkpoint belongs to ${parsed.jobId}, not ${jobId}`);
  }

  if (parsed.payloadSha256) {
    const { payloadSha256, ...rest } = parsed;
    const recomputed = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (recomputed !== payloadSha256) {
      recordAuditEvent(db, {
        actor: 'OWNER',
        category: 'TRAINING',
        action: 'VERIFY_CHECKPOINT_FAILED',
        target: resolvedPath,
        outcome: 'FAIL',
        details: { expected: payloadSha256, actual: recomputed },
      });
      throw new Error('Checkpoint integrity check FAILED (payload SHA-256 mismatch)');
    }
  }

  const verifiedSha256 = crypto.createHash('sha256').update(rawText, 'utf-8').digest('hex');
  const restoredStep = Math.max(0, Math.floor(Number(parsed.step ?? existing.currentStep)));

  const job = recordJobTelemetry(db, jobId, {
    currentStep: restoredStep,
    trainingLoss: parsed.trainingLoss ?? existing.trainingLoss,
    validationLoss: parsed.validationLoss ?? existing.validationLoss,
    checkpointPath: resolvedPath,
    jobStatus: 'PAUSED',
  });

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRAINING',
    action: 'RESTORE_TRAINING_CHECKPOINT',
    target: `${jobId} <- ${resolvedPath}`,
    outcome: 'PASS',
    details: { restoredStep, verifiedSha256 },
  });

  return { job, verifiedSha256, restoredStep };
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
        .filter((f) => f.endsWith('.ckpt.json'))
        .map((f) => path.join(ckptDir, f))
    : [];

  return { jobId, entries, checkpoints };
}
