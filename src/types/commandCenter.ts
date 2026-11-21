export type Locale = 'ar' | 'en';

export type SystemState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'READY'
  | 'BUSY'
  | 'WARNING'
  | 'ERROR'
  | 'NOT CONFIGURED';

export type StorageProviderId = 'host_dev' | 'android_saf' | 'termux' | 'external_sd';

export type StorageEnvironmentType =
  | 'HOST_DEVELOPMENT'
  | 'ANDROID_DEVICE'
  | 'TERMUX'
  | 'EXTERNAL_SD';

export type StorageState =
  | 'AVAILABLE'
  | 'NOT_FOUND'
  | 'NOT_AUTHORIZED'
  | 'NOT_MOUNTED'
  | 'READ_ONLY'
  | 'WRITE_TEST_FAILED'
  | 'VERIFY_FAILED';

export type AuditOutcome =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'PARTIAL'
  | 'INFO'
  | 'WARNING'
  | 'ERROR';

export interface StorageProviderProbeResult {
  providerId: StorageProviderId;
  environmentType: StorageEnvironmentType;
  configuredPath: string;
  discoveredPaths: string[];
  isVirtualHostPath: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  state: StorageState;
  totalBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
  failureReason: string | null;
  checkedAt: string;
}

export interface StorageVerificationReport {
  providerId: StorageProviderId;
  environmentType: StorageEnvironmentType;
  configuredPath: string;
  discoveredPaths: string[];
  readable: boolean;
  writable: boolean;
  state: StorageState;
  storageReady: boolean;
  testFilePath: string | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  contentMatched: boolean;
  cleanupCompleted: boolean;
  failureReason: string | null;
  executedAt: string;
}

export interface HostPlatformSnapshot {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  nodeVersion: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  cpuCount: number;
  uptimeSeconds: number;
}

export interface SeparatedEnvironmentProbe {
  hostEnvironment: {
    environmentType: 'HOST_DEVELOPMENT';
    label: string;
    host: HostPlatformSnapshot;
    provider: StorageProviderProbeResult;
  };
  androidDeviceEnvironment: {
    environmentType: 'ANDROID_DEVICE';
    targetDeviceModel: string;
    targetAndroidVersion: string;
    runningOnActualAndroidHardware: boolean;
    provider: StorageProviderProbeResult;
  };
  termuxEnvironment: {
    environmentType: 'TERMUX';
    termuxDetected: boolean;
    termuxPrefix: string;
    provider: StorageProviderProbeResult;
  };
  externalSdStorage: {
    environmentType: 'EXTERNAL_SD';
    archiveLocationConfirmedByOwner: boolean;
    provider: StorageProviderProbeResult;
  };
  selectedArchiveProvider: StorageProviderId;
  lastVerificationReport: StorageVerificationReport | null;
}

export interface BridgeHealthProbe {
  configured: boolean;
  endpointUrl: string;
  status: SystemState;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  category: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  details_json: string;
  created_at: string;
}

export interface ArchitectureModuleInfo {
  phase: string;
  id: string;
  nameEn: string;
  nameAr: string;
  status: 'ACTIVE' | 'PLANNED';
  descriptionEn: string;
  descriptionAr: string;
}

