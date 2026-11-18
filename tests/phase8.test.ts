import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executeOwnerApprovedCleanup,
  getDeviceManagerSnapshot,
} from '../server/services/deviceManagerService.ts';
import {
  isAuthorizedForAction,
  loginOwnerSession,
  revokeOwnerSession,
  setupOwnerPasskey,
  updateSecurityPermissions,
} from '../server/services/securityService.ts';
import {
  getIsolatedDemoCatalog,
  resetDemoSession,
  runIsolatedDemoInference,
} from '../server/services/demoService.ts';

function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-p8-'));
  const dbPath = path.join(dir, 'ng_ilmf_command.sqlite');
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
  stmt.run('bridge_endpoint', '', '', now);
  stmt.run('perm_export_requires_auth', 'true', '', now);
  stmt.run('perm_delete_requires_auth', 'true', '', now);
  stmt.run('perm_pairing_requires_auth', 'true', '', now);
  return { db, dir, dbPath };
}

test('Device Manager scans cleanup candidates without auto-deleting and protects SQLite/external paths', () => {
  const { db, dir, dbPath } = setupTempDb();
  const outsideFile = path.join(os.tmpdir(), `outside-ng-ilmf-${Date.now()}.tmp`);
  try {
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'stale-chunk.bin');
    fs.writeFileSync(cacheFile, 'cached-bytes-123');
    fs.writeFileSync(outsideFile, 'do-not-delete');

    const snapshot = getDeviceManagerSnapshot(db);
    assert.ok(snapshot.cleanupSuggestions.some((s) => s.path === path.resolve(cacheFile)));
    assert.ok(fs.existsSync(cacheFile));

    // Must refuse without ownerApproved=true
    assert.throws(
      () => executeOwnerApprovedCleanup(db, { filePath: cacheFile, ownerApproved: false }),
      /Explicit owner approval/,
    );
    assert.ok(fs.existsSync(cacheFile));

    // Must block deleting active SQLite database
    assert.throws(
      () => executeOwnerApprovedCleanup(db, { filePath: dbPath, ownerApproved: true }),
      /Active SQLite database/,
    );
    assert.ok(fs.existsSync(dbPath));

    // Must block deleting outside managed data_dir
    assert.throws(
      () => executeOwnerApprovedCleanup(db, { filePath: outsideFile, ownerApproved: true }),
      /inside the managed app workspace/,
    );
    assert.ok(fs.existsSync(outsideFile));

    // Owner-approved deletion of managed cache file succeeds and logs SHA-256
    const deleted = executeOwnerApprovedCleanup(db, {
      filePath: cacheFile,
      ownerApproved: true,
    });
    assert.equal(deleted.deletedPath, path.resolve(cacheFile));
    assert.equal(deleted.sha256BeforeDelete.length, 64);
    assert.equal(fs.existsSync(cacheFile), false);
  } finally {
    if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Owner Security uses salted scrypt passkey, enforces permissions, and revokes sessions cleanly', () => {
  const { db, dir } = setupTempDb();
  try {
    // Initially unlocked before passkey setup
    assert.equal(isAuthorizedForAction(db, 'export', undefined).allowed, true);

    const setup = setupOwnerPasskey(db, {
      passkey: 'Royal-Factory-Key-2026',
      deviceLabel: 'CPH1911 Handset',
    });
    assert.ok(setup.sessionToken.startsWith('ng_owner_'));
    assert.equal(setup.snapshot.ownerLockConfigured, true);
    assert.equal(setup.snapshot.sessionAuthenticated, true);

    // Unauthenticated export/delete now blocked
    assert.equal(isAuthorizedForAction(db, 'export', undefined).allowed, false);
    assert.equal(isAuthorizedForAction(db, 'delete', 'wrong-token').allowed, false);

    // Valid token authorized
    assert.equal(isAuthorizedForAction(db, 'export', setup.sessionToken).allowed, true);

    // Bad passkey logs failure
    assert.throws(
      () => loginOwnerSession(db, { passkey: 'Wrong-Passkey', deviceLabel: 'Attacker' }),
      /Invalid owner passkey/,
    );

    // Valid login issues second session
    const secondLogin = loginOwnerSession(db, {
      passkey: 'Royal-Factory-Key-2026',
      deviceLabel: 'Secondary Tablet',
    });
    assert.equal(isAuthorizedForAction(db, 'delete', secondLogin.sessionToken).allowed, true);

    // Revoking second session blocks it immediately
    revokeOwnerSession(db, secondLogin.sessionId, setup.sessionToken);
    assert.equal(isAuthorizedForAction(db, 'delete', secondLogin.sessionToken).allowed, false);

    // Updating permissions works with active owner token
    const permUpdated = updateSecurityPermissions(
      db,
      { exportRequiresAuth: false },
      setup.sessionToken,
    );
    assert.equal(permUpdated.permissions.exportRequiresAuth, false);
    assert.equal(isAuthorizedForAction(db, 'export', undefined).allowed, true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Isolated Demo Mode filters strictly to APPROVED/RELEASED products and refuses fake inference', async () => {
  const { db, dir } = setupTempDb();
  try {
    const now = new Date().toISOString();
    const insertProduct = db.prepare(`
      INSERT INTO model_products (
        id, name, product_class, version, weights_sha256,
        architecture_summary, training_summary, evaluation_summary,
        license, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProduct.run(
      'PRD-PRIVATE-01',
      'Secret Internal Base',
      'NG-BASE',
      '0.9.0',
      'deadbeef'.repeat(8),
      'Transformer 1.5B',
      'Internal training',
      'Pending QC',
      'PROPRIETARY',
      'IMPORTED',
      now,
      now,
    );
    insertProduct.run(
      'PRD-APPROVED-01',
      'NG Sovereign Arabic 7B',
      'NG-DOMAIN',
      '1.0.0',
      'cafebabe'.repeat(8),
      'Arabic Engineering LLM',
      'Curated corpus',
      '10/10 QC Pass',
      'NG-COMMERCIAL',
      'APPROVED',
      now,
      now,
    );

    const catalog = await getIsolatedDemoCatalog(db);
    assert.equal(catalog.isolatedMode, true);
    assert.equal(catalog.approvedProducts.length, 1);
    assert.equal(catalog.approvedProducts[0].id, 'PRD-APPROVED-01');
    // Verify private weights_sha256 is never leaked in demo payload
    assert.equal('weights_sha256' in catalog.approvedProducts[0], false);
    assert.equal(catalog.inferenceEngine.available, false);

    await assert.rejects(
      () =>
        runIsolatedDemoInference(db, {
          productId: 'PRD-PRIVATE-01',
          prompt: 'Hello',
        }),
      /not approved\/released/,
    );

    await assert.rejects(
      () =>
        runIsolatedDemoInference(db, {
          productId: 'PRD-APPROVED-01',
          prompt: 'Hello',
        }),
      /No real inference engine configured/,
    );

    const reset = resetDemoSession(db);
    assert.ok(reset.resetAt);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Android MainActivity.kt and SafStorageBridge.kt expose complete SAF & WebView bridge contract', () => {
  const mainActivity = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'android/app/src/main/java/com/ngilmf/commandcenter/MainActivity.kt',
    ),
    'utf-8',
  );
  const safBridge = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'android/app/src/main/java/com/ngilmf/commandcenter/SafStorageBridge.kt',
    ),
    'utf-8',
  );

  assert.match(mainActivity, /addJavascriptInterface\(safBridge,\s*BRIDGE_JS_NAME\)/);
  assert.match(mainActivity, /ActivityResultContracts\.OpenDocumentTree\(\)/);
  assert.match(mainActivity, /takePersistableUriPermission/);
  assert.match(mainActivity, /__ngIlmfAndroidBridgeCallback/);
  assert.match(safBridge, /openArchiveDocumentTree/);
  assert.match(safBridge, /runSafSha256ProbeJson/);
  assert.match(safBridge, /runSafSha256ProbeAsync/);
  assert.match(safBridge, /verifySafUriPermissionsJson/);
  assert.match(safBridge, /revokeSafUriPermissionJson/);
});
