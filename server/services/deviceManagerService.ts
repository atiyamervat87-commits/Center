import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { probeDeviceEnvironment } from '../storage/storageProbe.ts';
import { computeAndroidBridgeDiagnostics } from '../storage/androidBridgeDiagnostic.ts';

export interface CleanupSuggestion {
  id: string;
  path: string;
  sizeBytes: number;
  fileType: string;
  reason: string;
  inUse: boolean;
  expectedImpact: string;
}

export interface NetworkInterfaceSummary {
  name: string;
  family: string;
  address: string;
  internal: boolean;
}

export interface DeviceManagerSnapshot {
  generatedAt: string;
  internalStorage: {
    path: string;
    availableBytes: number | null;
    totalBytes: number | null;
    state: string;
  };
  externalSdStorage: {
    path: string;
    availableBytes: number | null;
    totalBytes: number | null;
    state: string;
  };
  memory: {
    isHostMemory: boolean;
    totalBytes: number;
    freeBytes: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
  };
  termuxStatus: {
    detected: boolean;
    state: string;
    prefixPath: string;
  };
  localServices: Array<{
    name: string;
    status: 'ONLINE' | 'OFFLINE';
    detail: string;
  }>;
  activeProcess: {
    pid: number;
    nodeVersion: string;
    uptimeSeconds: number;
    platform: string;
    arch: string;
  };
  cacheSummary: {
    cacheDirBytes: number;
    exportsDirBytes: number;
    trackedFilesCount: number;
  };
  installedDependencies: Array<{
    name: string;
    version: string;
    scope: 'runtime' | 'dev';
  }>;
  networkInterfaces: NetworkInterfaceSummary[];
  cleanupSuggestions: CleanupSuggestion[];
}

function scanDirectoryFiles(
  rootDir: string,
  protectedFiles: Set<string>,
): Array<{ filePath: string; sizeBytes: number; ext: string; mtimeMs: number }> {
  const results: Array<{ filePath: string; sizeBytes: number; ext: string; mtimeMs: number }> = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    return results;
  }

  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (protectedFiles.has(fullPath)) continue;
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            filePath: fullPath,
            sizeBytes: stat.size,
            ext: path.extname(entry.name) || 'file',
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // skip unreadable file
        }
      }
    }
  };

  walk(path.resolve(rootDir), 0);
  return results;
}

function readPackageDependencies(): Array<{
  name: string;
  version: string;
  scope: 'runtime' | 'dev';
}> {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const list: Array<{ name: string; version: string; scope: 'runtime' | 'dev' }> = [];
    for (const [name, version] of Object.entries(raw.dependencies ?? {})) {
      list.push({ name, version, scope: 'runtime' });
    }
    for (const [name, version] of Object.entries(raw.devDependencies ?? {})) {
      list.push({ name, version, scope: 'dev' });
    }
    return list;
  } catch {
    return [];
  }
}