export interface MasterDashboardSnapshot {
  generatedAt: string;
  factoryStatus: SystemState;
  archiveStatus: SystemState;
  storageReady: boolean;
  bridgeStatus: SystemState;
  externalTrainingEnvStatus: SystemState;
  bridgeProbe: BridgeHealthProbe;
  counts: {
    libraryModels: number;
    importedModels: number;
    approvedBrains: number;
    totalProducts: number;
    totalResources: number;
    projects: number;
    archiveEntries: number;
    transferOperations: number;
    activeJobs: number;
    registeredWorkers: number;
    errorEvents: number;
  };
  wingsSummary?: {
    dataFactory: {
      status: SystemState;
      totalResources: number;
      verifiedResources: number;
      archiveEntries: number;
      storageReady: boolean;
    };
    newMindFactory: {
      status: SystemState;
      registeredWorkers: number;
      onlineWorkers: number;
      activeJobs: number;
      queuedJobs: number;
      importedModels: number;
    };
    mindRepairFactory: {
      status: SystemState;
      totalProducts: number;
      evaluationProducts: number;
      repairedProducts: number;
      approvedProducts: number;
    };
    trustSecurityCenter: {
      status: SystemState;
      qcReportsTotal: number;
      qcPassedTotal: number;
      ownerLockConfigured: boolean;
      activeSessions: number;
    };
    ngIpServices: {
      status: SystemState;
      releasedProducts: number;
      deliveryPackages: number;
      verifiedPackages: number;
    };
  };
  performanceMetrics?: PerformanceMetricsSnapshot;
  trainingMetrics?: TrainingMetricsSnapshot;
  syncMetadata?: RealtimeSyncMetadata;
  environment: SeparatedEnvironmentProbe;
  androidDiagnostics: AndroidBridgeDiagnostics;
  config: Record<string, string>;
  recentAuditLogs: AuditLogEntry[];
  modules: ArchitectureModuleInfo[];
}

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
  jobStatus:
    | 'QUEUED'
    | 'TRANSFERRING'
    | 'RUNNING'
    | 'PAUSED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
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

export type RealtimeSyncConnectionState =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTED';

export interface AndroidBridgeDiagnostics {
  flags: {
    HOST_ONLY: boolean;
    ANDROID_CONNECTED: boolean;
    TERMUX_CONNECTED: boolean;
    SD_AUTHORIZED: boolean;
    SD_READ_WRITE_VERIFIED: boolean;
  };
  runtimeHost: string;
  nativeBridgeDetectedOnServer: boolean;
  safUri: string;
  safUriValidScheme: boolean;
  permissionRevoked: boolean;
  attestation: {
    isNativeAndroid: boolean;
    manufacturer?: string;
    model: string;
    androidRelease: string;
    sdkInt: number;
    termuxPackageInstalled: boolean;
    safUri: string;
    persistedRead: boolean;
    persistedWrite: boolean;
    revoked: boolean;
    attestedAt: string;
  } | null;
  diagnosticNote: string;
}

export interface VerifyStorageResponse {
  outcome: AuditOutcome;
  hostReport: StorageVerificationReport;
  report: StorageVerificationReport;
  environment: SeparatedEnvironmentProbe;
  auditEntry: AuditLogEntry;
}

export interface ApproveArchiveLocationResponse {
  approved: boolean;
  report: StorageVerificationReport;
  environment: SeparatedEnvironmentProbe;
  auditEntry: AuditLogEntry;
}

// --- PHASE 2A: Project Manager Types ---
export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ARCHIVED';

