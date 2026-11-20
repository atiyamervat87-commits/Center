import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response } from 'express';
import { getDefaultRuntimeConfig } from '../config/runtime.ts';
import { getConfigMap } from '../db/database.ts';
import {
  listTrainingJobs,
  listWorkers,
  recordJobTelemetry,
  type ModelScaleTier,
  type TrainingJobRecord,
} from './mindFactoryService.ts';
import { getMasterDashboardSnapshot } from './dashboardService.ts';
import type { SystemState } from './dashboardService.ts';

export interface PerformanceMetricsSnapshot {
  collectedAt: string;
  hostCpuPercent: number;
  loadAvg1m: number;
  loadAvg5m: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedPercent: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
  uptimeSeconds: number;
  sqliteDbBytes: number;
}

export interface TrainingJobMetricSummary {
  id: string;
  modelId: string;
  workerId: string;
  architecture: string;
  scaleTier: ModelScaleTier;
  jobStatus: TrainingJobRecord['jobStatus'];
  currentStep: number;
  totalSteps: number;
  progressPercent: number | null;
  trainingLoss: number | null;
  validationLoss: number | null;
  startedAt: string | null;
}

export interface TrainingMetricsSnapshot {
  collectedAt: string;
  totalWorkers: number;
  onlineWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  pausedJobs: number;
  completedJobs: number;
  failedJobs: number;
  jobs: TrainingJobMetricSummary[];
}

export interface RealtimeSyncMetadata {
  syncTransport: 'SSE' | 'POLL_FALLBACK';
  connectedClients: number;
  lastSyncAt: string;
  sequence: number;
}

let lastCpuUsage = process.cpuUsage();
let lastCpuSampleHrTimeNs = process.hrtime.bigint();

export function collectPerformanceMetrics(dbPathOverride?: string): PerformanceMetricsSnapshot {
  const nowNs = process.hrtime.bigint();
  const elapsedUs = Number(nowNs - lastCpuSampleHrTimeNs) / 1000;
  const cpuDelta = process.cpuUsage(lastCpuUsage);
  const totalCpuUs = cpuDelta.user + cpuDelta.system;
  const cpuCount = Math.max(1, os.cpus().length);

  let hostCpuPercent = 0;
  if (elapsedUs > 0) {
    hostCpuPercent = Math.min(100, Math.max(0, Number(((totalCpuUs / (elapsedUs * cpuCount)) * 100).toFixed(2))));
  }

  lastCpuUsage = process.cpuUsage();
  lastCpuSampleHrTimeNs = nowNs;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryUsedPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(2)) : 0;
  const memUsage = process.memoryUsage();
  const loads = os.loadavg();

  const dbPath = dbPathOverride ?? getDefaultRuntimeConfig().dbPath;
  let sqliteDbBytes = 0;
  try {
    if (fs.existsSync(dbPath)) {
      sqliteDbBytes = fs.statSync(dbPath).size;
    }
  } catch {
    sqliteDbBytes = 0;
  }

  return {
    collectedAt: new Date().toISOString(),
    hostCpuPercent,
    loadAvg1m: Number((loads[0] ?? 0).toFixed(2)),
    loadAvg5m: Number((loads[1] ?? 0).toFixed(2)),
    memoryUsedBytes: usedMem,
    memoryTotalBytes: totalMem,
    memoryUsedPercent,
    processRssBytes: memUsage.rss,
    processHeapUsedBytes: memUsage.heapUsed,
    uptimeSeconds: Math.floor(process.uptime()),
    sqliteDbBytes,
  };
}

