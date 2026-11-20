import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { listAuditLogs } from '../audit/auditService.ts';
import { probeDeviceEnvironment } from '../storage/storageProbe.ts';
import { computeAndroidBridgeDiagnostics } from '../storage/androidBridgeDiagnostic.ts';
import {
  collectPerformanceMetrics,
  collectTrainingMetrics,
  getRealtimeSyncService,
} from './realtimeSyncService.ts';

export type SystemState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'READY'
  | 'BUSY'
  | 'WARNING'
  | 'ERROR'
  | 'NOT CONFIGURED';

export interface BridgeHealthProbe {
  configured: boolean;
  endpointUrl: string;
  status: SystemState;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface ArchitectureModuleStatus {
  phase: string;
  id: string;
  nameEn: string;
  nameAr: string;
  status: 'ACTIVE' | 'PLANNED';
  descriptionEn: string;
  descriptionAr: string;
}

export async function probeTrainingBridge(endpointUrl: string): Promise<BridgeHealthProbe> {
  const checkedAt = new Date().toISOString();
  const trimmed = endpointUrl.trim();
  if (!trimmed) {
    return {
      configured: false,
      endpointUrl: '',
      status: 'NOT CONFIGURED',
      latencyMs: null,
      detail: 'No training worker endpoint URL configured',
      checkedAt,
    };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const healthUrl = trimmed.endsWith('/') ? `${trimmed}health` : `${trimmed}/health`;
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return {
        configured: true,
        endpointUrl: trimmed,
        status: 'ONLINE',
        latencyMs,
        detail: `HTTP ${response.status} verified`,
        checkedAt,
      };
    }

    return {
      configured: true,
      endpointUrl: trimmed,
      status: 'WARNING',
      latencyMs,
      detail: `Worker responded with HTTP ${response.status}`,
      checkedAt,
    };
  } catch (err) {
    return {
      configured: true,
      endpointUrl: trimmed,
      status: 'OFFLINE',
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : 'Unreachable worker endpoint',
      checkedAt,
    };
  }
}