export interface ProjectSummary {
  id: string;
  name: string;
  projectType: string;
  rootPath: string;
  version: string;
  status: ProjectStatus;
  dependencies: string[];
  notes: string;
  linkedResourcesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedResourceRecord {
  id: string;
  librarySection: string;
  name: string;
  resourceType: string;
  originSource: string;
  license: string;
  filePath: string;
  sizeBytes: number;
  version: string;
  sha256: string;
  verificationStatus: string;
  role: string;
  linkedAt: string;
  sharedProjectCount: number;
}

export interface AvailableIndependentResource {
  id: string;
  librarySection: string;
  name: string;
  resourceType: string;
  version: string;
  sha256: string;
  verificationStatus: string;
  linkedProjectCount: number;
}

export interface RootDirectoryFileEntry {
  name: string;
  kind: 'FILE' | 'DIRECTORY';
  sizeBytes: number;
  modifiedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  linkedResources: LinkedResourceRecord[];
  rootPathInspection: {
    exists: boolean;
    readable: boolean;
    files: RootDirectoryFileEntry[];
    error: string | null;
  };
}

export interface ExportedProjectReport {
  fileName: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  markdown: string;
  generatedAt: string;
}

// --- PHASE 8: Device Manager, Owner Security & Isolated Demo Mode ---
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

export interface SecurityPermissions {
  exportRequiresAuth: boolean;
  deleteRequiresAuth: boolean;
  pairingRequiresAuth: boolean;
}

export type SessionRole = 'OWNER' | 'OPERATOR' | 'VIEWER';

export interface OwnerSessionRecord {
  id: string;
  deviceLabel: string;
  role?: SessionRole;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
  isCurrent: boolean;
}

export interface SecuritySnapshot {
  ownerLockConfigured: boolean;
  bootstrapTokenRequired?: boolean;
  sessionAuthenticated: boolean;
  activeSessionId: string | null;
  activeRole?: SessionRole | null;
  permissions: SecurityPermissions;
  sessions: OwnerSessionRecord[];
}

export interface SanitizedDemoProduct {
  id: string;
  name: string;
  productClass: string;
  version: string;
  architectureSummary: string;
  trainingSummary: string;
  evaluationSummary: string;
  license: string;
  lifecycleState: 'APPROVED' | 'RELEASED';
  updatedAt: string;
}

export interface DemoCatalogSnapshot {
  isolatedMode: true;
  generatedAt: string;
  approvedProducts: SanitizedDemoProduct[];
  inferenceEngine: {
    available: boolean;
    status: string;
    detail: string;
  };
  restrictions: {
    weightsAccessBlocked: true;
    archiveAccessBlocked: true;
    settingsModificationBlocked: true;
  };
}

// --- FIVE PRODUCTION WINGS (Phases 2B - 7) ---
export type WingId =
  | 'DATA_FACTORY'
  | 'NEW_MIND_FACTORY'
  | 'MIND_REPAIR_FACTORY'
  | 'TRUST_SECURITY_CENTER'
  | 'NG_IP_SERVICES';

export type LibrarySection = 'MODEL' | 'DATASET' | 'SOFTWARE' | 'KNOWLEDGE';
export type ArchiveCategoryFolder =
  | 'INVENTORY'
  | 'LIBRARIES'
  | 'AI_MODELS'
  | 'DATASETS'
  | 'CHECKPOINTS'
  | 'BUILD_TOOLS'
  | 'CONFIGURATIONS'
  | 'RESTORE_PACKAGES'
  | 'MANIFESTS';

export interface ResourceRecord {
  id: string;
  librarySection: LibrarySection;
  name: string;
  resourceType: string;
  originSource: string;
  license: string;
  filePath: string;
  sizeBytes: number;
  version: string;
  sha256: string;
  verificationStatus: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'QUARANTINED';
  dependencies: string[];
  transferable: boolean;
  linkedProjectCount: number;
  importedAt: string;
  updatedAt: string;
}

export interface ArchiveEntryRecord {
  id: string;
  resourceId: string | null;
  categoryFolder: ArchiveCategoryFolder;
  archivePath: string;
  sourcePath: string;
  sha256: string;
  sizeBytes: number;
  verifyStatus: 'VERIFIED' | 'MISSING' | 'MISMATCH' | 'PENDING';
  lastVerifiedAt: string | null;
  archivedAt: string;
}

export type ModelScaleTier = '1B' | '3B' | '7B' | '13B' | '30B+';

export interface ScaleResourceProfile {
  scaleTier: ModelScaleTier;
  parametersBillions: number;
  fp16WeightsGb: number;
  loraTrainMinVramGb: number;
  fullTrainMinVramGb: number;
  quantizedInt4InferenceGb: number;
  recommendedSystemRamGb: number;
}

export interface TrainingWorkerRecord {
  id: string;
  workerName: string;
  endpointUrl: string;
  pairingFingerprint: string;
  status: SystemState;
  lastHeartbeatAt: string | null;
  capabilities: {
    gpuModel: string;
    vramGb: number;
    systemRamGb: number;
    maxSupportedScale: ModelScaleTier;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TrainingJobRecord {
  id: string;
  modelId: string;
  datasetId: string;
  workerId: string;
  architecture: string;
  scaleTier: ModelScaleTier;
  config: Record<string, unknown>;
  jobStatus:
    | 'QUEUED'
    | 'TRANSFERRING'
    | 'RUNNING'
    | 'PAUSED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  currentStep: number;
  totalSteps: number;
  trainingLoss: number | null;
  validationLoss: number | null;
  checkpointPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export type NgProductClass =
  | 'NG-BASE'
  | 'NG-DOMAIN'
  | 'NG-ADAPTED'
  | 'NG-REPAIRED'
  | 'NG-REENGINEERED'
  | 'NG-QUANTIZED'
  | 'NG-SECURED'
  | 'NG-SOFTWARE';

export type ModelLifecycleState =
  | 'IMPORTED'
  | 'INSPECTED'
  | 'READY_FOR_TRAINING'
  | 'TRAINING'
  | 'EVALUATION'
  | 'FAILED'
  | 'APPROVED'
  | 'RELEASED'
  | 'ARCHIVED';

export interface ModelProductRecord {
  id: string;
  name: string;
  productClass: NgProductClass;
  version: string;
  weightsSha256: string;
  architectureSummary: string;
  trainingSummary: string;
  evaluationSummary: string;
  license: string;
  runtimeRequirements: Record<string, unknown>;
  safetyReport: Record<string, unknown>;
  changelog: string;
  lifecycleState: ModelLifecycleState;
  qcPassedCount: number;
  qcTotalCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QcSuiteReportRow {
  id: string;
  productId: string;
  testSuite: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' | 'NOT TESTED';
  details: Record<string, unknown>;
  executedAt: string;
}

export interface DeliveryPackageRecord {
  id: string;
  productId: string;
  zipPath: string;
  manifestSha256: string;
  packageSha256: string;
  sizeBytes: number;
  verified: boolean;
  createdAt: string;
}

export interface DatasetPackageBuildResult {
  resource: ResourceRecord;
  packageDir: string;
  dataFilePath: string;
  dataFileSha256: string;
  manifestPath: string;
  manifestSha256: string;
  stats: {
    inputSourcesCount: number;
    rawLinesCount: number;
    cleanedLinesCount: number;
    droppedShortOrEmpty: number;
    deduplicatedCount: number;
    outputBytes: number;
  };
}

export interface ArchiveBatchVerifyResult {
  totalChecked: number;
  verifiedCount: number;
  mismatchCount: number;
  missingCount: number;
  entries: ArchiveEntryRecord[];
}

export interface IndependentMindCreateResult {
  productId: string;
  resourceId: string;
  mindDir: string;
  weightsManifestPath: string;
  weightsSha256: string;
}

export interface TrainingCheckpointSaveResult {
  job: TrainingJobRecord;
  checkpointPath: string;
  checkpointSha256: string;
  resultsLogPath: string;
}

export interface TrainingCheckpointRestoreResult {
  job: TrainingJobRecord;
  verifiedSha256: string;
  restoredStep: number;
}

export interface TrainingJobLogsResult {
  jobId: string;
  entries: Array<Record<string, unknown>>;
  checkpoints: string[];
}

export interface RepairExternalIntakeResult {
  product: ModelProductRecord;
  originalBackupPath: string;
  originalSha256: string;
  inspectionReport: {
    sha256Valid: boolean;
    sizeBytes: number;
    licenseCompliant: boolean;
    warnings: string[];
  };
}

export interface TrustQcRunResult {
  productId: string;
  passedCount: number;
  totalCount: number;
  allPassed: boolean;
  evidencePath: string;
  evidenceSha256: string;
  reports: QcSuiteReportRow[];
}

export interface DeliveryPackageVerifyResult {
  deliveryPackage: DeliveryPackageRecord;
  fileExists: boolean;
  validPkzipHeader: boolean;
  sha256Matched: boolean;
  actualSha256: string;
}

export type ResourceLibraryHealthStatus = 'HEALTHY' | 'CORRUPTED';

export interface ResourceIntegrityItem {
  id: string;
  name: string;
  librarySection: LibrarySection;
  verificationStatus: 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'QUARANTINED';
  sha256: string;
  sizeBytes: number;
  filePath: string;
  updatedAt: string;
}

export interface ResourceLibraryIntegrityStatus {
  overallStatus: ResourceLibraryHealthStatus;
  totalResources: number;
  verifiedCount: number;
  corruptedCount: number;
  unverifiedCount: number;
  totalBytes: number;
  running: boolean;
  checkedCount: number;
  checkTotalCount: number;
  startedAt: string | null;
  lastCheckedAt: string | null;
  resources: ResourceIntegrityItem[];
}

export interface StartIntegrityCheckResponse {
  started: boolean;
  status: ResourceLibraryIntegrityStatus;
}

