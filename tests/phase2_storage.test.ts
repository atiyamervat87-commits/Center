import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ExternalSDCardStorageProvider,
  HostDevelopmentStorageProvider,
} from '../server/storage/storageProvider.ts';
import {
  createProject,
  exportProjectReport,
  getProjectDetail,
  linkResourceToProject,
  listProjects,
  unlinkResourceFromProject,
  updateProject,
} from '../server/services/projectService.ts';
import { getMasterDashboardSnapshot } from '../server/services/dashboardService.ts';

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-p2-'));
  const db = new DatabaseSync(path.join(dir, 'test.sqlite'));
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
  stmt.run('selected_archive_provider', 'external_sd', '', now);
  stmt.run('archive_location_confirmed', 'false', '', now);
  stmt.run('last_storage_verification_json', '', '', now);
  stmt.run('bridge_endpoint', '', '', now);
  return { db, dir };
}

test('ExternalSDCardStorageProvider never auto-creates NG-ILMF_ARCHIVE and rejects unmounted SD', () => {
  const missingArchive = path.join(os.tmpdir(), 'nonexistent_mount_xyz', 'NG-ILMF_ARCHIVE');
  const provider = new ExternalSDCardStorageProvider(missingArchive);
  const probe = provider.probe();
  assert.equal(probe.exists, false);
  assert.equal(probe.state, 'NOT_MOUNTED');
  assert.equal(fs.existsSync(missingArchive), false);

  const report = provider.runIntegrityVerification();
  assert.equal(report.storageReady, false);
  assert.equal(report.state, 'NOT_MOUNTED');
  assert.ok(report.failureReason && report.failureReason.length > 0);
});

test('HostDevelopmentStorageProvider performs real SHA-256 read/write/compare and cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-sha-'));
  try {
    const provider = new HostDevelopmentStorageProvider(dir);
    const report = provider.runIntegrityVerification();
    assert.equal(report.state, 'AVAILABLE');
    assert.equal(report.storageReady, true);
    assert.equal(report.contentMatched, true);
    assert.equal(report.cleanupCompleted, true);
    assert.ok(report.expectedSha256 && report.expectedSha256.length === 64);
    assert.equal(report.expectedSha256, report.actualSha256);
    // Temp file must be removed after verification
    assert.ok(report.testFilePath && !fs.existsSync(report.testFilePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Storage verification rejects READ_ONLY directory without declaring STORAGE READY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-ro-'));
  try {
    fs.chmodSync(dir, 0o555);
    const provider = new HostDevelopmentStorageProvider(dir);
    const probe = provider.probe();
    // Note: root user in some containers bypasses chmod 555; check only if non-root
    if (process.getuid && process.getuid() !== 0) {
      assert.equal(probe.state, 'READ_ONLY');
      const report = provider.runIntegrityVerification();
      assert.equal(report.storageReady, false);
      assert.equal(report.state, 'READ_ONLY');
    }
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Dashboard gating keeps storageReady=false until owner confirms AND SHA-256 matches', async () => {
  const { db, dir } = setupDb();
  try {
    // Select host_dev and run real test, but leave archive_location_confirmed=false
    const provider = new HostDevelopmentStorageProvider(dir);
    const report = provider.runIntegrityVerification();
    db.prepare("UPDATE system_config SET value = 'host_dev' WHERE key = 'selected_archive_provider'").run();
    db.prepare('UPDATE system_config SET value = ? WHERE key = ?').run(
      JSON.stringify(report),
      'last_storage_verification_json',
    );

    const beforeConfirm = await getMasterDashboardSnapshot(db);
    assert.equal(beforeConfirm.storageReady, false);
    assert.equal(beforeConfirm.archiveStatus, 'WARNING');

    // Now simulate owner approval
    db.prepare("UPDATE system_config SET value = 'true' WHERE key = 'archive_location_confirmed'").run();
    const afterConfirm = await getMasterDashboardSnapshot(db);
    assert.equal(afterConfirm.storageReady, true);
    assert.equal(afterConfirm.archiveStatus, 'READY');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ProjectManager registers, versions, stops projects, preserves shared resources, and exports SHA-256 report', () => {
  const { db, dir } = setupDb();
  try {
    const projectRoot = path.join(dir, 'prj_files');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'train_config.json'), '{"epochs": 3}', 'utf-8');

    const created = createProject(db, {
      name: 'Arabic Reasoning Mind v1',
      projectType: 'LLM_TRAINING',
      rootPath: projectRoot,
      version: '0.1.0',
      dependencies: ['pytorch>=2.3', 'safetensors'],
      notes: 'Initial phase 2 project',
    });

    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.rootPathInspection.exists, true);
    assert.equal(created.rootPathInspection.files.length, 1);

    // Insert an independent shared resource directly to verify decoupling
    const resId = 'RES-SHARED01';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO resources (
        id, library_section, name, resource_type, origin_source, license,
        file_path, size_bytes, version, sha256, verification_status,
        dependencies_json, transferable, imported_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      resId,
      'MODEL',
      'Shared Base Tokenizer',
      'tokenizer.json',
      'HuggingFace Official',
      'Apache-2.0',
      path.join(dir, 'tokenizer.json'),
      2048,
      '1.0.0',
      crypto.createHash('sha256').update('tok').digest('hex'),
      'VERIFIED',
      '[]',
      1,
      now,
      now,
    );

    const linked = linkResourceToProject(db, created.id, resId, 'TOKENIZER');
    assert.equal(linked.linkedResources.length, 1);

    // Bump version and stop project
    const stopped = updateProject(db, created.id, {
      version: '0.2.0',
      status: 'STOPPED',
    });
    assert.ok(stopped);
    assert.equal(stopped.version, '0.2.0');
    assert.equal(stopped.status, 'STOPPED');

    // Unlink resource -> resource MUST STILL EXIST in resources table
    const unlinked = unlinkResourceFromProject(db, created.id, resId);
    assert.equal(unlinked.linkedResources.length, 0);
    const preserved = db.prepare('SELECT id FROM resources WHERE id = ?').get(resId) as
      | { id: string }
      | undefined;
    assert.equal(preserved?.id, resId);

    // Export verified report
    const exported = exportProjectReport(db, created.id);
    assert.ok(fs.existsSync(exported.filePath));
    const diskSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(exported.filePath))
      .digest('hex');
    assert.equal(exported.sha256, diskSha);

    // Confirm listProjects works with status filter
    const stoppedList = listProjects(db, { status: 'STOPPED' });
    assert.equal(stoppedList.length, 1);
    const reloaded = getProjectDetail(db, created.id);
    assert.equal(reloaded?.status, 'STOPPED');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
