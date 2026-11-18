import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  computeAndroidBridgeDiagnostics,
  isValidContentSafUri,
  recordNativeAndroidAttestation,
  revokeAndroidSafAuthorization,
} from '../server/storage/androidBridgeDiagnostic.ts';
import { getConfigMap } from '../server/db/database.ts';

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-ab-'));
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
  stmt.run('android_saf_uri', '', '', now);
  stmt.run('android_native_attestation_json', '', '', now);
  stmt.run('selected_archive_provider', 'external_sd', '', now);
  stmt.run('archive_location_confirmed', 'false', '', now);
  return { db, dir };
}

test('Host container defaults strictly to HOST_ONLY=true and ANDROID_CONNECTED=false', () => {
  const { db, dir } = setupDb();
  try {
    const diag = computeAndroidBridgeDiagnostics(getConfigMap(db));
    assert.equal(diag.flags.HOST_ONLY, true);
    assert.equal(diag.flags.ANDROID_CONNECTED, false);
    assert.equal(diag.flags.TERMUX_CONNECTED, false);
    assert.equal(diag.flags.SD_AUTHORIZED, false);
    assert.equal(diag.flags.SD_READ_WRITE_VERIFIED, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Rejects raw /storage/857A-1AED/V5 filesystem string and host simulation spoofing', () => {
  const { db, dir } = setupDb();
  try {
    assert.equal(isValidContentSafUri('/storage/857A-1AED/V5'), false);
    assert.equal(
      isValidContentSafUri('content://com.android.externalstorage.documents/tree/857A-1AED%3AV5'),
      true,
    );

    assert.throws(
      () =>
        recordNativeAndroidAttestation(db, {
          isNativeAndroid: false,
          model: 'Simulated Host',
          sdkInt: 30,
        }),
      /Host simulation is not permitted/,
    );

    assert.throws(
      () =>
        recordNativeAndroidAttestation(db, {
          isNativeAndroid: true,
          model: 'CPH1911',
          sdkInt: 30,
          safUri: '/storage/857A-1AED/V5',
        }),
      /Only content:\/\/ URIs/,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SAF URI attestation transitions flags cleanly and handles permission revocation', () => {
  const { db, dir } = setupDb();
  try {
    const safUri = 'content://com.android.externalstorage.documents/tree/857A-1AED%3AV5';
    const sha = crypto.createHash('sha256').update('probe').digest('hex');

    const verified = recordNativeAndroidAttestation(db, {
      isNativeAndroid: true,
      manufacturer: 'OPPO',
      model: 'CPH1911',
      androidRelease: '11',
      sdkInt: 30,
      termuxPackageInstalled: true,
      safUri,
      persistedRead: true,
      persistedWrite: true,
      revoked: false,
      safProbeReport: {
        isNativeAndroidExecution: true,
        uri: safUri,
        testFileName: '.ng_ilmf_saf_probe_1234.tmp',
        state: 'AVAILABLE',
        storageReady: true,
        expectedSha256: sha,
        actualSha256: sha,
        contentMatched: true,
        cleanupCompleted: true,
      },
    });

    assert.equal(verified.flags.HOST_ONLY, false);
    assert.equal(verified.flags.ANDROID_CONNECTED, true);
    assert.equal(verified.flags.TERMUX_CONNECTED, true);
    assert.equal(verified.flags.SD_AUTHORIZED, true);
    assert.equal(verified.flags.SD_READ_WRITE_VERIFIED, true);

    // Revoke permission -> immediately resets SD_AUTHORIZED & SD_READ_WRITE_VERIFIED
    const revoked = revokeAndroidSafAuthorization(db);
    assert.equal(revoked.flags.SD_AUTHORIZED, false);
    assert.equal(revoked.flags.SD_READ_WRITE_VERIFIED, false);
    assert.equal(revoked.permissionRevoked, true);
    assert.equal(getConfigMap(db).archive_location_confirmed, 'false');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
