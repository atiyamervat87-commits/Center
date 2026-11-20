import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getConfigMap, setConfigValue } from '../server/db/database.ts';
import {
  archiveResourceToSmartArchive,
  awaitBackgroundIntegrityCheck,
  deleteResourceSafely,
  getResourceLibraryIntegrityStatus,
  processAndBuildDatasetPackage,
  registerResource,
  startBackgroundResourceIntegrityCheck,
  verifyArchiveIntegrityBatch,
} from '../server/services/dataFactoryService.ts';
import {
  createIndependentMind,
  createTrainingJob,
  getTrainingJobLogs,
  registerWorker,
  restoreTrainingCheckpoint,
  saveTrainingCheckpoint,
  updateTrainingJobControl,
} from '../server/services/mindFactoryService.ts';
import {
  receiveExternalModelForRepair,
  registerOrRepairProduct,
  transitionProductLifecycle,
} from '../server/services/repairRegistryService.ts';
import { runTenSuiteQcCheck } from '../server/services/trustQcService.ts';
import {
  buildCertifiedDeliveryPackage,
  verifyDeliveryPackageIntegrity,
} from '../server/services/ngIpService.ts';
import { createProject, linkResourceToProject, unlinkResourceFromProject } from '../server/services/projectService.ts';
import { runProviderIntegrityTest } from '../server/storage/storageProbe.ts';
import { getMasterDashboardSnapshot } from '../server/services/dashboardService.ts';
import { listAuditLogs } from '../server/audit/auditService.ts';

function setupIsolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-exec-'));
  const dbPath = path.join(dir, 'ng_ilmf_exec.sqlite');
  const db = new DatabaseSync(dbPath);
  const schemaSql = fs.readFileSync(
    path.resolve(process.cwd(), 'server', 'db', 'schema.sql'),
    'utf-8',
  );
  db.exec(schemaSql);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)',
  );
  stmt.run('data_dir', dir, '', now);
  stmt.run('sd_archive_path', '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE', '', now);
  stmt.run('termux_prefix', '/data/data/com.termux/files/usr', '', now);
  stmt.run('termux_shared_path', '/data/data/com.termux/files/home/storage/shared', '', now);
  stmt.run('android_saf_uri', '', '', now);
  stmt.run('android_native_attestation_json', '', '', now);
  stmt.run('selected_archive_provider', 'external_sd', '', now);
  stmt.run('archive_location_confirmed', 'false', '', now);
  stmt.run('last_storage_verification_json', '', '', now);
  stmt.run('bridge_endpoint', '', '', now);
  stmt.run('perm_export_requires_auth', 'false', '', now);
  stmt.run('perm_delete_requires_auth', 'false', '', now);
  stmt.run('perm_pairing_requires_auth', 'false', '', now);
  return { db, dir, dbPath };
}

