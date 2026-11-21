import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  collectPerformanceMetrics,
  collectTrainingMetrics,
  RealtimeSyncService,
  syncOnlineWorkersTelemetry,
} from '../server/services/realtimeSyncService.ts';
import {
  createIndependentMind,
  createTrainingJob,
  probeWorkerConnection,
  recordJobTelemetry,
  registerWorker,
} from '../server/services/mindFactoryService.ts';
import { registerResource } from '../server/services/dataFactoryService.ts';
import { getMasterDashboardSnapshot } from '../server/services/dashboardService.ts';

function setupIsolatedSyncDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-sync-'));
  const dbPath = path.join(dir, 'ng_ilmf_sync_test.sqlite');
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

test('Performance & Training metric collectors reflect live OS telemetry and SQLite updates', async () => {
  const { db, dir, dbPath } = setupIsolatedSyncDb();
  try {
    const perf = collectPerformanceMetrics(dbPath);
    assert.ok(perf.memoryTotalBytes > 0);
    assert.ok(perf.memoryUsedPercent >= 0 && perf.memoryUsedPercent <= 100);
    assert.ok(perf.hostCpuPercent >= 0 && perf.hostCpuPercent <= 100);
    assert.ok(perf.sqliteDbBytes > 0);
    assert.ok(perf.processRssBytes > 0);

    const worker = registerWorker(db, {
      workerName: 'Sync-Test-Worker',
      endpointUrl: 'http://127.0.0.1:59998',
      gpuModel: 'RTX 4090',
      vramGb: 24,
      systemRamGb: 64,
    });

    const ds1 = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Sync-Test-Dataset',
      resourceType: 'JSONL',
      originSource: 'LOCAL',
      license: 'Apache-2.0',
      contentText: '{"text":"Sync test sample line 1"}\n',
    });
    const mind1 = createIndependentMind(db, {
      name: 'Sync-Mind-7B',
      version: '1.0.0',
      scaleTier: '7B',
      architecture: 'NG-7B-LoRA',
      tokenizerSpec: 'NG-BPE-32K',
      license: 'Apache-2.0',
      baseDatasetId: ds1.resource.id,
    });

    const created = await createTrainingJob(db, {
      modelId: mind1.productId,
      datasetId: ds1.resource.id,
      workerId: worker.id,
      architecture: 'NG-7B-LoRA',
      scaleTier: '7B',
      totalSteps: 200,
      dispatchToWorker: false,
    });

    const initialMetrics = collectTrainingMetrics(db);
    assert.equal(initialMetrics.totalWorkers, 1);
    assert.equal(initialMetrics.queuedJobs, 1);
    assert.equal(initialMetrics.runningJobs, 0);

    // Record real step & loss telemetry
    const updatedJob = recordJobTelemetry(db, created.job.id, {
      currentStep: 50,
      trainingLoss: 1.4235,
      validationLoss: 1.512,
      jobStatus: 'RUNNING',
    });
    assert.equal(updatedJob.currentStep, 50);
    assert.equal(updatedJob.trainingLoss, 1.4235);
    assert.equal(updatedJob.jobStatus, 'RUNNING');

    const snapshot = await getMasterDashboardSnapshot(db);
    assert.ok(snapshot.performanceMetrics);
    assert.ok(snapshot.trainingMetrics);
    assert.ok(snapshot.syncMetadata);
    assert.equal(snapshot.trainingMetrics?.runningJobs, 1);
    assert.equal(snapshot.trainingMetrics?.jobs[0].progressPercent, 25);
    assert.equal(snapshot.trainingMetrics?.jobs[0].trainingLoss, 1.4235);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncOnlineWorkersTelemetry pulls real /metrics from live HTTP worker and degrades to OFFLINE when stopped', async () => {
  const { db, dir } = setupIsolatedSyncDb();
  let mockWorker: http.Server | null = null;
  try {
    let advertisedStep = 0;
    let advertisedLoss = 2.5;
    let jobId = '';

    mockWorker = http.createServer((req, res) => {
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
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jobs: [
              {
                jobId,
                currentStep: advertisedStep,
                trainingLoss: advertisedLoss,
                jobStatus: 'RUNNING',
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockWorker!.listen(0, '127.0.0.1', resolve));
    const addr = mockWorker.address() as { port: number };
    const workerUrl = `http://127.0.0.1:${addr.port}`;

    const worker = registerWorker(db, {
      workerName: 'Live-HTTP-Trainer',
      endpointUrl: workerUrl,
      gpuModel: 'RTX A6000',
      vramGb: 48,
      systemRamGb: 128,
    });
    const probe = await probeWorkerConnection(db, worker.id);
    assert.equal(probe.reachable, true);

    const ds2 = registerResource(db, {
      librarySection: 'DATASET',
      name: 'Live-Sync-Corpus',
      resourceType: 'JSONL',
      originSource: 'LOCAL',
      license: 'Apache-2.0',
      contentText: '{"text":"Live worker metrics corpus line"}\n',
    });
    const mind2 = createIndependentMind(db, {
      name: 'Live-Mind-13B',
      version: '1.0.0',
      scaleTier: '13B',
      architecture: 'NG-13B-LoRA',
      tokenizerSpec: 'NG-BPE-32K',
      license: 'Apache-2.0',
      baseDatasetId: ds2.resource.id,
    });

    const jobCreated = await createTrainingJob(db, {
      modelId: mind2.productId,
      datasetId: ds2.resource.id,
      workerId: worker.id,
      architecture: 'NG-13B-LoRA',
      scaleTier: '13B',
      totalSteps: 400,
      dispatchToWorker: true,
    });
    jobId = jobCreated.job.id;

    // Advance metrics on the worker HTTP server & trigger sync
    advertisedStep = 120;
    advertisedLoss = 0.875;

    const syncSvc = new RealtimeSyncService();
    let broadcastCount = 0;
    let lastSequence = 0;
    syncSvc.on('snapshot', (payload: { sequence: number; snapshot: { trainingMetrics?: { jobs: Array<{ currentStep: number; trainingLoss: number | null }> } } }) => {
      broadcastCount += 1;
      lastSequence = payload.sequence;
      assert.equal(payload.snapshot.trainingMetrics?.jobs[0].currentStep, 120);
      assert.equal(payload.snapshot.trainingMetrics?.jobs[0].trainingLoss, 0.875);
    });

    const syncResult = await syncSvc.syncAndBroadcast(db, 'worker-metrics-test');
    assert.equal(syncResult.workerSync.onlineWorkers, 1);
    assert.equal(syncResult.workerSync.updatedJobs, 1);
    assert.equal(broadcastCount, 1);
    assert.equal(lastSequence, 1);

    // Stop worker -> next sync honestly detects OFFLINE status
    await new Promise<void>((resolve) => mockWorker!.close(() => resolve()));
    mockWorker = null;

    const afterStop = await syncOnlineWorkersTelemetry(db);
    assert.equal(afterStop.onlineWorkers, 0);
    const metricsAfterStop = collectTrainingMetrics(db);
    assert.equal(metricsAfterStop.onlineWorkers, 0);
    syncSvc.stop();
  } finally {
    if (mockWorker) {
      await new Promise<void>((resolve) => mockWorker!.close(() => resolve()));
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
