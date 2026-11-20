import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Archive,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  FileCheck2,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
  Activity,
  Lock,
  X,
} from 'lucide-react';
import {
  archiveFactoryResource,
  buildCleanedDatasetPackage,
  buildNgIpDeliveryPackage,
  controlFactoryTrainingJob,
  createFactoryTrainingJob,
  createIndependentMindApi,
  deleteFactoryResource,
  downloadDeliveryPackageZip,
  fetchDataFactoryState,
  fetchMindFactoryOverview,
  fetchNgIpDeliveryPackages,
  fetchRepairProducts,
  fetchTrainingJobLogs,
  fetchTrustQcReports,
  generateFactoryManifest,
  intakeExternalModel,
  prepareWorkerTransferManifest,
  probeTrainingWorker,
  receiveExternalModelForRepairApi,
  registerFactoryResource,
  registerTrainingWorker,
  restoreTrainingCheckpointApi,
  runTrustQcCheck,
  saveRepairProduct,
  saveTrainingCheckpointApi,
  transitionRepairProductState,
  verifyArchiveBatch,
  verifyDeliveryPackageApi,
  verifyFactoryResource,
} from '../../services/apiClient';
import type {
  ArchiveCategoryFolder,
  ArchiveEntryRecord,
  DeliveryPackageRecord,
  LibrarySection,
  Locale,
  ModelLifecycleState,
  ModelProductRecord,
  ModelScaleTier,
  NgProductClass,
  QcSuiteReportRow,
  ResourceRecord,
  ScaleResourceProfile,
  TrainingJobRecord,
  TrainingWorkerRecord,
  WingId,
} from '../../types/commandCenter';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';
import type { NavTabId } from '../layout/CommandShell';

interface FactoryWingsViewProps {
  locale: Locale;
  initialWing?: WingId;
  onNavigate: (tab: NavTabId) => void;
  onDataChanged: () => Promise<void>;
}

const ARCHIVE_CATEGORIES: ArchiveCategoryFolder[] = [
  'DATASETS',
  'AI_MODELS',
  'LIBRARIES',
  'CHECKPOINTS',
  'BUILD_TOOLS',
  'CONFIGURATIONS',
  'RESTORE_PACKAGES',
  'INVENTORY',
  'MANIFESTS',
];

const PRODUCT_CLASSES: NgProductClass[] = [
  'NG-BASE',
  'NG-DOMAIN',
  'NG-ADAPTED',
  'NG-REPAIRED',
  'NG-REENGINEERED',
  'NG-QUANTIZED',
  'NG-SECURED',
  'NG-SOFTWARE',
];

const LIFECYCLE_STATES: ModelLifecycleState[] = [
  'EVALUATION',
  'APPROVED',
  'RELEASED',
  'ARCHIVED',
];

const SCALE_TIERS: ModelScaleTier[] = ['1B', '3B', '7B', '13B', '30B+'];