test('1. SQLite WAL integrity: journal_mode=wal, FKs enabled, transaction commit/rollback, recovery after reopen', () => {
  const { db, dir, dbPath } = setupIsolatedDb();
  try {
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(mode.journal_mode.toLowerCase(), 'wal');

    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1);

    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as unknown as Array<{ name: string }>;
    const tableSet = new Set(tables.map((t) => t.name));
    for (const reqTable of [
      'system_config',
      'audit_logs',
      'projects',
      'resources',
      'project_resources',
      'archive_entries',
      'training_workers',
      'training_jobs',
      'model_products',
      'qc_reports',
      'delivery_packages',
      'owner_sessions',
    ]) {
      assert.ok(tableSet.has(reqTable), `Missing required table ${reqTable}`);
    }

    // Transaction rollback check
    db.exec('BEGIN');
    db.prepare(
      'INSERT INTO audit_logs (id, actor, category, action, target, outcome, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('AUD-ROLLBACK', 'TEST', 'DB', 'TX_ROLLBACK', 'tmp', 'INFO', '{}', new Date().toISOString());
    db.exec('ROLLBACK');
    const rolledBack = db.prepare('SELECT id FROM audit_logs WHERE id = ?').get('AUD-ROLLBACK');
    assert.equal(rolledBack, undefined);

    // Transaction commit + reopen recovery check
    db.exec('BEGIN');
    db.prepare(
      'INSERT INTO audit_logs (id, actor, category, action, target, outcome, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('AUD-COMMIT', 'TEST', 'DB', 'TX_COMMIT', 'tmp', 'PASS', '{}', new Date().toISOString());
    db.exec('COMMIT');
    db.close();

    const reopened = new DatabaseSync(dbPath);
    reopened.exec('PRAGMA foreign_keys = ON;');
    const persisted = reopened.prepare('SELECT id, outcome FROM audit_logs WHERE id = ?').get('AUD-COMMIT') as {
      id: string;
      outcome: string;
    };
    assert.equal(persisted.id, 'AUD-COMMIT');
    assert.equal(persisted.outcome, 'PASS');
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2-4. Real SHA-256 deduplication across different filenames, 4 resource types, and Project + Training deletion block', async () => {
  const { db, dir } = setupIsolatedDb();
  try {
    const sampleBytes = Buffer.from('{"text":"Arabic Sovereign NLP Dataset Row"}\n', 'utf-8');
    const fileA = path.join(dir, 'dataset_original_name.jsonl');
    const fileB = path.join(dir, 'completely_renamed_copy.txt');
    fs.writeFileSync(fileA, sampleBytes);
    fs.writeFileSync(fileB, sampleBytes);

    const ds = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Arabic-Core-Dataset',
      resourceType: 'JSONL',
      originSource: 'HUGGINGFACE_MIRROR',
      license: 'Apache-2.0',
      filePath: fileA,
      version: '1.0.0',
    });
    assert.equal(ds.deduplicated, false);
    assert.equal(ds.resource.sizeBytes, sampleBytes.length);
    assert.equal(ds.resource.sha256, crypto.createHash('sha256').update(sampleBytes).digest('hex'));

    // Same file bytes under different filename & name must deduplicate!
    const dup = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Renamed-Dataset-Mirror',
      resourceType: 'TXT',
      originSource: 'LOCAL_MIRROR',
      license: 'Apache-2.0',
      filePath: fileB,
    });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.resource.id, ds.resource.id);

    // Register MODEL, SOFTWARE, KNOWLEDGE
    const modelFile = path.join(dir, 'base_model.ngbin');
    fs.writeFileSync(modelFile, Buffer.from('NG_WEIGHTS_HEADER_V1_0001'));
    const mod = registerResource(db, {
      librarySection: 'MODEL',
      name: 'Base-Model-1B',
      resourceType: 'NGBIN',
      originSource: 'INTERNAL_FORGE',
      license: 'NG-COMMERCIAL',
      filePath: modelFile,
    });
    assert.equal(mod.resource.librarySection, 'MODEL');

    const sw = registerResource(db, {
      librarySection: 'SOFTWARE',
      name: 'Tokenizer-CLI-Script',
      resourceType: 'TS_TOOL',
      originSource: 'NG_INTERNAL_TOOLS',
      license: 'MIT',
      contentText: 'export function tokenize(s: string) { return s.split(" "); }\n',
    });
    assert.equal(sw.resource.librarySection, 'SOFTWARE');

    const know = registerResource(db, {
      librarySection: 'KNOWLEDGE',
      name: 'Arabic-Grammar-Rules',
      resourceType: 'MARKDOWN',
      originSource: 'CURATED_EXPERT',
      license: 'CC-BY-4.0',
      contentText: '# Arabic Syntax Reference\nNominal and verbal sentence rules.\n',
    });
    assert.equal(know.resource.librarySection, 'KNOWLEDGE');

    // Deletion block when linked to a project
    const proj = createProject(db, {
      name: 'Project-Alpha',
      projectType: 'LLM_CORPUS',
      rootPath: dir,
    });
    linkResourceToProject(db, proj.id, ds.resource.id, 'PRIMARY_CORPUS');
    assert.throws(() => deleteResourceSafely(db, ds.resource.id), /Blocked:.*linked to 1 project/);

    // Unlink from project, bind to training job -> STILL BLOCKED from deletion!
    unlinkResourceFromProject(db, proj.id, ds.resource.id);
    const worker = registerWorker(db, {
      workerName: 'Local-GPU-1',
      endpointUrl: 'http://127.0.0.1:59997',
      gpuModel: 'RTX 4090',
      vramGb: 24,
      systemRamGb: 64,
    });
    await createTrainingJob(db, {
      modelId: mod.resource.id,
      datasetId: ds.resource.id,
      workerId: worker.id,
      architecture: 'NG-Decoder-1B',
      scaleTier: '1B',
      totalSteps: 100,
      dispatchToWorker: false,
    });
    assert.throws(() => deleteResourceSafely(db, ds.resource.id), /Blocked:.*training job/);
    assert.throws(() => deleteResourceSafely(db, mod.resource.id), /Blocked:.*training job/);

    // Unlinked resource (KNOWLEDGE) can be safely deleted
    const deleted = deleteResourceSafely(db, know.resource.id);
    assert.equal(deleted.deletedId, know.resource.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. DATA FACTORY: extract HTML/JSON/CSV text, clean, deduplicate & build verifiable dataset package', () => {
  const { db, dir } = setupIsolatedDb();
  try {
    const pkg = processAndBuildDatasetPackage(db, {
      datasetName: 'Arabic-Science-Cleaned',
      license: 'Apache-2.0',
      originSource: 'RAW_CORPUS_BATCH',
      rawFiles: [
        {
          fileName: 'article.html',
          contentText:
            '<html><body><h1>الفيزياء الكلاسيكية</h1><p>قانون نيوتن الثاني يربط القوة بالكتلة.</p><p>قانون نيوتن الثاني يربط القوة بالكتلة.</p><p>x</p></body></html>',
        },
        {
          fileName: 'pairs.csv',
          contentText: 'Question,Answer\nما هي وحدة القوة,النيوتن هي وحدة قياس القوة\n',
        },
      ],
      stripHtml: true,
      deduplicateLines: true,
      minLineLength: 6,
      format: 'JSONL',
    });

    assert.ok(fs.existsSync(pkg.dataFilePath));
    assert.ok(fs.existsSync(pkg.manifestPath));
    assert.equal(pkg.resource.librarySection, 'DATASET');
    assert.equal(pkg.stats.deduplicatedCount, 0);
    assert.ok(pkg.stats.cleanedLinesCount >= 2);
    const dataBuf = fs.readFileSync(pkg.dataFilePath);
    assert.equal(crypto.createHash('sha256').update(dataBuf).digest('hex'), pkg.dataFileSha256);
    assert.ok(!dataBuf.toString('utf-8').includes('<h1>'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. NEW MIND: create independent Mind, save/log/restore training checkpoints & reject tampered checkpoint', async () => {
  const { db, dir } = setupIsolatedDb();
  try {
    const mind = createIndependentMind(db, {
      name: 'NG-Sovereign-Base-1B',
      productClass: 'NG-BASE',
      version: '1.0.0',
      scaleTier: '1B',
      architecture: 'NG-Decoder-GQA-24L',
      tokenizerSpec: 'NG-BPE-64K',
      license: 'NG-COMMERCIAL',
    });
    assert.ok(fs.existsSync(path.join(mind.mindDir, 'model_config.json')));
    assert.ok(fs.existsSync(path.join(mind.mindDir, 'tokenizer.json')));
    assert.ok(fs.existsSync(mind.weightsManifestPath));

    const ds = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Pretrain-Corpus',
      resourceType: 'JSONL',
      originSource: 'FACTORY',
      license: 'Apache-2.0',
      contentText: '{"text":"Sample pretraining document line 1"}\n',
    });
    const worker = registerWorker(db, {
      workerName: 'Cluster-Node-A',
      endpointUrl: 'http://127.0.0.1:59996',
      gpuModel: 'A100 40GB',
      vramGb: 40,
      systemRamGb: 128,
    });
    const { job } = await createTrainingJob(db, {
      modelId: mind.resourceId,
      datasetId: ds.resource.id,
      workerId: worker.id,
      architecture: 'NG-Decoder-GQA-24L',
      scaleTier: '1B',
      totalSteps: 500,
      dispatchToWorker: false,
    });

    const cp1 = saveTrainingCheckpoint(db, {
      jobId: job.id,
      step: 100,
      trainingLoss: 2.15,
      validationLoss: 2.24,
      checkpointNotes: 'Checkpoint step 100',
      jobStatus: 'RUNNING',
    });
    const cp2 = saveTrainingCheckpoint(db, {
      jobId: job.id,
      step: 250,
      trainingLoss: 1.68,
      validationLoss: 1.81,
      checkpointNotes: 'Checkpoint step 250',
      jobStatus: 'RUNNING',
    });
    assert.equal(cp2.job.currentStep, 250);

    const logs = getTrainingJobLogs(db, job.id);
    assert.equal(logs.checkpoints.length, 2);
    assert.equal(logs.entries.length, 2);

    // Restore back to step 100
    const restored = restoreTrainingCheckpoint(db, job.id, cp1.checkpointPath);
    assert.equal(restored.restoredStep, 100);
    assert.equal(restored.job.jobStatus, 'PAUSED');

    // Resume from PAUSED -> RUNNING (since job was RUNNING when checkpoint was saved), then PAUSE -> CANCEL -> block further control
    const resumed = updateTrainingJobControl(db, job.id, 'RESUME');
    assert.equal(resumed.jobStatus, 'RUNNING');
    const pausedAgain = updateTrainingJobControl(db, job.id, 'PAUSE');
    assert.equal(pausedAgain.jobStatus, 'PAUSED');
    const cancelled = updateTrainingJobControl(db, job.id, 'CANCEL');
    assert.equal(cancelled.jobStatus, 'CANCELLED');
    assert.throws(() => updateTrainingJobControl(db, job.id, 'RESUME'), /Cannot RESUME a job in status CANCELLED/);

    // Tamper cp2 checkpoint file on disk -> restore MUST reject!
    const rawCp2 = JSON.parse(fs.readFileSync(cp2.checkpointPath, 'utf-8')) as Record<string, unknown>;
    rawCp2.trainingLoss = 0.0001;
    fs.writeFileSync(cp2.checkpointPath, JSON.stringify(rawCp2, null, 2), 'utf-8');
    assert.throws(() => restoreTrainingCheckpoint(db, job.id, cp2.checkpointPath), /SHA-256 mismatch/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('7-9. MIND REPAIR (immutable original), TRUST & QC (evidence dossier), NG-IP (license gate + ZIP verify) & ARCHIVE batch verify', async () => {
  const { db, dir } = setupIsolatedDb();
  try {
    // Prepare original external model artifact
    const originalPayload = Buffer.from(
      JSON.stringify({ model: 'External-GPT-Legacy', layers: 24, format: 'safetensors-header' }),
      'utf-8',
    );
    const intake = receiveExternalModelForRepair(db, {
      name: 'Legacy-Model-X',
      version: '1.0.0',
      originSource: 'CLIENT_HANDOFF',
      license: 'Apache-2.0',
      architectureSummary: 'Transformer 24L requiring tokenizer repair',
      fileName: 'legacy_x.json',
      fileBase64: originalPayload.toString('base64'),
    });
    assert.ok(fs.existsSync(intake.originalBackupPath));
    assert.equal(intake.inspectionReport.sha256Valid, true);
    const originalFileDigest = intake.originalSha256;

    // Repair product -> produces new weightsSha256 & version, while keeping ORIGINAL file intact on disk
    const repairedWeightsSha = crypto.createHash('sha256').update('repaired-weights-v2').digest('hex');
    const repaired = registerOrRepairProduct(db, {
      id: intake.product.id,
      name: 'Legacy-Model-X-Repaired',
      productClass: 'NG-REPAIRED',
      version: '2.0.0',
      weightsSha256: repairedWeightsSha,
      architectureSummary: 'Transformer 24L with repaired UTF-8 tokenizer & RoPE fix',
      trainingSummary: 'Post-repair alignment & calibration',
      evaluationSummary: 'All regression prompts verified',
      license: 'Apache-2.0',
      safetyNotes: 'Verified safe and toxicity filtered',
      changelog: 'Fixed tokenizer EOS handling',
    });

    assert.ok(fs.existsSync(intake.originalBackupPath));
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(intake.originalBackupPath)).digest('hex'),
      originalFileDigest,
    );
    assert.ok(Array.isArray(repaired.safetyReport.preservedOriginals));
    assert.equal((repaired.safetyReport.preservedOriginals as unknown[]).length, 2);

    // Trust & QC 10-suite run writes real JSON evidence dossier
    const qc = runTenSuiteQcCheck(db, repaired.id);
    assert.equal(qc.allPassed, true);
    assert.equal(qc.passedCount, 10);
    assert.ok(fs.existsSync(qc.evidencePath));
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(qc.evidencePath)).digest('hex'),
      qc.evidenceSha256,
    );

    transitionProductLifecycle(db, repaired.id, 'APPROVED');
    const pkg = buildCertifiedDeliveryPackage(db, repaired.id, {
      ipHolder: 'NG-ILMF Sovereign Owner',
      licenseTermsNote: 'Certified Apache-2.0 NG-REPAIRED release',
    });
    assert.equal(pkg.verified, true);
    assert.ok(fs.existsSync(pkg.zipPath));

    const verifyOk = verifyDeliveryPackageIntegrity(db, pkg.id);
    assert.equal(verifyOk.fileExists, true);
    assert.equal(verifyOk.validPkzipHeader, true);
    assert.equal(verifyOk.sha256Matched, true);

    // Tamper ZIP -> integrity verify detects mismatch!
    const zipBytes = fs.readFileSync(pkg.zipPath);
    zipBytes[zipBytes.length - 1] = zipBytes[zipBytes.length - 1] ^ 0xff;
    fs.writeFileSync(pkg.zipPath, zipBytes);
    const verifyTampered = verifyDeliveryPackageIntegrity(db, pkg.id);
    assert.equal(verifyTampered.sha256Matched, false);
    assert.equal(verifyTampered.deliveryPackage.verified, false);

    // Disallowed IP license check
    const badLicenseProduct = registerOrRepairProduct(db, {
      name: 'Unlicensed-Model',
      productClass: 'NG-BASE',
      version: '1.0.0',
      weightsSha256: crypto.createHash('sha256').update('unlicensed').digest('hex'),
      architectureSummary: 'Test arch 12L',
      license: 'UNKNOWN',
    });
    assert.throws(() => buildCertifiedDeliveryPackage(db, badLicenseProduct.id), /Blocked:/);

    // Archive storage + batch re-verification
    setConfigValue(db, 'selected_archive_provider', 'host_dev');
    const probe = runProviderIntegrityTest(getConfigMap(db), 'host_dev');
    assert.equal(probe.storageReady, true);
    setConfigValue(db, 'archive_location_confirmed', 'true');
    setConfigValue(db, 'last_storage_verification_json', JSON.stringify(probe));

    const res = registerResource(db, {
      librarySection: 'KNOWLEDGE',
      name: 'Spec-Doc',
      resourceType: 'MD',
      originSource: 'OWNER',
      license: 'MIT',
      contentText: '# NG-ILMF Spec\nVerified archive entry.\n',
    });
    const arc = archiveResourceToSmartArchive(db, {
      resourceId: res.resource.id,
      categoryFolder: 'INVENTORY',
    });
    const batch1 = verifyArchiveIntegrityBatch(db);
    assert.equal(batch1.verifiedCount, 1);
    assert.equal(batch1.mismatchCount, 0);

    // Tamper archived file -> batch verify marks MISMATCH!
    fs.appendFileSync(arc.archivePath, '\nTAMPERED');
    const batch2 = verifyArchiveIntegrityBatch(db);
    assert.equal(batch2.mismatchCount, 1);
    assert.equal(batch2.entries[0].verifyStatus, 'MISMATCH');

    // Central command snapshot & audit logs reflection
    const snapshot = await getMasterDashboardSnapshot(db);
    assert.ok(snapshot.counts.totalProducts >= 2);
    assert.ok((snapshot.wingsSummary?.ngIpServices.deliveryPackages ?? 0) >= 1);
    assert.ok((snapshot.wingsSummary?.trustSecurityCenter.qcPassedTotal ?? 0) >= 10);
    const logs = listAuditLogs(db, { limit: 50 });
    assert.ok(logs.some((l) => l.action === 'VERIFY_DELIVERY_ZIP_INTEGRITY'));
    assert.ok(logs.some((l) => l.action === 'VERIFY_ARCHIVE_INTEGRITY_BATCH'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('10. Storage Integrity background SHA-256 check reports HEALTHY when files match and CORRUPTED when tampered or missing', async () => {
  const { db, dir } = setupIsolatedDb();
  try {
    const file1 = path.join(dir, 'corpus_one.jsonl');
    const file2 = path.join(dir, 'weights_two.ngbin');
    fs.writeFileSync(file1, '{"text":"Integrity test sample 1"}\n', 'utf-8');
    fs.writeFileSync(file2, Buffer.from('NG_WEIGHTS_SAMPLE_2'));

    const res1 = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Integrity-Dataset-1',
      resourceType: 'JSONL',
      originSource: 'LOCAL',
      license: 'Apache-2.0',
      filePath: file1,
    });
    const res2 = registerResource(db, {
      librarySection: 'MODEL',
      name: 'Integrity-Model-2',
      resourceType: 'NGBIN',
      originSource: 'LOCAL',
      license: 'NG-COMMERCIAL',
      filePath: file2,
    });

    const initial = getResourceLibraryIntegrityStatus(db);
    assert.equal(initial.overallStatus, 'HEALTHY');
    assert.equal(initial.totalResources, 2);
    assert.equal(initial.verifiedCount, 2);
    assert.equal(initial.corruptedCount, 0);

    // Trigger background SHA-256 verification while both files are intact
    const runHealthy = startBackgroundResourceIntegrityCheck(db);
    assert.equal(runHealthy.started, true);
    const healthyResult = await awaitBackgroundIntegrityCheck(db);
    assert.equal(healthyResult.overallStatus, 'HEALTHY');
    assert.equal(healthyResult.verifiedCount, 2);
    assert.equal(healthyResult.corruptedCount, 0);
    assert.equal(healthyResult.running, false);

    // Tamper file1 on disk -> background check must quarantine it & report CORRUPTED
    fs.appendFileSync(file1, '{"text":"TAMPERED_LINE"}\n', 'utf-8');
    const runTampered = startBackgroundResourceIntegrityCheck(db);
    assert.equal(runTampered.started, true);
    const tamperedResult = await awaitBackgroundIntegrityCheck(db);
    assert.equal(tamperedResult.overallStatus, 'CORRUPTED');
    assert.equal(tamperedResult.corruptedCount, 1);
    assert.equal(tamperedResult.verifiedCount, 1);
    const tamperedItem = tamperedResult.resources.find((r) => r.id === res1.resource.id);
    assert.equal(tamperedItem?.verificationStatus, 'QUARANTINED');

    // Remove file2 from disk -> both resources are now non-verified -> CORRUPTED (2)
    fs.unlinkSync(file2);
    startBackgroundResourceIntegrityCheck(db);
    const missingResult = await awaitBackgroundIntegrityCheck(db);
    assert.equal(missingResult.overallStatus, 'CORRUPTED');
    assert.equal(missingResult.corruptedCount, 2);
    assert.equal(missingResult.unverifiedCount, 1);
    const missingItem = missingResult.resources.find((r) => r.id === res2.resource.id);
    assert.equal(missingItem?.verificationStatus, 'UNVERIFIED');

    const logs = listAuditLogs(db, { limit: 20 });
    const batchLog = logs.find((l) => l.action === 'VERIFY_RESOURCE_LIBRARY_INTEGRITY_BATCH');
    assert.ok(batchLog);
    assert.equal(batchLog.outcome, 'FAIL');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