export function getArchitectureModules(): ArchitectureModuleStatus[] {
  return [
    {
      phase: 'PHASE 1',
      id: 'master-dashboard',
      nameEn: 'Master Dashboard & Core Architecture',
      nameAr: 'لوحة القيادة الرئيسية والهيكل الأساسي',
      status: 'ACTIVE',
      descriptionEn: 'SQLite persistence, real filesystem/device probes, audit trail, bilingual command shell.',
      descriptionAr: 'قاعدة بيانات SQLite، فحص حقيقي للتخزين والجهاز، سجل العمليات، وواجهة القيادة ثنائية اللغة.',
    },
    {
      phase: 'PHASE 2A',
      id: 'project-manager',
      nameEn: 'Project Manager (Active)',
      nameAr: 'مدير المشروعات المستقل (نشط)',
      status: 'ACTIVE',
      descriptionEn: 'Project registration, versioning, status lifecycle, root path inspection, shared resource protection, and verified report export.',
      descriptionAr: 'تسجيل المشروعات، إدارة الإصدارات والحالات، فحص مسار الملفات، حماية الموارد المشتركة، وتصدير التقارير الموثقة.',
    },
    {
      phase: 'PHASE 2B',
      id: 'resources-archive',
      nameEn: 'DATA FACTORY — Resource Library & Smart Archive',
      nameAr: 'جناح البيانات — مكتبة الموارد والأرشيف الذكي',
      status: 'ACTIVE',
      descriptionEn: 'Independent resource registry with SHA-256 deduplication, integrity verification, and gated Smart Archive manifests.',
      descriptionAr: 'سجل الموارد المستقل ببصمة SHA-256، التحقق من السلامة، ونظام الأرشفة الذكية المقيد بجاهزية الوسيط.',
    },
    {
      phase: 'PHASE 3',
      id: 'model-intake',
      nameEn: 'NEW MIND FACTORY — Model Intake Center',
      nameAr: 'مصنع العقول الجديدة — مركز استقبال النماذج',
      status: 'ACTIVE',
      descriptionEn: 'Model registration, weights SHA-256 inspection, tokenizer/architecture checks, and license recording.',
      descriptionAr: 'استقبال النماذج وفحص بصمة الأوزان والمعمارية والتوافق وتوثيق التراخيص.',
    },
    {
      phase: 'PHASE 4',
      id: 'computer-bridge',
      nameEn: 'NEW MIND FACTORY — Computer Training Bridge',
      nameAr: 'مصنع العقول الجديدة — جسر كمبيوتر التدريب',
      status: 'ACTIVE',
      descriptionEn: 'Real HTTP worker health probing, GPU/VRAM scaling checks (1B–30B+), and SHA-256 chunked transfer manifests.',
      descriptionAr: 'فحص اتصال HTTP الحقيقي بالعمال، تخطيط سعة 1B–30B+، وتجهيز حزم النقل ببصمة SHA-256.',
    },
    {
      phase: 'PHASE 5',
      id: 'training-jobs',
      nameEn: 'NEW MIND FACTORY — Training Job Manager',
      nameAr: 'مصنع العقول الجديدة — إدارة مهام التدريب',
      status: 'ACTIVE',
      descriptionEn: 'Capacity-validated job queuing, real worker HTTP dispatch, pause/cancel controls, zero fake telemetry.',
      descriptionAr: 'تجهيز وإرسال المهام وفق سعة VRAM الفعلية، وإيقاف/إلغاء آمن دون أي نسب تقدم وهمية.',
    },
    {
      phase: 'PHASE 6',
      id: 'product-registry',
      nameEn: 'MIND REPAIR & RE-ENG — Product Registry',
      nameAr: 'مصنع الإصلاح وإعادة الهندسة — سجل الأجيال والمنتجات',
      status: 'ACTIVE',
      descriptionEn: 'NG-BASE to NG-SOFTWARE lifecycle state machine blocking approval/release until all 10 QC suites pass.',
      descriptionAr: 'تصنيفات NG-* وإدارة الإصدارات ونقاط الاستعادة مع منع الاعتماد قبل اجتياز اختبارات الجودة.',
    },
    {
      phase: 'PHASE 7',
      id: 'qc-delivery',
      nameEn: 'TRUST & NG-IP — 10-Suite QC & Certified Delivery',
      nameAr: 'مركز الثقة وNG-IP — الجودة العشرية وحزم التسليم',
      status: 'ACTIVE',
      descriptionEn: '10-suite QC verification, license compliance checks, and SHA-256 verified ZIP delivery package builder.',
      descriptionAr: 'فحوصات الجودة العشرة والتحقق من التراخيص وبناء حزم تسليم ZIP موثقة ببصمة SHA-256.',
    },
    {
      phase: 'PHASE 8',
      id: 'device-security-demo',
      nameEn: 'Device Manager, Owner Security & Demo Mode',
      nameAr: 'إدارة الهاتف، أمن المالك، ووضع العرض التجريبي',
      status: 'ACTIVE',
      descriptionEn: 'Owner-approved cleanup suggestions, auth/RBAC sessions, isolated client demo mode.',
      descriptionAr: 'اقتراحات تنظيف بموافقة المالك، إدارة الجلسات والصلاحيات، ووضع عرض معزول.',
    },
  ];
}

