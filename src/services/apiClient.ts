import type {
  AndroidBridgeDiagnostics,
  ApproveArchiveLocationResponse,
  AuditLogEntry,
  AvailableIndependentResource,
  DemoCatalogSnapshot,
  DeviceManagerSnapshot,
  ExportedProjectReport,
  MasterDashboardSnapshot,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  SecurityPermissions,
  SecuritySnapshot,
  SeparatedEnvironmentProbe,
  StorageProviderId,
  VerifyStorageResponse,
} from '../types/commandCenter';

const API_BASE = '/api/v1';
const OWNER_TOKEN_KEY = 'ng_ilmf_owner_token';

export function getOwnerToken(): string {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(OWNER_TOKEN_KEY) ?? '';
}

export function setOwnerToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (!token) {
    window.sessionStorage.removeItem(OWNER_TOKEN_KEY);
  } else {
    window.sessionStorage.setItem(OWNER_TOKEN_KEY, token);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getOwnerToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-ng-owner-token': token } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let errMessage = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string; report?: { failureReason?: string } };
      if (payload.error) {
        errMessage = payload.error;
      } else if (payload.report?.failureReason) {
        errMessage = payload.report.failureReason;
      }
    } catch {
      // ignore non-json error body
    }
    throw new Error(errMessage);
  }

  return (await response.json()) as T;
}

export function fetchDashboardSnapshot(): Promise<MasterDashboardSnapshot> {
  return requestJson<MasterDashboardSnapshot>(`${API_BASE}/dashboard`);
}

export function verifyStorageProbe(providerId?: StorageProviderId): Promise<VerifyStorageResponse> {
  return requestJson<VerifyStorageResponse>(`${API_BASE}/system/verify-storage`, {
    method: 'POST',
    body: JSON.stringify(providerId ? { providerId } : {}),
  });
}

