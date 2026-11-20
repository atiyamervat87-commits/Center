import { triggerRealtimeSyncRefresh } from './apiClient';
import type {
  MasterDashboardSnapshot,
  RealtimeSyncConnectionState,
} from '../types/commandCenter';

export interface RealtimeSyncClientStatus {
  connectionState: RealtimeSyncConnectionState;
  transport: 'SSE' | 'HTTP_REFRESH';
  sequence: number;
  lastSyncedAt: string | null;
  lastReason: string | null;
  error: string | null;
}

interface SseSyncEnvelope {
  reason?: string;
  sequence?: number;
  syncedAt?: string;
  snapshot?: MasterDashboardSnapshot;
}

export type SnapshotListener = (
  snapshot: MasterDashboardSnapshot,
  status: RealtimeSyncClientStatus,
) => void;

export type StatusListener = (status: RealtimeSyncClientStatus) => void;

/**
 * Client-side Real-Time Data Synchronization Service.
 * Connects to `/api/v1/sync/stream` via EventSource (Server-Sent Events),
 * enforces monotonic sequence ordering to reject stale out-of-order frames,
 * reconnects automatically with exponential backoff on transport drop, and
 * supports on-demand worker & metric sync refreshes.
 */
export class RealtimeDashboardSyncClient {
  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  private status: RealtimeSyncClientStatus = {
    connectionState: 'DISCONNECTED',
    transport: 'SSE',
    sequence: 0,
    lastSyncedAt: null,
    lastReason: null,
    error: null,
  };

  private snapshotListeners = new Set<SnapshotListener>();
  private statusListeners = new Set<StatusListener>();

  getStatus(): RealtimeSyncClientStatus {
    return { ...this.status };
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  start() {
    this.stopped = false;
    this.connectStream();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.updateStatus({
      connectionState: 'DISCONNECTED',
    });
  }

  async syncNow(): Promise<MasterDashboardSnapshot> {
    const result = await triggerRealtimeSyncRefresh();
    const nextSeq = Math.max(
      this.status.sequence + 1,
      result.snapshot.syncMetadata?.sequence ?? this.status.sequence + 1,
    );
    this.updateStatus({
      sequence: nextSeq,
      lastSyncedAt: new Date().toISOString(),
      lastReason: 'manual-sync',
      error: null,
    });
    this.notifySnapshot(result.snapshot, nextSeq);
    return result.snapshot;
  }

  private connectStream() {
    if (this.stopped) return;
    if (typeof EventSource === 'undefined') {
      this.updateStatus({
        connectionState: 'DISCONNECTED',
        transport: 'HTTP_REFRESH',
        error: 'EventSource unsupported in current runtime',
      });
      return;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.updateStatus({
      connectionState: this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING',
      transport: 'SSE',
    });

    const source = new EventSource('/api/v1/sync/stream');
    this.eventSource = source;

    const handleEnvelope = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as SseSyncEnvelope;
        if (!payload.snapshot) return;
        const incomingSeq = typeof payload.sequence === 'number' ? payload.sequence : 0;

        // Idempotent monotonic sequence guard
        if (incomingSeq > 0 && incomingSeq < this.status.sequence) {
          return;
        }

        this.reconnectAttempt = 0;
        const effectiveSeq = Math.max(this.status.sequence, incomingSeq);
        this.updateStatus({
          connectionState: 'CONNECTED',
          transport: 'SSE',
          sequence: effectiveSeq,
          lastSyncedAt: payload.syncedAt ?? new Date().toISOString(),
          lastReason: payload.reason ?? event.type,
          error: null,
        });
        this.notifySnapshot(payload.snapshot, effectiveSeq);
      } catch {
        // ignore malformed frame cleanly
      }
    };

    source.addEventListener('init', handleEnvelope as EventListener);
    source.addEventListener('sync:snapshot', handleEnvelope as EventListener);

    source.onopen = () => {
      this.reconnectAttempt = 0;
      this.updateStatus({
        connectionState: 'CONNECTED',
        transport: 'SSE',
        error: null,
      });
    };

    source.onerror = () => {
      source.close();
      if (this.eventSource === source) {
        this.eventSource = null;
      }
      if (this.stopped) return;

      this.reconnectAttempt += 1;
      const delayMs = Math.min(15000, 1500 * Math.pow(2, this.reconnectAttempt - 1));
      this.updateStatus({
        connectionState: 'RECONNECTING',
        error: `Stream interrupted; reconnecting in ${Math.round(delayMs / 1000)}s`,
      });

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(() => {
        this.connectStream();
      }, delayMs);
    };
  }

  private notifySnapshot(snapshot: MasterDashboardSnapshot, sequence: number) {
    if (sequence < this.status.sequence) return;
    const currentStatus = this.getStatus();
    for (const listener of this.snapshotListeners) {
      listener(snapshot, currentStatus);
    }
  }

  private updateStatus(patch: Partial<RealtimeSyncClientStatus>) {
    this.status = {
      ...this.status,
      ...patch,
    };
    const snapshotStatus = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshotStatus);
    }
  }
}