export async function getMasterDashboardSnapshot(db: DatabaseSync) {
  const config = getConfigMap(db);
  const environment = probeDeviceEnvironment(config);
  const bridgeProbe = await probeTrainingBridge(config.bridge_endpoint ?? '');

  const countScalar = (sql: string): number => {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  };

  const libraryModelsCount = countScalar(
    "SELECT COUNT(*) AS count FROM resources WHERE library_section = 'MODEL'",
  );
  const importedModelsCount = countScalar(
    "SELECT COUNT(*) AS count FROM model_products WHERE lifecycle_state = 'IMPORTED'",
  );
  const approvedBrainsCount = countScalar(
    "SELECT COUNT(*) AS count FROM model_products WHERE lifecycle_state IN ('APPROVED', 'RELEASED')",
  );
  const totalProductsCount = countScalar('SELECT COUNT(*) AS count FROM model_products');
  const activeJobsCount = countScalar(
    "SELECT COUNT(*) AS count FROM training_jobs WHERE job_status IN ('QUEUED', 'TRANSFERRING', 'RUNNING')",
  );
  const totalResourcesCount = countScalar('SELECT COUNT(*) AS count FROM resources');
  const projectsCount = countScalar('SELECT COUNT(*) AS count FROM projects');
  const archiveEntriesCount = countScalar('SELECT COUNT(*) AS count FROM archive_entries');
  const workersCount = countScalar('SELECT COUNT(*) AS count FROM training_workers');
  const transferAndIoCount = countScalar(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE category IN ('TRANSFER', 'IMPORT', 'EXPORT', 'ARCHIVE')",
  );
  const errorAuditCount = countScalar(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE outcome IN ('ERROR', 'FAIL')",
  );

  const recentAuditLogs = listAuditLogs(db, { limit: 12 });

  // Honest Factory & Storage Status Calculation:
  // Host Development storage is separated from Android/SD/Termux environments.
  // STORAGE READY (archiveStatus = 'READY') is NEVER reported unless owner confirmed location AND SHA-256 read/write verification passed.
  const hostWritable = environment.hostEnvironment.provider.writable;
  const selectedId = environment.selectedArchiveProvider;
  const selectedProviderProbe =
    selectedId === 'host_dev'
      ? environment.hostEnvironment.provider
      : selectedId === 'android_saf'
        ? environment.androidDeviceEnvironment.provider
        : selectedId === 'termux'
          ? environment.termuxEnvironment.provider
          : environment.externalSdStorage.provider;

  const verification = environment.lastVerificationReport;
  const verifiedForSelected =
    Boolean(verification) &&
    verification?.providerId === selectedId &&
    verification?.configuredPath === selectedProviderProbe.configuredPath &&
    verification?.storageReady === true &&
    verification?.contentMatched === true &&
    verification?.expectedSha256 === verification?.actualSha256;

  const androidDiagnostics = computeAndroidBridgeDiagnostics(config);
  const ownerConfirmed = environment.externalSdStorage.archiveLocationConfirmedByOwner;
  const storageReady =
    selectedId === 'android_saf'
      ? androidDiagnostics.flags.SD_READ_WRITE_VERIFIED
      : ownerConfirmed && verifiedForSelected && selectedProviderProbe.state === 'AVAILABLE';

  let archiveStatus: SystemState = 'NOT CONFIGURED';
  if (selectedId === 'android_saf') {
    if (androidDiagnostics.flags.SD_READ_WRITE_VERIFIED) {
      archiveStatus = 'READY';
    } else if (androidDiagnostics.flags.ANDROID_CONNECTED) {
      archiveStatus = 'WARNING';
    } else {
      archiveStatus = 'OFFLINE';
    }
  } else if (!selectedProviderProbe.configuredPath) {
    archiveStatus = 'NOT CONFIGURED';
  } else if (storageReady) {
    archiveStatus = 'READY';
  } else if (
    selectedProviderProbe.state === 'NOT_MOUNTED' ||
    selectedProviderProbe.state === 'NOT_FOUND'
  ) {
    archiveStatus = 'OFFLINE';
  } else if (
    selectedProviderProbe.state === 'READ_ONLY' ||
    selectedProviderProbe.state === 'NOT_AUTHORIZED' ||
    selectedProviderProbe.state === 'AVAILABLE'
  ) {
    // Even if AVAILABLE on filesystem, until owner confirms & SHA-256 test passes, it is WARNING (not READY)
    archiveStatus = 'WARNING';
  } else {
    archiveStatus = 'ERROR';
  }

  let factoryStatus: SystemState = 'READY';
  if (!hostWritable) {
    factoryStatus = 'ERROR';
  } else if (activeJobsCount > 0) {
    factoryStatus = 'BUSY';
  } else if (errorAuditCount > 0 || !storageReady) {
    factoryStatus = 'WARNING';
  } else {
    factoryStatus = 'ONLINE';
  }

  let externalTrainingEnvStatus: SystemState = 'NOT CONFIGURED';
  if (workersCount > 0 || bridgeProbe.configured) {
    externalTrainingEnvStatus = bridgeProbe.status;
  }

  const verifiedResourcesCount = countScalar(
    "SELECT COUNT(*) AS count FROM resources WHERE verification_status = 'VERIFIED'",
  );
  const onlineWorkersCount = countScalar(
    "SELECT COUNT(*) AS count FROM training_workers WHERE status = 'ONLINE'",
  );
  const queuedJobsCount = countScalar(
    "SELECT COUNT(*) AS count FROM training_jobs WHERE job_status = 'QUEUED'",
  );
  const evaluationProductsCount = countScalar(
    "SELECT COUNT(*) AS count FROM model_products WHERE lifecycle_state IN ('INSPECTED', 'EVALUATION')",
  );
  const repairedProductsCount = countScalar(
    "SELECT COUNT(*) AS count FROM model_products WHERE product_class IN ('NG-REPAIRED', 'NG-REENGINEERED')",
  );
  const releasedProductsCount = countScalar(
    "SELECT COUNT(*) AS count FROM model_products WHERE lifecycle_state = 'RELEASED'",
  );
  const qcReportsTotal = countScalar('SELECT COUNT(*) AS count FROM qc_reports');
  const qcPassedTotal = countScalar(
    "SELECT COUNT(*) AS count FROM qc_reports WHERE result = 'PASS'",
  );
  const deliveryPackagesCount = countScalar('SELECT COUNT(*) AS count FROM delivery_packages');
  const verifiedDeliveryPackagesCount = countScalar(
    'SELECT COUNT(*) AS count FROM delivery_packages WHERE verified = 1',
  );
  const activeSessionsCount = countScalar(
    'SELECT COUNT(*) AS count FROM owner_sessions WHERE revoked = 0',
  );

  const wingsSummary = {
    dataFactory: {
      status: (storageReady ? 'READY' : totalResourcesCount > 0 ? 'WARNING' : 'ONLINE') as SystemState,
      totalResources: totalResourcesCount,
      verifiedResources: verifiedResourcesCount,
      archiveEntries: archiveEntriesCount,
      storageReady,
    },
    newMindFactory: {
      status: (onlineWorkersCount > 0 ? 'ONLINE' : workersCount > 0 ? 'WARNING' : 'READY') as SystemState,
      registeredWorkers: workersCount,
      onlineWorkers: onlineWorkersCount,
      activeJobs: activeJobsCount,
      queuedJobs: queuedJobsCount,
      importedModels: importedModelsCount,
    },
    mindRepairFactory: {
      status: (totalProductsCount > 0 ? 'READY' : 'ONLINE') as SystemState,
      totalProducts: totalProductsCount,
      evaluationProducts: evaluationProductsCount,
      repairedProducts: repairedProductsCount,
      approvedProducts: approvedBrainsCount,
    },
    trustSecurityCenter: {
      status: (config.owner_passkey_hash ? 'ONLINE' : 'WARNING') as SystemState,
      qcReportsTotal,
      qcPassedTotal,
      ownerLockConfigured: Boolean(config.owner_passkey_hash),
      activeSessions: activeSessionsCount,
    },
    ngIpServices: {
      status: (verifiedDeliveryPackagesCount > 0 ? 'READY' : 'ONLINE') as SystemState,
      releasedProducts: releasedProductsCount,
      deliveryPackages: deliveryPackagesCount,
      verifiedPackages: verifiedDeliveryPackagesCount,
    },
  };

  const performanceMetrics = collectPerformanceMetrics();
  const trainingMetrics = collectTrainingMetrics(db);
  const syncMetadata = getRealtimeSyncService().getMetadata();

  return {
    generatedAt: new Date().toISOString(),
    factoryStatus,
    archiveStatus,
    storageReady,
    bridgeStatus: bridgeProbe.status,
    externalTrainingEnvStatus,
    bridgeProbe,
    counts: {
      libraryModels: libraryModelsCount,
      importedModels: importedModelsCount,
      approvedBrains: approvedBrainsCount,
      totalProducts: totalProductsCount,
      totalResources: totalResourcesCount,
      projects: projectsCount,
      archiveEntries: archiveEntriesCount,
      transferOperations: transferAndIoCount,
      activeJobs: activeJobsCount,
      registeredWorkers: workersCount,
      errorEvents: errorAuditCount,
    },
    wingsSummary,
    performanceMetrics,
    trainingMetrics,
    syncMetadata,
    environment,
    androidDiagnostics,
    config,
    recentAuditLogs,
    modules: getArchitectureModules(),
  };
}