export function getDeviceManagerSnapshot(db: DatabaseSync): DeviceManagerSnapshot {
  const config = getConfigMap(db);
  const env = probeDeviceEnvironment(config);
  const androidDiag = computeAndroidBridgeDiagnostics(config);
  const dataDir = path.resolve(config.data_dir || process.cwd());

  // Protect SQLite primary DB + WAL/SHM files strictly
  const protectedDbFiles = new Set<string>([
    path.resolve(dataDir, 'ng_ilmf_command.sqlite'),
    path.resolve(dataDir, 'ng_ilmf_command.sqlite-wal'),
    path.resolve(dataDir, 'ng_ilmf_command.sqlite-shm'),
  ]);

  const exportsDir = path.join(dataDir, 'exports');
  const cacheDir = path.join(dataDir, 'cache');

  const exportFiles = scanDirectoryFiles(exportsDir, protectedDbFiles);
  const cacheFiles = scanDirectoryFiles(cacheDir, protectedDbFiles);
  const rootTmpFiles = scanDirectoryFiles(dataDir, protectedDbFiles).filter(
    (f) => f.filePath.endsWith('.tmp') || path.basename(f.filePath).startsWith('.ng_ilmf_'),
  );

  const exportsDirBytes = exportFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
  const cacheDirBytes =
    cacheFiles.reduce((acc, f) => acc + f.sizeBytes, 0) +
    rootTmpFiles.reduce((acc, f) => acc + f.sizeBytes, 0);

  const cleanupSuggestions: CleanupSuggestion[] = [];

  for (const f of rootTmpFiles) {
    cleanupSuggestions.push({
      id: `CLN-${crypto.createHash('sha1').update(f.filePath).digest('hex').slice(0, 8).toUpperCase()}`,
      path: f.filePath,
      sizeBytes: f.sizeBytes,
      fileType: 'TEMP_PROBE',
      reason: 'Residual temporary probe file inside app workspace',
      inUse: false,
      expectedImpact: 'Reclaims workspace space; safe to remove after verification.',
    });
  }

  for (const f of cacheFiles) {
    cleanupSuggestions.push({
      id: `CLN-${crypto.createHash('sha1').update(f.filePath).digest('hex').slice(0, 8).toUpperCase()}`,
      path: f.filePath,
      sizeBytes: f.sizeBytes,
      fileType: f.ext.toUpperCase(),
      reason: 'Workspace cache artifact',
      inUse: false,
      expectedImpact: 'Frees cache storage; cached artifacts can be regenerated if needed.',
    });
  }

  for (const f of exportFiles) {
    cleanupSuggestions.push({
      id: `CLN-${crypto.createHash('sha1').update(f.filePath).digest('hex').slice(0, 8).toUpperCase()}`,
      path: f.filePath,
      sizeBytes: f.sizeBytes,
      fileType: 'EXPORTED_REPORT',
      reason: 'Generated project report archive in local workspace',
      inUse: false,
      expectedImpact: 'Removes local exported report copy; project record in SQLite stays intact.',
    });
  }

  const netInterfaces: NetworkInterfaceSummary[] = [];
  const rawNets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(rawNets)) {
    for (const addr of addrs ?? []) {
      netInterfaces.push({
        name,
        family: String(addr.family),
        address: addr.address,
        internal: addr.internal,
      });
    }
  }

  const memUsage = process.memoryUsage();

  return {
    generatedAt: new Date().toISOString(),
    internalStorage: {
      path: env.hostEnvironment.provider.configuredPath,
      availableBytes: env.hostEnvironment.provider.availableBytes,
      totalBytes: env.hostEnvironment.provider.totalBytes,
      state: env.hostEnvironment.provider.state,
    },
    externalSdStorage: {
      path: androidDiag.safUri || env.externalSdStorage.provider.configuredPath,
      availableBytes: env.externalSdStorage.provider.availableBytes,
      totalBytes: env.externalSdStorage.provider.totalBytes,
      state: env.externalSdStorage.provider.state,
    },
    memory: {
      isHostMemory: !androidDiag.flags.ANDROID_CONNECTED,
      totalBytes: env.hostEnvironment.host.totalMemoryBytes,
      freeBytes: env.hostEnvironment.host.freeMemoryBytes,
      processRssBytes: memUsage.rss,
      processHeapUsedBytes: memUsage.heapUsed,
    },
    termuxStatus: {
      detected: env.termuxEnvironment.termuxDetected,
      state: env.termuxEnvironment.provider.state,
      prefixPath: env.termuxEnvironment.termuxPrefix,
    },
    localServices: [
      {
        name: 'Express Command API',
        status: 'ONLINE',
        detail: `PID ${process.pid} · Node ${process.version}`,
      },
      {
        name: 'SQLite WAL Database',
        status: 'ONLINE',
        detail: path.join(dataDir, 'ng_ilmf_command.sqlite'),
      },
    ],
    activeProcess: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      platform: process.platform,
      arch: process.arch,
    },
    cacheSummary: {
      cacheDirBytes,
      exportsDirBytes,
      trackedFilesCount: cleanupSuggestions.length,
    },
    installedDependencies: readPackageDependencies(),
    networkInterfaces: netInterfaces,
    cleanupSuggestions,
  };
}

export function executeOwnerApprovedCleanup(
  db: DatabaseSync,
  input: { filePath: string; ownerApproved: boolean },
): { deletedPath: string; sha256BeforeDelete: string; sizeBytes: number } {
  if (!input.ownerApproved) {
    throw new Error('Explicit owner approval (ownerApproved=true) is mandatory before deleting any file.');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const target = path.resolve(input.filePath);

  // Security boundary: only permit deleting files inside app-owned data_dir, and never SQLite DB files
  if (!target.startsWith(`${dataDir}${path.sep}`)) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'CLEANUP',
      action: 'BLOCK_OUTSIDE_WORKSPACE_DELETE',
      target,
      outcome: 'BLOCKED',
      details: { reason: 'Path outside managed workspace data_dir' },
    });
    throw new Error('Blocked: Cleanup can only delete files inside the managed app workspace directory.');
  }

  const base = path.basename(target);
  if (base.includes('.sqlite')) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'CLEANUP',
      action: 'BLOCK_ACTIVE_DB_DELETE',
      target,
      outcome: 'BLOCKED',
      details: { reason: 'Active database file is in use' },
    });
    throw new Error('Blocked: Active SQLite database files cannot be deleted.');
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Target file not found: ${target}`);
  }

  const buf = fs.readFileSync(target);
  const sha256BeforeDelete = crypto.createHash('sha256').update(buf).digest('hex');
  fs.unlinkSync(target);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'CLEANUP',
    action: 'OWNER_APPROVED_FILE_CLEANUP',
    target,
    outcome: 'PASS',
    details: { sizeBytes: buf.length, sha256BeforeDelete },
  });

  return {
    deletedPath: target,
    sha256BeforeDelete,
    sizeBytes: buf.length,
  };
}
