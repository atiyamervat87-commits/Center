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
  getSecuritySnapshot,
  isAuthorizedForAction,
  loginOwnerSession,
  revokeOwnerSession,
  setupOwnerPasskey,
  updateSecurityPermissions,
  type SecurityPermissions,
} from '../services/securityService.ts';
import {
  getIsolatedDemoCatalog,
  resetDemoSession,
  runIsolatedDemoInference,
} from '../services/demoService.ts';

function readOwnerToken(req: express.Request): string | undefined {
  const token = req.header('x-ng-owner-token');
  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
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

  router.get('/config', (_req, res) => {
    const db = getDatabase();
    const config = getConfigMap(db);
    const environment = probeDeviceEnvironment(config);
    res.json({ config, environment });
  });

  router.put('/config', (req, res) => {
    const db = getDatabase();
    const updates = req.body as Record<string, unknown>;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON key-value object' });
      return;
    }

    if (typeof updates.bridge_endpoint === 'string') {
      const auth = isAuthorizedForAction(db, 'pairing', readOwnerToken(req));
      if (!auth.allowed) {
        res.status(403).json({ error: auth.reason });
        return;
      }
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

    const config = getConfigMap(db);
    const environment = probeDeviceEnvironment(config);
    res.json({ config, environment, auditEntry });
  });

  router.post('/system/verify-storage', (req, res) => {
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

    res.json({
      outcome,
      hostReport,
      report: targetReport,
      environment,
      auditEntry,
    });
  });

  router.post('/storage/approve-location', (req, res) => {
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
    let envBefore = probeDeviceEnvironment(updatedConfig);
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

  router.post('/projects', (req, res) => {
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

  router.put('/projects/:id', (req, res) => {
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

  router.post('/projects/:id/resources', (req, res) => {
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

  router.delete('/projects/:id/resources/:resourceId', (req, res) => {
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

  router.post('/projects/:id/export', (req, res) => {
    try {
      const db = getDatabase();
      const auth = isAuthorizedForAction(db, 'export', readOwnerToken(req));
      if (!auth.allowed) {
        res.status(403).json({ error: auth.reason });
        return;
      }
      const report = exportProjectReport(db, req.params.id);
      res.json({ report });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to export project report',
      });
    }
  });

  // --- Android Bridge Diagnostics & SAF Attestation Endpoints ---
  router.get('/android/bridge-status', (_req, res) => {
    const db = getDatabase();
    const config = getConfigMap(db);
    const diagnostics = computeAndroidBridgeDiagnostics(config);
    res.json({ diagnostics });
  });

  router.post('/android/attest', (req, res) => {
    try {
      const db = getDatabase();
      const diagnostics = recordNativeAndroidAttestation(db, req.body ?? {});
      res.json({ diagnostics });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Android attestation rejected',
      });
    }
  });

  router.post('/android/revoke', (_req, res) => {
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

  router.post('/device/cleanup', (req, res) => {
    try {
      const db = getDatabase();
      const auth = isAuthorizedForAction(db, 'delete', readOwnerToken(req));
      if (!auth.allowed) {
        res.status(403).json({ error: auth.reason });
        return;
      }
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
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { passkey?: string; deviceLabel?: string };
      const result = setupOwnerPasskey(db, {
        passkey: body.passkey ?? '',
        deviceLabel: body.deviceLabel,
        currentToken: readOwnerToken(req),
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to configure owner passkey',
      });
    }
  });

  router.post('/security/login', (req, res) => {
    try {
      const db = getDatabase();
      const body = (req.body ?? {}) as { passkey?: string; deviceLabel?: string };
      const result = loginOwnerSession(db, {
        passkey: body.passkey ?? '',
        deviceLabel: body.deviceLabel,
      });
      res.json(result);
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Owner authentication failed',
      });
    }
  });

  router.post('/security/sessions/:id/revoke', (req, res) => {
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

  router.put('/security/permissions', (req, res) => {
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

  router.post('/demo/infer', async (req, res) => {
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

  router.post('/demo/reset', (_req, res) => {
    const db = getDatabase();
    const result = resetDemoSession(db);
    res.json(result);
  });

  return router;
}
