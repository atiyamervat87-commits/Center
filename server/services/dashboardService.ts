import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { listAuditLogs } from '../audit/auditService.ts';
import { probeDeviceEnvironment } from '../storage/storageProbe.ts';
import { computeAndroidBridgeDiagnostics } from '../storage/androidBridgeDiagnostic.ts';

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
      nameEn: 'Resource Library & Smart Archive',
      nameAr: 'مكتبة الموارد والأرشيف الذكي',
      status: 'PLANNED',
      descriptionEn: 'Independent resource registry with SHA-256 deduplication and SD Card archive manifests.',
      descriptionAr: 'سجل الموارد المستقل ببصمة SHA-256 ونظام أرشفة بطاقة SD وفهارس CSV/MD.',
    },
    {
      phase: 'PHASE 3',
      id: 'model-intake',
      nameEn: 'Model Intake Center',
      nameAr: 'مركز استقبال النماذج الخارجية',
      status: 'PLANNED',
      descriptionEn: 'ZIP/directory validation, architecture inspection, weight format & tokenizer checks.',
      descriptionAr: 'استيراد وفحص سلامة الأوزان والمعمارية وتوافق Tokenizer وتقرير الاستقبال.',
    },
    {
      phase: 'PHASE 4',
      id: 'computer-bridge',
      nameEn: 'Computer Training Bridge',
      nameAr: 'جسر اتصال كمبيوتر التدريب',
      status: 'PLANNED',
      descriptionEn: 'Authenticated Wi-Fi pairing, chunked resumable transfer, SHA-256 verification.',
      descriptionAr: 'إقران آمن عبر الشبكة المحلية، نقل الأجزاء واستكمال الانقطاع والتحقق بالبصمة.',
    },
    {
      phase: 'PHASE 5',
      id: 'training-jobs',
      nameEn: 'Training Job Manager',
      nameAr: 'مدير مهام التدريب',
      status: 'PLANNED',
      descriptionEn: 'Job submission, real worker telemetry, checkpoint tracking, pause/resume.',
      descriptionAr: 'إرسال المهام ومراقبة التقدم الفعلي من العامل وسجلات الخسارة ونقاط الاستعادة.',
    },
    {
      phase: 'PHASE 6',
      id: 'product-registry',
      nameEn: 'Model Library & Product Registry',
      nameAr: 'سجل العقول والمنتجات المعتمدة',
      status: 'PLANNED',
      descriptionEn: 'NG-BASE to NG-SOFTWARE product lifecycle enforcement before approval.',
      descriptionAr: 'تصنيفات المنتجات وحالات الاعتماد الصارمة قبل الإصدار.',
    },
    {
      phase: 'PHASE 7',
      id: 'qc-delivery',
      nameEn: 'Quality Control & Customer Delivery Center',
      nameAr: 'مركز الجودة وتسليم المنتجات للعملاء',
      status: 'PLANNED',
      descriptionEn: '10-suite QC verification and verified ZIP delivery package builder.',
      descriptionAr: 'اختبارات الجودة العشرة وبناء حزم التسليم ZIP الموثقة ببصمة SHA-256.',
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
    environment,
    androidDiagnostics,
    config,
    recentAuditLogs,
    modules: getArchitectureModules(),
  };
}
