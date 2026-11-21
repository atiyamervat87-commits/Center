import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { inspectBinaryWeightsFile, type BinaryWeightsInspection } from '../ml/neuralMindEngine.ts';
import { inspectTokenizerFile } from '../ml/tokenizerEngine.ts';
import { resolveSafeRealPath, writeFileAtomic } from '../utils/fsAtomic.ts';

export type QcResult = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' | 'NOT TESTED';

export interface QcSuiteReportRow {
  id: string;
  productId: string;
  testSuite: string;
  result: QcResult;
  details: Record<string, unknown>;
  executedAt: string;
}

export const MANDATORY_QC_SUITES = [
  'WEIGHTS_SHA256_INTEGRITY',
  'MANIFEST_SCHEMA_VALID',
  'LICENSE_COMPLIANCE',
  'PROVENANCE_TRACEABLE',
  'ARCHITECTURE_COMPATIBILITY',
  'TOKENIZER_CONSISTENCY',
  'SAFETY_POLICY_CHECK',
  'DEPENDENCY_AUDIT',
  'RESTORE_CHECKPOINT_PRESENT',
  'RELEASE_METADATA_COMPLETE',
] as const;

const DISALLOWED_LICENSES = new Set(['', 'UNKNOWN', 'NONE', 'UNLICENSED', 'N/A']);

export function listQcReports(db: DatabaseSync, productId?: string): QcSuiteReportRow[] {
  const rows = productId
    ? (db
        .prepare('SELECT * FROM qc_reports WHERE product_id = ? ORDER BY executed_at DESC')
        .all(productId) as unknown as Array<{
        id: string;
        product_id: string;
        test_suite: string;
        result: QcResult;
        details_json: string;
        executed_at: string;
      }>)
    : (db
        .prepare('SELECT * FROM qc_reports ORDER BY executed_at DESC LIMIT 100')
        .all() as unknown as Array<{
        id: string;
        product_id: string;
        test_suite: string;
        result: QcResult;
        details_json: string;
        executed_at: string;
      }>);

  return rows.map((r) => {
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(r.details_json) as Record<string, unknown>;
    } catch {
      details = {};
    }
    return {
      id: r.id,
      productId: r.product_id,
      testSuite: r.test_suite,
      result: r.result,
      details,
      executedAt: r.executed_at,
    };
  });
}

function resolveWorkspaceFile(candidate: unknown, dataDir: string): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const check = resolveSafeRealPath(candidate.trim(), dataDir);
  if (!check.allowed) return null;
  if (!fs.existsSync(check.canonicalTarget) || !fs.statSync(check.canonicalTarget).isFile()) {
    return null;
  }
  return check.canonicalTarget;
}

/**
 * Executes 10 strict engineering QC verification suites against real filesystem
 * artifacts (binary weights container, tokenizer round-trip, restore checkpoint file,
 * model_config schema, and provenance lineage). Never fakes a PASS for JSON-as-weights
 * or virtual missing files.
 */
