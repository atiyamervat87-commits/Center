import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDatabase, getConfigMap, setConfigValue } from '../db/database.ts';
import { recordAuditEvent, listAuditLogs } from '../audit/auditService.ts';
import { getMasterDashboardSnapshot, getArchitectureModules } from '../services/dashboardService.ts';
import { probeDeviceEnvironment, runProviderIntegrityTest } from '../storage/storageProbe.ts';
import type { StorageProviderId } from '../storage/storageProvider.ts';
import {
  computeAndroidBridgeDiagnostics,
  issueAndroidAttestationChallenge,
  recordNativeAndroidAttestation,
  revokeAndroidSafAuthorization,
} from '../storage/androidBridgeDiagnostic.ts';
import {
  createProject,
  exportProjectReport,
  getProjectDetail,
  linkResourceToProject,
  listAvailableIndependentResources,
  listProjects,
  unlinkResourceFromProject,
  updateProject,
  type ProjectStatus,
} from '../services/projectService.ts';
import {
  executeOwnerApprovedCleanup,
  getDeviceManagerSnapshot,
} from '../services/deviceManagerService.ts';
import {
  checkAuthRateLimit,
  clearAuthFailures,
  getSecuritySnapshot,
  isAuthorizedForAction,
  loginOwnerSession,
  recordAuthFailure,
  revokeOwnerSession,
  sanitizeConfigForClient,
  setupOwnerPasskey,
  updateSecurityPermissions,
  type SecurityPermissions,
  type SessionRole,
} from '../services/securityService.ts';
import {
  getIsolatedDemoCatalog,
  resetDemoSession,
  runIsolatedDemoInference,
} from '../services/demoService.ts';
import {
  archiveResourceToSmartArchive,
  deleteResourceSafely,
  generateDataFactoryManifest,
  getResourceLibraryIntegrityStatus,
  listArchiveEntries,
  listResources,
  processAndBuildDatasetPackage,
  registerResource,
  startBackgroundResourceIntegrityCheck,
  verifyArchiveIntegrityBatch,
  verifyResourceIntegrity,
  type ArchiveCategoryFolder,
  type LibrarySection,
} from '../services/dataFactoryService.ts';
import {
  createIndependentMind,
  createTrainingJob,
  getScalePlanningMatrix,
  getTrainingJobLogs,
  intakeExternalModel,
  listTrainingJobs,
  listWorkers,
  prepareTransferManifest,
  probeWorkerConnection,
  recordJobTelemetry,
  registerWorker,
  restoreTrainingCheckpoint,
  saveTrainingCheckpoint,
  transferResourceToWorker,
  updateTrainingJobControl,
  verifyWorkerTelemetryAuth,
  type ModelScaleTier,
  type TrainingJobRecord,
} from '../services/mindFactoryService.ts';
import {
  collectPerformanceMetrics,
  collectTrainingMetrics,
  getRealtimeSyncService,
} from '../services/realtimeSyncService.ts';
import {
  executeModelRepair,
  listModelProducts,
  receiveExternalModelForRepair,
  registerOrRepairProduct,
  transitionProductLifecycle,
  type ModelLifecycleState,
  type NgProductClass,
} from '../services/repairRegistryService.ts';
import { listQcReports, runTenSuiteQcCheck } from '../services/trustQcService.ts';
import {
  buildCertifiedDeliveryPackage,
  listDeliveryPackages,
  verifyDeliveryPackageIntegrity,
} from '../services/ngIpService.ts';
import { resolveSafeRealPath } from '../utils/fsAtomic.ts';
import { validateWorkerEndpointUrl } from '../utils/urlSecurity.ts';

