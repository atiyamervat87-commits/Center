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
  environment: SeparatedEnvironmentProbe;
  androidDiagnostics: AndroidBridgeDiagnostics;
  config: Record<string, string>;
  recentAuditLogs: AuditLogEntry[];
  modules: ArchitectureModuleInfo[];
}

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

export interface OwnerSessionRecord {
  id: string;
  deviceLabel: string;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
  isCurrent: boolean;
}

export interface SecuritySnapshot {
  ownerLockConfigured: boolean;
  sessionAuthenticated: boolean;
  activeSessionId: string | null;
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

