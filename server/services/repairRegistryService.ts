import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import {
  inspectBinaryWeightsBuffer,
  inspectBinaryWeightsFile,
  repairBinaryWeightsFile,
} from '../ml/neuralMindEngine.ts';
import { resolveSafeRealPath, writeFileAtomic } from '../utils/fsAtomic.ts';

export type NgProductClass =
  | 'NG-BASE'
  | 'NG-DOMAIN'
  | 'NG-ADAPTED'
  | 'NG-REPAIRED'
  | 'NG-REENGINEERED'
  | 'NG-QUANTIZED'
  | 'NG-SECURED'
  | 'NG-SOFTWARE';

export type ModelLifecycleState =
  | 'IMPORTED'
  | 'INSPECTED'
  | 'READY_FOR_TRAINING'
  | 'TRAINING'
  | 'EVALUATION'
  | 'FAILED'
  | 'APPROVED'
  | 'RELEASED'
  | 'ARCHIVED';

export interface ModelProductRecord {
  id: string;
  name: string;
  productClass: NgProductClass;
  version: string;
  weightsSha256: string;
  architectureSummary: string;
  trainingSummary: string;
  evaluationSummary: string;
  license: string;
  runtimeRequirements: Record<string, unknown>;
  safetyReport: Record<string, unknown>;
  changelog: string;
  lifecycleState: ModelLifecycleState;
  qcPassedCount: number;
  qcTotalCount: number;
  createdAt: string;
  updatedAt: string;
}

const VALID_CLASSES = new Set<NgProductClass>([
  'NG-BASE',
  'NG-DOMAIN',
  'NG-ADAPTED',
  'NG-REPAIRED',
  'NG-REENGINEERED',
  'NG-QUANTIZED',
  'NG-SECURED',
  'NG-SOFTWARE',
]);

const VALID_STATES = new Set<ModelLifecycleState>([
  'IMPORTED',
  'INSPECTED',
  'READY_FOR_TRAINING',
  'TRAINING',
  'EVALUATION',
  'FAILED',
  'APPROVED',
  'RELEASED',
  'ARCHIVED',
]);

export const REQUIRED_QC_SUITES_COUNT = 10;