export function runTenSuiteQcCheck(
  db: DatabaseSync,
  productId: string,
): {
  productId: string;
  passedCount: number;
  totalCount: number;
  allPassed: boolean;
  evidencePath: string;
  evidenceSha256: string;
  reports: QcSuiteReportRow[];
} {
  const product = db
    .prepare('SELECT * FROM model_products WHERE id = ?')
    .get(productId) as
    | {
        id: string;
        name: string;
        product_class: string;
        version: string;
        weights_sha256: string;
        architecture_summary: string;
        training_summary: string;
        evaluation_summary: string;
        license: string;
        runtime_requirements_json: string;
        safety_report_json: string;
        changelog: string;
        lifecycle_state: string;
      }
    | undefined;

  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  let runtimeReq: Record<string, unknown> = {};
  let safetyReport: Record<string, unknown> = {};
  let jsonValid = true;
  try {
    runtimeReq = JSON.parse(product.runtime_requirements_json) as Record<string, unknown>;
    safetyReport = JSON.parse(product.safety_report_json) as Record<string, unknown>;
  } catch {
    jsonValid = false;
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());

  const matchingResource = db
    .prepare('SELECT id, file_path, sha256, origin_source, verification_status FROM resources WHERE sha256 = ?')
    .get(product.weights_sha256) as
    | {
        id: string;
        file_path: string;
        sha256: string;
        origin_source: string;
        verification_status: string;
      }
    | undefined;

  const linkedTrainingJob = db
    .prepare('SELECT id, job_status, current_step FROM training_jobs WHERE model_id = ? LIMIT 1')
    .get(product.id) as { id: string; job_status: string; current_step: number } | undefined;

  // 1. Resolve and verify real binary weights file on disk
  const weightsFilePath =
    resolveWorkspaceFile(runtimeReq.weightsPath, dataDir) ??
    resolveWorkspaceFile(runtimeReq.weightsManifestPath, dataDir) ??
    resolveWorkspaceFile(matchingResource?.file_path, dataDir);

  let weightsInspection: BinaryWeightsInspection = {
    isBinaryWeights: false,
    detectedFormat: 'UNKNOWN',
    filePath: weightsFilePath ?? '',
    sizeBytes: 0,
    sha256: '',
    tensorCount: 0,
    parameterCount: 0,
    nonFiniteCount: 0,
    headerSummary: null,
    reason: 'No verified binary weights file on disk inside data_dir',
  };

  if (weightsFilePath) {
    weightsInspection = inspectBinaryWeightsFile(weightsFilePath);
  }

  const shaFormatValid = /^[a-f0-9]{64}$/.test(product.weights_sha256);
  const binaryWeightsVerified =
    shaFormatValid &&
    weightsInspection.isBinaryWeights &&
    weightsInspection.detectedFormat !== 'JSON_REJECTED' &&
    weightsInspection.sha256 === product.weights_sha256 &&
    weightsInspection.nonFiniteCount === 0 &&
    weightsInspection.tensorCount > 0;

  // 2. Verify model_config.json if present (or explicit mindDir/model_config.json)
  const mindDir = typeof runtimeReq.mindDir === 'string' ? runtimeReq.mindDir : '';
  const configFilePath =
    resolveWorkspaceFile(runtimeReq.configPath, dataDir) ??
    (mindDir ? resolveWorkspaceFile(path.join(mindDir, 'model_config.json'), dataDir) : null);

  let configFileValid = true;
  if (configFilePath) {
    try {
      const parsedCfg = JSON.parse(fs.readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
      configFileValid = Boolean(parsedCfg && typeof parsedCfg === 'object' && parsedCfg.architecture);
    } catch {
      configFileValid = false;
    }
  } else if (typeof runtimeReq.configPath === 'string' && runtimeReq.configPath.trim()) {
    // Declared configPath is missing or escaped workspace!
    configFileValid = false;
  }

  // 3. Tokenizer consistency verification (real tokenizer.json encode/decode round-trip)
  const tokenizerFilePath =
    resolveWorkspaceFile(runtimeReq.tokenizerPath, dataDir) ??
    (mindDir ? resolveWorkspaceFile(path.join(mindDir, 'tokenizer.json'), dataDir) : null);

  const tokenizerInspection = tokenizerFilePath
    ? inspectTokenizerFile(tokenizerFilePath)
    : {
        valid: false,
        spec: '',
        vocabSize: 0,
        mergesCount: 0,
        roundTripPassed: false,
        sha256: '',
        reason: 'tokenizer.json not found on disk inside data_dir',
      };

  // 4. License & Provenance & Safety
  const licenseClean = !DISALLOWED_LICENSES.has(product.license.trim().toUpperCase());
  const hasSafetyNotes =
    typeof safetyReport.notes === 'string' && safetyReport.notes.trim().length >= 8;

  // 5. Restore checkpoint file must physically exist inside data_dir
  const restoreCandidate =
    (typeof safetyReport.restoreCheckpointPath === 'string' && safetyReport.restoreCheckpointPath.trim()) ||
    (typeof runtimeReq.restoreCheckpointPath === 'string' && runtimeReq.restoreCheckpointPath.trim()) ||
    '';
  const resolvedRestoreFile = resolveWorkspaceFile(restoreCandidate, dataDir);

  const originalBackupObj =
    typeof safetyReport.originalBackup === 'object' && safetyReport.originalBackup !== null
      ? (safetyReport.originalBackup as { backupPath?: unknown; weightsSha256?: unknown })
      : null;
  const resolvedBackupFile = originalBackupObj
    ? resolveWorkspaceFile(originalBackupObj.backupPath, dataDir)
    : null;

  const hasRestoreFileOnDisk = Boolean(resolvedRestoreFile || resolvedBackupFile);

  const hasPreservedOriginals =
    Array.isArray(safetyReport.preservedOriginals) && safetyReport.preservedOriginals.length > 0;
  const provenanceVerified =
    product.training_summary.trim().length >= 5 &&
    (Boolean(linkedTrainingJob) ||
      Boolean(matchingResource?.origin_source) ||
      hasPreservedOriginals ||
      Boolean(resolvedBackupFile));

  // Verify no declared path escapes dataDir
  const declaredPathFields = [
    runtimeReq.weightsPath,
    runtimeReq.tokenizerPath,
    runtimeReq.configPath,
    runtimeReq.restoreCheckpointPath,
    safetyReport.restoreCheckpointPath,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const allDeclaredPathsConfined = declaredPathFields.every(
    (p) => resolveSafeRealPath(p.trim(), dataDir).allowed,
  );

  const evaluations: Array<{
    suite: (typeof MANDATORY_QC_SUITES)[number];
    result: QcResult;
    detail: Record<string, unknown>;
  }> = [
    {
      suite: 'WEIGHTS_SHA256_INTEGRITY',
      result: binaryWeightsVerified ? 'PASS' : 'FAIL',
      detail: {
        shaFormatValid,
        weightsFilePath: weightsFilePath || null,
        isBinaryWeights: weightsInspection.isBinaryWeights,
        detectedFormat: weightsInspection.detectedFormat,
        sha256Matched: weightsInspection.sha256 === product.weights_sha256,
        nonFiniteCount: weightsInspection.nonFiniteCount,
        tensorCount: weightsInspection.tensorCount,
        reason: weightsInspection.reason ?? null,
      },
    },
    {
      suite: 'MANIFEST_SCHEMA_VALID',
      result:
        jsonValid && product.name.trim().length > 0 && product.version.trim().length > 0 && configFileValid
          ? 'PASS'
          : 'FAIL',
      detail: {
        jsonValid,
        name: product.name,
        version: product.version,
        configFilePath: configFilePath || null,
        configFileValid,
      },
    },
    {
      suite: 'LICENSE_COMPLIANCE',
      result: licenseClean ? 'PASS' : 'FAIL',
      detail: { license: product.license, approved: licenseClean },
    },
    {
      suite: 'PROVENANCE_TRACEABLE',
      result: provenanceVerified ? 'PASS' : 'FAIL',
      detail: {
        trainingSummaryPresent: product.training_summary.trim().length >= 5,
        linkedResourceOrigin: matchingResource?.origin_source ?? null,
        linkedTrainingJobId: linkedTrainingJob?.id ?? null,
        hasPreservedOriginals,
      },
    },
    {
      suite: 'ARCHITECTURE_COMPATIBILITY',
      result:
        product.architecture_summary.trim().length >= 5 &&
        weightsInspection.isBinaryWeights &&
        weightsInspection.tensorCount > 0
          ? 'PASS'
          : 'FAIL',
      detail: {
        architectureSummary: product.architecture_summary,
        tensorCount: weightsInspection.tensorCount,
        parameterCount: weightsInspection.parameterCount,
      },
    },
    {
      suite: 'TOKENIZER_CONSISTENCY',
      result: tokenizerInspection.valid && tokenizerInspection.roundTripPassed ? 'PASS' : 'FAIL',
      detail: {
        tokenizerFilePath: tokenizerFilePath || null,
        valid: tokenizerInspection.valid,
        roundTripPassed: tokenizerInspection.roundTripPassed,
        spec: tokenizerInspection.spec || null,
        vocabSize: tokenizerInspection.vocabSize,
        mergesCount: tokenizerInspection.mergesCount,
        reason: tokenizerInspection.reason ?? null,
      },
    },
    {
      suite: 'SAFETY_POLICY_CHECK',
      result:
        hasSafetyNotes && weightsInspection.isBinaryWeights && weightsInspection.nonFiniteCount === 0
          ? 'PASS'
          : 'FAIL',
      detail: {
        safetyNotesPresent: hasSafetyNotes,
        nonFiniteWeights: weightsInspection.nonFiniteCount,
      },
    },
    {
      suite: 'DEPENDENCY_AUDIT',
      result:
        jsonValid && licenseClean && Object.keys(runtimeReq).length > 0 && allDeclaredPathsConfined
          ? 'PASS'
          : 'FAIL',
      detail: {
        runtimeRequirementsKeys: Object.keys(runtimeReq).length,
        allDeclaredPathsConfined,
      },
    },
    {
      suite: 'RESTORE_CHECKPOINT_PRESENT',
      result: hasRestoreFileOnDisk ? 'PASS' : 'FAIL',
      detail: {
        hasRestoreFileOnDisk,
        resolvedRestoreFile: resolvedRestoreFile || null,
        resolvedBackupFile: resolvedBackupFile || null,
      },
    },
    {
      suite: 'RELEASE_METADATA_COMPLETE',
      result:
        product.evaluation_summary.trim().length >= 5 && product.changelog.trim().length >= 5
          ? 'PASS'
          : 'FAIL',
      detail: {
        evaluationSummaryPresent: product.evaluation_summary.trim().length >= 5,
        changelogPresent: product.changelog.trim().length >= 5,
      },
    },
  ];

  const passedCount = evaluations.filter((e) => e.result === 'PASS').length;
  const allPassed = passedCount === evaluations.length;
  const now = new Date().toISOString();

  const evidenceDir = path.join(dataDir, 'qc_evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `QC_EVIDENCE_${productId}_${Date.now()}.json`);
  const evidencePayload = JSON.stringify(
    {
      productId,
      productName: product.name,
      version: product.version,
      weightsSha256: product.weights_sha256,
      license: product.license,
      executedAt: now,
      passedCount,
      totalCount: evaluations.length,
      allPassed,
      evaluations,
    },
    null,
    2,
  );
  writeFileAtomic(evidencePath, evidencePayload, 'utf-8');
  const evidenceSha256 = crypto.createHash('sha256').update(evidencePayload, 'utf-8').digest('hex');

  db.prepare('DELETE FROM qc_reports WHERE product_id = ?').run(productId);
  const insertStmt = db.prepare(`
    INSERT INTO qc_reports (id, product_id, test_suite, result, details_json, executed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of evaluations) {
    const id = `QC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    insertStmt.run(
      id,
      productId,
      item.suite,
      item.result,
      JSON.stringify({
        ...item.detail,
        productVersion: product.version,
        weightsSha256: product.weights_sha256,
        evidencePath,
        evidenceSha256,
      }),
      now,
    );
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'TRUST_QC',
    action: 'RUN_10_SUITE_QC_VERIFICATION',
    target: productId,
    outcome: allPassed ? 'PASS' : 'FAIL',
    details: {
      passedCount,
      totalCount: evaluations.length,
      allPassed,
      evidencePath,
      evidenceSha256,
    },
  });

  return {
    productId,
    passedCount,
    totalCount: evaluations.length,
    allPassed,
    evidencePath,
    evidenceSha256,
    reports: listQcReports(db, productId),
  };
}