export async function approveArchiveLocation(payload: {
  providerId: StorageProviderId;
  archivePath?: string;
  ownerConfirmed: boolean;
  initializeDirectory?: boolean;
}): Promise<ApproveArchiveLocationResponse> {
  const token = getOwnerToken();
  const response = await fetch(`${API_BASE}/storage/approve-location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-ng-owner-token': token } : {}),
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as ApproveArchiveLocationResponse;
}

export function updateRuntimeConfig(
  updates: Record<string, string>,
): Promise<{
  config: Record<string, string>;
  environment: SeparatedEnvironmentProbe;
  auditEntry: AuditLogEntry;
}> {
  return requestJson(`${API_BASE}/config`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function fetchAuditLogs(params: {
  limit?: number;
  outcome?: string;
  search?: string;
}): Promise<{ logs: AuditLogEntry[] }> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.outcome && params.outcome !== 'ALL') query.set('outcome', params.outcome);
  if (params.search && params.search.trim()) query.set('search', params.search.trim());
  const qs = query.toString();
  return requestJson<{ logs: AuditLogEntry[] }>(`${API_BASE}/audit${qs ? `?${qs}` : ''}`);
}

// --- PHASE 2A: Project Manager API Client ---
export function fetchProjects(params: { status?: string; search?: string } = {}): Promise<{
  projects: ProjectSummary[];
  independentResources: AvailableIndependentResource[];
}> {
  const query = new URLSearchParams();
  if (params.status && params.status !== 'ALL') query.set('status', params.status);
  if (params.search && params.search.trim()) query.set('search', params.search.trim());
  const qs = query.toString();
  return requestJson(`${API_BASE}/projects${qs ? `?${qs}` : ''}`);
}

export function fetchProjectDetail(projectId: string): Promise<{
  project: ProjectDetail;
  independentResources: AvailableIndependentResource[];
}> {
  return requestJson(`${API_BASE}/projects/${encodeURIComponent(projectId)}`);
}

export function createProject(input: {
  name: string;
  projectType: string;
  rootPath: string;
  version?: string;
  status?: ProjectStatus;
  dependencies?: string[];
  notes?: string;
}): Promise<{ project: ProjectDetail }> {
  return requestJson(`${API_BASE}/projects`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateProject(
  projectId: string,
  updates: {
    name?: string;
    projectType?: string;
    rootPath?: string;
    version?: string;
    status?: ProjectStatus;
    dependencies?: string[];
    notes?: string;
  },
): Promise<{ project: ProjectDetail }> {
  return requestJson(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export function linkProjectResource(
  projectId: string,
  resourceId: string,
  role = 'DEPENDENCY',
): Promise<{ project: ProjectDetail }> {
  return requestJson(`${API_BASE}/projects/${encodeURIComponent(projectId)}/resources`, {
    method: 'POST',
    body: JSON.stringify({ resourceId, role }),
  });
}

export function unlinkProjectResource(
  projectId: string,
  resourceId: string,
): Promise<{ project: ProjectDetail }> {
  return requestJson(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
    { method: 'DELETE' },
  );
}

export function exportProjectReport(projectId: string): Promise<{ report: ExportedProjectReport }> {
  return requestJson(`${API_BASE}/projects/${encodeURIComponent(projectId)}/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// --- Android Bridge API Client ---
export function fetchAndroidBridgeStatus(): Promise<{ diagnostics: AndroidBridgeDiagnostics }> {
  return requestJson(`${API_BASE}/android/bridge-status`);
}

export function submitAndroidBridgeAttestation(
  payload: Record<string, unknown>,
): Promise<{ diagnostics: AndroidBridgeDiagnostics }> {
  return requestJson(`${API_BASE}/android/attest`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokeAndroidSafPermission(): Promise<{ diagnostics: AndroidBridgeDiagnostics }> {
  return requestJson(`${API_BASE}/android/revoke`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// --- PHASE 8: Device Manager, Owner Security & Demo Mode API Client ---
export function fetchDeviceManagerStatus(): Promise<DeviceManagerSnapshot> {
  return requestJson<DeviceManagerSnapshot>(`${API_BASE}/device/status`);
}

export function executeApprovedCleanup(
  filePath: string,
  ownerApproved: boolean,
): Promise<{ result: { deletedPath: string; sha256BeforeDelete: string; sizeBytes: number } }> {
  return requestJson(`${API_BASE}/device/cleanup`, {
    method: 'POST',
    body: JSON.stringify({ filePath, ownerApproved }),
  });
}

export function fetchSecurityStatus(): Promise<SecuritySnapshot> {
  return requestJson<SecuritySnapshot>(`${API_BASE}/security/status`);
}

export async function setupOwnerPasskey(input: {
  passkey: string;
  deviceLabel?: string;
}): Promise<{ sessionId: string; sessionToken: string; snapshot: SecuritySnapshot }> {
  const res = await requestJson<{
    sessionId: string;
    sessionToken: string;
    snapshot: SecuritySnapshot;
  }>(`${API_BASE}/security/setup-owner`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setOwnerToken(res.sessionToken);
  return res;
}

export async function loginOwnerSession(input: {
  passkey: string;
  deviceLabel?: string;
}): Promise<{ sessionId: string; sessionToken: string; snapshot: SecuritySnapshot }> {
  const res = await requestJson<{
    sessionId: string;
    sessionToken: string;
    snapshot: SecuritySnapshot;
  }>(`${API_BASE}/security/login`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setOwnerToken(res.sessionToken);
  return res;
}

export function revokeOwnerSession(sessionId: string): Promise<{ snapshot: SecuritySnapshot }> {
  return requestJson(`${API_BASE}/security/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function updateSecurityPermissions(
  permissions: Partial<SecurityPermissions>,
): Promise<{ snapshot: SecuritySnapshot }> {
  return requestJson(`${API_BASE}/security/permissions`, {
    method: 'PUT',
    body: JSON.stringify(permissions),
  });
}

export function fetchDemoCatalog(): Promise<DemoCatalogSnapshot> {
  return requestJson<DemoCatalogSnapshot>(`${API_BASE}/demo/catalog`);
}

export function runDemoInference(
  productId: string,
  prompt: string,
): Promise<{ output: string; latencyMs: number }> {
  return requestJson(`${API_BASE}/demo/infer`, {
    method: 'POST',
    body: JSON.stringify({ productId, prompt }),
  });
}

export function resetDemoSandbox(): Promise<{ resetAt: string }> {
  return requestJson(`${API_BASE}/demo/reset`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