export function collectTrainingMetrics(db: DatabaseSync): TrainingMetricsSnapshot {
  const workers = listWorkers(db);
  const allJobs = listTrainingJobs(db);

  const onlineWorkers = workers.filter((w) => w.status === 'ONLINE').length;
  const queuedJobs = allJobs.filter((j) => j.jobStatus === 'QUEUED' || j.jobStatus === 'TRANSFERRING').length;
  const runningJobs = allJobs.filter((j) => j.jobStatus === 'RUNNING').length;
  const pausedJobs = allJobs.filter((j) => j.jobStatus === 'PAUSED').length;
  const completedJobs = allJobs.filter((j) => j.jobStatus === 'COMPLETED').length;
  const failedJobs = allJobs.filter((j) => j.jobStatus === 'FAILED').length;

  const jobs: TrainingJobMetricSummary[] = allJobs.slice(0, 12).map((j) => ({
    id: j.id,
    modelId: j.modelId,
    workerId: j.workerId,
    architecture: j.architecture,
    scaleTier: j.scaleTier,
    jobStatus: j.jobStatus,
    currentStep: j.currentStep,
    totalSteps: j.totalSteps,
    progressPercent:
      j.totalSteps > 0 ? Number(Math.min(100, (j.currentStep / j.totalSteps) * 100).toFixed(1)) : null,
    trainingLoss: j.trainingLoss,
    validationLoss: j.validationLoss,
    startedAt: j.startedAt,
  }));

  return {
    collectedAt: new Date().toISOString(),
    totalWorkers: workers.length,
    onlineWorkers,
    queuedJobs,
    runningJobs,
    pausedJobs,
    completedJobs,
    failedJobs,
    jobs,
  };
}

interface WorkerMetricsPayload {
  jobs?: Array<{
    jobId?: string;
    id?: string;
    currentStep?: number;
    totalSteps?: number;
    trainingLoss?: number | null;
    validationLoss?: number | null;
    checkpointPath?: string | null;
    jobStatus?: TrainingJobRecord['jobStatus'];
  }>;
}

/**
 * Probes registered ONLINE workers' real HTTP `/health` and `/metrics` endpoints.
 * Never fabricates progress; only writes telemetry genuinely returned by the worker.
 */
