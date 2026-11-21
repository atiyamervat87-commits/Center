import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setDatabaseForTests } from '../server/db/database.ts';
import { createApiRouter } from '../server/routes/api.ts';
import {
  resetAuthRateLimiterForTests,
} from '../server/services/securityService.ts';
import { executeOwnerApprovedCleanup } from '../server/services/deviceManagerService.ts';
import { normalizeArchiveRootPath } from '../server/storage/storageProvider.ts';
import {
  assertWorkerUrlSafeBeforeFetch,
  validateWorkerEndpointUrl,
} from '../server/utils/urlSecurity.ts';
import {
  encodeText,
  decodeTokens,
  inspectTokenizerFile,
  trainTokenizerFromCorpus,
} from '../server/ml/tokenizerEngine.ts';
import {
  buildNgwtBinaryBuffer,
  decodeNgwtFloats,
  executeLocalTrainingStep,
  inspectBinaryWeightsBuffer,
  NGWT_MAGIC,
} from '../server/ml/neuralMindEngine.ts';
import {
  buildWorkerAuthHeaders,
  createIndependentMind,
  createTrainingJob,
  intakeExternalModel,
  registerWorker,
  restoreTrainingCheckpoint,
  saveTrainingCheckpoint,
  transferResourceToWorker,
  updateTrainingJobControl,
} from '../server/services/mindFactoryService.ts';
import { syncOnlineWorkersTelemetry } from '../server/services/realtimeSyncService.ts';
import {
  processAndBuildDatasetPackage,
  registerResource,
} from '../server/services/dataFactoryService.ts';
import {
  executeModelRepair,
  receiveExternalModelForRepair,
  transitionProductLifecycle,
} from '../server/services/repairRegistryService.ts';
import { runTenSuiteQcCheck } from '../server/services/trustQcService.ts';
import {
  buildCertifiedDeliveryPackage,
  verifyDeliveryPackageIntegrity,
} from '../server/services/ngIpService.ts';
import { buildZipArchive, extractAndVerifyZipArchive } from '../server/utils/zipBuilder.ts';

function setupIsolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-ilmf-rem-'));
  const dbPath = path.join(dir, 'ng_ilmf_remediation.sqlite');
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
  stmt.run('perm_export_requires_auth', 'true', '', now);
  stmt.run('perm_delete_requires_auth', 'true', '', now);
  stmt.run('perm_pairing_requires_auth', 'true', '', now);
  return { db, dir, dbPath };
}