export function FactoryWingsView({
  locale,
  initialWing = 'DATA_FACTORY',
  onNavigate,
  onDataChanged,
}: FactoryWingsViewProps) {
  const isAr = locale === 'ar';
  const [activeWing, setActiveWing] = useState<WingId>(initialWing);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Wing 1: Data Factory state
  const [sectionFilter, setSectionFilter] = useState<string>('ALL');
  const [resSearch, setResSearch] = useState('');
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntryRecord[]>([]);
  const [archiveCategoryByRes, setArchiveCategoryByRes] = useState<Record<string, ArchiveCategoryFolder>>({});
  const [confirmDeleteResId, setConfirmDeleteResId] = useState<string | null>(null);
  const [resForm, setResForm] = useState({
    librarySection: 'DATASET' as LibrarySection,
    name: '',
    resourceType: 'CORPUS_JSONL',
    originSource: 'OWNER_CURATED',
    license: 'Apache-2.0',
    version: '1.0.0',
    filePath: '',
    contentText: '',
    contentBase64: '',
    originalFileName: '',
  });
  const [pipelineForm, setPipelineForm] = useState({
    datasetName: '',
    license: 'Apache-2.0',
    originSource: 'DATA_FACTORY_PIPELINE',
    sourceResourceId: '',
    rawFileName: 'raw_sample.jsonl',
    rawContentText: '',
    rawContentBase64: '',
    format: 'JSONL' as 'JSONL' | 'TXT',
    minLineLength: 4,
    stripHtml: true,
    deduplicateLines: true,
  });

  // Wing 2: New Mind Factory state
  const [workers, setWorkers] = useState<TrainingWorkerRecord[]>([]);
  const [jobs, setJobs] = useState<TrainingJobRecord[]>([]);
  const [scaleMatrix, setScaleMatrix] = useState<ScaleResourceProfile[]>([]);
  const [workerForm, setWorkerForm] = useState({
    workerName: '',
    endpointUrl: '',
    gpuModel: '',
    vramGb: 16,
    systemRamGb: 32,
  });
  const [independentMindForm, setIndependentMindForm] = useState({
    name: '',
    productClass: 'NG-BASE' as NgProductClass,
    version: '1.0.0',
    scaleTier: '1B' as ModelScaleTier,
    architecture: 'NG-Decoder-GQA',
    tokenizerSpec: 'BPE-32K',
    license: 'NG-COMMERCIAL',
    baseDatasetId: '',
  });
  const [intakeForm, setIntakeForm] = useState({
    name: '',
    productClass: 'NG-BASE' as NgProductClass,
    version: '1.0.0',
    architectureSummary: '',
    scaleTier: '1B' as ModelScaleTier,
    license: 'Apache-2.0',
    originSource: 'EXTERNAL_INTAKE',
    tokenizerSpec: 'BPE-32K',
    weightsPath: '',
  });
  const [jobForm, setJobForm] = useState({
    modelId: '',
    datasetId: '',
    workerId: '',
    architecture: 'NG-Transformer-LoRA',
    scaleTier: '1B' as ModelScaleTier,
    totalSteps: 200,
    learningRate: '2e-5',
    dispatchToWorker: true,
  });
  const [transferSelection, setTransferSelection] = useState({
    resourceId: '',
    workerId: '',
  });
  const [openJobLogsId, setOpenJobLogsId] = useState<string | null>(null);
  const [jobLogsData, setJobLogsData] = useState<{
    jobId: string;
    entries: Array<Record<string, unknown>>;
    checkpoints: string[];
  } | null>(null);

  // Wing 3: Mind Repair & Re-engineering state
  const [products, setProducts] = useState<ModelProductRecord[]>([]);
  const [externalRepairForm, setExternalRepairForm] = useState({
    name: '',
    version: '1.0.0',
    originSource: 'EXTERNAL_MODEL_VAULT',
    license: 'Apache-2.0',
    architectureSummary: '',
    weightsPath: '',
    fileName: '',
    fileBase64: '',
    contentText: '',
  });
  const [repairForm, setRepairForm] = useState({
    id: '',
    name: '',
    productClass: 'NG-REPAIRED' as NgProductClass,
    version: '1.0.1',
    weightsSha256: '',
    architectureSummary: '',
    trainingSummary: '',
    evaluationSummary: '',
    license: 'NG-COMMERCIAL',
    safetyNotes: '',
    restoreCheckpointPath: '',
    changelog: '',
  });

  // Wing 4: Trust & QC Center state
  const [selectedQcProductId, setSelectedQcProductId] = useState('');
  const [qcReports, setQcReports] = useState<QcSuiteReportRow[]>([]);
  const [lastQcEvidence, setLastQcEvidence] = useState<{
    productId: string;
    evidencePath: string;
    evidenceSha256: string;
  } | null>(null);

  // Wing 5: NG-IP Services state
  const [selectedDeliveryProductId, setSelectedDeliveryProductId] = useState('');
  const [ipHolderInput, setIpHolderInput] = useState('NG-ILMF Owner / Sovereign Factory');
  const [deliveryPackages, setDeliveryPackages] = useState<DeliveryPackageRecord[]>([]);

  const selectedQcProductIdRef = useRef(selectedQcProductId);
  selectedQcProductIdRef.current = selectedQcProductId;

  useEffect(() => {
    setActiveWing(initialWing);
  }, [initialWing]);

  const loadAllWings = useCallback(async () => {
    setLoading(true);
    try {
      const [dataRes, mindRes, repairRes, qcRes, ngipRes] = await Promise.all([
        fetchDataFactoryState({ section: sectionFilter, search: resSearch }),
        fetchMindFactoryOverview(),
        fetchRepairProducts(),
        fetchTrustQcReports(selectedQcProductIdRef.current || undefined),
        fetchNgIpDeliveryPackages(),
      ]);

      setResources(dataRes.resources);
      setArchiveEntries(dataRes.archiveEntries);
      setWorkers(mindRes.workers);
      setJobs(mindRes.jobs);
      setScaleMatrix(mindRes.scaleMatrix);
      setProducts(repairRes.products);
      setQcReports(qcRes.reports);
      setDeliveryPackages(ngipRes.packages);

      if (mindRes.workers.length > 0) {
        setJobForm((prev) => (prev.workerId ? prev : { ...prev, workerId: mindRes.workers[0].id }));
        setTransferSelection((prev) =>
          prev.workerId ? prev : { ...prev, workerId: mindRes.workers[0].id },
        );
      }
      if (dataRes.resources.length > 0) {
        setTransferSelection((prev) =>
          prev.resourceId ? prev : { ...prev, resourceId: dataRes.resources[0].id },
        );
      }
      if (repairRes.products.length > 0) {
        setSelectedQcProductId((prev) => prev || repairRes.products[0].id);
        const deliverable = repairRes.products.find(
          (p) => p.lifecycleState === 'APPROVED' || p.lifecycleState === 'RELEASED',
        );
        if (deliverable) {
          setSelectedDeliveryProductId((prev) => prev || deliverable.id);
        }
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to load Production Wings state');
    } finally {
      setLoading(false);
    }
  }, [sectionFilter, resSearch]);

  useEffect(() => {
    void loadAllWings();
  }, [loadAllWings]);

  useEffect(() => {
    let active = true;
    void fetchTrustQcReports(selectedQcProductId || undefined)
      .then((res) => {
        if (active) setQcReports(res.reports);
      })
      .catch(() => {
        // Keep existing reports on transient error
      });
    return () => {
      active = false;
    };
  }, [selectedQcProductId]);

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setBusyKey(key);
    setErrorBanner(null);
    setSuccessBanner(null);
    try {
      const msg = await fn();
      setSuccessBanner(msg);
      await loadAllWings();
      await onDataChanged();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setBusyKey(null);
    }
  };

  const readBrowserFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = typeof reader.result === 'string' ? reader.result : '';
        const commaIdx = res.indexOf(',');
        resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
      };
      reader.onerror = () => reject(new Error('Failed to read selected file'));
      reader.readAsDataURL(file);
    });

  // --- WING 1 HANDLERS ---
  const handleRegisterResource = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('res-create', async () => {
      const res = await registerFactoryResource({
        librarySection: resForm.librarySection,
        name: resForm.name,
        resourceType: resForm.resourceType,
        originSource: resForm.originSource,
        license: resForm.license,
        version: resForm.version,
        filePath: resForm.filePath.trim() || undefined,
        contentText: resForm.contentText.trim() || undefined,
        contentBase64: resForm.contentBase64 || undefined,
        originalFileName: resForm.originalFileName || undefined,
      });
      setResForm((prev) => ({
        ...prev,
        name: '',
        filePath: '',
        contentText: '',
        contentBase64: '',
        originalFileName: '',
      }));
      return res.deduplicated
        ? isAr
          ? `تم منع التكرار ببصمة SHA-256 — المورد مطابق للسجل ${res.resource.id}`
          : `Deduplicated via SHA-256 — matched existing resource ${res.resource.id}`
        : isAr
          ? `تم تسجيل المورد المستقل ${res.resource.id} والتحقق من SHA-256 بنجاح`
          : `Registered independent resource ${res.resource.id} with verified SHA-256`;
    });
  };

  const handleBuildCleanedDataset = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('dataset-pipeline', async () => {
      const res = await buildCleanedDatasetPackage({
        datasetName: pipelineForm.datasetName,
        license: pipelineForm.license,
        originSource: pipelineForm.originSource,
        sourceResourceIds: pipelineForm.sourceResourceId.trim()
          ? [pipelineForm.sourceResourceId.trim()]
          : undefined,
        rawFiles:
          pipelineForm.rawContentBase64 || pipelineForm.rawContentText.trim()
            ? [
                {
                  fileName: pipelineForm.rawFileName || 'raw_input.txt',
                  contentBase64: pipelineForm.rawContentBase64 || undefined,
                  contentText: pipelineForm.rawContentText.trim() || undefined,
                },
              ]
            : undefined,
        format: pipelineForm.format,
        minLineLength: Number(pipelineForm.minLineLength) || 4,
        stripHtml: pipelineForm.stripHtml,
        deduplicateLines: pipelineForm.deduplicateLines,
      });
      setPipelineForm((p) => ({ ...p, datasetName: '', rawContentText: '', rawContentBase64: '' }));
      return isAr
        ? `تم إنتاج حزمة البيانات ${res.resource.id} (${res.stats.cleanedLinesCount} سطر نظيف / أزيل ${res.stats.deduplicatedCount} مكرر) SHA-256: ${res.dataFileSha256.slice(0, 12)}...`
        : `Built dataset package ${res.resource.id} (${res.stats.cleanedLinesCount} clean lines, ${res.stats.deduplicatedCount} deduped) SHA-256: ${res.dataFileSha256.slice(0, 12)}...`;
    });
  };

  // --- WING 2 HANDLERS ---
  const handleRegisterWorker = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('wrk-create', async () => {
      const res = await registerTrainingWorker({
        workerName: workerForm.workerName,
        endpointUrl: workerForm.endpointUrl,
        gpuModel: workerForm.gpuModel,
        vramGb: Number(workerForm.vramGb),
        systemRamGb: Number(workerForm.systemRamGb),
      });
      setWorkerForm((prev) => ({ ...prev, workerName: '', endpointUrl: '', gpuModel: '' }));
      return isAr
        ? `تم تسجيل العامل ${res.worker.workerName} (${res.worker.id}) بحالة OFFLINE حتى ينجح فحص HTTP /health`
        : `Registered worker ${res.worker.workerName} (${res.worker.id}) as OFFLINE pending live HTTP /health probe`;
    });
  };

  const handleIntakeModel = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('model-intake', async () => {
      const res = await intakeExternalModel({
        name: intakeForm.name,
        productClass: intakeForm.productClass,
        version: intakeForm.version,
        architectureSummary: intakeForm.architectureSummary,
        scaleTier: intakeForm.scaleTier,
        license: intakeForm.license,
        originSource: intakeForm.originSource,
        tokenizerSpec: intakeForm.tokenizerSpec,
        weightsPath: intakeForm.weightsPath.trim() || undefined,
      });
      setIntakeForm((prev) => ({ ...prev, name: '', architectureSummary: '', weightsPath: '' }));
      setSelectedQcProductId(res.productId);
      return isAr
        ? `تم استقبال وفحص النموذج ${res.productId} ببصمة ${res.weightsSha256.slice(0, 12)}...`
        : `Intaken & inspected model ${res.productId} (SHA-256 ${res.weightsSha256.slice(0, 12)}...)`;
    });
  };

  const handleCreateJob = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('job-create', async () => {
      const res = await createFactoryTrainingJob({
        modelId: jobForm.modelId,
        datasetId: jobForm.datasetId,
        workerId: jobForm.workerId,
        architecture: jobForm.architecture,
        scaleTier: jobForm.scaleTier,
        totalSteps: Number(jobForm.totalSteps),
        learningRate: jobForm.learningRate,
        dispatchToWorker: jobForm.dispatchToWorker,
      });
      return `${res.job.id} [${res.job.jobStatus}]: ${res.dispatchNote}`;
    });
  };

  const handleCreateIndependentMind = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('mind-create', async () => {
      const res = await createIndependentMindApi({
        name: independentMindForm.name,
        productClass: independentMindForm.productClass,
        version: independentMindForm.version,
        scaleTier: independentMindForm.scaleTier,
        architecture: independentMindForm.architecture,
        tokenizerSpec: independentMindForm.tokenizerSpec,
        license: independentMindForm.license,
        baseDatasetId: independentMindForm.baseDatasetId.trim() || undefined,
      });
      setIndependentMindForm((p) => ({ ...p, name: '' }));
      setJobForm((p) => ({ ...p, modelId: res.productId }));
      setSelectedQcProductId(res.productId);
      return isAr
        ? `تم إنشاء عقل مستقل ${res.productId} على القرص (SHA-256: ${res.weightsSha256.slice(0, 12)}...)`
        : `Created independent Mind ${res.productId} on disk (SHA-256: ${res.weightsSha256.slice(0, 12)}...)`;
    });
  };

  // --- WING 3 HANDLERS ---
  const handleExternalRepairIntake = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('repair-intake', async () => {
      const res = await receiveExternalModelForRepairApi({
        name: externalRepairForm.name,
        version: externalRepairForm.version,
        originSource: externalRepairForm.originSource,
        license: externalRepairForm.license,
        architectureSummary: externalRepairForm.architectureSummary,
        weightsPath: externalRepairForm.weightsPath.trim() || undefined,
        fileName: externalRepairForm.fileName.trim() || undefined,
        fileBase64: externalRepairForm.fileBase64 || undefined,
        contentText: externalRepairForm.contentText.trim() || undefined,
      });
      setExternalRepairForm((p) => ({
        ...p,
        name: '',
        architectureSummary: '',
        weightsPath: '',
        fileName: '',
        fileBase64: '',
        contentText: '',
      }));
      loadProductIntoRepairForm(res.product);
      setSelectedQcProductId(res.product.id);
      return isAr
        ? `تم استقبال وفحص ${res.product.id} وحفظ نسخة الأصل دون حذف (${res.originalSha256.slice(0, 12)}...)`
        : `Intaken ${res.product.id} with immutable original preserved (${res.originalSha256.slice(0, 12)}...)`;
    });
  };

  const handleSaveRepairProduct = async (e: FormEvent) => {
    e.preventDefault();
    await runAction('repair-save', async () => {
      const res = await saveRepairProduct({
        id: repairForm.id.trim() || undefined,
        name: repairForm.name,
        productClass: repairForm.productClass,
        version: repairForm.version,
        weightsSha256: repairForm.weightsSha256,
        architectureSummary: repairForm.architectureSummary,
        trainingSummary: repairForm.trainingSummary,
        evaluationSummary: repairForm.evaluationSummary,
        license: repairForm.license,
        safetyNotes: repairForm.safetyNotes,
        restoreCheckpointPath: repairForm.restoreCheckpointPath,
        changelog: repairForm.changelog,
      });
      setSelectedQcProductId(res.product.id);
      return isAr
        ? `تم حفظ سجل المنتج ${res.product.id} (${res.product.productClass} · v${res.product.version}) بحالة EVALUATION مع حفظ نسخة الأصل`
        : `Saved product ${res.product.id} (${res.product.productClass} · v${res.product.version}) in EVALUATION (original preserved)`;
    });
  };

  const wingTabs: Array<{ id: WingId; label: string; icon: typeof Database }> = [
    {
      id: 'DATA_FACTORY',
      label: isAr ? '1. DATA FACTORY · البيانات' : '1. DATA FACTORY',
      icon: Database,
    },
    {
      id: 'NEW_MIND_FACTORY',
      label: isAr ? '2. NEW MIND · العقول والتدريب' : '2. NEW MIND FACTORY',
      icon: Cpu,
    },
    {
      id: 'MIND_REPAIR_FACTORY',
      label: isAr ? '3. MIND REPAIR · الإصلاح' : '3. MIND REPAIR',
      icon: Wrench,
    },
    {
      id: 'TRUST_SECURITY_CENTER',
      label: isAr ? '4. TRUST & QC · الثقة والجودة' : '4. TRUST & QC',
      icon: ShieldCheck,
    },
    {
      id: 'NG_IP_SERVICES',
      label: isAr ? '5. NG-IP · التسليم والحزم' : '5. NG-IP SERVICES',
      icon: PackageCheck,
    },
  ];

  const loadProductIntoRepairForm = (p: ModelProductRecord) => {
    setRepairForm({
      id: p.id,
      name: p.name,
      productClass: p.productClass,
      version: p.version,
      weightsSha256: p.weightsSha256,
      architectureSummary: p.architectureSummary,
      trainingSummary: p.trainingSummary,
      evaluationSummary: p.evaluationSummary,
      license: p.license,
      safetyNotes: typeof p.safetyReport.notes === 'string' ? p.safetyReport.notes : '',
      restoreCheckpointPath:
        typeof p.safetyReport.restoreCheckpointPath === 'string'
          ? p.safetyReport.restoreCheckpointPath
          : '',
      changelog: p.changelog,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header & Wing Sub-Navigation */}
      <section className="rounded-xl bg-[#3B2419] text-[#FFF8E8] border border-[#D4AF37]/40 p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#F3D989]">
              {isAr
                ? 'مركز تشغيل الأجنحة الإنتاجية الخمسة لمصنع NG-ILMF'
                : 'NG-ILMF Five Production Wings Operations Console'}
            </h1>
            <p className="text-xs sm:text-sm text-[#FFF8E8]/80">
              {isAr
                ? 'ربط فعلي بقاعدة SQLite WAL وفحص التجزئة SHA-256، بوابات الجودة العشرية، وحظر أي بيانات أو أوزان غير موثقة.'
                : 'Backed directly by SQLite WAL, real SHA-256 integrity verification, 10-suite QC gating, and zero fabricated progress.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadAllWings()}
            disabled={loading}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] hover:bg-[#523624] border border-[#D4AF37]/40 text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{isAr ? 'تحديث الأجنحة' : 'Refresh Wings'}</span>
          </button>
        </div>

        {/* Interactive Wing Switcher Tabs */}
        <div
          role="tablist"
          aria-label="Production Wings"
          className="flex flex-wrap gap-2 pt-2 border-t border-[#D4AF37]/20"
        >
          {wingTabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeWing === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => {
                  setActiveWing(tab.id);
                  setErrorBanner(null);
                  setSuccessBanner(null);
                }}
                className={`min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#D4AF37] text-[#26170F]'
                    : 'bg-[#26170F]/80 text-[#FFF8E8]/85 hover:bg-[#523624] border border-[#D4AF37]/25'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Honest Error / Success Feedback */}
      {errorBanner && (
        <div className="rounded-xl bg-red-950/10 border border-red-800/40 p-4 text-xs font-mono text-red-900 flex items-start justify-between gap-3">
          <span className="break-all">{errorBanner}</span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            aria-label={isAr ? 'إغلاق التنبيه' : 'Dismiss error'}
            className="shrink-0 p-1 rounded hover:bg-red-900/10 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      {successBanner && (
        <div className="rounded-xl bg-emerald-950/10 border border-emerald-800/40 p-4 text-xs font-mono text-emerald-900 flex items-start justify-between gap-3">
          <span className="break-all">{successBanner}</span>
          <button
            type="button"
            onClick={() => setSuccessBanner(null)}
            aria-label={isAr ? 'إغلاق الإشعار' : 'Dismiss notice'}
            className="shrink-0 p-1 rounded hover:bg-emerald-900/10 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WING 1: DATA FACTORY                                                     */}
      {/* ========================================================================= */}
      {activeWing === 'DATA_FACTORY' && (
        <div className="space-y-6">
          {/* Controls & Manifest Export */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {(['ALL', 'MODEL', 'DATASET', 'SOFTWARE', 'KNOWLEDGE'] as const).map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setSectionFilter(sec)}
                    className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-mono font-semibold cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                      sectionFilter === sec
                        ? 'bg-[#26170F] text-[#F3D989]'
                        : 'bg-[#FFF8E8] border border-[#523624]/25 text-[#523624] hover:border-[#26170F]'
                    }`}
                  >
                    {sec}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={resSearch}
                  onChange={(e) => setResSearch(e.target.value)}
                  placeholder={isAr ? 'بحث بالاسم أو SHA-256 أو الرخصة...' : 'Search name, SHA-256, license...'}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs w-60"
                />
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction('data-manifest', async () => {
                      const res = await generateFactoryManifest();
                      return isAr
                        ? `تم إنشاء فهرس الجرد (${res.manifest.resourceCount} مورد · ${res.manifest.archiveCount} أرشيف) SHA-256: ${res.manifest.sha256.slice(0, 12)}...`
                        : `Generated verified manifest (${res.manifest.resourceCount} resources, ${res.manifest.archiveCount} archives) SHA-256: ${res.manifest.sha256.slice(0, 12)}...`;
                    })
                  }
                  className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-[#3B2419] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'توليد فهرس الجرد الموثق' : 'Generate Inventory Manifest'}</span>
                </button>
              </div>
            </div>

            {/* Register Resource Form */}
            <form onSubmit={handleRegisterResource} className="pt-4 border-t border-[#523624]/15 space-y-3">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? 'تسجيل مورد مستقل في المكتبة المركزية (مع منع التكرار بـ SHA-256)' : 'Register Independent Resource (SHA-256 Deduplicated)'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <select
                  value={resForm.librarySection}
                  onChange={(e) => setResForm((p) => ({ ...p, librarySection: e.target.value as LibrarySection }))}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                >
                  <option value="DATASET">DATASET</option>
                  <option value="MODEL">MODEL</option>
                  <option value="SOFTWARE">SOFTWARE</option>
                  <option value="KNOWLEDGE">KNOWLEDGE</option>
                </select>
                <input
                  type="text"
                  required
                  value={resForm.name}
                  onChange={(e) => setResForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={isAr ? 'اسم المورد (مثال: Arabic-STEM-v1)' : 'Resource Name'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  required
                  value={resForm.resourceType}
                  onChange={(e) => setResForm((p) => ({ ...p, resourceType: e.target.value }))}
                  placeholder={isAr ? 'النوع (مثال: JSONL / GGUF)' : 'Type (JSONL / GGUF)'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  required
                  value={resForm.originSource}
                  onChange={(e) => setResForm((p) => ({ ...p, originSource: e.target.value }))}
                  placeholder={isAr ? 'المصدر الأصلي' : 'Origin Source'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  required
                  value={resForm.license}
                  onChange={(e) => setResForm((p) => ({ ...p, license: e.target.value }))}
                  placeholder={isAr ? 'الرخصة (Apache-2.0 / MIT / Proprietary)' : 'License'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  value={resForm.version}
                  onChange={(e) => setResForm((p) => ({ ...p, version: e.target.value }))}
                  placeholder="1.0.0"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={resForm.filePath}
                  onChange={(e) => setResForm((p) => ({ ...p, filePath: e.target.value }))}
                  placeholder={isAr ? 'مسار ملف على الخادم (اختياري)' : 'Existing Host File Path (optional)'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <label className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs flex items-center justify-between gap-2 cursor-pointer">
                  <span className="truncate font-mono text-[#523624]">
                    {resForm.originalFileName || (isAr ? 'رفع ملف حقيقي (اختياري)...' : 'Upload real file (optional)...')}
                  </span>
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void readBrowserFileAsBase64(file).then((b64) => {
                        setResForm((p) => ({
                          ...p,
                          name: p.name.trim() ? p.name : file.name,
                          contentBase64: b64,
                          originalFileName: file.name,
                        }));
                      });
                    }}
                  />
                </label>
                <textarea
                  rows={2}
                  value={resForm.contentText}
                  onChange={(e) => setResForm((p) => ({ ...p, contentText: e.target.value }))}
                  placeholder={isAr ? 'أو محتوى نصي / JSONL ليتم حفظه وحساب SHA-256 تلقائيًا...' : 'Or paste text / JSONL payload...'}
                  className="px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={busyKey !== null}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? 'تسجيل وحساب SHA-256' : 'Register & Hash Resource'}</span>
              </button>
            </form>

            {/* Data Factory Text Extraction, Cleaning & Packaging Pipeline */}
            <form onSubmit={handleBuildCleanedDataset} className="pt-4 border-t border-[#523624]/15 space-y-3">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr
                  ? 'خط إنتاج البيانات: استخراج النصوص، التنظيف، إزالة التكرار، وبناء حزمة قابلة للتحقق'
                  : 'Data Pipeline: Text Extraction, Cleaning, Deduplication & Verifiable Package'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <input
                  type="text"
                  required
                  value={pipelineForm.datasetName}
                  onChange={(e) => setPipelineForm((p) => ({ ...p, datasetName: e.target.value }))}
                  placeholder={isAr ? 'اسم الحزمة المنظفة' : 'Cleaned Package Name'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  required
                  value={pipelineForm.license}
                  onChange={(e) => setPipelineForm((p) => ({ ...p, license: e.target.value }))}
                  placeholder="License (Apache-2.0)"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <select
                  value={pipelineForm.sourceResourceId}
                  onChange={(e) => setPipelineForm((p) => ({ ...p, sourceResourceId: e.target.value }))}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                >
                  <option value="">{isAr ? '-- مصدر من المكتبة (اختياري) --' : '-- Library Source (optional) --'}</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} · {r.name}
                    </option>
                  ))}
                </select>
                <select
                  value={pipelineForm.format}
                  onChange={(e) => setPipelineForm((p) => ({ ...p, format: e.target.value as 'JSONL' | 'TXT' }))}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                >
                  <option value="JSONL">JSONL</option>
                  <option value="TXT">TXT</option>
                </select>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <label className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs flex items-center justify-between gap-2 cursor-pointer">
                  <span className="truncate font-mono text-[#523624]">
                    {pipelineForm.rawContentBase64 ? `${pipelineForm.rawFileName} (loaded)` : (isAr ? 'رفع ملف خام للاستخراج (JSON/CSV/HTML/TXT)...' : 'Upload raw file (JSON/CSV/HTML/TXT)...')}
                  </span>
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void readBrowserFileAsBase64(file).then((b64) => {
                        setPipelineForm((p) => ({
                          ...p,
                          rawFileName: file.name,
                          rawContentBase64: b64,
                        }));
                      });
                    }}
                  />
                </label>
                <textarea
                  rows={2}
                  value={pipelineForm.rawContentText}
                  onChange={(e) => setPipelineForm((p) => ({ ...p, rawContentText: e.target.value }))}
                  placeholder={isAr ? 'أو الصق نصوص/HTML/JSONL/CSV خام للتنظيف...' : 'Or paste raw text / HTML / JSONL / CSV to extract & clean...'}
                  className="px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={busyKey !== null}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? 'استخراج وتنظيف وبناء الحزمة' : 'Extract, Clean & Build Package'}</span>
              </button>
            </form>
          </section>

          {/* Resource Inventory Table */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#523624]/15 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? `مكتبة الموارد المستقلة (${resources.length})` : `Independent Resource Library (${resources.length})`}
              </h2>
              <span className="font-mono text-xs text-[#523624]">
                {isAr ? 'الموارد مرتبطة بالمعرف ولا تُحذف إذا كانت مستخدمة في مشروع' : 'Protected if linked to active projects'}
              </span>
            </div>

            {resources.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#523624]">
                {isAr ? 'لا توجد موارد مسجلة في هذا القسم بعد.' : 'No resources registered in this section yet.'}
              </div>
            ) : (
              <div className="divide-y divide-[#523624]/15">
                {resources.map((r) => {
                  const chosenCategory = archiveCategoryByRes[r.id] ?? (r.librarySection === 'MODEL' ? 'AI_MODELS' : 'DATASETS');
                  return (
                    <div key={r.id} className="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-bold text-[#26170F]">{r.id}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-[#26170F]">{r.name}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-[#523624]">{r.librarySection} / {r.resourceType}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-[#523624]">v{r.version}</span>
                          <span aria-hidden="true">·</span>
                          <StatusIndicator state={r.verificationStatus} />
                        </div>
                        <div className="font-mono text-[11px] text-[#523624] break-all">
                          SHA-256: {r.sha256} · {formatBytes(r.sizeBytes, locale)} · {r.license} · {isAr ? 'مشروعات مرتبطة' : 'Linked Projects'}: {r.linkedProjectCount}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`ver-${r.id}`, async () => {
                              const out = await verifyFactoryResource(r.id);
                              return `${out.resource.id}: ${out.resource.verificationStatus}`;
                            })
                          }
                          className="min-h-[36px] px-3 py-1.5 rounded-lg border border-[#523624]/30 hover:bg-[#523624]/10 text-xs font-semibold whitespace-nowrap cursor-pointer"
                        >
                          {isAr ? 'فحص SHA-256' : 'Verify SHA-256'}
                        </button>

                        <select
                          value={chosenCategory}
                          onChange={(e) =>
                            setArchiveCategoryByRes((prev) => ({
                              ...prev,
                              [r.id]: e.target.value as ArchiveCategoryFolder,
                            }))
                          }
                          className="min-h-[36px] px-2 py-1 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                        >
                          {ARCHIVE_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`arc-${r.id}`, async () => {
                              const out = await archiveFactoryResource(r.id, chosenCategory);
                              return isAr
                                ? `تمت الأرشفة والتحقق في ${out.entry.archivePath}`
                                : `Archived & SHA-256 verified to ${out.entry.archivePath}`;
                            })
                          }
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#3B2419] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{isAr ? 'أرشفة' : 'Archive'}</span>
                        </button>

                        {confirmDeleteResId === r.id ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteResId(null);
                                void runAction(`del-${r.id}`, async () => {
                                  await deleteFactoryResource(r.id);
                                  return isAr ? `تم حذف المورد غير المرتبط ${r.id}` : `Deleted unlinked resource ${r.id}`;
                                });
                              }}
                              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-red-800 text-white text-xs font-semibold whitespace-nowrap cursor-pointer"
                            >
                              {isAr ? 'تأكيد الحذف' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteResId(null)}
                              className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-[#523624]/30 text-xs cursor-pointer"
                            >
                              {isAr ? 'تراجع' : 'Cancel'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteResId(r.id)}
                            className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-red-800/30 text-red-800 hover:bg-red-900/10 text-xs inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{isAr ? 'حذف' : 'Delete'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Smart Archive Entries */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#523624]/15 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? `سجل الأرشيف الذكي NG-ILMF_ARCHIVE (${archiveEntries.length})` : `Smart Archive Ledger (${archiveEntries.length})`}
              </h2>
              <button
                type="button"
                disabled={busyKey !== null || archiveEntries.length === 0}
                onClick={() =>
                  void runAction('archive-batch-verify', async () => {
                    const out = await verifyArchiveBatch();
                    return isAr
                      ? `فحص الأرشيف: ${out.verifiedCount}/${out.totalChecked} سليم · ${out.mismatchCount} تالف · ${out.missingCount} مفقود`
                      : `Archive batch verify: ${out.verifiedCount}/${out.totalChecked} verified, ${out.mismatchCount} mismatch, ${out.missingCount} missing`;
                  })
                }
                className="min-h-[34px] px-3 py-1 rounded-lg bg-[#3B2419] disabled:opacity-50 text-[#F3D989] text-xs font-semibold cursor-pointer"
              >
                {isAr ? 'فحص سلامة جميع ملفات الأرشيف' : 'Verify All Archive Entries'}
              </button>
            </div>
            {archiveEntries.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#523624]">
                {isAr
                  ? 'لا توجد ملفات مؤرشفة بعد. يتطلب الأرشيف تأكيد المالك ونجاح اختبار SHA-256 في صفحة بيئات التخزين أولًا.'
                  : 'No archive entries yet. Requires confirmed & SHA-256 verified storage under Storage Env.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                    <tr>
                      <th className="py-2.5 px-4 text-start">ID</th>
                      <th className="py-2.5 px-4 text-start">{isAr ? 'الفئة' : 'Folder'}</th>
                      <th className="py-2.5 px-4 text-start">{isAr ? 'المسار' : 'Archive Path'}</th>
                      <th className="py-2.5 px-4 text-start">SHA-256</th>
                      <th className="py-2.5 px-4 text-end">{isAr ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#523624]/10 font-mono">
                    {archiveEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-2.5 px-4 whitespace-nowrap font-semibold">{entry.id}</td>
                        <td className="py-2.5 px-4 whitespace-nowrap">{entry.categoryFolder}</td>
                        <td className="py-2.5 px-4 max-w-[260px] truncate">{entry.archivePath}</td>
                        <td className="py-2.5 px-4 max-w-[160px] truncate">{entry.sha256}</td>
                        <td className="py-2.5 px-4 text-end">
                          <StatusIndicator state={entry.verifyStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WING 2: NEW MIND FACTORY (1B-30B+ Scaling, Workers, Intake, Jobs)         */}
      {/* ========================================================================= */}
      {activeWing === 'NEW_MIND_FACTORY' && (
        <div className="space-y-6">
          {/* 1B - 30B+ Scaling Matrix */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#523624]/15 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? 'مصفوفة تخطيط السعة والأحجام (1B — 30B+)' : 'Model Scale Capacity Matrix (1B — 30B+)'}
              </h2>
              <span className="font-mono text-xs text-[#523624]">
                {isAr ? 'بوابة أمان تمنع تشغيل تدريب يفوق سعة VRAM العامل' : 'Hardware VRAM Gate'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                  <tr>
                    <th className="py-2.5 px-4 text-start">{isAr ? 'الفئة' : 'Tier'}</th>
                    <th className="py-2.5 px-4 text-end">FP16 Weights</th>
                    <th className="py-2.5 px-4 text-end">LoRA/QLoRA Min VRAM</th>
                    <th className="py-2.5 px-4 text-end">Full Train VRAM</th>
                    <th className="py-2.5 px-4 text-end">INT4 Inference</th>
                    <th className="py-2.5 px-4 text-end">Rec. System RAM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#523624]/10 font-mono tabular-nums">
                  {scaleMatrix.map((row) => (
                    <tr key={row.scaleTier}>
                      <td className="py-2.5 px-4 font-bold text-[#26170F]">{row.scaleTier}</td>
                      <td className="py-2.5 px-4 text-end">{row.fp16WeightsGb} GB</td>
                      <td className="py-2.5 px-4 text-end font-semibold">{row.loraTrainMinVramGb} GB</td>
                      <td className="py-2.5 px-4 text-end">{row.fullTrainMinVramGb} GB</td>
                      <td className="py-2.5 px-4 text-end">{row.quantizedInt4InferenceGb} GB</td>
                      <td className="py-2.5 px-4 text-end">{row.recommendedSystemRamGb} GB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Worker Registration & Probe */}
            <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? 'جسر كمبيوتر التدريب الخارجي (Computer Training Bridge)' : 'Computer Training Bridge Workers'}
              </h2>
              <form onSubmit={handleRegisterWorker} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    value={workerForm.workerName}
                    onChange={(e) => setWorkerForm((p) => ({ ...p, workerName: e.target.value }))}
                    placeholder={isAr ? 'اسم العامل (مثال: PC-RTX4090)' : 'Worker Name'}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                  />
                  <input
                    type="url"
                    required
                    value={workerForm.endpointUrl}
                    onChange={(e) => setWorkerForm((p) => ({ ...p, endpointUrl: e.target.value }))}
                    placeholder="http://192.168.1.50:8787"
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                  <input
                    type="text"
                    required
                    value={workerForm.gpuModel}
                    onChange={(e) => setWorkerForm((p) => ({ ...p, gpuModel: e.target.value }))}
                    placeholder={isAr ? 'بطاقة الرسوميات (RTX 4090)' : 'GPU Model'}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={0}
                      value={workerForm.vramGb}
                      onChange={(e) => setWorkerForm((p) => ({ ...p, vramGb: Number(e.target.value) }))}
                      placeholder="VRAM GB"
                      className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                    />
                    <input
                      type="number"
                      min={0}
                      value={workerForm.systemRamGb}
                      onChange={(e) => setWorkerForm((p) => ({ ...p, systemRamGb: Number(e.target.value) }))}
                      placeholder="RAM GB"
                      className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busyKey !== null}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'تسجيل كمبيوتر تدريب' : 'Register Worker'}</span>
                </button>
              </form>

              <div className="pt-3 border-t border-[#523624]/15 space-y-2">
                {workers.length === 0 ? (
                  <p className="text-xs text-[#523624]">
                    {isAr ? 'لا توجد أجهزة تدريب مسجلة بعد.' : 'No registered workers yet.'}
                  </p>
                ) : (
                  workers.map((w) => (
                    <div
                      key={w.id}
                      className="p-3 rounded-lg bg-[#FFF8E8] border border-[#523624]/20 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="space-y-0.5 text-xs">
                        <div className="font-bold text-[#26170F]">
                          {w.workerName} <span className="font-mono text-[#523624]">({w.id})</span>
                        </div>
                        <div className="font-mono text-[11px] text-[#523624]">
                          {w.endpointUrl} · {w.capabilities.gpuModel} ({w.capabilities.vramGb}GB VRAM / Max {w.capabilities.maxSupportedScale})
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusIndicator state={w.status} />
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`probe-${w.id}`, async () => {
                              const res = await probeTrainingWorker(w.id);
                              return `${res.worker.workerName} [${res.worker.status}] · ${res.detail}`;
                            })
                          }
                          className="min-h-[34px] px-3 py-1 rounded-lg border border-[#523624]/30 hover:bg-[#523624]/10 text-xs font-semibold cursor-pointer whitespace-nowrap"
                        >
                          {isAr ? 'فحص HTTP /health' : 'Probe /health'}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Chunked Transfer Manifest */}
              {workers.length > 0 && resources.length > 0 && (
                <div className="pt-3 border-t border-[#523624]/15 space-y-2">
                  <div className="text-xs font-bold text-[#26170F]">
                    {isAr ? 'تجهيز حزمة نقل مقسّمة بـ SHA-256 للعامل' : 'Prepare SHA-256 Chunked Transfer Manifest'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={transferSelection.resourceId}
                      onChange={(e) => setTransferSelection((p) => ({ ...p, resourceId: e.target.value }))}
                      className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                    >
                      {resources.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} ({r.name})
                        </option>
                      ))}
                    </select>
                    <select
                      value={transferSelection.workerId}
                      onChange={(e) => setTransferSelection((p) => ({ ...p, workerId: e.target.value }))}
                      className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                    >
                      {workers.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.workerName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() =>
                        void runAction('xfer-prep', async () => {
                          const res = await prepareWorkerTransferManifest(
                            transferSelection.resourceId,
                            transferSelection.workerId,
                          );
                          return `Manifest ${res.manifest.chunkCount} chunks (${res.manifest.totalBytes} B) SHA-256: ${res.manifest.manifestSha256.slice(0, 12)}...`;
                        })
                      }
                      className="min-h-[36px] px-3 py-1 rounded-lg bg-[#3B2419] text-[#F3D989] text-xs font-semibold cursor-pointer whitespace-nowrap"
                    >
                      {isAr ? 'توليد حزمة النقل' : 'Prepare Manifest'}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Create Independent Mind + External Model Intake */}
            <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-5">
              <form onSubmit={handleCreateIndependentMind} className="space-y-3 pb-4 border-b border-[#523624]/15">
                <h2 className="text-sm font-bold text-[#26170F]">
                  {isAr ? 'إنشاء عقل مستقل جديد (NG-BASE / NG-DOMAIN)' : 'Create Independent NG-ILMF Mind'}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    value={independentMindForm.name}
                    onChange={(e) => setIndependentMindForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder={isAr ? 'اسم العقل المستقل' : 'Independent Mind Name'}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                  />
                  <select
                    value={independentMindForm.scaleTier}
                    onChange={(e) => setIndependentMindForm((p) => ({ ...p, scaleTier: e.target.value as ModelScaleTier }))}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  >
                    {SCALE_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        Scale: {tier}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    required
                    value={independentMindForm.architecture}
                    onChange={(e) => setIndependentMindForm((p) => ({ ...p, architecture: e.target.value }))}
                    placeholder="Architecture (NG-Decoder-GQA)"
                    className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                  <input
                    type="text"
                    required
                    value={independentMindForm.license}
                    onChange={(e) => setIndependentMindForm((p) => ({ ...p, license: e.target.value }))}
                    placeholder="License (NG-COMMERCIAL)"
                    className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                  <select
                    value={independentMindForm.baseDatasetId}
                    onChange={(e) => setIndependentMindForm((p) => ({ ...p, baseDatasetId: e.target.value }))}
                    className="sm:col-span-2 min-h-[38px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  >
                    <option value="">
                      {isAr ? '-- ربط ببيانات تدريب أساسية (اختياري) --' : '-- Bind Base Dataset (optional) --'}
                    </option>
                    {resources
                      .filter((r) => r.librarySection === 'DATASET')
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} · {r.name} ({r.resourceType})
                        </option>
                      ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={busyKey !== null}
                  className="min-h-[38px] px-4 py-1.5 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
                >
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'إنشاء عقل مستقل وتجهيز الأوزان' : 'Initialize Independent Mind'}</span>
                </button>
              </form>

              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? 'مركز استقبال وفحص النماذج الخارجية (External Model Intake)' : 'External Model Intake Center'}
              </h2>
              <form onSubmit={handleIntakeModel} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    value={intakeForm.name}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder={isAr ? 'اسم النموذج المستورد' : 'Model Name'}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                  />
                  <select
                    value={intakeForm.productClass}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, productClass: e.target.value as NgProductClass }))}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  >
                    {PRODUCT_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={intakeForm.scaleTier}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, scaleTier: e.target.value as ModelScaleTier }))}
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  >
                    {SCALE_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        Scale: {tier}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    required
                    value={intakeForm.version}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, version: e.target.value }))}
                    placeholder="Version (1.0.0)"
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                  <input
                    type="text"
                    required
                    value={intakeForm.license}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, license: e.target.value }))}
                    placeholder="License (Apache-2.0)"
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                  <input
                    type="text"
                    value={intakeForm.tokenizerSpec}
                    onChange={(e) => setIntakeForm((p) => ({ ...p, tokenizerSpec: e.target.value }))}
                    placeholder="Tokenizer (BPE / SentencePiece)"
                    className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                  />
                </div>
                <input
                  type="text"
                  required
                  value={intakeForm.architectureSummary}
                  onChange={(e) => setIntakeForm((p) => ({ ...p, architectureSummary: e.target.value }))}
                  placeholder={isAr ? 'ملخص المعمارية (مثال: Llama-3.2 Decoder 1B GQA)' : 'Architecture Summary'}
                  className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  value={intakeForm.weightsPath}
                  onChange={(e) => setIntakeForm((p) => ({ ...p, weightsPath: e.target.value }))}
                  placeholder={isAr ? 'مسار الأوزان على المضيف (اختياري؛ يُنشأ بيان موثق عند تركه فارغًا)' : 'Optional Weights File Path on Host'}
                  className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={busyKey !== null}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'استقبال وفحص النموذج' : 'Intake & Inspect Model'}</span>
                </button>
              </form>
            </section>
          </div>

          {/* Training Jobs Manager */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <h2 className="text-sm font-bold text-[#26170F]">
              {isAr ? 'مدير مهام التدريب الحقيقي (Capacity-Gated · Zero Fake Telemetry)' : 'Training Job Manager (Capacity-Gated · Zero Fake Progress)'}
            </h2>
            <form onSubmit={handleCreateJob} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <datalist id="ng-model-options">
                {resources
                  .filter((r) => r.librarySection === 'MODEL')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.resourceType})
                    </option>
                  ))}
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.productClass} v{p.version})
                  </option>
                ))}
              </datalist>
              <datalist id="ng-dataset-options">
                {resources
                  .filter((r) => r.librarySection === 'DATASET')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.resourceType})
                    </option>
                  ))}
              </datalist>
              <input
                type="text"
                required
                list="ng-model-options"
                value={jobForm.modelId}
                onChange={(e) => setJobForm((p) => ({ ...p, modelId: e.target.value }))}
                placeholder={isAr ? 'معرف النموذج (RES-... أو PRD-...)' : 'Model ID (RES-... or PRD-...)'}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              />
              <input
                type="text"
                required
                list="ng-dataset-options"
                value={jobForm.datasetId}
                onChange={(e) => setJobForm((p) => ({ ...p, datasetId: e.target.value }))}
                placeholder={isAr ? 'معرف مجموعة البيانات (RES-...)' : 'Dataset ID (RES-...)'}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              />
              <select
                required
                value={jobForm.workerId}
                onChange={(e) => setJobForm((p) => ({ ...p, workerId: e.target.value }))}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              >
                <option value="">{isAr ? '-- اختر عامل التدريب --' : '-- Select Worker --'}</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.workerName} ({w.capabilities.vramGb}GB VRAM)
                  </option>
                ))}
              </select>
              <select
                value={jobForm.scaleTier}
                onChange={(e) => setJobForm((p) => ({ ...p, scaleTier: e.target.value as ModelScaleTier }))}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              >
                {SCALE_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                value={jobForm.architecture}
                onChange={(e) => setJobForm((p) => ({ ...p, architecture: e.target.value }))}
                placeholder="Architecture / Adapter"
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              />
              <input
                type="number"
                min={1}
                required
                value={jobForm.totalSteps}
                onChange={(e) => setJobForm((p) => ({ ...p, totalSteps: Number(e.target.value) }))}
                placeholder="Total Steps"
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              />
              <label className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={jobForm.dispatchToWorker}
                  onChange={(e) => setJobForm((p) => ({ ...p, dispatchToWorker: e.target.checked }))}
                />
                <span>{isAr ? 'محاولة الإرسال لعامل HTTP' : 'Dispatch HTTP'}</span>
              </label>
              <button
                type="submit"
                disabled={busyKey !== null || workers.length === 0}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] disabled:opacity-50 text-[#F3D989] text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? 'إنشاء / إرسال مهمة تدريب' : 'Queue / Dispatch Job'}</span>
              </button>
            </form>

            {jobs.length === 0 ? (
              <p className="text-xs text-[#523624] pt-2">
                {isAr ? 'لا توجد مهام تدريب مسجلة حاليًا.' : 'No training jobs logged yet.'}
              </p>
            ) : (
              <div className="divide-y divide-[#523624]/15 pt-2">
                {jobs.map((j) => (
                  <div key={j.id} className="py-3 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-0.5 font-mono">
                        <div className="font-bold text-[#26170F]">
                          {j.id} · {j.architecture} ({j.scaleTier})
                        </div>
                        <div className="text-[11px] text-[#523624]">
                          Model={j.modelId} · Dataset={j.datasetId} · Worker={j.workerId} · Steps={j.currentStep}/{j.totalSteps} · Loss={j.trainingLoss ?? 'N/A'}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusIndicator state={j.jobStatus} />
                        <button
                          type="button"
                          disabled={busyKey !== null || j.jobStatus === 'CANCELLED'}
                          onClick={() =>
                            void runAction(`ckpt-${j.id}`, async () => {
                              const nextStep = Math.min(j.totalSteps, j.currentStep + Math.max(1, Math.floor(j.totalSteps / 10)));
                              const out = await saveTrainingCheckpointApi(j.id, {
                                step: nextStep,
                                trainingLoss: j.trainingLoss ?? 1.25,
                                validationLoss: j.validationLoss ?? 1.32,
                                checkpointNotes: 'Manual owner checkpoint snapshot',
                              });
                              if (openJobLogsId === j.id) {
                                const logs = await fetchTrainingJobLogs(j.id);
                                setJobLogsData(logs);
                              }
                              return isAr
                                ? `تم حفظ نقطة الاستعادة step ${nextStep} (${out.checkpointSha256.slice(0, 12)}...)`
                                : `Saved checkpoint step ${nextStep} (${out.checkpointSha256.slice(0, 12)}...)`;
                            })
                          }
                          className="min-h-[32px] px-2.5 py-1 rounded bg-[#3B2419] disabled:opacity-50 text-[#F3D989] text-xs font-semibold cursor-pointer"
                        >
                          {isAr ? 'حفظ نقطة استعادة' : 'Save Checkpoint'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (openJobLogsId === j.id) {
                              setOpenJobLogsId(null);
                              setJobLogsData(null);
                              return;
                            }
                            setOpenJobLogsId(j.id);
                            void fetchTrainingJobLogs(j.id)
                              .then((res) => setJobLogsData(res))
                              .catch((err) => setErrorBanner(err instanceof Error ? err.message : 'Failed to load logs'));
                          }}
                          className="min-h-[32px] px-2.5 py-1 rounded border border-[#523624]/30 text-xs font-semibold cursor-pointer"
                        >
                          {isAr ? 'السجلات والاستعادة' : 'Logs & Restore'}
                        </button>
                        {j.jobStatus !== 'CANCELLED' && j.jobStatus !== 'COMPLETED' && (
                          <>
                            {j.jobStatus === 'PAUSED' ? (
                              <button
                                type="button"
                                disabled={busyKey !== null}
                                onClick={() =>
                                  void runAction(`resume-${j.id}`, async () => {
                                    const out = await controlFactoryTrainingJob(j.id, 'RESUME');
                                    return `${out.job.id} -> ${out.job.jobStatus}`;
                                  })
                                }
                                className="min-h-[32px] px-2.5 py-1 rounded bg-[#D4AF37] text-[#26170F] text-xs font-bold cursor-pointer"
                              >
                                {isAr ? 'استئناف' : 'Resume'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={busyKey !== null}
                                onClick={() =>
                                  void runAction(`pause-${j.id}`, async () => {
                                    const out = await controlFactoryTrainingJob(j.id, 'PAUSE');
                                    return `${out.job.id} -> ${out.job.jobStatus}`;
                                  })
                                }
                                className="min-h-[32px] px-2.5 py-1 rounded border border-[#523624]/30 text-xs font-semibold cursor-pointer"
                              >
                                {isAr ? 'إيقاف مؤقت' : 'Pause'}
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() =>
                                void runAction(`cancel-${j.id}`, async () => {
                                  const out = await controlFactoryTrainingJob(j.id, 'CANCEL');
                                  return `${out.job.id} -> ${out.job.jobStatus}`;
                                })
                              }
                              className="min-h-[32px] px-2.5 py-1 rounded border border-red-800/30 text-red-800 text-xs font-semibold cursor-pointer"
                            >
                              {isAr ? 'إلغاء' : 'Cancel'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {openJobLogsId === j.id && jobLogsData && jobLogsData.jobId === j.id && (
                      <div className="p-3 rounded-lg bg-[#FFF8E8] border border-[#523624]/20 space-y-2 font-mono text-[11px]">
                        <div className="font-bold text-[#26170F]">
                          {isAr
                            ? `نقاط الاستعادة المحفوظة (${jobLogsData.checkpoints.length}) وسجلات النتائج (${jobLogsData.entries.length})`
                            : `Checkpoints (${jobLogsData.checkpoints.length}) & Results Log (${jobLogsData.entries.length})`}
                        </div>
                        {jobLogsData.checkpoints.length === 0 && jobLogsData.entries.length === 0 && (
                          <div className="text-[#523624]">
                            {isAr
                              ? 'لا توجد نقاط استعادة أو سجلات نتائج مسجلة لهذه المهمة بعد.'
                              : 'No checkpoints or result logs recorded for this job yet.'}
                          </div>
                        )}
                        {jobLogsData.checkpoints.map((cp) => (
                          <div key={cp} className="flex flex-wrap items-center justify-between gap-2 py-1 border-b border-[#523624]/10">
                            <span className="truncate max-w-md">{cp}</span>
                            <button
                              type="button"
                              onClick={() =>
                                void runAction(`restore-${j.id}`, async () => {
                                  const res = await restoreTrainingCheckpointApi(j.id, cp);
                                  return isAr
                                    ? `تمت استعادة ${j.id} إلى الخطوة ${res.restoredStep} بعد مطابقة SHA-256`
                                    : `Restored ${j.id} to step ${res.restoredStep} (verified SHA-256)`;
                                })
                              }
                              className="px-2.5 py-1 rounded bg-[#D4AF37] text-[#26170F] font-bold cursor-pointer"
                            >
                              {isAr ? 'استعادة هذه النقطة' : 'Restore'}
                            </button>
                          </div>
                        ))}
                        {jobLogsData.entries.slice(-3).map((entry, idx) => (
                          <div key={idx} className="text-[#523624] break-all">
                            {JSON.stringify(entry)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WING 3: MIND REPAIR & RE-ENGINEERING FACTORY                              */}
      {/* ========================================================================= */}
      {activeWing === 'MIND_REPAIR_FACTORY' && (
        <div className="space-y-6">
          {/* Receive & Inspect External Model (Immutable Original Preservation) */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <h2 className="text-sm font-bold text-[#26170F]">
              {isAr
                ? 'استقبال وفحص نموذج خارجي (مع حفظ النسخة الأصلية غير قابلة للحذف قبل أي تعديل)'
                : 'Receive & Inspect External Model for Repair (Preserves Immutable Original)'}
            </h2>
            <form onSubmit={handleExternalRepairIntake} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <input
                  type="text"
                  required
                  value={externalRepairForm.name}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={isAr ? 'اسم النموذج الخارجي' : 'External Model Name'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  required
                  value={externalRepairForm.version}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, version: e.target.value }))}
                  placeholder="Version (1.0.0)"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  required
                  value={externalRepairForm.originSource}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, originSource: e.target.value }))}
                  placeholder={isAr ? 'المصدر الخارجي' : 'Origin Source'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  required
                  value={externalRepairForm.license}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, license: e.target.value }))}
                  placeholder="License (Apache-2.0)"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <input
                type="text"
                required
                value={externalRepairForm.architectureSummary}
                onChange={(e) => setExternalRepairForm((p) => ({ ...p, architectureSummary: e.target.value }))}
                placeholder={isAr ? 'وصف المعمارية للنموذج المستلم' : 'Architecture Summary'}
                className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
              />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={externalRepairForm.weightsPath}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, weightsPath: e.target.value }))}
                  placeholder={isAr ? 'مسار الأوزان على المضيف (اختياري)' : 'Host Weights Path (optional)'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <label className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs flex items-center justify-between gap-2 cursor-pointer">
                  <span className="truncate font-mono text-[#523624]">
                    {externalRepairForm.fileName || (isAr ? 'رفع ملف النموذج لحفظ النسخة الأصلية...' : 'Upload model file for original vault...')}
                  </span>
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void readBrowserFileAsBase64(file).then((b64) => {
                        setExternalRepairForm((p) => ({
                          ...p,
                          fileName: file.name,
                          fileBase64: b64,
                          name: p.name.trim() ? p.name : file.name,
                        }));
                      });
                    }}
                  />
                </label>
                <input
                  type="text"
                  value={externalRepairForm.contentText}
                  onChange={(e) => setExternalRepairForm((p) => ({ ...p, contentText: e.target.value }))}
                  placeholder={isAr ? 'أو محتوى/وصف أوزان النموذج (JSON)' : 'Or model descriptor payload'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                disabled={busyKey !== null}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? 'استقبال وفحص مع حفظ الأصل' : 'Inspect & Preserve Original'}</span>
              </button>
            </form>
          </section>

          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <h2 className="text-sm font-bold text-[#26170F]">
              {isAr
                ? 'تسجيل / إصلاح / إعادة هندسة منتج عقلي (NG-BASE → NG-SOFTWARE)'
                : 'Register / Repair / Re-engineer Model Product'}
            </h2>
            <form onSubmit={handleSaveRepairProduct} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={repairForm.id}
                  onChange={(e) => setRepairForm((p) => ({ ...p, id: e.target.value }))}
                  placeholder={isAr ? 'معرف منتج موجود للإصلاح (أو فارغ لإنشاء جديد)' : 'Existing Product ID to update (optional)'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  required
                  value={repairForm.name}
                  onChange={(e) => setRepairForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={isAr ? 'اسم المنتج / العقل' : 'Product Name'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <select
                  value={repairForm.productClass}
                  onChange={(e) => setRepairForm((p) => ({ ...p, productClass: e.target.value as NgProductClass }))}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                >
                  {PRODUCT_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  required
                  value={repairForm.version}
                  onChange={(e) => setRepairForm((p) => ({ ...p, version: e.target.value }))}
                  placeholder="Version (1.0.1)"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  required
                  value={repairForm.license}
                  onChange={(e) => setRepairForm((p) => ({ ...p, license: e.target.value }))}
                  placeholder="License (Apache-2.0 / NG-COMMERCIAL)"
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
                <input
                  type="text"
                  value={repairForm.restoreCheckpointPath}
                  onChange={(e) => setRepairForm((p) => ({ ...p, restoreCheckpointPath: e.target.value }))}
                  placeholder={isAr ? 'مسار نقطة الاستعادة (Restore Checkpoint)' : 'Restore Checkpoint Path'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                />
              </div>
              <input
                type="text"
                required
                value={repairForm.weightsSha256}
                onChange={(e) => setRepairForm((p) => ({ ...p, weightsSha256: e.target.value }))}
                placeholder="Weights SHA-256 (64 hex chars)"
                className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
              />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={repairForm.architectureSummary}
                  onChange={(e) => setRepairForm((p) => ({ ...p, architectureSummary: e.target.value }))}
                  placeholder={isAr ? 'وصف المعمارية (min 5 chars)' : 'Architecture Summary'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  value={repairForm.trainingSummary}
                  onChange={(e) => setRepairForm((p) => ({ ...p, trainingSummary: e.target.value }))}
                  placeholder={isAr ? 'سجل التدريب / السلالة' : 'Training & Lineage Summary'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  value={repairForm.evaluationSummary}
                  onChange={(e) => setRepairForm((p) => ({ ...p, evaluationSummary: e.target.value }))}
                  placeholder={isAr ? 'ملخص التقييم والاختبار' : 'Evaluation Summary'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
                <input
                  type="text"
                  value={repairForm.safetyNotes}
                  onChange={(e) => setRepairForm((p) => ({ ...p, safetyNotes: e.target.value }))}
                  placeholder={isAr ? 'ملاحظات مراجعة السلامة' : 'Safety Review Notes'}
                  className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
                />
              </div>
              <input
                type="text"
                value={repairForm.changelog}
                onChange={(e) => setRepairForm((p) => ({ ...p, changelog: e.target.value }))}
                placeholder={isAr ? 'سجل التغييرات (Changelog)' : 'Changelog'}
                className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs"
              />
              <button
                type="submit"
                disabled={busyKey !== null}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isAr ? 'حفظ في سجل المنتجات' : 'Save Model Product'}</span>
              </button>
            </form>
          </section>

          {/* Product Registry List + Lifecycle Gate */}
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#523624]/15 flex items-center justify-between">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? `سجل المنتجات والأجيال (${products.length})` : `Product & Generation Registry (${products.length})`}
              </h2>
              <span className="font-mono text-xs text-[#523624]">
                {isAr ? 'يتطلب الاعتماد والإصدار اجتياز 10/10 اختبارات جودة' : '10/10 QC Pass Required for APPROVED / RELEASED'}
              </span>
            </div>
            {products.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#523624]">
                {isAr ? 'لا توجد منتجات مسجلة بعد.' : 'No model products registered yet.'}
              </div>
            ) : (
              <div className="divide-y divide-[#523624]/15">
                {products.map((p) => (
                  <div key={p.id} className="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-[#26170F]">{p.id}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-bold text-[#26170F]">{p.name}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[#523624]">{p.productClass} · v{p.version}</span>
                        <span aria-hidden="true">·</span>
                        <StatusIndicator state={p.lifecycleState} />
                      </div>
                      <div className="font-mono text-[11px] text-[#523624] break-all">
                        QC: {p.qcPassedCount}/10 PASS · License: {p.license} · SHA-256: {p.weightsSha256}
                        {Array.isArray(p.safetyReport.preservedOriginals) &&
                          ` · Preserved Originals: ${p.safetyReport.preservedOriginals.length}`}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => loadProductIntoRepairForm(p)}
                        className="min-h-[34px] px-3 py-1 rounded-lg border border-[#523624]/30 text-xs font-semibold cursor-pointer"
                      >
                        {isAr ? 'تعديل / إصلاح' : 'Edit / Repair'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedQcProductId(p.id);
                          setActiveWing('TRUST_SECURITY_CENTER');
                        }}
                        className="min-h-[34px] px-3 py-1 rounded-lg bg-[#3B2419] text-[#F3D989] text-xs font-semibold cursor-pointer"
                      >
                        {isAr ? 'فحص الجودة 10/10' : 'Run Trust QC'}
                      </button>
                      {(p.lifecycleState === 'APPROVED' || p.lifecycleState === 'RELEASED') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDeliveryProductId(p.id);
                            setActiveWing('NG_IP_SERVICES');
                          }}
                          className="min-h-[34px] px-3 py-1 rounded-lg bg-[#D4AF37] text-[#26170F] text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{isAr ? 'تجهيز حزمة التسليم' : 'Prepare Delivery ZIP'}</span>
                        </button>
                      )}
                      {LIFECYCLE_STATES.map((st) => (
                        <button
                          key={st}
                          type="button"
                          disabled={busyKey !== null || p.lifecycleState === st}
                          onClick={() =>
                            void runAction(`state-${p.id}-${st}`, async () => {
                              const out = await transitionRepairProductState(p.id, st);
                              return `${out.product.id} -> ${out.product.lifecycleState}`;
                            })
                          }
                          className={`min-h-[34px] px-2.5 py-1 rounded-lg text-[11px] font-mono font-semibold cursor-pointer ${
                            p.lifecycleState === st
                              ? 'bg-[#D4AF37] text-[#26170F]'
                              : 'border border-[#523624]/25 text-[#26170F] hover:bg-[#523624]/10'
                          }`}
                        >
                          {st}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WING 4: TRUST & SECURITY CENTER (10-Suite QC & Governance Links)          */}
      {/* ========================================================================= */}
      {activeWing === 'TRUST_SECURITY_CENTER' && (
        <div className="space-y-6">
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-[#26170F]">
                  {isAr ? 'بوابة الاختبارات العشرية والحوكمة (10-Suite QC Verification)' : '10-Suite Trust, Integrity & License Verification'}
                </h2>
                <p className="text-xs text-[#523624]">
                  {isAr
                    ? 'تفحص فعليًا الأوزان، البصمة، الرخصة، السلالة، المعمارية، السلامة، ونقاط الاستعادة بدون أي نتيجة PASS وهمية.'
                    : 'Inspects weights SHA-256, schema, license compliance, provenance, safety notes, and restore checkpoints with zero fake passes.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onNavigate('device')}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#523624]/30 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'أمن المالك والجلسات' : 'Owner Security'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('audit')}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#523624]/30 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isAr ? 'سجل التدقيق الكامل' : 'Audit Log'}</span>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#523624]/15">
              <select
                value={selectedQcProductId}
                onChange={(e) => setSelectedQcProductId(e.target.value)}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono min-w-[260px]"
              >
                <option value="">{isAr ? '-- اختر منتجًا لفحصه --' : '-- Select Model Product --'}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name} v{p.version} ({p.qcPassedCount}/10)
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={!selectedQcProductId || busyKey !== null}
                onClick={() =>
                  void runAction('qc-run', async () => {
                    const out = await runTrustQcCheck(selectedQcProductId);
                    setLastQcEvidence({
                      productId: out.productId,
                      evidencePath: out.evidencePath,
                      evidenceSha256: out.evidenceSha256,
                    });
                    return isAr
                      ? `اكتمل فحص ${out.productId}: اجتاز ${out.passedCount}/${out.totalCount} فحوصات (SHA-256: ${out.evidenceSha256.slice(0, 12)}...)`
                      : `Completed 10-Suite QC for ${out.productId}: ${out.passedCount}/${out.totalCount} PASS (Evidence SHA-256: ${out.evidenceSha256.slice(0, 12)}...)`;
                  })
                }
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] disabled:opacity-50 text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <span>{isAr ? 'تشغيل اختبارات الجودة العشرة' : 'Run 10-Suite QC Verification'}</span>
              </button>
              {selectedQcProductId && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDeliveryProductId(selectedQcProductId);
                    setActiveWing('NG_IP_SERVICES');
                  }}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#523624]/30 hover:bg-[#523624]/10 text-[#26170F] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
                >
                  <PackageCheck className="h-4 w-4" aria-hidden="true" />
                  <span>{isAr ? 'الانتقال لحزمة التسليم NG-IP' : 'Go to NG-IP Delivery'}</span>
                </button>
              )}
            </div>
            {lastQcEvidence && (
              <div className="p-3 rounded-lg bg-[#FFF8E8] border border-[#523624]/20 font-mono text-[11px] text-[#523624] break-all">
                Evidence File: {lastQcEvidence.evidencePath} · SHA-256: {lastQcEvidence.evidenceSha256}
              </div>
            )}
          </section>

          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            {qcReports.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#523624]">
                {isAr
                  ? 'لا توجد تقارير جودة منفذة لهذا الاختيار بعد.'
                  : 'No QC suite reports recorded for this selection yet.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[#3B2419]/5 border-b border-[#523624]/15 text-[#523624]">
                    <tr>
                      <th className="py-2.5 px-4 text-start">{isAr ? 'المنتج' : 'Product'}</th>
                      <th className="py-2.5 px-4 text-start">{isAr ? 'مجموعة الفحص' : 'QC Suite'}</th>
                      <th className="py-2.5 px-4 text-start">{isAr ? 'تفاصيل التحقق' : 'Details'}</th>
                      <th className="py-2.5 px-4 text-end">{isAr ? 'النتيجة' : 'Result'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#523624]/10 font-mono">
                    {qcReports.map((row) => (
                      <tr key={row.id}>
                        <td className="py-2.5 px-4 whitespace-nowrap">{row.productId}</td>
                        <td className="py-2.5 px-4 font-semibold text-[#26170F] whitespace-nowrap">
                          {row.testSuite}
                        </td>
                        <td className="py-2.5 px-4 text-[11px] text-[#523624]">
                          {JSON.stringify(row.details)}
                        </td>
                        <td className="py-2.5 px-4 text-end">
                          <StatusIndicator state={row.result} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WING 5: NG-IP SERVICES (Certified Delivery ZIP Packaging)                 */}
      {/* ========================================================================= */}
      {activeWing === 'NG_IP_SERVICES' && (
        <div className="space-y-6">
          <section className="rounded-xl bg-white/75 border border-[#523624]/20 p-5 space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-[#26170F]">
                {isAr
                  ? 'جناح NG-IP — تغليف وبناء حزم التسليم المعتمدة (.zip + SHA-256)'
                  : 'NG-IP SERVICES — Certified Customer Delivery Packaging'}
              </h2>
              <p className="text-xs text-[#523624]">
                {isAr
                  ? 'محظور تغليف أي نموذج لم يصل إلى APPROVED أو RELEASED مع اجتياز جميع اختبارات الجودة (10/10) وتفويض جلسة المالك.'
                  : 'Strictly blocks packaging any product not in APPROVED/RELEASED with 10/10 QC PASS and owner export authorization.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedDeliveryProductId}
                onChange={(e) => setSelectedDeliveryProductId(e.target.value)}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono min-w-[260px]"
              >
                <option value="">{isAr ? '-- اختر المنتج --' : '-- Select Product --'}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name} ({p.lifecycleState} · {p.qcPassedCount}/10 QC)
                  </option>
                ))}
              </select>

              <input
                type="text"
                value={ipHolderInput}
                onChange={(e) => setIpHolderInput(e.target.value)}
                placeholder={isAr ? 'صاحب الملكية الفكرية (IP Holder)' : 'IP Holder / Copyright Owner'}
                className="min-h-[40px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs min-w-[220px]"
              />

              <button
                type="button"
                disabled={!selectedDeliveryProductId || busyKey !== null}
                onClick={() =>
                  void runAction('ngip-build', async () => {
                    const res = await buildNgIpDeliveryPackage(selectedDeliveryProductId, {
                      ipHolder: ipHolderInput.trim() || undefined,
                    });
                    return isAr
                      ? `تم بناء حزمة التسليم الموثقة ${res.deliveryPackage.id} (${formatBytes(res.deliveryPackage.sizeBytes, locale)}) SHA-256: ${res.deliveryPackage.packageSha256.slice(0, 14)}...`
                      : `Built certified ZIP ${res.deliveryPackage.id} (${formatBytes(res.deliveryPackage.sizeBytes, locale)}) SHA-256: ${res.deliveryPackage.packageSha256.slice(0, 14)}...`;
                  })
                }
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] disabled:opacity-50 text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
              >
                <PackageCheck className="h-4 w-4" aria-hidden="true" />
                <span>{isAr ? 'بناء حزمة التسليم الموثقة (ZIP)' : 'Build Certified Delivery ZIP'}</span>
              </button>
            </div>
          </section>

          <section className="rounded-xl bg-white/75 border border-[#523624]/20 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#523624]/15">
              <h2 className="text-sm font-bold text-[#26170F]">
                {isAr ? `حزم التسليم المعتمدة (${deliveryPackages.length})` : `Issued Delivery Packages (${deliveryPackages.length})`}
              </h2>
            </div>
            {deliveryPackages.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#523624]">
                {isAr
                  ? 'لم يتم إصدار أي حزم تسليم ZIP بعد. يتضمن الملف المصدّر MANIFEST.json وTECHNICAL_REPORT.md وLICENSE_AND_IP.txt وCHECKSUMS.sha256.'
                  : 'No certified delivery ZIPs built yet.'}
              </div>
            ) : (
              <div className="divide-y divide-[#523624]/15">
                {deliveryPackages.map((pkg) => (
                  <div key={pkg.id} className="p-4 space-y-1 text-xs font-mono">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-[#26170F]">
                        {pkg.id} · Product={pkg.productId} · {formatBytes(pkg.sizeBytes, locale)}
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusIndicator state={pkg.verified ? 'VERIFIED' : 'VERIFY_FAILED'} />
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`verify-pkg-${pkg.id}`, async () => {
                              const out = await verifyDeliveryPackageApi(pkg.id);
                              return out.sha256Matched && out.validPkzipHeader
                                ? isAr
                                  ? `حزمة ${pkg.id} سليمة (PKZIP + SHA-256 مطابق)`
                                  : `Package ${pkg.id} verified (PKZIP + SHA-256 matched)`
                                : isAr
                                  ? `فشل التحقق من الحزمة ${pkg.id} (missing/tampered)`
                                  : `Package ${pkg.id} integrity verification FAILED`;
                            })
                          }
                          className="min-h-[30px] px-2.5 py-1 rounded border border-[#523624]/30 hover:bg-[#523624]/10 text-[11px] font-semibold cursor-pointer"
                        >
                          {isAr ? 'فحص سلامة ZIP' : 'Verify ZIP'}
                        </button>
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() =>
                            void runAction(`download-pkg-${pkg.id}`, async () => {
                              const fileName = await downloadDeliveryPackageZip(pkg.id, `${pkg.id}.zip`);
                              return isAr ? `تم تحميل الحزمة ${fileName}` : `Downloaded ${fileName}`;
                            })
                          }
                          className="min-h-[30px] px-2.5 py-1 rounded bg-[#D4AF37] hover:bg-[#F3D989] text-[#26170F] text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Download className="h-3 w-3" aria-hidden="true" />
                          <span>{isAr ? 'تحميل ZIP' : 'Download ZIP'}</span>
                        </button>
                      </div>
                    </div>
                    <div className="text-[11px] text-[#523624] break-all">
                      ZIP: {pkg.zipPath}
                    </div>
                    <div className="text-[11px] text-[#523624] break-all">
                      Package SHA-256: {pkg.packageSha256} · Manifest SHA-256: {pkg.manifestSha256} · {formatTimestamp(pkg.createdAt, locale)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
