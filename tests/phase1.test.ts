import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordAuditEvent, listAuditLogs } from '../server/audit/auditService.ts';
import {
  probeDeviceEnvironment,
  runProviderIntegrityTest,
} from '../server/storage/storageProbe.ts';
import { getMasterDashboardSnapshot } from '../server/services/dashboardService.ts';

function createTempTestDb(): { db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  const schemaSql = fs.readFileSync(
    path.resolve(process.cwd(), 'server', 'db', 'schema.sql'),
    'utf-8',
  );
  db.exec(schemaSql);
  const now = new Date().toISOString();
  const entries = [
    ['data_dir', dir],
    ['sd_archive_path', '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE'],
    ['termux_prefix', '/data/data/com.termux/files/usr'],
    ['termux_shared_path', '/data/data/com.termux/files/home/storage/shared'],
    ['android_saf_uri', ''],
    ['selected_archive_provider', 'external_sd'],
    ['archive_location_confirmed', 'false'],
    ['last_storage_verification_json', ''],
    ['bridge_endpoint', ''],
  ];
  const stmt = db.prepare(
    'INSERT INTO system_config (key, value, description, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (const [k, v] of entries) {
    stmt.run(k, v, 'test config', now);
  }
  return { db, dir };
}

test('SQLite schema creates all 12 core tables', () => {
  const { db, dir } = createTempTestDb();
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(rows.map((r) => r.name));
    const expected = [
      'system_config',
      'projects',
      'resources',
      'project_resources',
      'archive_entries',
      'training_workers',
      'training_jobs',
      'model_products',
      'qc_reports',
      'delivery_packages',
      'audit_logs',
      'owner_sessions',
    ];
    for (const name of expected) {
      assert.ok(tableNames.has(name), `Missing table ${name}`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Separated environment probe distinguishes Host Dev from Android/Termux/SD', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-probe-'));
  try {
    const env = probeDeviceEnvironment({
      data_dir: tmpDir,
      sd_archive_path: '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE',
      termux_prefix: '/data/data/com.termux/files/usr',
      termux_shared_path: '/data/data/com.termux/files/home/storage/shared',
      android_saf_uri: '',
      selected_archive_provider: 'external_sd',
    });

    assert.equal(env.hostEnvironment.provider.state, 'AVAILABLE');
    assert.equal(env.hostEnvironment.provider.isVirtualHostPath, true);
    assert.equal(env.androidDeviceEnvironment.provider.state, 'NOT_MOUNTED');
    assert.equal(env.termuxEnvironment.provider.state, 'NOT_MOUNTED');
    assert.equal(env.externalSdStorage.provider.state, 'NOT_MOUNTED');

    const hostVerify = runProviderIntegrityTest({ data_dir: tmpDir }, 'host_dev');
    assert.equal(hostVerify.storageReady, true);
    assert.equal(hostVerify.contentMatched, true);
    assert.equal(hostVerify.expectedSha256, hostVerify.actualSha256);
    assert.equal(hostVerify.cleanupCompleted, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit service records and filters events in SQLite', () => {
  const { db, dir } = createTempTestDb();
  try {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'STORAGE_PROBE',
      action: 'TEST_VERIFY',
      target: dir,
      outcome: 'PASS',
      details: { verified: true },
    });
    const all = listAuditLogs(db, { limit: 10 });
    assert.equal(all.length, 1);
    assert.equal(all[0].action, 'TEST_VERIFY');
    assert.equal(all[0].outcome, 'PASS');

    const filteredEmpty = listAuditLogs(db, { outcome: 'ERROR' });
    assert.equal(filteredEmpty.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Dashboard snapshot reports zero fake models and storageReady=false before verified approval', async () => {
  const { db, dir } = createTempTestDb();
  try {
    const snapshot = await getMasterDashboardSnapshot(db);
    assert.equal(snapshot.counts.libraryModels, 0);
    assert.equal(snapshot.counts.importedModels, 0);
    assert.equal(snapshot.counts.approvedBrains, 0);
    assert.equal(snapshot.storageReady, false);
    assert.equal(snapshot.bridgeStatus, 'NOT CONFIGURED');
    assert.equal(snapshot.externalTrainingEnvStatus, 'NOT CONFIGURED');
    assert.equal(snapshot.archiveStatus, 'OFFLINE');
    assert.equal(snapshot.factoryStatus, 'WARNING');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