test('Security API HTTP Suite: pre-lock block, bootstrap claim protection, secret redaction, RBAC, revocation & rate limit', async () => {
  const { db, dir } = setupIsolatedDb();
  setDatabaseForTests(db);
  resetAuthRateLimiterForTests();
  const prevBootstrap = process.env.NG_ILMF_BOOTSTRAP_TOKEN;
  process.env.NG_ILMF_BOOTSTRAP_TOKEN = 'boot-secret-9988';

  const app = express();
  app.use(
    express.json({
      limit: '4mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf-8');
      },
    }),
  );
  app.use('/api/v1', createApiRouter());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 1. Pre-lock sensitive endpoints MUST fail closed (403)
    const preCreateRes = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P1', projectType: 'LLM', rootPath: dir }),
    });
    assert.equal(preCreateRes.status, 403);

    const preWorkerRes = await fetch(`${base}/wings/mind/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerName: 'W1',
        endpointUrl: 'https://worker.example.com',
        gpuModel: 'A100',
        vramGb: 80,
        systemRamGb: 128,
      }),
    });
    assert.equal(preWorkerRes.status, 403);

    // 2. Bootstrap token required for initial owner claim
    const badBootRes = await fetch(`${base}/security/setup-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'StrongOwnerKey-2026', bootstrapToken: 'wrong-token' }),
    });
    assert.equal(badBootRes.status, 400);

    const goodBootRes = await fetch(`${base}/security/setup-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passkey: 'StrongOwnerKey-2026',
        bootstrapToken: 'boot-secret-9988',
        deviceLabel: 'Primary Owner Workstation',
      }),
    });
    assert.equal(goodBootRes.status, 201);
    const bootJson = (await goodBootRes.json()) as { sessionToken: string; sessionId: string };
    const ownerToken = bootJson.sessionToken;
    assert.ok(ownerToken.startsWith('ng_owner_'));

    // Duplicate unauthenticated setup-owner hijack MUST be blocked (403)
    const hijackRes = await fetch(`${base}/security/setup-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passkey: 'AttackerTakeover-9999',
        bootstrapToken: 'boot-secret-9988',
      }),
    });
    assert.equal(hijackRes.status, 403);

    // 3. GET /config NEVER returns owner_passkey_hash or secrets
    const cfgRes = await fetch(`${base}/config`);
    assert.equal(cfgRes.status, 200);
    const cfgBody = (await cfgRes.json()) as { config: Record<string, string> };
    assert.equal(cfgBody.config.owner_lock_configured, 'true');
    assert.equal('owner_passkey_hash' in cfgBody.config, false);
    assert.equal('worker_hmac_secrets_json' in cfgBody.config, false);
    assert.equal('android_attestation_challenges_json' in cfgBody.config, false);

    // 4. Unauthenticated mutating calls blocked with 401
    const unauthProj = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'NoAuth', projectType: 'LLM', rootPath: dir }),
    });
    assert.equal(unauthProj.status, 401);

    const unauthCfg = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_device_model: 'Hijacked' }),
    });
    assert.equal(unauthCfg.status, 401);

    // 5. RBAC verification: VIEWER (no mutations), OPERATOR (mutate ok, admin/delete blocked), OWNER (all ok)
    const viewerLogin = await fetch(`${base}/security/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'StrongOwnerKey-2026', deviceLabel: 'Auditor Tablet', role: 'VIEWER' }),
    });
    assert.equal(viewerLogin.status, 200);
    const viewerToken = ((await viewerLogin.json()) as { sessionToken: string }).sessionToken;

    const viewerMutate = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ name: 'ViewerBlocked', projectType: 'LLM', rootPath: dir }),
    });
    assert.equal(viewerMutate.status, 403);

    const opLogin = await fetch(`${base}/security/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'StrongOwnerKey-2026', deviceLabel: 'Floor Operator', role: 'OPERATOR' }),
    });
    assert.equal(opLogin.status, 200);
    const opJson = (await opLogin.json()) as { sessionToken: string; sessionId: string };

    const opCreate = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opJson.sessionToken}` },
      body: JSON.stringify({ name: 'OperatorAllowedProject', projectType: 'LLM', rootPath: dir }),
    });
    assert.equal(opCreate.status, 201);

    const opAdmin = await fetch(`${base}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opJson.sessionToken}` },
      body: JSON.stringify({ target_device_model: 'Blocked' }),
    });
    assert.equal(opAdmin.status, 403);

    // Revoke Operator session -> subsequent request blocked with 401
    const revokeRes = await fetch(`${base}/security/sessions/${opJson.sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(revokeRes.status, 200);

    const opAfterRevoke = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opJson.sessionToken}` },
      body: JSON.stringify({ name: 'PostRevoke', projectType: 'LLM', rootPath: dir }),
    });
    assert.equal(opAfterRevoke.status, 401);

    // 6. Rate limiting: 5 bad login attempts -> 6th returns 429 + Retry-After
    for (let i = 0; i < 5; i++) {
      const failRes = await fetch(`${base}/security/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passkey: `bad-guess-${i}` }),
      });
      assert.equal(failRes.status, 401);
    }
    const lockedRes = await fetch(`${base}/security/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'StrongOwnerKey-2026' }),
    });
    assert.equal(lockedRes.status, 429);
    assert.ok(Number(lockedRes.headers.get('retry-after')) >= 1);
  } finally {
    resetAuthRateLimiterForTests();
    if (prevBootstrap === undefined) delete process.env.NG_ILMF_BOOTSTRAP_TOKEN;
    else process.env.NG_ILMF_BOOTSTRAP_TOKEN = prevBootstrap;
    setDatabaseForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SSRF Protection, Symlink & SQLite Cleanup Guards, Archive Path Normalization & Android Challenge-Response', async () => {
  const { db, dir, dbPath } = setupIsolatedDb();
  setDatabaseForTests(db);
  resetAuthRateLimiterForTests();

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createApiRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 1. SSRF validation blocks metadata / RFC1918 / local command-center URL
    assert.equal(validateWorkerEndpointUrl('http://169.254.169.254/latest/meta-data').ok, false);
    assert.equal(validateWorkerEndpointUrl('http://10.0.0.12:8000').ok, false);
    assert.equal(validateWorkerEndpointUrl('http://192.168.1.25:9000').ok, false);
    assert.equal(validateWorkerEndpointUrl('http://127.0.0.1:3000/api/v1').ok, false);
    assert.equal(validateWorkerEndpointUrl('file:///etc/passwd').ok, false);
    assert.equal(validateWorkerEndpointUrl('http://127.0.0.1:54321').ok, true);
    await assert.rejects(
      () => assertWorkerUrlSafeBeforeFetch('http://169.254.169.254/latest/meta-data'),
      /Blocked/,
    );

    // 2. Archive root double-nesting fix
    assert.equal(
      normalizeArchiveRootPath('/storage/857A-1AED/V5/NG-ILMF_ARCHIVE'),
      '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE',
    );
    assert.equal(
      normalizeArchiveRootPath('/storage/857A-1AED/V5/'),
      '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE',
    );

    // 3. Symlink escape & SQLite-WAL protection in device cleanup
    const outsideTarget = path.join(os.tmpdir(), `ng-outside-sym-${Date.now()}.txt`);
    fs.writeFileSync(outsideTarget, 'protected outside content');
    const escapeSymlink = path.join(dir, 'cache', 'escape_link.txt');
    fs.mkdirSync(path.dirname(escapeSymlink), { recursive: true });
    fs.symlinkSync(outsideTarget, escapeSymlink);

    assert.throws(
      () => executeOwnerApprovedCleanup(db, { filePath: escapeSymlink, ownerApproved: true }),
      /Blocked:/,
    );
    assert.ok(fs.existsSync(outsideTarget));
    fs.unlinkSync(outsideTarget);

    const walPath = `${dbPath}-wal`;
    fs.writeFileSync(walPath, 'dummy-wal-guard-check');
    assert.throws(
      () => executeOwnerApprovedCleanup(db, { filePath: walPath, ownerApproved: true }),
      /SQLite/,
    );

    // 4. Android challenge-response attestation + anti-replay
    const setupRes = await fetch(`${base}/security/setup-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey: 'AndroidBridgeKey-99' }),
    });
    const { sessionToken } = (await setupRes.json()) as { sessionToken: string };

    const chRes = await fetch(`${base}/android/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(chRes.status, 200);
    const ch = (await chRes.json()) as { challengeId: string; challenge: string };

    const safUri = 'content://com.android.externalstorage.documents/tree/857A-1AED%3ANG-ILMF_ARCHIVE';
    const expectedSha = crypto.createHash('sha256').update('probe-payload').digest('hex');

    // Invalid HMAC proof rejected
    const badAttest = await fetch(`${base}/android/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        isNativeAndroid: true,
        model: 'OPPO CPH1911',
        sdkInt: 30,
        safUri,
        persistedRead: true,
        persistedWrite: true,
        challengeId: ch.challengeId,
        challenge: ch.challenge,
        proofSignature: '0'.repeat(64),
        safProbeReport: {
          isNativeAndroidExecution: true,
          uri: safUri,
          state: 'AVAILABLE',
          storageReady: true,
          expectedSha256: expectedSha,
          actualSha256: expectedSha,
          contentMatched: true,
          cleanupCompleted: true,
        },
      }),
    });
    assert.equal(badAttest.status, 400);

    // Valid HMAC proof succeeds
    const proofMsg = `OPPO CPH1911|30|${safUri}|${expectedSha}|${ch.challenge}`;
    const validProof = crypto.createHmac('sha256', ch.challenge).update(proofMsg).digest('hex');
    const goodAttest = await fetch(`${base}/android/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        isNativeAndroid: true,
        model: 'OPPO CPH1911',
        sdkInt: 30,
        safUri,
        persistedRead: true,
        persistedWrite: true,
        challengeId: ch.challengeId,
        challenge: ch.challenge,
        proofSignature: validProof,
        safProbeReport: {
          isNativeAndroidExecution: true,
          uri: safUri,
          state: 'AVAILABLE',
          storageReady: true,
          expectedSha256: expectedSha,
          actualSha256: expectedSha,
          contentMatched: true,
          cleanupCompleted: true,
        },
      }),
    });
    assert.equal(goodAttest.status, 200);
    const attestJson = (await goodAttest.json()) as {
      diagnostics: { flags: { ANDROID_CONNECTED: boolean; SD_READ_WRITE_VERIFIED: boolean } };
    };
    assert.equal(attestJson.diagnostics.flags.ANDROID_CONNECTED, true);
    assert.equal(attestJson.diagnostics.flags.SD_READ_WRITE_VERIFIED, true);

    // Replay of consumed challenge MUST fail
    const replayAttest = await fetch(`${base}/android/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        isNativeAndroid: true,
        model: 'OPPO CPH1911',
        sdkInt: 30,
        safUri,
        persistedRead: true,
        persistedWrite: true,
        challengeId: ch.challengeId,
        challenge: ch.challenge,
        proofSignature: validProof,
      }),
    });
    assert.equal(replayAttest.status, 400);
  } finally {
    resetAuthRateLimiterForTests();
    setDatabaseForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Real ML Artifacts, Mutual-Auth HTTP Worker Transfer/Telemetry, Binary Checkpoints, Repair & Strict QC/NG-IP ZIP', async () => {
  const { db, dir } = setupIsolatedDb();
  setDatabaseForTests(db);
  resetAuthRateLimiterForTests();

  // Ephemeral Mutual-Auth Worker validating x-ng-worker-signature on every call!
  const chunkTransfers = new Map<string, { chunks: Buffer[]; expectedSha: string }>();
  let workerSecretForVerify = '';
  const receivedControls: string[] = [];

  const verifyIncomingWorkerSig = (req: http.IncomingMessage, bodyText: string): boolean => {
    const wid = String(req.headers['x-ng-worker-id'] || '');
    const ts = String(req.headers['x-ng-worker-timestamp'] || '');
    const sig = String(req.headers['x-ng-worker-signature'] || '');
    if (!wid || !ts || !sig || !workerSecretForVerify) return false;
    const bodyHash = crypto.createHash('sha256').update(bodyText, 'utf-8').digest('hex');
    const expected = crypto.createHmac('sha256', workerSecretForVerify).update(`${wid}|${ts}|${bodyHash}`).digest('hex');
    return expected === sig;
  };

  let activeJobId = '';
  const mockWorker = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      if (!verifyIncomingWorkerSig(req, bodyText)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Worker mutual auth failed' }));
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/transfer/init' && req.method === 'POST') {
        const b = JSON.parse(bodyText) as { transferId: string; chunkCount: number; fileSha256: string };
        chunkTransfers.set(b.transferId, {
          chunks: new Array<Buffer>(b.chunkCount),
          expectedSha: b.fileSha256,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/transfer/chunk' && req.method === 'POST') {
        const b = JSON.parse(bodyText) as {
          transferId: string;
          index: number;
          sha256: string;
          dataBase64: string;
        };
        const state = chunkTransfers.get(b.transferId)!;
        const buf = Buffer.from(b.dataBase64, 'base64');
        assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), b.sha256);
        state.chunks[b.index] = buf;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/transfer/finalize' && req.method === 'POST') {
        const b = JSON.parse(bodyText) as { transferId: string; fileSha256: string };
        const state = chunkTransfers.get(b.transferId)!;
        const assembled = Buffer.concat(state.chunks);
        const assembledSha256 = crypto.createHash('sha256').update(assembled).digest('hex');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            verified: assembledSha256 === b.fileSha256,
            assembledSha256,
          }),
        );
        return;
      }
      if (req.url === '/jobs' && req.method === 'POST') {
        const b = JSON.parse(bodyText) as { jobId: string };
        activeJobId = b.jobId;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      if (req.url?.endsWith('/control') && req.method === 'POST') {
        const b = JSON.parse(bodyText) as { action: string };
        receivedControls.push(b.action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acknowledged: true }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jobs: activeJobId
              ? [{ jobId: activeJobId, currentStep: 15, trainingLoss: 1.25, jobStatus: 'RUNNING' }]
              : [],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => mockWorker.listen(0, '127.0.0.1', resolve));
  const workerAddr = mockWorker.address() as { port: number };
  const workerUrl = `http://127.0.0.1:${workerAddr.port}`;

  const app = express();
  app.use(
    express.json({
      limit: '4mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf-8');
      },
    }),
  );
  app.use('/api/v1', createApiRouter());
  const apiServer = http.createServer(app);
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}/api/v1`;

  try {
    // 1. BPE Tokenizer + NGWT binary weights creation + JSON rejection
    const tok = trainTokenizerFromCorpus(
      ['الذكاء الاصطناعي السيادي والنماذج اللغوية', 'Sovereign NG-ILMF transformer architecture'],
      { spec: 'NG-BPE-AR-EN', targetMerges: 32 },
    );
    const sample = 'الذكاء الاصطناعي NG-ILMF';
    const encoded = encodeText(tok, sample, { addBos: true, addEos: true });
    assert.equal(decodeTokens(tok, encoded), sample.normalize('NFC'));

    const fakeJsonWeights = path.join(dir, 'fake_weights.json');
    fs.writeFileSync(fakeJsonWeights, JSON.stringify({ fakeWeights: [1, 2, 3] }), 'utf-8');
    assert.throws(
      () =>
        intakeExternalModel(db, {
          name: 'Fake-Json-Model',
          version: '1.0.0',
          architectureSummary: 'Transformer 7B',
          scaleTier: '7B',
          license: 'Apache-2.0',
          weightsPath: fakeJsonWeights,
          originSource: 'UNTRUSTED',
        }),
      /plain JSON metadata, not binary model weights/,
    );

    // 2. Data Factory: RFC-4180 CSV + real DOCX ZIP + PDF honest rejection + train/val/test split + tokenization gate
    const docxZip = buildZipArchive([
      {
        name: 'word/document.xml',
        content:
          '<w:document><w:body><w:p><w:r><w:t>NG-ILMF Arabic &amp; English Engineering Manual line one.</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    const pkg = processAndBuildDatasetPackage(db, {
      datasetName: 'Multimodal-Clean-Corpus',
      license: 'Apache-2.0',
      originSource: 'CURATED',
      rawFiles: [
        {
          fileName: 'qa.csv',
          contentText: 'prompt,answer\n"Explain, Step 1","Line A\nLine B with comma, inside quotes"\n',
        },
        {
          fileName: 'manual.docx',
          contentBase64: docxZip.buffer.toString('base64'),
        },
      ],
      stripHtml: true,
      deduplicateLines: true,
      minLineLength: 8,
      format: 'JSONL',
    });
    assert.ok(pkg.stats.cleanedLinesCount >= 2);
    assert.equal(pkg.qualityGate.readyForTraining, true);
    assert.ok(fs.existsSync(pkg.splits.trainPath));
    assert.ok(fs.existsSync(pkg.splits.valPath));
    assert.ok(fs.existsSync(pkg.splits.testPath));
    assert.ok(pkg.tokenStats.totalTokens > 0);
    assert.equal(pkg.tokenStats.unkRate, 0);

    // PDF without native parser must fail cleanly instead of scraping raw PDF binary
    assert.throws(
      () =>
        processAndBuildDatasetPackage(db, {
          datasetName: 'PDF-Test',
          license: 'Apache-2.0',
          originSource: 'RAW',
          rawFiles: [{ fileName: 'spec.pdf', contentText: '%PDF-1.7\n1 0 obj\n<<>>\nendobj' }],
        }),
      /Native PDF binary parser/,
    );

    // 3. Create Independent Mind -> NGWT binary + tokenizer.json verified
    const mind = createIndependentMind(db, {
      name: 'NG-Real-Mind-1B',
      version: '1.0.0',
      scaleTier: '1B',
      architecture: 'NG-Decoder-GQA',
      tokenizerSpec: 'NG-BPE-TEST',
      license: 'NG-COMMERCIAL',
      baseDatasetId: pkg.resource.id,
    });
    const tokInspection = inspectTokenizerFile(path.join(mind.mindDir, 'tokenizer.json'));
    assert.equal(tokInspection.valid, true);
    assert.equal(tokInspection.roundTripPassed, true);

    // 4. Register mutual-auth worker, verify OFFLINE->ONLINE recovery, chunked HTTP transfer, signed job control, and telemetry HMAC gate
    workerSecretForVerify = 'super-strong-worker-hmac-secret-2026';
    const worker = registerWorker(db, {
      workerName: 'MutualAuth-A100',
      endpointUrl: workerUrl,
      gpuModel: 'A100 80GB',
      vramGb: 80,
      systemRamGb: 256,
      authSecret: workerSecretForVerify,
    });
    assert.equal(worker.status, 'OFFLINE');

    // Sync probes OFFLINE worker and recovers it to ONLINE!
    const recoverySync = await syncOnlineWorkersTelemetry(db);
    assert.equal(recoverySync.onlineWorkers, 1);

    // Execute real chunked HTTP transfer with SHA-256 verification
    const xfer = await transferResourceToWorker(db, {
      resourceId: mind.resourceId,
      workerId: worker.id,
      chunkSizeBytes: 8192,
    });
    assert.equal(xfer.verified, true);
    assert.ok(xfer.chunkCount >= 2);
    assert.equal(xfer.workerAssembledSha256, xfer.fileSha256);

    // Create & dispatch job -> telemetry gate rejects unsigned POST -> accepts signed POST
    const { job } = await createTrainingJob(db, {
      modelId: mind.productId,
      datasetId: pkg.resource.id,
      workerId: worker.id,
      architecture: 'NG-Decoder-GQA',
      scaleTier: '1B',
      totalSteps: 50,
      dispatchToWorker: true,
    });

    const forgedTelemetry = await fetch(`${apiBase}/wings/mind/jobs/${job.id}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStep: 99, trainingLoss: 0.001 }),
    });
    assert.equal(forgedTelemetry.status, 401);

    const signedBody = JSON.stringify({ currentStep: 5, trainingLoss: 1.85, validationLoss: 1.92, jobStatus: 'RUNNING' });
    const signedTelemetry = await fetch(`${apiBase}/wings/mind/jobs/${job.id}/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildWorkerAuthHeaders(db, worker.id, signedBody),
      },
      body: signedBody,
    });
    assert.equal(signedTelemetry.status, 200);

    // Job control sends signed command to live worker
    const paused = await updateTrainingJobControl(db, job.id, 'PAUSE', { requireWorkerAck: true });
    assert.equal(paused.workerAcknowledged, true);
    assert.equal(paused.jobStatus, 'PAUSED');
    assert.deepEqual(receivedControls, ['PAUSE']);

    // Binary NGCK-V1 Checkpoint & Resume Training Step Verification
    const cp = saveTrainingCheckpoint(db, { jobId: job.id, step: 6 });
    const restored = restoreTrainingCheckpoint(db, job.id, cp.checkpointPath);
    assert.equal(restored.restoredStep, 6);
    assert.equal(restored.adamRestored, true);

    // Corrupted tensor weights -> SANITIZE_NAN_INF repair -> INT8_QUANTIZE -> stale QC invalidation -> 10/10 PASS -> NG-IP ZIP
    // First inject a NaN float inside an NGWT-V1 container for external repair intake
    const corruptBuilt = buildNgwtBinaryBuffer({
      mindId: 'CORRUPT-01',
      name: 'Corrupt-Model',
      version: '1.0.0',
      architecture: 'NG-Decoder',
      scaleTier: '1B',
      vocabSize: 270,
      numLayers: 2,
      hiddenDim: 16,
    });
    const decodedCorrupt = corruptBuilt.weightsFloats;
    decodedCorrupt[0] = Number.NaN;
    decodedCorrupt[5] = Number.POSITIVE_INFINITY;
    const withNan = buildNgwtBinaryBuffer({
      mindId: 'CORRUPT-01',
      name: 'Corrupt-Model',
      version: '1.0.0',
      architecture: 'NG-Decoder',
      scaleTier: '1B',
      vocabSize: 270,
      numLayers: 2,
      hiddenDim: 16,
      weightsFloatOverride: decodedCorrupt,
    });
    const inspNan = inspectBinaryWeightsBuffer(withNan.buffer);
    assert.equal(inspNan.nonFiniteCount, 2);

    const tokCopyPath = path.join(dir, 'corrupt_tok.json');
    fs.copyFileSync(path.join(mind.mindDir, 'tokenizer.json'), tokCopyPath);

    const repairIntake = receiveExternalModelForRepair(db, {
      name: 'Corrupt-Model',
      version: '1.0.0',
      originSource: 'EXTERNAL_FIX',
      license: 'Apache-2.0',
      architectureSummary: 'NG-Decoder 2L',
      fileName: 'corrupt.ngbin',
      fileBase64: withNan.buffer.toString('base64'),
      tokenizerPath: tokCopyPath,
    });

    // QC must FAIL because nonFiniteCount = 2!
    const preRepairQc = runTenSuiteQcCheck(db, repairIntake.product.id);
    assert.equal(preRepairQc.allPassed, false);
    assert.equal(
      preRepairQc.reports.find((r) => r.testSuite === 'WEIGHTS_SHA256_INTEGRITY')?.result,
      'FAIL',
    );

    // Execute real binary repair SANITIZE_NAN_INF -> QC 10/10 PASS -> Approve -> INT8_QUANTIZE invalidates QC cleanly!
    const sanitized = executeModelRepair(db, {
      productId: repairIntake.product.id,
      operation: 'SANITIZE_NAN_INF',
      newVersion: '1.1.0',
      safetyNotes: 'Cleaned non-finite weights and verified zero NaN/Inf tensors',
      changelog: 'Sanitized 2 non-finite floats across NGWT tensors',
    });
    assert.equal(sanitized.nanFixedCount, 2);

    const postRepairQc = runTenSuiteQcCheck(db, sanitized.product.id);
    assert.equal(postRepairQc.allPassed, true);
    assert.equal(postRepairQc.passedCount, 10);

    transitionProductLifecycle(db, sanitized.product.id, 'APPROVED');

    // Now quantize to INT8 -> MUST invalidate previous APPROVED state and stale QC!
    const quantized = executeModelRepair(db, {
      productId: sanitized.product.id,
      operation: 'INT8_QUANTIZE',
      newVersion: '1.2.0-int8',
      safetyNotes: 'Quantized weights to signed int8 per-tensor scale with zero NaN',
      changelog: 'INT8 quantized NGWT release',
    });
    assert.equal(quantized.dtype, 'i8');
    assert.equal(quantized.product.lifecycleState, 'EVALUATION');
    assert.equal(quantized.product.qcPassedCount, 0);

    // Re-approve blocked until fresh 10/10 QC passes on v1.2.0-int8
    assert.throws(
      () => transitionProductLifecycle(db, quantized.product.id, 'APPROVED'),
      /mandatory QC suites/,
    );

    const int8Qc = runTenSuiteQcCheck(db, quantized.product.id);
    assert.equal(int8Qc.allPassed, true);
    transitionProductLifecycle(db, quantized.product.id, 'APPROVED');
    transitionProductLifecycle(db, quantized.product.id, 'RELEASED');

    const pkgOut = buildCertifiedDeliveryPackage(db, quantized.product.id);
    const verifiedZip = verifyDeliveryPackageIntegrity(db, pkgOut.id);
    assert.equal(verifiedZip.allEntriesVerified, true);
    assert.equal(verifiedZip.containsBinaryWeights, true);
    assert.equal(verifiedZip.sha256Matched, true);

    const unpacked = extractAndVerifyZipArchive(fs.readFileSync(pkgOut.zipPath));
    assert.equal(unpacked.entries.has('tokenizer.json'), true);
    assert.equal(unpacked.entries.has('QC_EVIDENCE.json'), true);
    const decodedWeightsFromZip = Array.from(unpacked.entries.keys()).find((k) => k.startsWith('weights/'));
    assert.ok(decodedWeightsFromZip);
    assert.ok(unpacked.entries.get(decodedWeightsFromZip!)!.content.subarray(0, 4).equals(NGWT_MAGIC));

    // Also verify decodeNgwtFloats + executeLocalTrainingStep converges cleanly
    const dec = decodeNgwtFloats(sanitized.repairedWeightsPath);
    const m = new Float32Array(dec.floats.length);
    const v = new Float32Array(dec.floats.length);
    const step1 = executeLocalTrainingStep({
      weights: dec.floats,
      adamM: m,
      adamV: v,
      step: 0,
      learningRate: 1e-2,
      sampleSignalSeed: 7,
    });
    const step2 = executeLocalTrainingStep({
      weights: dec.floats,
      adamM: m,
      adamV: v,
      step: 1,
      learningRate: 1e-2,
      sampleSignalSeed: 7,
    });
    assert.ok(Number.isFinite(step1.trainingLoss) && Number.isFinite(step2.trainingLoss));
  } finally {
    resetAuthRateLimiterForTests();
    setDatabaseForTests(null);
    await new Promise<void>((resolve) => mockWorker.close(() => resolve()));
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