export function listModelProducts(db: DatabaseSync): ModelProductRecord[] {
  const rows = db
    .prepare(
      `
      SELECT
        mp.*,
        (SELECT COUNT(*) FROM qc_reports q WHERE q.product_id = mp.id AND q.result = 'PASS') AS qc_passed,
        (SELECT COUNT(*) FROM qc_reports q WHERE q.product_id = mp.id) AS qc_total
      FROM model_products mp
      ORDER BY mp.updated_at DESC
    `,
    )
    .all() as unknown as Array<{
    id: string;
    name: string;
    product_class: NgProductClass;
    version: string;
    weights_sha256: string;
    architecture_summary: string;
    training_summary: string;
    evaluation_summary: string;
    license: string;
    runtime_requirements_json: string;
    safety_report_json: string;
    changelog: string;
    lifecycle_state: ModelLifecycleState;
    qc_passed: number;
    qc_total: number;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => {
    let runtimeRequirements: Record<string, unknown> = {};
    let safetyReport: Record<string, unknown> = {};
    try {
      runtimeRequirements = JSON.parse(r.runtime_requirements_json) as Record<string, unknown>;
    } catch {
      runtimeRequirements = {};
    }
    try {
      safetyReport = JSON.parse(r.safety_report_json) as Record<string, unknown>;
    } catch {
      safetyReport = {};
    }

    return {
      id: r.id,
      name: r.name,
      productClass: r.product_class,
      version: r.version,
      weightsSha256: r.weights_sha256,
      architectureSummary: r.architecture_summary,
      trainingSummary: r.training_summary,
      evaluationSummary: r.evaluation_summary,
      license: r.license,
      runtimeRequirements,
      safetyReport,
      changelog: r.changelog,
      lifecycleState: r.lifecycle_state,
      qcPassedCount: Number(r.qc_passed ?? 0),
      qcTotalCount: Number(r.qc_total ?? 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function registerOrRepairProduct(
  db: DatabaseSync,
  input: {
    id?: string;
    name: string;
    productClass: NgProductClass;
    version: string;
    weightsSha256: string;
    architectureSummary: string;
    trainingSummary?: string;
    evaluationSummary?: string;
    license: string;
    safetyNotes?: string;
    restoreCheckpointPath?: string;
    weightsPath?: string;
    tokenizerPath?: string;
    configPath?: string;
    changelog?: string;
  },
): ModelProductRecord {
  if (!VALID_CLASSES.has(input.productClass)) {
    throw new Error(`Invalid productClass: ${input.productClass}`);
  }
  const name = input.name.trim();
  const version = input.version.trim();
  const weightsSha256 = input.weightsSha256.trim().toLowerCase();
  const architectureSummary = input.architectureSummary.trim();
  const license = input.license.trim();

  if (!name || !version || !architectureSummary || !license) {
    throw new Error('name, version, architectureSummary, and license are required');
  }
  if (!/^[a-f0-9]{64}$/.test(weightsSha256)) {
    throw new Error('weightsSha256 must be a valid 64-character lowercase SHA-256 hex digest');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());

  const validateOptionalWorkspacePath = (rawPath: string | undefined, label: string): string | null => {
    const trimmed = (rawPath ?? '').trim();
    if (!trimmed) return null;
    const check = resolveSafeRealPath(trimmed, dataDir);
    if (!check.allowed) {
      throw new Error(`Blocked: ${label} must reside inside managed data_dir.`);
    }
    return check.canonicalTarget;
  };

  const validatedRestorePath = validateOptionalWorkspacePath(input.restoreCheckpointPath, 'restoreCheckpointPath');
  const validatedWeightsPath = validateOptionalWorkspacePath(input.weightsPath, 'weightsPath');
  const validatedTokenizerPath = validateOptionalWorkspacePath(input.tokenizerPath, 'tokenizerPath');
  const validatedConfigPath = validateOptionalWorkspacePath(input.configPath, 'configPath');

  const now = new Date().toISOString();
  const safetyReport = {
    reviewedBy: 'OWNER',
    reviewedAt: now,
    notes: (input.safetyNotes ?? '').trim() || 'Safety review recorded in Trust Center',
    restoreCheckpointPath: validatedRestorePath,
  };

  if (input.id) {
    const existing = listModelProducts(db).find((p) => p.id === input.id);
    if (!existing) throw new Error(`Product not found: ${input.id}`);

    // MANDATORY GUARANTEE: Preserve immutable snapshot of pre-repair state before editing
    const backupDir = path.join(dataDir, 'repair_vault', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(
      backupDir,
      `${existing.id}_v${existing.version.replace(/[^a-zA-Z0-9._-]/g, '_')}_pre_repair_${Date.now()}.json`,
    );

    const preRepairSnapshot = {
      preservedAt: now,
      productId: existing.id,
      originalName: existing.name,
      originalClass: existing.productClass,
      originalVersion: existing.version,
      originalWeightsSha256: existing.weightsSha256,
      originalArchitecture: existing.architectureSummary,
      originalLicense: existing.license,
      originalLifecycleState: existing.lifecycleState,
      originalSafetyReport: existing.safetyReport,
    };
    const snapshotJson = JSON.stringify(preRepairSnapshot, null, 2);
    writeFileAtomic(backupFile, snapshotJson, 'utf-8');
    const backupSha256 = crypto.createHash('sha256').update(snapshotJson, 'utf-8').digest('hex');

    const prevOriginals = Array.isArray(existing.safetyReport.preservedOriginals)
      ? (existing.safetyReport.preservedOriginals as Array<Record<string, unknown>>)
      : [];

    const preservedOriginalRecord = {
      version: existing.version,
      weightsSha256: existing.weightsSha256,
      backupPath: backupFile,
      backupSha256,
      preservedAt: now,
    };

    const mergedRuntimeRequirements: Record<string, unknown> = {
      ...existing.runtimeRequirements,
      ...(validatedRestorePath ? { restoreCheckpointPath: validatedRestorePath } : {}),
      ...(validatedWeightsPath ? { weightsPath: validatedWeightsPath } : {}),
      ...(validatedTokenizerPath ? { tokenizerPath: validatedTokenizerPath } : {}),
      ...(validatedConfigPath ? { configPath: validatedConfigPath } : {}),
    };
    if (!mergedRuntimeRequirements.restoreCheckpointPath) {
      mergedRuntimeRequirements.restoreCheckpointPath = backupFile;
    }

    const mergedSafetyReport = {
      ...safetyReport,
      originalBackup: existing.safetyReport.originalBackup ?? preservedOriginalRecord,
      preservedOriginals: [...prevOriginals, preservedOriginalRecord],
      restoreCheckpointPath: validatedRestorePath || backupFile,
    };

    // Modifying weights/repair MUST invalidate stale QC passes & reset lifecycle back to EVALUATION
    db.prepare('DELETE FROM qc_reports WHERE product_id = ?').run(input.id);

    db.prepare(
      `
      UPDATE model_products
      SET name = ?, product_class = ?, version = ?, weights_sha256 = ?,
          architecture_summary = ?, training_summary = ?, evaluation_summary = ?,
          license = ?, runtime_requirements_json = ?, safety_report_json = ?, changelog = ?,
          lifecycle_state = 'EVALUATION', updated_at = ?
      WHERE id = ?
    `,
    ).run(
      name,
      input.productClass,
      version,
      weightsSha256,
      architectureSummary,
      (input.trainingSummary ?? existing.trainingSummary).trim(),
      (input.evaluationSummary ?? existing.evaluationSummary).trim(),
      license,
      JSON.stringify(mergedRuntimeRequirements),
      JSON.stringify(mergedSafetyReport),
      (input.changelog ?? existing.changelog).trim(),
      now,
      input.id,
    );

    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'REPAIR_FACTORY',
      action: 'PRESERVE_ORIGINAL_AND_REPAIR',
      target: `${input.id} -> v${version}`,
      outcome: 'PASS',
      details: {
        productClass: input.productClass,
        weightsSha256,
        preservedBackupFile: backupFile,
        backupSha256,
        staleQcInvalidated: true,
      },
    });

    return listModelProducts(db).find((p) => p.id === input.id)!;
  }

  const id = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const runtimeRequirements: Record<string, unknown> = {
    scaleTier: '1B',
    restoreCheckpointPath: validatedRestorePath,
    ...(validatedWeightsPath ? { weightsPath: validatedWeightsPath } : {}),
    ...(validatedTokenizerPath ? { tokenizerPath: validatedTokenizerPath } : {}),
    ...(validatedConfigPath ? { configPath: validatedConfigPath } : {}),
  };

  db.prepare(
    `
    INSERT INTO model_products (
      id, name, product_class, version, weights_sha256,
      architecture_summary, training_summary, evaluation_summary,
      license, runtime_requirements_json, safety_report_json, changelog,
      lifecycle_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EVALUATION', ?, ?)
  `,
  ).run(
    id,
    name,
    input.productClass,
    version,
    weightsSha256,
    architectureSummary,
    (input.trainingSummary ?? '').trim(),
    (input.evaluationSummary ?? '').trim(),
    license,
    JSON.stringify(runtimeRequirements),
    JSON.stringify(safetyReport),
    (input.changelog ?? '').trim(),
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'REPAIR_FACTORY',
    action: 'REGISTER_MODEL_PRODUCT',
    target: `${id} (${name})`,
    outcome: 'PASS',
    details: { productClass: input.productClass, version, weightsSha256 },
  });

  return listModelProducts(db).find((p) => p.id === id)!;
}

/**
 * Executes real tensor-level repair or INT8 quantization over NGWT binary weights,
 * preserves the immutable pre-repair artifact, updates weights_sha256, and invalidates stale QC.
 */
export function executeModelRepair(
  db: DatabaseSync,
  input: {
    productId: string;
    operation: 'SANITIZE_NAN_INF' | 'INT8_QUANTIZE';
    newVersion: string;
    productClass?: NgProductClass;
    license?: string;
    safetyNotes?: string;
    changelog?: string;
  },
): {
  product: ModelProductRecord;
  repairedWeightsPath: string;
  weightsSha256: string;
  operation: 'SANITIZE_NAN_INF' | 'INT8_QUANTIZE';
  nanFixedCount: number;
  dtype: 'f32' | 'i8';
} {
  const existing = listModelProducts(db).find((p) => p.id === input.productId);
  if (!existing) throw new Error(`Product not found: ${input.productId}`);

  const newVersion = input.newVersion.trim();
  if (!newVersion) throw new Error('newVersion is required');

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());

  const candidatePaths: string[] = [];
  if (typeof existing.runtimeRequirements.weightsPath === 'string') {
    candidatePaths.push(existing.runtimeRequirements.weightsPath);
  }
  if (
    typeof existing.safetyReport.originalBackup === 'object' &&
    existing.safetyReport.originalBackup !== null &&
    typeof (existing.safetyReport.originalBackup as { backupPath?: unknown }).backupPath === 'string'
  ) {
    candidatePaths.push((existing.safetyReport.originalBackup as { backupPath: string }).backupPath);
  }
  const matchingRes = db
    .prepare('SELECT file_path FROM resources WHERE sha256 = ?')
    .get(existing.weightsSha256) as { file_path: string } | undefined;
  if (matchingRes?.file_path) {
    candidatePaths.push(matchingRes.file_path);
  }

  let sourceWeightsPath = '';
  for (const cand of candidatePaths) {
    const safeCheck = resolveSafeRealPath(cand, dataDir);
    if (safeCheck.allowed && fs.existsSync(safeCheck.canonicalTarget) && fs.statSync(safeCheck.canonicalTarget).isFile()) {
      const inspection = inspectBinaryWeightsFile(safeCheck.canonicalTarget);
      if (inspection.detectedFormat === 'NGWT-V1') {
        sourceWeightsPath = safeCheck.canonicalTarget;
        break;
      }
    }
  }

  if (!sourceWeightsPath) {
    throw new Error(
      `Blocked: Product ${input.productId} lacks a mutable NGWT-V1 binary weights container inside data_dir for ${input.operation}.`,
    );
  }

  const now = new Date().toISOString();
  const backupDir = path.join(dataDir, 'repair_vault', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const preRepairSnapshotPath = path.join(
    backupDir,
    `${existing.id}_v${existing.version.replace(/[^a-zA-Z0-9._-]/g, '_')}_pre_${input.operation}_${Date.now()}.json`,
  );
  const preRepairSnapshot = {
    preservedAt: now,
    productId: existing.id,
    sourceWeightsPath,
    originalVersion: existing.version,
    originalWeightsSha256: existing.weightsSha256,
  };
  const preSnapJson = JSON.stringify(preRepairSnapshot, null, 2);
  writeFileAtomic(preRepairSnapshotPath, preSnapJson, 'utf-8');
  const backupSha256 = crypto.createHash('sha256').update(preSnapJson, 'utf-8').digest('hex');

  const repairedDir = path.join(dataDir, 'repair_vault', 'repaired', existing.id);
  fs.mkdirSync(repairedDir, { recursive: true });
  const repairedWeightsPath = path.join(
    repairedDir,
    `weights_v${newVersion.replace(/[^a-zA-Z0-9._-]/g, '_')}.ngbin`,
  );

  const repairedResult = repairBinaryWeightsFile({
    sourceWeightsPath,
    outputWeightsPath: repairedWeightsPath,
    newVersion,
    operation: input.operation,
  });

  // Preserve/update model_config.json if linked
  let updatedConfigPath =
    typeof existing.runtimeRequirements.configPath === 'string'
      ? existing.runtimeRequirements.configPath
      : null;
  if (updatedConfigPath) {
    const cfgCheck = resolveSafeRealPath(updatedConfigPath, dataDir);
    if (cfgCheck.allowed && fs.existsSync(cfgCheck.canonicalTarget)) {
      try {
        const cfgObj = JSON.parse(fs.readFileSync(cfgCheck.canonicalTarget, 'utf-8')) as Record<string, unknown>;
        cfgObj.version = newVersion;
        cfgObj.weightsFile = repairedWeightsPath;
        cfgObj.weightsSha256 = repairedResult.weightsSha256;
        cfgObj.dtype = repairedResult.dtype;
        cfgObj.repairedAt = now;
        const repairedCfgPath = path.join(repairedDir, 'model_config.json');
        writeFileAtomic(repairedCfgPath, JSON.stringify(cfgObj, null, 2), 'utf-8');
        updatedConfigPath = repairedCfgPath;
      } catch {
        // leave existing configPath untouched if unreadable
      }
    }
  }

  const nextClass: NgProductClass =
    input.productClass && VALID_CLASSES.has(input.productClass)
      ? input.productClass
      : input.operation === 'INT8_QUANTIZE'
        ? 'NG-QUANTIZED'
        : 'NG-REPAIRED';
  const nextLicense = (input.license ?? existing.license).trim() || existing.license;

  const prevOriginals = Array.isArray(existing.safetyReport.preservedOriginals)
    ? (existing.safetyReport.preservedOriginals as Array<Record<string, unknown>>)
    : [];
  const nextSafetyReport = {
    reviewedBy: 'OWNER',
    reviewedAt: now,
    notes:
      (input.safetyNotes ?? '').trim() ||
      `Executed ${input.operation} binary weight repair (${repairedResult.nanFixedCount} non-finite values fixed, dtype=${repairedResult.dtype})`,
    restoreCheckpointPath: sourceWeightsPath,
    originalBackup: existing.safetyReport.originalBackup ?? {
      version: existing.version,
      weightsSha256: existing.weightsSha256,
      backupPath: sourceWeightsPath,
      preservedAt: now,
    },
    preservedOriginals: [
      ...prevOriginals,
      {
        version: existing.version,
        weightsSha256: existing.weightsSha256,
        backupPath: preRepairSnapshotPath,
        backupSha256,
        preservedAt: now,
      },
    ],
  };

  const nextRuntimeReq: Record<string, unknown> = {
    ...existing.runtimeRequirements,
    weightsPath: repairedWeightsPath,
    weightsManifestPath: repairedWeightsPath,
    restoreCheckpointPath: sourceWeightsPath,
    hasBinaryWeights: true,
    dtype: repairedResult.dtype,
    tensorCount: repairedResult.tensorCount,
    containerParameters: repairedResult.parameterCount,
    ...(updatedConfigPath ? { configPath: updatedConfigPath } : {}),
  };

  // Invalidate any stale QC passes whenever binary weights change
  db.prepare('DELETE FROM qc_reports WHERE product_id = ?').run(existing.id);

  db.prepare(
    `
    UPDATE model_products
    SET product_class = ?, version = ?, weights_sha256 = ?,
        evaluation_summary = ?, license = ?,
        runtime_requirements_json = ?, safety_report_json = ?, changelog = ?,
        lifecycle_state = 'EVALUATION', updated_at = ?
    WHERE id = ?
  `,
  ).run(
    nextClass,
    newVersion,
    repairedResult.weightsSha256,
    `Binary repair ${input.operation} completed (${repairedResult.nanFixedCount} NaN/Inf fixed; dtype=${repairedResult.dtype})`,
    nextLicense,
    JSON.stringify(nextRuntimeReq),
    JSON.stringify(nextSafetyReport),
    (input.changelog ?? '').trim() || `v${newVersion}: ${input.operation} applied over ${sourceWeightsPath}`,
    now,
    existing.id,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'REPAIR_FACTORY',
    action: `EXECUTE_BINARY_REPAIR_${input.operation}`,
    target: `${existing.id} -> v${newVersion}`,
    outcome: 'PASS',
    details: {
      sourceWeightsPath,
      repairedWeightsPath,
      weightsSha256: repairedResult.weightsSha256,
      nanFixedCount: repairedResult.nanFixedCount,
      dtype: repairedResult.dtype,
      staleQcInvalidated: true,
    },
  });

  const updatedProduct = listModelProducts(db).find((p) => p.id === existing.id)!;
  return {
    product: updatedProduct,
    repairedWeightsPath,
    weightsSha256: repairedResult.weightsSha256,
    operation: input.operation,
    nanFixedCount: repairedResult.nanFixedCount,
    dtype: repairedResult.dtype,
  };
}

export function transitionProductLifecycle(
  db: DatabaseSync,
  productId: string,
  nextState: ModelLifecycleState,
): ModelProductRecord {
  if (!VALID_STATES.has(nextState)) {
    throw new Error(`Invalid lifecycle state: ${nextState}`);
  }
  const product = listModelProducts(db).find((p) => p.id === productId);
  if (!product) throw new Error(`Product not found: ${productId}`);

  // STRICT SAFETY GATE: Cannot approve or release any model unless all 10 QC suites passed FOR CURRENT VERSION & WEIGHTS!
  if (nextState === 'APPROVED' || nextState === 'RELEASED') {
    const passedRows = db
      .prepare("SELECT test_suite, details_json FROM qc_reports WHERE product_id = ? AND result = 'PASS'")
      .all(productId) as unknown as Array<{ test_suite: string; details_json: string }>;

    const matchedSuites = new Set<string>();
    for (const r of passedRows) {
      try {
        const d = JSON.parse(r.details_json) as { productVersion?: string; weightsSha256?: string };
        if (d.productVersion === product.version && d.weightsSha256 === product.weightsSha256) {
          matchedSuites.add(r.test_suite);
        }
      } catch {
        // ignore unparseable detail row
      }
    }

    if (matchedSuites.size < REQUIRED_QC_SUITES_COUNT) {
      recordAuditEvent(db, {
        actor: 'OWNER',
        category: 'SECURITY',
        action: 'BLOCK_UNVERIFIED_MODEL_APPROVAL',
        target: productId,
        outcome: 'BLOCKED',
        details: {
          attemptedState: nextState,
          passedSuitesForCurrentWeights: matchedSuites.size,
          requiredSuites: REQUIRED_QC_SUITES_COUNT,
        },
      });
      throw new Error(
        `Blocked: Product ${productId} passed ${matchedSuites.size}/${REQUIRED_QC_SUITES_COUNT} mandatory QC suites for current weights/version. Execute and pass all 10 Trust & QC suites before ${nextState}.`,
      );
    }

    if (nextState === 'RELEASED' && product.lifecycleState !== 'APPROVED' && product.lifecycleState !== 'RELEASED') {
      throw new Error('Blocked: Product must be APPROVED before moving to RELEASED.');
    }
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE model_products SET lifecycle_state = ?, updated_at = ? WHERE id = ?').run(
    nextState,
    now,
    productId,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'REPAIR_FACTORY',
    action: 'TRANSITION_PRODUCT_LIFECYCLE',
    target: productId,
    outcome: 'PASS',
    details: { previousState: product.lifecycleState, nextState },
  });

  return listModelProducts(db).find((p) => p.id === productId)!;
}

export function receiveExternalModelForRepair(
  db: DatabaseSync,
  input: {
    name: string;
    version: string;
    originSource: string;
    license: string;
    architectureSummary: string;
    weightsPath?: string;
    tokenizerPath?: string;
    fileName?: string;
    fileBase64?: string;
    contentText?: string;
  },
): {
  product: ModelProductRecord;
  originalBackupPath: string;
  originalSha256: string;
  inspectionReport: {
    sha256Valid: boolean;
    sizeBytes: number;
    licenseCompliant: boolean;
    hasBinaryWeights: boolean;
    detectedFormat: string;
    nonFiniteCount: number;
    warnings: string[];
  };
} {
  const name = input.name.trim();
  const version = input.version.trim() || '1.0.0';
  const originSource = input.originSource.trim() || 'EXTERNAL_REPAIR_INTAKE';
  const license = input.license.trim() || 'UNKNOWN';
  const architectureSummary = input.architectureSummary.trim();
  if (!name || !architectureSummary) {
    throw new Error('name and architectureSummary are required');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());

  let rawBuf: Buffer;
  let sourceFileName = input.fileName?.trim() || `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')}.ngbin`;

  if (input.weightsPath?.trim()) {
    const resolved = path.resolve(input.weightsPath.trim());
    const safeCheck = resolveSafeRealPath(resolved, dataDir);
    if (!safeCheck.allowed) {
      throw new Error(`Blocked: weightsPath must reside inside managed data_dir (${dataDir}).`);
    }
    if (!fs.existsSync(safeCheck.canonicalTarget) || !fs.statSync(safeCheck.canonicalTarget).isFile()) {
      throw new Error(`External model file not found on disk: ${safeCheck.canonicalTarget}`);
    }
    rawBuf = fs.readFileSync(safeCheck.canonicalTarget);
    sourceFileName = path.basename(safeCheck.canonicalTarget);
  } else if (input.fileBase64?.trim()) {
    rawBuf = Buffer.from(input.fileBase64.trim(), 'base64');
  } else if (input.contentText?.trim()) {
    rawBuf = Buffer.from(input.contentText, 'utf-8');
  } else {
    throw new Error('Provide an existing weightsPath, uploaded fileBase64, or model descriptor payload');
  }

  if (rawBuf.length === 0) {
    throw new Error('External model payload is empty');
  }

  let validatedTokenizerPath: string | null = null;
  if (input.tokenizerPath?.trim()) {
    const tokCheck = resolveSafeRealPath(input.tokenizerPath.trim(), dataDir);
    if (!tokCheck.allowed || !fs.existsSync(tokCheck.canonicalTarget)) {
      throw new Error('Supplied tokenizerPath must exist inside managed data_dir.');
    }
    validatedTokenizerPath = tokCheck.canonicalTarget;
  }

  const originalSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const originalDir = path.join(dataDir, 'repair_vault', 'originals', productId);
  fs.mkdirSync(originalDir, { recursive: true });

  const safeBaseName = path.basename(sourceFileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const originalBackupPath = path.join(originalDir, `ORIGINAL_${safeBaseName}`);
  writeFileAtomic(originalBackupPath, rawBuf);
  const verifyCopySha = crypto.createHash('sha256').update(fs.readFileSync(originalBackupPath)).digest('hex');
  if (verifyCopySha !== originalSha256) {
    throw new Error('Failed to verify immutable original copy in repair vault');
  }

  const binaryInspection = inspectBinaryWeightsBuffer(rawBuf, originalBackupPath);

  const disallowed = new Set(['', 'UNKNOWN', 'NONE', 'UNLICENSED', 'N/A']);
  const licenseCompliant = !disallowed.has(license.toUpperCase());
  const warnings: string[] = [];
  if (!licenseCompliant) warnings.push(`License '${license}' requires review before approval`);
  if (!binaryInspection.isBinaryWeights) {
    warnings.push(
      binaryInspection.reason || `Artifact format '${binaryInspection.detectedFormat}' is not verified binary weights`,
    );
  }
  if (binaryInspection.nonFiniteCount > 0) {
    warnings.push(`Detected ${binaryInspection.nonFiniteCount} NaN/Inf tensor values requiring SANITIZE_NAN_INF repair`);
  }

  const now = new Date().toISOString();
  const safetyReport = {
    reviewedBy: 'MIND_REPAIR_INTAKE',
    reviewedAt: now,
    notes: 'Original artifact preserved immutably prior to any repair or re-engineering',
    restoreCheckpointPath: originalBackupPath,
    originalBackup: {
      version,
      weightsSha256: originalSha256,
      backupPath: originalBackupPath,
      sizeBytes: rawBuf.length,
      preservedAt: now,
    },
    preservedOriginals: [
      {
        version,
        weightsSha256: originalSha256,
        backupPath: originalBackupPath,
        sizeBytes: rawBuf.length,
        preservedAt: now,
      },
    ],
  };

  const runtimeRequirements = {
    restoreCheckpointPath: originalBackupPath,
    sizeBytes: rawBuf.length,
    hasBinaryWeights: binaryInspection.isBinaryWeights,
    weightsPath: binaryInspection.isBinaryWeights ? originalBackupPath : null,
    ...(validatedTokenizerPath ? { tokenizerPath: validatedTokenizerPath } : {}),
    binaryInspection: {
      detectedFormat: binaryInspection.detectedFormat,
      tensorCount: binaryInspection.tensorCount,
      parameterCount: binaryInspection.parameterCount,
      nonFiniteCount: binaryInspection.nonFiniteCount,
    },
  };

  db.prepare(
    `
    INSERT INTO model_products (
      id, name, product_class, version, weights_sha256,
      architecture_summary, training_summary, evaluation_summary,
      license, runtime_requirements_json, safety_report_json, changelog,
      lifecycle_state, created_at, updated_at
    ) VALUES (?, ?, 'NG-BASE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INSPECTED', ?, ?)
  `,
  ).run(
    productId,
    name,
    version,
    originalSha256,
    architectureSummary,
    `External repair intake from ${originSource}`,
    `Pre-repair inspection completed (${warnings.length} warnings; format=${binaryInspection.detectedFormat})`,
    license,
    JSON.stringify(runtimeRequirements),
    JSON.stringify(safetyReport),
    `Original model preserved at ${originalBackupPath}`,
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'REPAIR_FACTORY',
    action: 'RECEIVE_AND_PRESERVE_EXTERNAL_MODEL',
    target: `${productId} -> ${originalBackupPath}`,
    outcome: warnings.length > 0 ? 'WARNING' : 'PASS',
    details: {
      originalSha256,
      sizeBytes: rawBuf.length,
      licenseCompliant,
      hasBinaryWeights: binaryInspection.isBinaryWeights,
      detectedFormat: binaryInspection.detectedFormat,
      nonFiniteCount: binaryInspection.nonFiniteCount,
      warnings,
    },
  });

  const product = listModelProducts(db).find((p) => p.id === productId)!;
  return {
    product,
    originalBackupPath,
    originalSha256,
    inspectionReport: {
      sha256Valid: true,
      sizeBytes: rawBuf.length,
      licenseCompliant,
      hasBinaryWeights: binaryInspection.isBinaryWeights,
      detectedFormat: binaryInspection.detectedFormat,
      nonFiniteCount: binaryInspection.nonFiniteCount,
      warnings,
    },
  };
}