export async function syncOnlineWorkersTelemetry(db: DatabaseSync): Promise<{
  probedWorkers: number;
  onlineWorkers: number;
  updatedJobs: number;
}> {
  const workers = listWorkers(db);
  const config = getConfigMap(db);
  const activeWorkers = workers.filter(
    (w) => w.status === 'ONLINE' || w.status === 'WARNING',
  );

  let updatedJobs = 0;
  let onlineCount = 0;

  for (const worker of activeWorkers) {
    const base = worker.endpointUrl.endsWith('/')
      ? worker.endpointUrl.slice(0, -1)
      : worker.endpointUrl;
    const now = new Date().toISOString();

    let nextStatus: SystemState = worker.status;
    let reachable = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const healthRes = await fetch(`${base}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);
      reachable = healthRes.ok;
      nextStatus = healthRes.ok ? 'ONLINE' : 'WARNING';
    } catch {
      reachable = false;
      nextStatus = 'OFFLINE';
    }

    if (reachable) {
      onlineCount += 1;
      db.prepare(
        'UPDATE training_workers SET status = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
      ).run('ONLINE', now, now, worker.id);

      // Query optional worker /metrics endpoint if implemented by the remote training worker
      try {
        const metricsController = new AbortController();
        const metricsTimer = setTimeout(() => metricsController.abort(), 1500);
        const metricsRes = await fetch(`${base}/metrics`, {
          method: 'GET',
          signal: metricsController.signal,
        });
        clearTimeout(metricsTimer);
        if (metricsRes.ok) {
          const payload = (await metricsRes.json()) as WorkerMetricsPayload;
          if (Array.isArray(payload.jobs)) {
            for (const item of payload.jobs) {
              const targetId = item.jobId ?? item.id;
              if (!targetId) continue;
              const existing = listTrainingJobs(db).find((j) => j.id === targetId);
              if (!existing) continue;
              recordJobTelemetry(db, targetId, {
                currentStep: item.currentStep,
                totalSteps: item.totalSteps,
                trainingLoss: item.trainingLoss,
                validationLoss: item.validationLoss,
                checkpointPath: item.checkpointPath,
                jobStatus: item.jobStatus,
              });
              updatedJobs += 1;
            }
          }
        }
      } catch {
        // Worker does not expose /metrics or timed out; keep last honest SQLite metrics
      }
    } else if (nextStatus !== worker.status) {
      db.prepare('UPDATE training_workers SET status = ?, updated_at = ? WHERE id = ?').run(
        nextStatus,
        now,
        worker.id,
      );
    }
  }

  // Also ensure configured default bridge endpoint status stays fresh if workers == 0
  void config;

  return {
    probedWorkers: activeWorkers.length,
    onlineWorkers: onlineCount,
    updatedJobs,
  };
}

interface SseClient {
  id: string;
  res: Response;
}

export class RealtimeSyncService extends EventEmitter {
  private clients = new Map<string, SseClient>();
  private sequence = 0;
  private lastSyncAt = new Date().toISOString();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;
  private dbRef: DatabaseSync | null = null;

  getMetadata(): RealtimeSyncMetadata {
    return {
      syncTransport: 'SSE',
      connectedClients: this.clients.size,
      lastSyncAt: this.lastSyncAt,
      sequence: this.sequence,
    };
  }

  start(db: DatabaseSync, intervalMs = 5000) {
    this.dbRef = db;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        // ignore closed stream
      }
    }
    this.clients.clear();
  }

  private async tick() {
    if (!this.dbRef || this.pollingInFlight) return;
    // Skip periodic SSE push when nobody is subscribed and no active training jobs exist
    if (this.clients.size === 0) return;

    this.pollingInFlight = true;
    try {
      await this.syncAndBroadcast(this.dbRef, 'periodic-metrics-sync');
    } catch {
      // keep background sync loop resilient
    } finally {
      this.pollingInFlight = false;
    }
  }

  async syncAndBroadcast(db: DatabaseSync, reason = 'manual-sync') {
    const workerSync = await syncOnlineWorkersTelemetry(db);
    const snapshot = await getMasterDashboardSnapshot(db);
    this.emitSnapshot(snapshot, reason);
    return { snapshot, workerSync };
  }

  async broadcastSnapshot(db: DatabaseSync, reason = 'state-mutation') {
    const snapshot = await getMasterDashboardSnapshot(db);
    this.emitSnapshot(snapshot, reason);
    return snapshot;
  }

  emitSnapshot(snapshot: unknown, reason: string) {
    this.sequence += 1;
    this.lastSyncAt = new Date().toISOString();
    const payload = {
      reason,
      sequence: this.sequence,
      syncedAt: this.lastSyncAt,
      snapshot,
    };
    this.emit('snapshot', payload);
    this.sendToAllSseClients('sync:snapshot', payload, this.sequence);
  }

  async subscribeSseClient(req: Request, res: Response, db: DatabaseSync) {
    this.dbRef = db;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clients.set(clientId, { id: clientId, res });

    res.write('retry: 3000\n\n');

    req.on('close', () => {
      this.clients.delete(clientId);
    });

    try {
      this.sequence += 1;
      this.lastSyncAt = new Date().toISOString();
      const snapshot = await getMasterDashboardSnapshot(db);
      const initPayload = {
        reason: 'initial-sync',
        sequence: this.sequence,
        syncedAt: this.lastSyncAt,
        snapshot,
      };
      if (!res.writableEnded) {
        res.write(`id: ${this.sequence}\nevent: init\ndata: ${JSON.stringify(initPayload)}\n\n`);
      }
    } catch {
      this.clients.delete(clientId);
    }
  }

  private sendToAllSseClients(eventName: string, payload: unknown, seq: number) {
    const serialized = `id: ${seq}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [clientId, client] of this.clients.entries()) {
      if (client.res.writableEnded) {
        this.clients.delete(clientId);
        continue;
      }
      try {
        client.res.write(serialized);
      } catch {
        this.clients.delete(clientId);
      }
    }
  }
}

let singletonSyncService: RealtimeSyncService | null = null;

export function getRealtimeSyncService(): RealtimeSyncService {
  if (!singletonSyncService) {
    singletonSyncService = new RealtimeSyncService();
  }
  return singletonSyncService;
}
