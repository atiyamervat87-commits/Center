import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  archiveResourceToSmartArchive,
  deleteResourceSafely,
  generateDataFactoryManifest,
  registerResource,
  verifyResourceIntegrity,
} from '../server/services/dataFactoryService.ts';
import {
  createTrainingJob,
  intakeExternalModel,
  prepareTransferManifest,
  probeWorkerConnection,
  registerWorker,
  updateTrainingJobControl,
} from '../server/services/mindFactoryService.ts';
import {
  registerOrRepairProduct,
  transitionProductLifecycle,
} from '../server/services/repairRegistryService.ts';
import { runTenSuiteQcCheck } from '../server/services/trustQcService.ts';
import { buildCertifiedDeliveryPackage } from '../server/services/ngIpService.ts';
import { createProject, linkResourceToProject } from '../server/services/projectService.ts';
import { setConfigValue } from '../server/db/database.ts';
import { runProviderIntegrityTest } from '../server/storage/storageProbe.ts';
import { getConfigMap } from '../server/db/database.ts';

function setupIsolatedWingsDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-wings-'));
  const dbPath = path.join(dir, 'ng_ilmf_wings_test.sqlite');
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

test('Wing 1 (DATA FACTORY): Registration, SHA-256 deduplication, archive gating, project link protection, and manifest', () => {
  const { db, dir } = setupIsolatedWingsDb();
  try {
    // 1. Register dataset via contentText
    const first = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Arabic-Physics-Corpus',
      resourceType: 'JSONL',
      originSource: 'OWNER_CURATED',
      license: 'Apache-2.0',
      contentText: '{"prompt":"Newton","answer":"Force = mass * acceleration"}\n',
      version: '1.0.0',
    });
    assert.equal(first.deduplicated, false);
    assert.equal(first.resource.verificationStatus, 'VERIFIED');
    assert.equal(first.resource.sha256.length, 64);

    // 2. Duplicate SHA-256 must deduplicate
    const dup = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Duplicate-Alias',
      resourceType: 'JSONL',
      originSource: 'MIRROR',
      license: 'Apache-2.0',
      contentText: '{"prompt":"Newton","answer":"Force = mass * acceleration"}\n',
    });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.resource.id, first.resource.id);

    // 3. Re-verify SHA-256 on disk
    const reVerified = verifyResourceIntegrity(db, first.resource.id);
    assert.equal(reVerified.verificationStatus, 'VERIFIED');

    // 4. Archive blocked while storageReady is false
    assert.throws(
      () =>
        archiveResourceToSmartArchive(db, {
          resourceId: first.resource.id,
          categoryFolder: 'DATASETS',
        }),
      /NOT READY/,
    );

    // 5. Switch selected provider to host_dev, run real SHA-256 probe, confirm owner approval
    setConfigValue(db, 'selected_archive_provider', 'host_dev');
    const hostReport = runProviderIntegrityTest(getConfigMap(db), 'host_dev');
    assert.equal(hostReport.storageReady, true);
    setConfigValue(db, 'archive_location_confirmed', 'true');
    setConfigValue(db, 'last_storage_verification_json', JSON.stringify(hostReport));

    const archived = archiveResourceToSmartArchive(db, {
      resourceId: first.resource.id,
      categoryFolder: 'DATASETS',
    });
    assert.equal(archived.verifyStatus, 'VERIFIED');
    assert.equal(archived.sha256, first.resource.sha256);
    assert.ok(fs.existsSync(archived.archivePath));

    // 6. Generate verified manifest
    const manifest = generateDataFactoryManifest(db);
    assert.equal(manifest.resourceCount, 1);
    assert.equal(manifest.archiveCount, 1);
    assert.equal(manifest.sha256.length, 64);
    assert.ok(fs.existsSync(manifest.filePath));

    // 7. Link resource to a project & verify delete is blocked cleanly
    const project = createProject(db, {
      name: 'PhysicsMind-Project',
      projectType: 'LLM_DOMAIN',
      rootPath: dir,
    });
    linkResourceToProject(db, project.id, first.resource.id, 'TRAINING_DATA');
    assert.throws(() => deleteResourceSafely(db, first.resource.id), /Blocked: Resource/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wing 2 (NEW MIND FACTORY): Capacity gating (1B-30B+), honest offline/online probe, chunked manifest, zero fake loss', async () => {
  const { db, dir } = setupIsolatedWingsDb();
  let mockServer: http.Server | null = null;
  try {
    // 1. Small worker (4GB VRAM) -> blocked from 13B training
    const smallWorker = registerWorker(db, {
      workerName: 'Low-VRAM-Laptop',
      endpointUrl: 'http://127.0.0.1:59999',
      gpuModel: 'GTX 1650',
      vramGb: 4,
      systemRamGb: 8,
    });
    assert.equal(smallWorker.status, 'OFFLINE');

    // Probing unreachable port must return OFFLINE honestly
    const offlineProbe = await probeWorkerConnection(db, smallWorker.id);
    assert.equal(offlineProbe.reachable, false);
    assert.equal(offlineProbe.worker.status, 'OFFLINE');

    await assert.rejects(
      () =>
        createTrainingJob(db, {
          modelId: 'PRD-TEST-13B',
          datasetId: 'RES-DATA-01',
          workerId: smallWorker.id,
          architecture: 'LoRA-13B',
          scaleTier: '13B',
          totalSteps: 500,
        }),
      /does not meet minimum 24 GB VRAM for 13B training/,
    );

    // 2. Start a real ephemeral HTTP worker endpoint to test real HTTP /health probe & chunked transfer
    mockServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/jobs' && req.method === 'POST') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => mockServer!.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address() as { port: number };
    const workerUrl = `http://127.0.0.1:${addr.port}`;

    const gpuWorker = registerWorker(db, {
      workerName: 'Lab-RTX4090-Node',
      endpointUrl: workerUrl,
      gpuModel: 'RTX 4090 24GB',
      vramGb: 24,
      systemRamGb: 64,
    });
    const onlineProbe = await probeWorkerConnection(db, gpuWorker.id);
    assert.equal(onlineProbe.reachable, true);
    assert.equal(onlineProbe.worker.status, 'ONLINE');

    // 3. Intake external model & prepare chunked SHA-256 transfer manifest
    const intake = intakeExternalModel(db, {
      name: 'Qwen-Base-13B-Intake',
      productClass: 'NG-BASE',
      version: '1.0.0',
      architectureSummary: 'Transformer 13B GQA 40-layer decoder',
      scaleTier: '13B',
      license: 'Apache-2.0',
      originSource: 'OFFLINE_LOCAL_ARCHIVE',
      tokenizerSpec: 'BPE-151K',
    });
    assert.equal(intake.inspected, true);
    assert.equal(intake.weightsSha256.length, 64);

    const xfer = prepareTransferManifest(db, {
      resourceId: intake.resourceId,
      workerId: gpuWorker.id,
      chunkSizeBytes: 4096,
    });
    assert.equal(xfer.chunkCount >= 1, true);
    assert.equal(xfer.manifestSha256.length, 64);
    assert.ok(fs.existsSync(xfer.manifestPath));

    // 4. Create training job on 24GB worker (13B LoRA fits 24GB), verify zero fake loss & PAUSE control
    const jobRes = await createTrainingJob(db, {
      modelId: intake.productId,
      datasetId: intake.resourceId,
      workerId: gpuWorker.id,
      architecture: 'NG-13B-LoRA',
      scaleTier: '13B',
      totalSteps: 300,
      dispatchToWorker: true,
    });
    assert.equal(jobRes.job.jobStatus, 'RUNNING');
    assert.equal(jobRes.job.trainingLoss, null);
    assert.equal(jobRes.job.currentStep, 0);

    const paused = updateTrainingJobControl(db, jobRes.job.id, 'PAUSE');
    assert.equal(paused.jobStatus, 'PAUSED');
  } finally {
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wings 3 + 4 + 5 End-to-End Flow: QC failure blocks approval/ZIP -> repair -> 10/10 PASS -> RELEASED -> Certified ZIP', () => {
  const { db, dir } = setupIsolatedWingsDb();
  try {
    const validSha = crypto.createHash('sha256').update('ng-ilmf-model-weights-v2').digest('hex');

    // 1. Register product with UNKNOWN license & missing provenance/checkpoint
    const product = registerOrRepairProduct(db, {
      name: 'NG-Arabic-Instruct',
      productClass: 'NG-BASE',
      version: '1.0.0',
      weightsSha256: validSha,
      architectureSummary: 'Transformer 7B GQA RoPE Arabic-English',
      license: 'UNKNOWN',
    });
    assert.equal(product.lifecycleState, 'EVALUATION');

    // 2. Attempting APPROVED before QC is strictly BLOCKED
    assert.throws(
      () => transitionProductLifecycle(db, product.id, 'APPROVED'),
      /mandatory QC suites/,
    );

    // 3. Running 10-suite QC against UNKNOWN license must NOT pass all 10
    const failedQc = runTenSuiteQcCheck(db, product.id);
    assert.equal(failedQc.totalCount, 10);
    assert.equal(failedQc.allPassed, false);
    const licenseRow = failedQc.reports.find((r) => r.testSuite === 'LICENSE_COMPLIANCE');
    assert.equal(licenseRow?.result, 'FAIL');

    // Delivery ZIP blocked when not approved
    assert.throws(() => buildCertifiedDeliveryPackage(db, product.id), /Only APPROVED or RELEASED/);

    // 4. Repair product in Wing 3 with clean license, provenance, safety review, evaluation & checkpoint
    const repaired = registerOrRepairProduct(db, {
      id: product.id,
      name: 'NG-Arabic-Instruct-Repaired',
      productClass: 'NG-REPAIRED',
      version: '1.1.0',
      weightsSha256: validSha,
      architectureSummary: 'Transformer 7B GQA RoPE Arabic-English Repaired',
      trainingSummary: 'Cleaned STEM + Arabic Instruction fine-tune lineage verified',
      evaluationSummary: 'Evaluated on 10 Trust & Security QC suites with zero regressions',
      license: 'NG-COMMERCIAL',
      safetyNotes: 'Passed red-team prompt safety policy inspection',
      restoreCheckpointPath: '/checkpoints/ng_arabic_v1.0.0.ckpt',
      changelog: 'Fixed license metadata, added restore checkpoint, verified SHA-256.',
    });
    assert.equal(repaired.productClass, 'NG-REPAIRED');

    // 5. Re-run 10-suite QC -> must achieve 10/10 PASS
    const passedQc = runTenSuiteQcCheck(db, repaired.id);
    assert.equal(passedQc.passedCount, 10);
    assert.equal(passedQc.allPassed, true);

    // 6. Lifecycle transitions: APPROVED -> RELEASED
    const approved = transitionProductLifecycle(db, repaired.id, 'APPROVED');
    assert.equal(approved.lifecycleState, 'APPROVED');
    const released = transitionProductLifecycle(db, repaired.id, 'RELEASED');
    assert.equal(released.lifecycleState, 'RELEASED');

    // 7. Wing 5 builds real PKZIP delivery archive with verified SHA-256 digests
    const pkg = buildCertifiedDeliveryPackage(db, released.id);
    assert.equal(pkg.verified, true);
    assert.equal(pkg.packageSha256.length, 64);
    assert.equal(pkg.manifestSha256.length, 64);
    assert.ok(fs.existsSync(pkg.zipPath));

    const zipBytes = fs.readFileSync(pkg.zipPath);
    // Verify PKZIP magic header 0x50 0x4B 0x03 0x04 and contained files
    assert.equal(zipBytes[0], 0x50);
    assert.equal(zipBytes[1], 0x4b);
    assert.equal(zipBytes[2], 0x03);
    assert.equal(zipBytes[3], 0x04);
    assert.equal(zipBytes.toString('utf-8').includes('MANIFEST.json'), true);
    assert.equal(zipBytes.toString('utf-8').includes('TECHNICAL_REPORT.md'), true);
    assert.equal(zipBytes.toString('utf-8').includes('LICENSE_AND_IP.txt'), true);
    assert.equal(zipBytes.toString('utf-8').includes('CHECKSUMS.sha256'), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