function readBearerToken(req: express.Request): string | undefined {
  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

function readOwnerToken(req: express.Request): string | undefined {
  const headerToken = req.header('x-ng-owner-token');
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return readBearerToken(req);
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

type AuthActionScope = 'export' | 'delete' | 'pairing' | 'mutate' | 'admin';

function requireOwnerAuth(actionType: AuthActionScope): express.RequestHandler {
  return (req, res, next) => {
    const db = getDatabase();
    const rawToken = readOwnerToken(req);
    const auth = isAuthorizedForAction(db, actionType, rawToken);
    if (!auth.allowed) {
      const config = getConfigMap(db);
      const lockConfigured = Boolean(config.owner_passkey_hash);
      // 401 when lock is configured and token is missing/expired/invalid; 403 for pre-lock block or RBAC denial
      const isRoleOrPrelock = !lockConfigured || Boolean(auth.role);
      res.status(isRoleOrPrelock ? 403 : 401).json({ error: auth.reason });
      return;
    }
    next();
  };
}

export function createApiRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    try {
      const db = getDatabase();
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      res.json({
        status: row.ok === 1 ? 'ONLINE' : 'ERROR',
        database: 'SQLite WAL',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        status: 'ERROR',
        error: err instanceof Error ? err.message : 'Database health check failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/dashboard', async (_req, res) => {
    try {
      const db = getDatabase();
      const snapshot = await getMasterDashboardSnapshot(db);
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load dashboard state',
      });
    }
  });

  // --- REAL-TIME DATA SYNCHRONIZATION SERVICE ENDPOINTS ---
  router.get('/sync/stream', (req, res) => {
    const db = getDatabase();
    void getRealtimeSyncService().subscribeSseClient(req, res, db);
  });

  router.get('/sync/metrics', (_req, res) => {
    const db = getDatabase();
    const syncService = getRealtimeSyncService();
    res.json({
      performanceMetrics: collectPerformanceMetrics(),
      trainingMetrics: collectTrainingMetrics(db),
      syncMetadata: syncService.getMetadata(),
    });
  });

  router.post('/sync/refresh', requireOwnerAuth('mutate'), async (_req, res) => {
    try {
      const db = getDatabase();
      const result = await getRealtimeSyncService().syncAndBroadcast(db, 'manual-sync');
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to synchronize live metrics',
      });
    }
  });

  router.get('/config', (_req, res) => {
    const db = getDatabase();
    const rawConfig = getConfigMap(db);
    const config = sanitizeConfigForClient(rawConfig);
    const environment = probeDeviceEnvironment(rawConfig);
    res.json({ config, environment });
  });

  router.put('/config', requireOwnerAuth('admin'), (req, res) => {
    const db = getDatabase();
    const updates = req.body as Record<string, unknown>;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON key-value object' });
      return;
    }

    if (typeof updates.bridge_endpoint === 'string' && updates.bridge_endpoint.trim()) {
      const urlCheck = validateWorkerEndpointUrl(updates.bridge_endpoint.trim());
      if (!urlCheck.ok) {
        res.status(400).json({ error: urlCheck.reason || 'Blocked unsafe bridge_endpoint URL' });
        return;
      }
      updates.bridge_endpoint = urlCheck.normalizedUrl;
    }

    const allowedKeys = new Set([
      'data_dir',
      'sd_archive_path',
      'termux_prefix',
      'termux_shared_path',
      'android_saf_uri',
      'selected_archive_provider',
      'target_device_model',
      'android_version',
      'bridge_endpoint',
    ]);

    const applied: Record<string, string> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (allowedKeys.has(key) && typeof value === 'string') {
        setConfigValue(db, key, value.trim());
        applied[key] = value.trim();
      }
    }

    if (Object.keys(applied).length === 0) {
      res.status(400).json({ error: 'No valid configuration keys provided' });
      return;
    }

    // Invalidate previous owner confirmation & verification if archive path or provider changed
    if (
      'sd_archive_path' in applied ||
      'selected_archive_provider' in applied ||
      'termux_shared_path' in applied ||
      'android_saf_uri' in applied
    ) {
      setConfigValue(db, 'archive_location_confirmed', 'false');
      setConfigValue(db, 'last_storage_verification_json', '');
    }

    const auditEntry = recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'CONFIG',
      action: 'UPDATE_RUNTIME_CONFIG',
      target: Object.keys(applied).join(', '),
      outcome: 'PASS',
      details: applied,
    });

    const rawConfig = getConfigMap(db);
    const config = sanitizeConfigForClient(rawConfig);
    const environment = probeDeviceEnvironment(rawConfig);
    res.json({ config, environment, auditEntry });
  });

  router.post('/system/verify-storage', requireOwnerAuth('mutate'), (req, res) => {
    const db = getDatabase();
    const config = getConfigMap(db);
    const body = (req.body ?? {}) as { providerId?: StorageProviderId };
    const validProviders = new Set<StorageProviderId>([
      'host_dev',
      'android_saf',
      'termux',
      'external_sd',
    ]);

    const requestedProvider =
      body.providerId && validProviders.has(body.providerId)
        ? body.providerId
        : ((config.selected_archive_provider as StorageProviderId) || 'external_sd');

    const hostReport = runProviderIntegrityTest(config, 'host_dev');
    const targetReport =
      requestedProvider === 'host_dev'
        ? hostReport
        : runProviderIntegrityTest(config, requestedProvider);

    if (requestedProvider === (config.selected_archive_provider || 'external_sd')) {
      setConfigValue(db, 'last_storage_verification_json', JSON.stringify(targetReport));
    }

    const environment = probeDeviceEnvironment(config);
    const outcome =
      targetReport.storageReady && targetReport.state === 'AVAILABLE'
        ? 'PASS'
        : hostReport.storageReady
          ? 'PARTIAL'
          : 'FAIL';

    const auditEntry = recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'STORAGE_PROBE',
      action: 'RUN_SHA256_STORAGE_VERIFICATION',
      target: `${requestedProvider}: ${targetReport.configuredPath || 'UNSET'}`,
      outcome,
      details: {
        providerId: requestedProvider,
        environmentType: targetReport.environmentType,
        state: targetReport.state,
        contentMatched: targetReport.contentMatched,
        expectedSha256: targetReport.expectedSha256,
        actualSha256: targetReport.actualSha256,
        failureReason: targetReport.failureReason,
        hostDevState: hostReport.state,
      },
    });

    void getRealtimeSyncService().broadcastSnapshot(db, 'storage-verification');

    res.json({
      outcome,
      hostReport,
      report: targetReport,
      environment,
      auditEntry,
    });
  });

  router.post('/storage/approve-location', requireOwnerAuth('admin'), (req, res) => {
    const db = getDatabase();
    const body = (req.body ?? {}) as {
      providerId?: StorageProviderId;
      archivePath?: string;
      ownerConfirmed?: boolean;
      initializeDirectory?: boolean;
    };

    if (!body.ownerConfirmed) {
      res.status(400).json({ error: 'Explicit owner confirmation (ownerConfirmed: true) is required' });
      return;
    }

    const validProviders = new Set<StorageProviderId>([
      'host_dev',
      'android_saf',
      'termux',
      'external_sd',
    ]);
    const providerId: StorageProviderId =
      body.providerId && validProviders.has(body.providerId) ? body.providerId : 'external_sd';

    setConfigValue(db, 'selected_archive_provider', providerId);
    if (typeof body.archivePath === 'string' && body.archivePath.trim()) {
      if (providerId === 'external_sd') {
        setConfigValue(db, 'sd_archive_path', body.archivePath.trim());
      } else if (providerId === 'termux') {
        setConfigValue(db, 'termux_shared_path', body.archivePath.trim());
      } else if (providerId === 'android_saf') {
        setConfigValue(db, 'android_saf_uri', body.archivePath.trim());
      } else if (providerId === 'host_dev') {
        setConfigValue(db, 'data_dir', body.archivePath.trim());
      }
    }

    const updatedConfig = getConfigMap(db);
    const envBefore = probeDeviceEnvironment(updatedConfig);
    const activeProbe =
      providerId === 'host_dev'
        ? envBefore.hostEnvironment.provider
        : providerId === 'android_saf'
          ? envBefore.androidDeviceEnvironment.provider
          : providerId === 'termux'
            ? envBefore.termuxEnvironment.provider
            : envBefore.externalSdStorage.provider;

    // Never auto-create NG-ILMF_ARCHIVE unless the parent medium is mounted & writable AND owner requested initialization
    if (
      body.initializeDirectory &&
      providerId === 'external_sd' &&
      activeProbe.state === 'NOT_FOUND' &&
      activeProbe.writable &&
      activeProbe.configuredPath
    ) {
      const baseName = path.basename(activeProbe.configuredPath);
      if (baseName === 'NG-ILMF_ARCHIVE') {
        fs.mkdirSync(activeProbe.configuredPath, { recursive: true });
      }
    }

    const report = runProviderIntegrityTest(updatedConfig, providerId);
    const confirmed = report.storageReady && report.state === 'AVAILABLE';

    setConfigValue(db, 'archive_location_confirmed', confirmed ? 'true' : 'false');
    setConfigValue(db, 'last_storage_verification_json', JSON.stringify(report));

    const environment = probeDeviceEnvironment(getConfigMap(db));
    const auditEntry = recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'STORAGE_PROBE',
      action: 'APPROVE_ARCHIVE_STORAGE_LOCATION',
      target: `${providerId}: ${report.configuredPath}`,
      outcome: confirmed ? 'PASS' : 'BLOCKED',
      details: {
        providerId,
        state: report.state,
        storageReady: confirmed,
        expectedSha256: report.expectedSha256,
        actualSha256: report.actualSha256,
        failureReason: report.failureReason,
      },
    });

    res.status(confirmed ? 200 : 422).json({
      approved: confirmed,
      report,
      environment,
      auditEntry,
    });
  });

  router.get('/audit', (req, res) => {
    const db = getDatabase();
    const limit = Number(req.query.limit ?? 50);
    const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : 'ALL';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const logs = listAuditLogs(db, { limit, outcome, search });
    res.json({ logs });
  });

  router.get('/architecture', (_req, res) => {
    res.json({ modules: getArchitectureModules() });
  });

  // --- PHASE 2: Project Manager Endpoints ---
  router.get('/projects', (req, res) => {
    const db = getDatabase();
    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const projects = listProjects(db, { status, search });
    const independentResources = listAvailableIndependentResources(db);
    res.json({ projects, independentResources });
  });

  router.post('/projects', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = req.body as {
        name?: string;
        projectType?: string;
        rootPath?: string;
        version?: string;
        status?: ProjectStatus;
        dependencies?: string[];
        notes?: string;
      };
      const created = createProject(db, {
        name: body.name ?? '',
        projectType: body.projectType ?? '',
        rootPath: body.rootPath ?? '',
        version: body.version,
        status: body.status,
        dependencies: body.dependencies,
        notes: body.notes,
      });
      res.status(201).json({ project: created });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to create project',
      });
    }
  });

  router.get('/projects/:id', (req, res) => {
    const db = getDatabase();
    const project = getProjectDetail(db, req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const independentResources = listAvailableIndependentResources(db);
    res.json({ project, independentResources });
  });

  router.put('/projects/:id', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = req.body as {
        name?: string;
        projectType?: string;
        rootPath?: string;
        version?: string;
        status?: ProjectStatus;
        dependencies?: string[];
        notes?: string;
      };
      const updated = updateProject(db, req.params.id, body);
      if (!updated) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ project: updated });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update project',
      });
    }
  });

  router.post('/projects/:id/resources', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = req.body as { resourceId?: string; role?: string };
      if (!body.resourceId) {
        res.status(400).json({ error: 'resourceId is required' });
        return;
      }
      const project = linkResourceToProject(db, req.params.id, body.resourceId, body.role);
      res.json({ project });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to link resource',
      });
    }
  });

  router.delete('/projects/:id/resources/:resourceId', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const project = unlinkResourceFromProject(db, req.params.id, req.params.resourceId);
      res.json({ project });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to unlink resource',
      });
    }
  });

  router.post('/projects/:id/export', requireOwnerAuth('export'), (req, res) => {
    try {
      const db = getDatabase();
      const report = exportProjectReport(db, req.params.id);
      res.json({ report });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to export project report',
      });
    }
  });

  // --- Android Bridge Diagnostics & Cryptographic Challenge Attestation Endpoints ---
  router.get('/android/bridge-status', (_req, res) => {
    const db = getDatabase();
    const config = getConfigMap(db);
    const diagnostics = computeAndroidBridgeDiagnostics(config);
    res.json({ diagnostics });
  });

  router.post('/android/challenge', requireOwnerAuth('admin'), (_req, res) => {
    const db = getDatabase();
    const challenge = issueAndroidAttestationChallenge(db);
    res.json(challenge);
  });

  router.post('/android/attest', requireOwnerAuth('admin'), (req, res) => {
    try {
      const db = getDatabase();
      const diagnostics = recordNativeAndroidAttestation(db, req.body ?? {}, {
        requireChallenge: true,
      });
      res.json({ diagnostics });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Android attestation rejected',
      });
    }
  });

  router.post('/android/revoke', requireOwnerAuth('admin'), (_req, res) => {
    const db = getDatabase();
    const diagnostics = revokeAndroidSafAuthorization(db);
    res.json({ diagnostics });
  });

  // --- PHASE 8: Device & Resource Manager ---
  router.get('/device/status', (_req, res) => {
    const db = getDatabase();
    const snapshot = getDeviceManagerSnapshot(db);
    res.json(snapshot);
  });

  router.post('/device/cleanup', requireOwnerAuth('delete'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { filePath?: string; ownerApproved?: boolean };
      if (!body.filePath) {
        res.status(400).json({ error: 'filePath is required' });
        return;
      }
      const result = executeOwnerApprovedCleanup(db, {
        filePath: body.filePath,
        ownerApproved: Boolean(body.ownerApproved),
      });
      res.json({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cleanup failed';
      res.status(message.startsWith('Blocked:') ? 403 : 400).json({ error: message });
    }
  });

  // --- PHASE 8: Owner Security Center ---
  router.get('/security/status', (req, res) => {
    const db = getDatabase();
    const snapshot = getSecuritySnapshot(db, readOwnerToken(req));
    res.json(snapshot);
  });

  router.post('/security/setup-owner', (req, res) => {
    const clientKey = req.socket.remoteAddress || req.ip || 'local';
    const rate = checkAuthRateLimit(clientKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Too many authentication attempts. Retry after ${rate.retryAfterSeconds}s.`,
      });
      return;
    }

    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        passkey?: string;
        deviceLabel?: string;
        bootstrapToken?: string;
      };
      const isRemoteHttpRequest = !isLoopbackRemoteAddress(req.socket.remoteAddress);
      const result = setupOwnerPasskey(db, {
        passkey: body.passkey ?? '',
        deviceLabel: body.deviceLabel,
        currentToken: readOwnerToken(req),
        bootstrapToken: body.bootstrapToken,
        isRemoteHttpRequest,
      });
      clearAuthFailures(clientKey);
      res.status(201).json(result);
    } catch (err) {
      recordAuthFailure(clientKey);
      const msg = err instanceof Error ? err.message : 'Failed to configure owner passkey';
      const status = msg.startsWith('Blocked:') || msg.includes('already initialized') || msg.includes('Active OWNER')
        ? 403
        : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post('/security/login', (req, res) => {
    const clientKey = req.socket.remoteAddress || req.ip || 'local';
    const rate = checkAuthRateLimit(clientKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Too many failed login attempts. Retry after ${rate.retryAfterSeconds}s.`,
      });
      return;
    }

    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        passkey?: string;
        deviceLabel?: string;
        role?: SessionRole;
      };
      const result = loginOwnerSession(db, {
        passkey: body.passkey ?? '',
        deviceLabel: body.deviceLabel,
        role: body.role,
      });
      clearAuthFailures(clientKey);
      res.json(result);
    } catch (err) {
      recordAuthFailure(clientKey);
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Owner authentication failed',
      });
    }
  });

  router.post('/security/sessions/:id/revoke', requireOwnerAuth('admin'), (req, res) => {
    try {
      const db = getDatabase();
      const snapshot = revokeOwnerSession(db, req.params.id, readOwnerToken(req));
      res.json({ snapshot });
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'Failed to revoke session',
      });
    }
  });

  router.put('/security/permissions', requireOwnerAuth('admin'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as Partial<SecurityPermissions>;
      const snapshot = updateSecurityPermissions(db, body, readOwnerToken(req));
      res.json({ snapshot });
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : 'Failed to update security permissions',
      });
    }
  });

  // --- PHASE 8: Isolated Demo Mode ---
  router.get('/demo/catalog', async (_req, res) => {
    try {
      const db = getDatabase();
      const catalog = await getIsolatedDemoCatalog(db);
      res.json(catalog);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load isolated demo catalog',
      });
    }
  });

  router.post('/demo/infer', requireOwnerAuth('mutate'), async (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { productId?: string; prompt?: string };
      if (!body.productId || !body.prompt?.trim()) {
        res.status(400).json({ error: 'productId and non-empty prompt are required' });
        return;
      }
      const result = await runIsolatedDemoInference(db, {
        productId: body.productId,
        prompt: body.prompt.trim(),
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Demo inference unavailable';
      const isOffline = msg.includes('No real inference engine');
      res.status(isOffline ? 503 : 400).json({ error: msg });
    }
  });

  router.post('/demo/reset', requireOwnerAuth('mutate'), (_req, res) => {
    const db = getDatabase();
    const result = resetDemoSession(db);
    res.json(result);
  });

  // --- WING 1: DATA FACTORY (Resources & Smart Archive) ---
  router.get('/wings/data/resources', (req, res) => {
    const db = getDatabase();
    const section = typeof req.query.section === 'string' ? req.query.section : 'ALL';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const resources = listResources(db, { section, search });
    const archiveEntries = listArchiveEntries(db);
    res.json({ resources, archiveEntries });
  });

  router.get('/wings/data/resources/integrity', (_req, res) => {
    const db = getDatabase();
    res.json(getResourceLibraryIntegrityStatus(db));
  });

  router.post('/wings/data/resources/check-integrity', requireOwnerAuth('mutate'), (_req, res) => {
    try {
      const db = getDatabase();
      const result = startBackgroundResourceIntegrityCheck(db, () => {
        void getRealtimeSyncService().broadcastSnapshot(db, 'resource-library-integrity-checked');
      });
      res.status(result.started ? 202 : 200).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to start integrity verification',
      });
    }
  });

  router.post('/wings/data/resources', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        librarySection?: LibrarySection;
        name?: string;
        resourceType?: string;
        originSource?: string;
        license?: string;
        filePath?: string;
        contentText?: string;
        contentBase64?: string;
        originalFileName?: string;
        version?: string;
        dependencies?: string[];
        transferable?: boolean;
      };
      const result = registerResource(db, {
        librarySection: body.librarySection ?? 'DATASET',
        name: body.name ?? '',
        resourceType: body.resourceType ?? '',
        originSource: body.originSource ?? '',
        license: body.license ?? '',
        filePath: body.filePath,
        contentText: body.contentText,
        contentBase64: body.contentBase64,
        originalFileName: body.originalFileName,
        version: body.version,
        dependencies: body.dependencies,
        transferable: body.transferable,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'resource-registered');
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to register resource' });
    }
  });

  router.post('/wings/data/dataset-package', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        datasetName?: string;
        license?: string;
        originSource?: string;
        version?: string;
        sourceResourceIds?: string[];
        rawFiles?: Array<{ fileName: string; contentText?: string; contentBase64?: string }>;
        stripHtml?: boolean;
        deduplicateLines?: boolean;
        minLineLength?: number;
        format?: 'JSONL' | 'TXT';
      };
      const result = processAndBuildDatasetPackage(db, {
        datasetName: body.datasetName ?? '',
        license: body.license ?? '',
        originSource: body.originSource ?? 'DATA_FACTORY_PIPELINE',
        version: body.version,
        sourceResourceIds: body.sourceResourceIds,
        rawFiles: body.rawFiles,
        stripHtml: body.stripHtml,
        deduplicateLines: body.deduplicateLines,
        minLineLength: body.minLineLength,
        format: body.format,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'dataset-package-built');
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Dataset pipeline failed' });
    }
  });

  router.post('/wings/data/resources/:id/verify', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const resource = verifyResourceIntegrity(db, req.params.id);
      void getRealtimeSyncService().broadcastSnapshot(db, 'resource-verified');
      res.json({ resource });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Resource verify failed' });
    }
  });

  router.delete('/wings/data/resources/:id', requireOwnerAuth('delete'), (req, res) => {
    try {
      const db = getDatabase();
      const result = deleteResourceSafely(db, req.params.id);
      void getRealtimeSyncService().broadcastSnapshot(db, 'resource-deleted');
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      res.status(msg.startsWith('Blocked:') ? 409 : 400).json({ error: msg });
    }
  });

  router.post('/wings/data/archive', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        resourceId?: string;
        categoryFolder?: ArchiveCategoryFolder;
      };
      const entry = archiveResourceToSmartArchive(db, {
        resourceId: body.resourceId ?? '',
        categoryFolder: body.categoryFolder ?? 'DATASETS',
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'resource-archived');
      res.status(201).json({ entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Archive operation failed' });
    }
  });

  router.post('/wings/data/archive/verify', requireOwnerAuth('mutate'), (_req, res) => {
    try {
      const db = getDatabase();
      const summary = verifyArchiveIntegrityBatch(db);
      void getRealtimeSyncService().broadcastSnapshot(db, 'archive-batch-verified');
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Archive verify failed' });
    }
  });

  router.post('/wings/data/manifest', requireOwnerAuth('export'), (_req, res) => {
    try {
      const db = getDatabase();
      const manifest = generateDataFactoryManifest(db);
      void getRealtimeSyncService().broadcastSnapshot(db, 'data-manifest-generated');
      res.json({ manifest });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Manifest generation failed' });
    }
  });

  // --- WING 2: NEW MIND FACTORY (Intake, Workers/Bridge, Scaling 1B-30B+, Jobs) ---
  router.get('/wings/mind/overview', (_req, res) => {
    const db = getDatabase();
    res.json({
      workers: listWorkers(db),
      jobs: listTrainingJobs(db),
      scaleMatrix: getScalePlanningMatrix(),
    });
  });

  router.post('/wings/mind/workers', requireOwnerAuth('pairing'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        workerName?: string;
        endpointUrl?: string;
        gpuModel?: string;
        vramGb?: number;
        systemRamGb?: number;
        maxSupportedScale?: ModelScaleTier;
        authSecret?: string;
      };
      const worker = registerWorker(db, {
        workerName: body.workerName ?? '',
        endpointUrl: body.endpointUrl ?? '',
        gpuModel: body.gpuModel ?? '',
        vramGb: Number(body.vramGb ?? 0),
        systemRamGb: Number(body.systemRamGb ?? 0),
        maxSupportedScale: body.maxSupportedScale,
        authSecret: body.authSecret,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'worker-registered');
      res.status(201).json({ worker });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Worker registration failed' });
    }
  });

  router.post('/wings/mind/workers/:id/probe', requireOwnerAuth('pairing'), async (req, res) => {
    try {
      const db = getDatabase();
      const result = await probeWorkerConnection(db, req.params.id);
      void getRealtimeSyncService().broadcastSnapshot(db, 'worker-probed');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Worker probe failed' });
    }
  });

  router.post('/wings/mind/transfer-manifest', requireOwnerAuth('export'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        resourceId?: string;
        workerId?: string;
        chunkSizeBytes?: number;
      };
      const manifest = prepareTransferManifest(db, {
        resourceId: body.resourceId ?? '',
        workerId: body.workerId ?? '',
        chunkSizeBytes: body.chunkSizeBytes,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'transfer-manifest-prepared');
      res.json({ manifest });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Transfer prep failed' });
    }
  });

  router.post('/wings/mind/transfer', requireOwnerAuth('export'), async (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        resourceId?: string;
        workerId?: string;
        chunkSizeBytes?: number;
      };
      const result = await transferResourceToWorker(db, {
        resourceId: body.resourceId ?? '',
        workerId: body.workerId ?? '',
        chunkSizeBytes: body.chunkSizeBytes,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'worker-chunk-transfer-completed');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Worker chunk transfer failed' });
    }
  });

  router.post('/wings/mind/create', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        name?: string;
        productClass?: NgProductClass;
        version?: string;
        scaleTier?: ModelScaleTier;
        architecture?: string;
        tokenizerSpec?: string;
        license?: string;
        baseDatasetId?: string;
        seedConfigJson?: string;
      };
      const created = createIndependentMind(db, {
        name: body.name ?? '',
        productClass: body.productClass,
        version: body.version ?? '1.0.0',
        scaleTier: body.scaleTier ?? '1B',
        architecture: body.architecture ?? '',
        tokenizerSpec: body.tokenizerSpec ?? 'BPE-32K',
        license: body.license ?? '',
        baseDatasetId: body.baseDatasetId,
        seedConfigJson: body.seedConfigJson,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'independent-mind-created');
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create independent Mind' });
    }
  });

  router.post('/wings/mind/intake', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        name?: string;
        productClass?: NgProductClass;
        version?: string;
        architectureSummary?: string;
        scaleTier?: ModelScaleTier;
        license?: string;
        weightsPath?: string;
        fileBase64?: string;
        fileName?: string;
        tokenizerSpec?: string;
        originSource?: string;
      };
      const result = intakeExternalModel(db, {
        name: body.name ?? '',
        productClass: body.productClass,
        version: body.version ?? '1.0.0',
        architectureSummary: body.architectureSummary ?? '',
        scaleTier: body.scaleTier ?? '1B',
        license: body.license ?? '',
        weightsPath: body.weightsPath,
        fileBase64: body.fileBase64,
        fileName: body.fileName,
        tokenizerSpec: body.tokenizerSpec,
        originSource: body.originSource ?? 'EXTERNAL_INTAKE',
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'model-intake');
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Model intake failed' });
    }
  });

  router.post('/wings/mind/jobs', requireOwnerAuth('mutate'), async (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        modelId?: string;
        datasetId?: string;
        workerId?: string;
        architecture?: string;
        scaleTier?: ModelScaleTier;
        totalSteps?: number;
        learningRate?: string;
        dispatchToWorker?: boolean;
      };
      const result = await createTrainingJob(db, {
        modelId: body.modelId ?? '',
        datasetId: body.datasetId ?? '',
        workerId: body.workerId ?? '',
        architecture: body.architecture ?? '',
        scaleTier: body.scaleTier ?? '1B',
        totalSteps: Number(body.totalSteps ?? 100),
        learningRate: body.learningRate,
        dispatchToWorker: Boolean(body.dispatchToWorker),
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'training-job-created');
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Training job creation failed';
      res.status(msg.startsWith('Blocked:') ? 422 : 400).json({ error: msg });
    }
  });

  router.post('/wings/mind/jobs/:id/control', requireOwnerAuth('mutate'), async (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { action?: string; requireWorkerAck?: boolean };
      if (body.action !== 'PAUSE' && body.action !== 'RESUME' && body.action !== 'CANCEL') {
        res.status(400).json({ error: 'action must be PAUSE, RESUME, or CANCEL' });
        return;
      }
      const job = await updateTrainingJobControl(db, req.params.id, body.action, {
        requireWorkerAck: Boolean(body.requireWorkerAck),
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'training-job-controlled');
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Job control failed' });
    }
  });

  router.post('/wings/mind/jobs/:id/telemetry', (req, res) => {
    try {
      const db = getDatabase();
      const targetJob = listTrainingJobs(db).find((j) => j.id === req.params.id);
      if (!targetJob) {
        res.status(404).json({ error: `Training job not found: ${req.params.id}` });
        return;
      }

      const rawBodyText =
        (req as express.Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

      const workerAuth = verifyWorkerTelemetryAuth(
        db,
        targetJob.workerId,
        {
          workerIdHeader: req.header('x-ng-worker-id'),
          timestampHeader: req.header('x-ng-worker-timestamp'),
          signatureHeader: req.header('x-ng-worker-signature'),
          authTokenHeader: req.header('x-ng-worker-secret') || readBearerToken(req),
        },
        rawBodyText,
      );

      if (!workerAuth.valid) {
        recordAuditEvent(db, {
          actor: 'UNAUTHENTICATED_WORKER',
          category: 'SECURITY',
          action: 'REJECT_FORGED_JOB_TELEMETRY',
          target: req.params.id,
          outcome: 'BLOCKED',
          details: { workerId: targetJob.workerId, reason: workerAuth.reason },
        });
        res.status(401).json({ error: workerAuth.reason || 'Worker telemetry authentication failed' });
        return;
      }

      const body = (req.body ?? {}) as {
        currentStep?: number;
        totalSteps?: number;
        trainingLoss?: number | null;
        validationLoss?: number | null;
        checkpointPath?: string | null;
        jobStatus?: TrainingJobRecord['jobStatus'];
      };
      const job = recordJobTelemetry(db, req.params.id, body);
      void getRealtimeSyncService().broadcastSnapshot(db, 'training-job-telemetry');
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Job telemetry update failed' });
    }
  });

  router.post('/wings/mind/jobs/:id/checkpoint', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        step?: number;
        trainingLoss?: number | null;
        validationLoss?: number | null;
        checkpointNotes?: string;
        jobStatus?: TrainingJobRecord['jobStatus'];
      };
      const saved = saveTrainingCheckpoint(db, {
        jobId: req.params.id,
        step: Number(body.step ?? 0),
        trainingLoss: body.trainingLoss,
        validationLoss: body.validationLoss,
        checkpointNotes: body.checkpointNotes,
        jobStatus: body.jobStatus,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'training-checkpoint-saved');
      res.status(201).json(saved);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save checkpoint' });
    }
  });

  router.post('/wings/mind/jobs/:id/restore', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { checkpointPath?: string };
      const restored = restoreTrainingCheckpoint(db, req.params.id, body.checkpointPath ?? '');
      void getRealtimeSyncService().broadcastSnapshot(db, 'training-checkpoint-restored');
      res.json(restored);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to restore checkpoint' });
    }
  });

  router.get('/wings/mind/jobs/:id/logs', (req, res) => {
    try {
      const db = getDatabase();
      const logs = getTrainingJobLogs(db, req.params.id);
      res.json(logs);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to read job logs' });
    }
  });

  // --- WING 3: MIND REPAIR & RE-ENGINEERING FACTORY (Product Registry & Lifecycle) ---
  router.get('/wings/repair/products', (_req, res) => {
    const db = getDatabase();
    res.json({ products: listModelProducts(db) });
  });

  router.post('/wings/repair/intake', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        name?: string;
        version?: string;
        originSource?: string;
        license?: string;
        architectureSummary?: string;
        weightsPath?: string;
        tokenizerPath?: string;
        fileName?: string;
        fileBase64?: string;
        contentText?: string;
      };
      const intake = receiveExternalModelForRepair(db, {
        name: body.name ?? '',
        version: body.version ?? '1.0.0',
        originSource: body.originSource ?? 'EXTERNAL_REPAIR_INTAKE',
        license: body.license ?? '',
        architectureSummary: body.architectureSummary ?? '',
        weightsPath: body.weightsPath,
        tokenizerPath: body.tokenizerPath,
        fileName: body.fileName,
        fileBase64: body.fileBase64,
        contentText: body.contentText,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'repair-external-intake');
      res.status(201).json(intake);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'External model intake failed' });
    }
  });

  router.post('/wings/repair/products', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        id?: string;
        name?: string;
        productClass?: NgProductClass;
        version?: string;
        weightsSha256?: string;
        architectureSummary?: string;
        trainingSummary?: string;
        evaluationSummary?: string;
        license?: string;
        safetyNotes?: string;
        restoreCheckpointPath?: string;
        weightsPath?: string;
        tokenizerPath?: string;
        configPath?: string;
        changelog?: string;
      };
      const product = registerOrRepairProduct(db, {
        id: body.id,
        name: body.name ?? '',
        productClass: body.productClass ?? 'NG-REPAIRED',
        version: body.version ?? '1.0.0',
        weightsSha256: body.weightsSha256 ?? '',
        architectureSummary: body.architectureSummary ?? '',
        trainingSummary: body.trainingSummary,
        evaluationSummary: body.evaluationSummary,
        license: body.license ?? '',
        safetyNotes: body.safetyNotes,
        restoreCheckpointPath: body.restoreCheckpointPath,
        weightsPath: body.weightsPath,
        tokenizerPath: body.tokenizerPath,
        configPath: body.configPath,
        changelog: body.changelog,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'repair-product-saved');
      res.status(body.id ? 200 : 201).json({ product });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Product registry save failed' });
    }
  });

  router.post('/wings/repair/products/:id/execute', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as {
        operation?: 'SANITIZE_NAN_INF' | 'INT8_QUANTIZE';
        newVersion?: string;
        productClass?: NgProductClass;
        license?: string;
        safetyNotes?: string;
        changelog?: string;
      };
      if (body.operation !== 'SANITIZE_NAN_INF' && body.operation !== 'INT8_QUANTIZE') {
        res.status(400).json({ error: 'operation must be SANITIZE_NAN_INF or INT8_QUANTIZE' });
        return;
      }
      const repaired = executeModelRepair(db, {
        productId: req.params.id,
        operation: body.operation,
        newVersion: body.newVersion ?? '',
        productClass: body.productClass,
        license: body.license,
        safetyNotes: body.safetyNotes,
        changelog: body.changelog,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'repair-binary-weights-executed');
      res.json(repaired);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Binary weights repair failed' });
    }
  });

  router.put('/wings/repair/products/:id/state', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { nextState?: ModelLifecycleState };
      const product = transitionProductLifecycle(
        db,
        req.params.id,
        body.nextState ?? 'EVALUATION',
      );
      void getRealtimeSyncService().broadcastSnapshot(db, 'product-lifecycle-changed');
      res.json({ product });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lifecycle transition failed';
      res.status(msg.startsWith('Blocked:') ? 422 : 400).json({ error: msg });
    }
  });

  // --- WING 4: TRUST & SECURITY CENTER (10-Suite QC Verification) ---
  router.get('/wings/trust/qc', (req, res) => {
    const db = getDatabase();
    const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
    res.json({ reports: listQcReports(db, productId) });
  });

  router.post('/wings/trust/qc/:productId/run', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const summary = runTenSuiteQcCheck(db, req.params.productId);
      void getRealtimeSyncService().broadcastSnapshot(db, 'qc-verification-run');
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'QC run failed' });
    }
  });

  // --- WING 5: NG-IP SERVICES (Certified Delivery ZIPs & Technical Dossiers) ---
  router.get('/wings/ngip/packages', (_req, res) => {
    const db = getDatabase();
    res.json({ packages: listDeliveryPackages(db) });
  });

  router.post('/wings/ngip/packages/:productId/build', requireOwnerAuth('export'), (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { ipHolder?: string; licenseTermsNote?: string };
      const deliveryPackage = buildCertifiedDeliveryPackage(db, req.params.productId, {
        ipHolder: body.ipHolder,
        licenseTermsNote: body.licenseTermsNote,
      });
      void getRealtimeSyncService().broadcastSnapshot(db, 'delivery-package-built');
      res.status(201).json({ deliveryPackage });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delivery build failed';
      res.status(msg.startsWith('Blocked:') ? 422 : 400).json({ error: msg });
    }
  });

  router.post('/wings/ngip/packages/:id/verify', requireOwnerAuth('mutate'), (req, res) => {
    try {
      const db = getDatabase();
      const result = verifyDeliveryPackageIntegrity(db, req.params.id);
      void getRealtimeSyncService().broadcastSnapshot(db, 'delivery-package-verified');
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delivery package verification failed' });
    }
  });

  router.get('/wings/ngip/packages/:id/download', requireOwnerAuth('export'), (req, res) => {
    try {
      const db = getDatabase();
      const pkg = listDeliveryPackages(db).find((p) => p.id === req.params.id);
      if (!pkg) {
        res.status(404).json({ error: 'Delivery package not found' });
        return;
      }

      const config = getConfigMap(db);
      const dataDir = path.resolve(config.data_dir || process.cwd());
      const safeCheck = resolveSafeRealPath(pkg.zipPath, dataDir);
      if (!safeCheck.allowed) {
        res.status(403).json({ error: 'Blocked: Delivery package path outside workspace' });
        return;
      }
      const resolvedZip = safeCheck.canonicalTarget;
      if (!fs.existsSync(resolvedZip) || !fs.statSync(resolvedZip).isFile()) {
        res.status(404).json({ error: 'Certified delivery ZIP missing on disk' });
        return;
      }

      recordAuditEvent(db, {
        actor: 'OWNER',
        category: 'NG_IP',
        action: 'DOWNLOAD_CERTIFIED_DELIVERY_ZIP',
        target: pkg.id,
        outcome: 'PASS',
        details: { zipPath: resolvedZip, sizeBytes: pkg.sizeBytes },
      });

      const fileName = path.basename(resolvedZip);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.sendFile(resolvedZip);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Delivery package download failed',
      });
    }
  });

  return router;
}
