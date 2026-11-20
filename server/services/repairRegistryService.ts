import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';

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

  const now = new Date().toISOString();
  const safetyReport = {
    reviewedBy: 'OWNER',
    reviewedAt: now,
    notes: (input.safetyNotes ?? '').trim() || 'Safety review recorded in Trust Center',
    restoreCheckpointPath: (input.restoreCheckpointPath ?? '').trim() || null,
  };

  if (input.id) {
    const existing = listModelProducts(db).find((p) => p.id === input.id);
    if (!existing) throw new Error(`Product not found: ${input.id}`);

    // MANDATORY GUARANTEE: Preserve immutable snapshot of pre-repair state before editing
    const config = getConfigMap(db);
    const dataDir = path.resolve(config.data_dir || process.cwd());
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
    fs.writeFileSync(backupFile, snapshotJson, 'utf-8');
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

    const mergedSafetyReport = {
      ...safetyReport,
      originalBackup: existing.safetyReport.originalBackup ?? preservedOriginalRecord,
      preservedOriginals: [...prevOriginals, preservedOriginalRecord],
      restoreCheckpointPath:
        (input.restoreCheckpointPath ?? '').trim() || backupFile,
    };

    // Modifying weights/repair resets lifecycle back to EVALUATION until QC passes again
    db.prepare(
      `
      UPDATE model_products
      SET name = ?, product_class = ?, version = ?, weights_sha256 = ?,
          architecture_summary = ?, training_summary = ?, evaluation_summary = ?,
          license = ?, safety_report_json = ?, changelog = ?,
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
      },
    });

    return listModelProducts(db).find((p) => p.id === input.id)!;
  }

  const id = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const runtimeRequirements = {
    scaleTier: '1B',
    restoreCheckpointPath: (input.restoreCheckpointPath ?? '').trim() || null,
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

  // STRICT SAFETY GATE: Cannot approve or release any model unless all 10 QC suites passed!
  if (nextState === 'APPROVED' || nextState === 'RELEASED') {
    const passedRows = db
      .prepare("SELECT COUNT(DISTINCT test_suite) AS count FROM qc_reports WHERE product_id = ? AND result = 'PASS'")
      .get(productId) as { count: number };

    if (passedRows.count < REQUIRED_QC_SUITES_COUNT) {
      recordAuditEvent(db, {
        actor: 'OWNER',
        category: 'SECURITY',
        action: 'BLOCK_UNVERIFIED_MODEL_APPROVAL',
        target: productId,
        outcome: 'BLOCKED',
        details: {
          attemptedState: nextState,
          passedSuites: passedRows.count,
          requiredSuites: REQUIRED_QC_SUITES_COUNT,
        },
      });
      throw new Error(
        `Blocked: Product ${productId} passed ${passedRows.count}/${REQUIRED_QC_SUITES_COUNT} mandatory QC suites. Execute and pass all 10 Trust & QC suites before ${nextState}.`,
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

  let rawBuf: Buffer;
  let sourceFileName = input.fileName?.trim() || `${name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')}.model.json`;

  if (input.weightsPath?.trim()) {
    const resolved = input.weightsPath.trim();
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`External model file not found on disk: ${resolved}`);
    }
    rawBuf = fs.readFileSync(resolved);
    sourceFileName = path.basename(resolved);
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

  const originalSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
  const productId = `PRD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const originalDir = path.join(dataDir, 'repair_vault', 'originals', productId);
  fs.mkdirSync(originalDir, { recursive: true });

  const originalBackupPath = path.join(originalDir, `ORIGINAL_${sourceFileName}`);
  fs.writeFileSync(originalBackupPath, rawBuf);
  const verifyCopySha = crypto.createHash('sha256').update(fs.readFileSync(originalBackupPath)).digest('hex');
  if (verifyCopySha !== originalSha256) {
    throw new Error('Failed to verify immutable original copy in repair vault');
  }

  const disallowed = new Set(['', 'UNKNOWN', 'NONE', 'UNLICENSED', 'N/A']);
  const licenseCompliant = !disallowed.has(license.toUpperCase());
  const warnings: string[] = [];
  if (!licenseCompliant) warnings.push(`License '${license}' requires review before approval`);
  if (rawBuf.length < 32) warnings.push('Very small weights/metadata payload size');

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
    `Pre-repair inspection completed (${warnings.length} warnings)`,
    license,
    JSON.stringify({ restoreCheckpointPath: originalBackupPath, sizeBytes: rawBuf.length }),
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
    details: { originalSha256, sizeBytes: rawBuf.length, licenseCompliant, warnings },
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
      warnings,
    },
  };
}
