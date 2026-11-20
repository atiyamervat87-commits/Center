import type {
  AndroidBridgeDiagnostics,
  ApproveArchiveLocationResponse,
  ArchiveBatchVerifyResult,
  ArchiveCategoryFolder,
  ArchiveEntryRecord,
  AuditLogEntry,
  AvailableIndependentResource,
  DatasetPackageBuildResult,
  DeliveryPackageRecord,
  DeliveryPackageVerifyResult,
  DemoCatalogSnapshot,
  DeviceManagerSnapshot,
  ExportedProjectReport,
  IndependentMindCreateResult,
  LibrarySection,
  MasterDashboardSnapshot,
  ModelLifecycleState,
  ModelProductRecord,
  ModelScaleTier,
  NgProductClass,
  PerformanceMetricsSnapshot,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
  QcSuiteReportRow,
  RealtimeSyncMetadata,
  RepairExternalIntakeResult,
  ResourceLibraryIntegrityStatus,
  ResourceRecord,
  ScaleResourceProfile,
  SecurityPermissions,
  SecuritySnapshot,
  SeparatedEnvironmentProbe,
  StartIntegrityCheckResponse,
  StorageProviderId,
  TrainingCheckpointRestoreResult,
  TrainingCheckpointSaveResult,
  TrainingJobLogsResult,
  TrainingJobRecord,
  TrainingMetricsSnapshot,
  TrainingWorkerRecord,
  TrustQcRunResult,
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

// --- FIVE PRODUCTION WINGS API CLIENT ---
export function fetchDataFactoryState(params: { section?: string; search?: string } = {}): Promise<{
  resources: ResourceRecord[];
  archiveEntries: ArchiveEntryRecord[];
}> {
  const query = new URLSearchParams();
  if (params.section && params.section !== 'ALL') query.set('section', params.section);
  if (params.search?.trim()) query.set('search', params.search.trim());
  const qs = query.toString();
  return requestJson(`${API_BASE}/wings/data/resources${qs ? `?${qs}` : ''}`);
}

export function fetchResourceLibraryIntegrityStatus(): Promise<ResourceLibraryIntegrityStatus> {
  return requestJson<ResourceLibraryIntegrityStatus>(`${API_BASE}/wings/data/resources/integrity`);
}

export function triggerResourceLibraryIntegrityCheck(): Promise<StartIntegrityCheckResponse> {
  return requestJson<StartIntegrityCheckResponse>(`${API_BASE}/wings/data/resources/check-integrity`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function registerFactoryResource(input: {
  librarySection: LibrarySection;
  name: string;
  resourceType: string;
  originSource: string;
  license: string;
  filePath?: string;
  contentText?: string;
  contentBase64?: string;
  originalFileName?: string;
  version?: string;
}): Promise<{ resource: ResourceRecord; deduplicated: boolean }> {
  return requestJson(`${API_BASE}/wings/data/resources`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function buildCleanedDatasetPackage(input: {
  datasetName: string;
  license: string;
  originSource?: string;
  version?: string;
  sourceResourceIds?: string[];
  rawFiles?: Array<{ fileName: string; contentText?: string; contentBase64?: string }>;
  stripHtml?: boolean;
  deduplicateLines?: boolean;
  minLineLength?: number;
  format?: 'JSONL' | 'TXT';
}): Promise<DatasetPackageBuildResult> {
  return requestJson(`${API_BASE}/wings/data/dataset-package`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function verifyFactoryResource(resourceId: string): Promise<{ resource: ResourceRecord }> {
  return requestJson(`${API_BASE}/wings/data/resources/${encodeURIComponent(resourceId)}/verify`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function deleteFactoryResource(resourceId: string): Promise<{ deletedId: string }> {
  return requestJson(`${API_BASE}/wings/data/resources/${encodeURIComponent(resourceId)}`, {
    method: 'DELETE',
  });
}

export function archiveFactoryResource(
  resourceId: string,
  categoryFolder: ArchiveCategoryFolder,
): Promise<{ entry: ArchiveEntryRecord }> {
  return requestJson(`${API_BASE}/wings/data/archive`, {
    method: 'POST',
    body: JSON.stringify({ resourceId, categoryFolder }),
  });
}

export function verifyArchiveBatch(): Promise<ArchiveBatchVerifyResult> {
  return requestJson(`${API_BASE}/wings/data/archive/verify`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function generateFactoryManifest(): Promise<{
  manifest: { filePath: string; sha256: string; resourceCount: number; archiveCount: number };
}> {
  return requestJson(`${API_BASE}/wings/data/manifest`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchMindFactoryOverview(): Promise<{
  workers: TrainingWorkerRecord[];
  jobs: TrainingJobRecord[];
  scaleMatrix: ScaleResourceProfile[];
}> {
  return requestJson(`${API_BASE}/wings/mind/overview`);
}

export function registerTrainingWorker(input: {
  workerName: string;
  endpointUrl: string;
  gpuModel: string;
  vramGb: number;
  systemRamGb: number;
  maxSupportedScale?: ModelScaleTier;
}): Promise<{ worker: TrainingWorkerRecord }> {
  return requestJson(`${API_BASE}/wings/mind/workers`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function probeTrainingWorker(workerId: string): Promise<{
  worker: TrainingWorkerRecord;
  reachable: boolean;
  latencyMs: number | null;
  detail: string;
}> {
  return requestJson(`${API_BASE}/wings/mind/workers/${encodeURIComponent(workerId)}/probe`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function prepareWorkerTransferManifest(
  resourceId: string,
  workerId: string,
): Promise<{
  manifest: {
    manifestPath: string;
    manifestSha256: string;
    chunkCount: number;
    totalBytes: number;
    workerEndpoint: string;
  };
}> {
  return requestJson(`${API_BASE}/wings/mind/transfer-manifest`, {
    method: 'POST',
    body: JSON.stringify({ resourceId, workerId }),
  });
}

export function intakeExternalModel(input: {
  name: string;
  productClass?: NgProductClass;
  version: string;
  architectureSummary: string;
  scaleTier: ModelScaleTier;
  license: string;
  weightsPath?: string;
  tokenizerSpec?: string;
  originSource: string;
}): Promise<{ productId: string; resourceId: string; weightsSha256: string; inspected: boolean }> {
  return requestJson(`${API_BASE}/wings/mind/intake`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createFactoryTrainingJob(input: {
  modelId: string;
  datasetId: string;
  workerId: string;
  architecture: string;
  scaleTier: ModelScaleTier;
  totalSteps: number;
  learningRate?: string;
  dispatchToWorker?: boolean;
}): Promise<{ job: TrainingJobRecord; dispatchNote: string }> {
  return requestJson(`${API_BASE}/wings/mind/jobs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function controlFactoryTrainingJob(
  jobId: string,
  action: 'PAUSE' | 'RESUME' | 'CANCEL',
): Promise<{ job: TrainingJobRecord }> {
  return requestJson(`${API_BASE}/wings/mind/jobs/${encodeURIComponent(jobId)}/control`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export function createIndependentMindApi(input: {
  name: string;
  productClass?: NgProductClass;
  version: string;
  scaleTier: ModelScaleTier;
  architecture: string;
  tokenizerSpec: string;
  license: string;
  baseDatasetId?: string;
  seedConfigJson?: string;
}): Promise<IndependentMindCreateResult> {
  return requestJson(`${API_BASE}/wings/mind/create`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveTrainingCheckpointApi(
  jobId: string,
  input: {
    step: number;
    trainingLoss?: number | null;
    validationLoss?: number | null;
    checkpointNotes?: string;
    jobStatus?: TrainingJobRecord['jobStatus'];
  },
): Promise<TrainingCheckpointSaveResult> {
  return requestJson(`${API_BASE}/wings/mind/jobs/${encodeURIComponent(jobId)}/checkpoint`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function restoreTrainingCheckpointApi(
  jobId: string,
  checkpointPath: string,
): Promise<TrainingCheckpointRestoreResult> {
  return requestJson(`${API_BASE}/wings/mind/jobs/${encodeURIComponent(jobId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ checkpointPath }),
  });
}

export function fetchTrainingJobLogs(jobId: string): Promise<TrainingJobLogsResult> {
  return requestJson(`${API_BASE}/wings/mind/jobs/${encodeURIComponent(jobId)}/logs`);
}

export function fetchRepairProducts(): Promise<{ products: ModelProductRecord[] }> {
  return requestJson(`${API_BASE}/wings/repair/products`);
}

export function receiveExternalModelForRepairApi(input: {
  name: string;
  version: string;
  originSource: string;
  license: string;
  architectureSummary: string;
  weightsPath?: string;
  fileName?: string;
  fileBase64?: string;
  contentText?: string;
}): Promise<RepairExternalIntakeResult> {
  return requestJson(`${API_BASE}/wings/repair/intake`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function saveRepairProduct(input: {
  id?: string;
  name: string;
  productClass: NgProductClass;
  version: string;
  weightsSha256: string;
  architectureSummary: string;
  trainingSummary?: string;
  evaluationSummary?: string;
  license: string;
  safetyNotes?: string;
  restoreCheckpointPath?: string;
  changelog?: string;
}): Promise<{ product: ModelProductRecord }> {
  return requestJson(`${API_BASE}/wings/repair/products`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function transitionRepairProductState(
  productId: string,
  nextState: ModelLifecycleState,
): Promise<{ product: ModelProductRecord }> {
  return requestJson(`${API_BASE}/wings/repair/products/${encodeURIComponent(productId)}/state`, {
    method: 'PUT',
    body: JSON.stringify({ nextState }),
  });
}

export function fetchTrustQcReports(productId?: string): Promise<{ reports: QcSuiteReportRow[] }> {
  const qs = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return requestJson(`${API_BASE}/wings/trust/qc${qs}`);
}

export function runTrustQcCheck(productId: string): Promise<TrustQcRunResult> {
  return requestJson(`${API_BASE}/wings/trust/qc/${encodeURIComponent(productId)}/run`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchNgIpDeliveryPackages(): Promise<{ packages: DeliveryPackageRecord[] }> {
  return requestJson(`${API_BASE}/wings/ngip/packages`);
}

export function buildNgIpDeliveryPackage(
  productId: string,
  options: { ipHolder?: string; licenseTermsNote?: string } = {},
): Promise<{ deliveryPackage: DeliveryPackageRecord }> {
  return requestJson(`${API_BASE}/wings/ngip/packages/${encodeURIComponent(productId)}/build`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

export function verifyDeliveryPackageApi(packageId: string): Promise<DeliveryPackageVerifyResult> {
  return requestJson(`${API_BASE}/wings/ngip/packages/${encodeURIComponent(packageId)}/verify`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function downloadDeliveryPackageZip(packageId: string, fallbackFileName?: string): Promise<string> {
  const token = getOwnerToken();
  const response = await fetch(`${API_BASE}/wings/ngip/packages/${encodeURIComponent(packageId)}/download`, {
    method: 'GET',
    headers: {
      ...(token ? { 'x-ng-owner-token': token } : {}),
    },
  });

  if (!response.ok) {
    let errMessage = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) errMessage = payload.error;
    } catch {
      // ignore
    }
    throw new Error(errMessage);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const fileName = match?.[1] || fallbackFileName || `${packageId}.zip`;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

// --- REAL-TIME SYNCHRONIZATION CLIENT HELPERS ---
export function fetchRealtimeMetrics(): Promise<{
  performanceMetrics: PerformanceMetricsSnapshot;
  trainingMetrics: TrainingMetricsSnapshot;
  syncMetadata: RealtimeSyncMetadata;
}> {
  return requestJson(`${API_BASE}/sync/metrics`);
}

export function triggerRealtimeSyncRefresh(): Promise<{
  snapshot: MasterDashboardSnapshot;
  workerSync: {
    probedWorkers: number;
    onlineWorkers: number;
    updatedJobs: number;
  };
}> {
  return requestJson(`${API_BASE}/sync/refresh`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

