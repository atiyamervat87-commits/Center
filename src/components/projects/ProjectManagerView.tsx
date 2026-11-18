import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Download,
  FileText,
  FolderGit2,
  Link2,
  Plus,
  PowerOff,
  Save,
  Search,
  Unlink,
} from 'lucide-react';
import { t } from '../../i18n/translations';
import type {
  AvailableIndependentResource,
  ExportedProjectReport,
  Locale,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
} from '../../types/commandCenter';
import {
  createProject,
  exportProjectReport,
  fetchProjectDetail,
  fetchProjects,
  linkProjectResource,
  unlinkProjectResource,
  updateProject,
} from '../../services/apiClient';
import { formatBytes, formatTimestamp } from '../../utils/formatters';
import { StatusIndicator } from '../common/StatusIndicator';

interface ProjectManagerViewProps {
  locale: Locale;
  onDataChanged: () => Promise<void>;
}

const STATUS_FILTERS: Array<'ALL' | ProjectStatus> = [
  'ALL',
  'ACTIVE',
  'PAUSED',
  'STOPPED',
  'ARCHIVED',
];

const PROJECT_TYPES = [
  'LLM_TRAINING',
  'DOMAIN_ADAPTATION',
  'MODEL_REPAIR',
  'QUANTIZATION',
  'EVALUATION',
  'SOFTWARE_ENGINEERING',
];

export function ProjectManagerView({ locale, onDataChanged }: ProjectManagerViewProps) {
  const copy = t(locale);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [independentResources, setIndependentResources] = useState<AvailableIndependentResource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ProjectDetail | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    projectType: 'LLM_TRAINING',
    rootPath: '',
    version: '0.1.0',
    status: 'ACTIVE' as ProjectStatus,
    dependenciesText: '',
    notes: '',
  });
  const [submittingCreate, setSubmittingCreate] = useState(false);

  // Edit state for selected project
  const [editVersion, setEditVersion] = useState('');
  const [editStatus, setEditStatus] = useState<ProjectStatus>('ACTIVE');
  const [editRootPath, setEditRootPath] = useState('');
  const [editDepsText, setEditDepsText] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [linkResourceId, setLinkResourceId] = useState('');
  const [exportedReport, setExportedReport] = useState<ExportedProjectReport | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchProjects({ status: statusFilter, search });
      setProjects(data.projects);
      setIndependentResources(data.independentResources);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (projectId: string) => {
    try {
      const res = await fetchProjectDetail(projectId);
      setSelectedDetail(res.project);
      setIndependentResources(res.independentResources);
      setEditVersion(res.project.version);
      setEditStatus(res.project.status);
      setEditRootPath(res.project.rootPath);
      setEditDepsText(res.project.dependencies.join(', '));
      setEditNotes(res.project.notes);
      setExportedReport(null);
      setActionMessage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project details');
    }
  }, []);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setSelectedDetail(null);
    }
  }, [selectedId, loadDetail]);

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittingCreate(true);
    setError(null);
    try {
      const deps = createForm.dependenciesText
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      const res = await createProject({
        name: createForm.name,
        projectType: createForm.projectType,
        rootPath: createForm.rootPath,
        version: createForm.version,
        status: createForm.status,
        dependencies: deps,
        notes: createForm.notes,
      });
      setShowCreateForm(false);
      setCreateForm({
        name: '',
        projectType: 'LLM_TRAINING',
        rootPath: '',
        version: '0.1.0',
        status: 'ACTIVE',
        dependenciesText: '',
        notes: '',
      });
      await loadList();
      await onDataChanged();
      setSelectedId(res.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Project creation failed');
    } finally {
      setSubmittingCreate(false);
    }
  };

  const handleSaveProjectChanges = async (overrideStatus?: ProjectStatus) => {
    if (!selectedDetail) return;
    setSavingEdit(true);
    setActionMessage(null);
    try {
      const targetStatus = overrideStatus ?? editStatus;
      const deps = editDepsText
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      const res = await updateProject(selectedDetail.id, {
        version: editVersion,
        status: targetStatus,
        rootPath: editRootPath,
        dependencies: deps,
        notes: editNotes,
      });
      setSelectedDetail(res.project);
      setEditStatus(res.project.status);
      await loadList();
      await onDataChanged();
      setActionMessage(`Updated ${res.project.id} -> v${res.project.version} (${res.project.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleLinkResource = async () => {
    if (!selectedDetail || !linkResourceId) return;
    try {
      const res = await linkProjectResource(selectedDetail.id, linkResourceId);
      setSelectedDetail(res.project);
      setLinkResourceId('');
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link resource');
    }
  };

  const handleUnlinkResource = async (resourceId: string) => {
    if (!selectedDetail) return;
    try {
      const res = await unlinkProjectResource(selectedDetail.id, resourceId);
      setSelectedDetail(res.project);
      await loadList();
      setActionMessage(`Unlinked ${resourceId} from project; resource remains intact in library.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink resource');
    }
  };

  const handleExportReport = async () => {
    if (!selectedDetail) return;
    try {
      const res = await exportProjectReport(selectedDetail.id);
      setExportedReport(res.report);
      await onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export project report');
    }
  };

  const triggerDownloadMarkdown = () => {
    if (!exportedReport) return;
    const blob = new Blob([exportedReport.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportedReport.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#26170F]">{copy.pmTitle}</h1>
          <p className="text-sm text-[#523624] mt-1 max-w-3xl">{copy.pmSubtitle}</p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateForm((v) => !v)}
          className="min-h-[44px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#B8860B] hover:text-[#FFF8E8] text-[#26170F] text-xs font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{showCreateForm ? copy.pmCancel : copy.pmNewBtn}</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/30 bg-white/80 px-4 py-3 text-xs font-mono text-red-800">
          {error}
        </div>
      )}

      {/* Registration Form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateSubmit}
          className="rounded-xl bg-white/85 border border-[#B8860B]/50 p-5 sm:p-6 space-y-4"
        >
          <h2 className="text-base font-bold text-[#26170F]">{copy.pmFormTitleNew}</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <label className="block space-y-1.5">
              <span className="font-semibold text-[#3B2419]">{copy.pmFieldName}</span>
              <input
                type="text"
                required
                value={createForm.name}
                onChange={(e) => setCreateForm((s) => ({ ...s, name: e.target.value }))}
                className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-[#26170F]"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="font-semibold text-[#3B2419]">{copy.pmFieldType}</span>
              <select
                value={createForm.projectType}
                onChange={(e) => setCreateForm((s) => ({ ...s, projectType: e.target.value }))}
                className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-[#26170F]"
              >
                {PROJECT_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {pt}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className="font-semibold text-[#3B2419]">{copy.pmFieldRootPath}</span>
              <input
                type="text"
                dir="ltr"
                required
                placeholder="/app/applet/var/ng-ilmf/projects/arabic-brain"
                value={createForm.rootPath}
                onChange={(e) => setCreateForm((s) => ({ ...s, rootPath: e.target.value }))}
                className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-[#26170F]"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="font-semibold text-[#3B2419]">{copy.pmFieldVersion}</span>
                <input
                  type="text"
                  dir="ltr"
                  required
                  value={createForm.version}
                  onChange={(e) => setCreateForm((s) => ({ ...s, version: e.target.value }))}
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-[#26170F]"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="font-semibold text-[#3B2419]">{copy.pmFieldStatus}</span>
                <select
                  value={createForm.status}
                  onChange={(e) =>
                    setCreateForm((s) => ({ ...s, status: e.target.value as ProjectStatus }))
                  }
                  className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-[#26170F]"
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="PAUSED">PAUSED</option>
                  <option value="STOPPED">STOPPED</option>
                  <option value="ARCHIVED">ARCHIVED</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1.5 md:col-span-2">
              <span className="font-semibold text-[#3B2419]">{copy.pmFieldDeps}</span>
              <input
                type="text"
                dir="ltr"
                placeholder="pytorch>=2.3, transformers, sentencepiece"
                value={createForm.dependenciesText}
                onChange={(e) =>
                  setCreateForm((s) => ({ ...s, dependenciesText: e.target.value }))
                }
                className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono text-[#26170F]"
              />
            </label>

            <label className="block space-y-1.5 md:col-span-2">
              <span className="font-semibold text-[#3B2419]">{copy.pmFieldNotes}</span>
              <textarea
                rows={2}
                value={createForm.notes}
                onChange={(e) => setCreateForm((s) => ({ ...s, notes: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-[#26170F]"
              />
            </label>
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#523624]/25 text-xs font-semibold text-[#523624] cursor-pointer"
            >
              {copy.pmCancel}
            </button>
            <button
              type="submit"
              disabled={submittingCreate}
              className="min-h-[44px] px-5 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold cursor-pointer"
            >
              {copy.pmCreateSubmit}
            </button>
          </div>
        </form>
      )}

      {/* Search & Status Filter Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#3B2419]/10 rounded-lg w-fit">
          {STATUS_FILTERS.map((st) => {
            const active = statusFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`min-h-[36px] px-3 py-1.5 rounded-md font-mono text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-[#26170F] text-[#F3D989]'
                    : 'text-[#523624] hover:text-[#26170F]'
                }`}
              >
                {st === 'ALL' ? copy.pmFilterAll : st}
              </button>
            );
          })}
        </div>

        <div className="relative w-full md:w-80">
          <Search
            className="h-4 w-4 text-[#523624] absolute top-1/2 -translate-y-1/2 start-3"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={copy.pmSearchPlaceholder}
            className="w-full min-h-[44px] ps-9 pe-3 py-2 rounded-lg bg-white/80 border border-[#523624]/25 text-xs text-[#26170F]"
          />
        </div>
      </div>

      {/* Master-Detail Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Project List */}
        <div className="lg:col-span-5 rounded-xl bg-white/75 border border-[#523624]/20 divide-y divide-[#523624]/15 overflow-hidden">
          {loading ? (
            <div className="p-5 space-y-3">
              <div className="h-14 bg-[#523624]/10 rounded animate-pulse" />
              <div className="h-14 bg-[#523624]/10 rounded animate-pulse" />
            </div>
          ) : projects.length === 0 ? (
            <div className="p-6 text-center text-sm text-[#523624]">{copy.pmEmptyList}</div>
          ) : (
            projects.map((prj) => {
              const isSelected = selectedId === prj.id;
              return (
                <button
                  key={prj.id}
                  type="button"
                  onClick={() => setSelectedId(prj.id)}
                  className={`w-full text-start p-4 transition-colors cursor-pointer space-y-1.5 ${
                    isSelected ? 'bg-[#3B2419] text-[#FFF8E8]' : 'hover:bg-[#D4AF37]/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm truncate">{prj.name}</span>
                    <StatusIndicator state={prj.status} inverted={isSelected} />
                  </div>
                  <div
                    className={`flex flex-wrap items-center gap-x-2 text-xs font-mono ${
                      isSelected ? 'text-[#F3D989]/90' : 'text-[#523624]'
                    }`}
                  >
                    <span>{prj.id}</span>
                    <span aria-hidden="true">·</span>
                    <span>v{prj.version}</span>
                    <span aria-hidden="true">·</span>
                    <span>{prj.projectType}</span>
                    <span aria-hidden="true">·</span>
                    <span>{prj.linkedResourcesCount} shared</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Selected Project Inspector */}
        <div className="lg:col-span-7">
          {!selectedDetail ? (
            <div className="rounded-xl bg-white/70 border border-[#523624]/20 p-8 text-center text-sm text-[#523624]">
              {copy.pmSelectPrompt}
            </div>
          ) : (
            <div className="rounded-xl bg-white/80 border border-[#523624]/25 p-5 sm:p-6 space-y-6">
              {/* Project Header */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#523624]/15 pb-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-mono text-xs text-[#523624]">
                    <FolderGit2 className="h-4 w-4 text-[#B8860B]" aria-hidden="true" />
                    <span>{selectedDetail.id}</span>
                    <span aria-hidden="true">·</span>
                    <span>{selectedDetail.projectType}</span>
                  </div>
                  <h2 className="text-lg font-bold text-[#26170F]">{selectedDetail.name}</h2>
                  <div className="font-mono text-xs text-[#523624] tabular-nums">
                    {formatTimestamp(selectedDetail.updatedAt, locale)}
                  </div>
                </div>
                <StatusIndicator state={selectedDetail.status} />
              </div>

              {actionMessage && (
                <div className="rounded-lg bg-[#FFF8E8] border border-[#B8860B]/40 px-3 py-2 text-xs font-mono text-[#26170F]">
                  {actionMessage}
                </div>
              )}

              {/* State & Versioning Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <label className="block space-y-1">
                  <span className="font-semibold text-[#3B2419]">{copy.pmFieldVersion}</span>
                  <input
                    type="text"
                    dir="ltr"
                    value={editVersion}
                    onChange={(e) => setEditVersion(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="font-semibold text-[#3B2419]">{copy.pmFieldStatus}</span>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as ProjectStatus)}
                    className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="PAUSED">PAUSED</option>
                    <option value="STOPPED">STOPPED</option>
                    <option value="ARCHIVED">ARCHIVED</option>
                  </select>
                </label>

                <label className="block space-y-1 sm:col-span-2">
                  <span className="font-semibold text-[#3B2419]">{copy.pmFieldRootPath}</span>
                  <input
                    type="text"
                    dir="ltr"
                    value={editRootPath}
                    onChange={(e) => setEditRootPath(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono"
                  />
                </label>

                <label className="block space-y-1 sm:col-span-2">
                  <span className="font-semibold text-[#3B2419]">{copy.pmFieldDeps}</span>
                  <input
                    type="text"
                    dir="ltr"
                    value={editDepsText}
                    onChange={(e) => setEditDepsText(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 font-mono"
                  />
                </label>

                <label className="block space-y-1 sm:col-span-2">
                  <span className="font-semibold text-[#3B2419]">{copy.pmFieldNotes}</span>
                  <textarea
                    rows={2}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#FFF8E8] border border-[#523624]/25"
                  />
                </label>
              </div>

              {/* Project Action Bar */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={() => void handleSaveProjectChanges()}
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-[#26170F] text-[#F3D989] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{copy.pmSaveChanges}</span>
                </button>

                {selectedDetail.status !== 'STOPPED' && (
                  <button
                    type="button"
                    disabled={savingEdit}
                    onClick={() => void handleSaveProjectChanges('STOPPED')}
                    className="min-h-[42px] px-4 py-2 rounded-lg border border-red-800/35 text-red-900 hover:bg-red-50 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
                  >
                    <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{copy.pmStopProject}</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleExportReport()}
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#B8860B] hover:text-[#FFF8E8] text-[#26170F] text-xs font-bold inline-flex items-center gap-2 cursor-pointer"
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{copy.pmExportReport}</span>
                </button>
              </div>

              {/* Exported Report Verification Box */}
              {exportedReport && (
                <div className="rounded-lg bg-[#FFF8E8] border border-[#B8860B]/50 p-4 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-[#26170F]">{copy.pmExportedBanner}</span>
                    <button
                      type="button"
                      onClick={triggerDownloadMarkdown}
                      className="min-h-[36px] px-3 py-1 rounded-md bg-[#26170F] text-[#F3D989] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{copy.pmDownloadMd}</span>
                    </button>
                  </div>
                  <div className="font-mono text-[#523624] break-all">{exportedReport.filePath}</div>
                  <div className="font-mono text-[#26170F] break-all">
                    SHA-256: {exportedReport.sha256} · {formatBytes(exportedReport.sizeBytes, locale)}
                  </div>
                </div>
              )}

              {/* Root Path Real Inspection */}
              <div className="pt-4 border-t border-[#523624]/15 space-y-2">
                <h3 className="text-sm font-bold text-[#26170F]">{copy.pmRootScanTitle}</h3>
                {selectedDetail.rootPathInspection.error ? (
                  <div className="font-mono text-xs text-amber-800">
                    {selectedDetail.rootPathInspection.error}
                  </div>
                ) : selectedDetail.rootPathInspection.files.length === 0 ? (
                  <div className="font-mono text-xs text-[#523624]">Directory exists (empty)</div>
                ) : (
                  <div className="max-h-40 overflow-y-auto divide-y divide-[#523624]/10 border border-[#523624]/15 rounded-lg">
                    {selectedDetail.rootPathInspection.files.map((f) => (
                      <div
                        key={f.name}
                        className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs font-mono"
                      >
                        <span className="truncate">
                          [{f.kind}] {f.name}
                        </span>
                        <span className="tabular-nums text-[#523624] shrink-0">
                          {formatBytes(f.sizeBytes, locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Independent Shared Resources Protection Section */}
              <div className="pt-4 border-t border-[#523624]/15 space-y-3">
                <h3 className="text-sm font-bold text-[#26170F]">{copy.pmLinkedResourcesTitle}</h3>

                {selectedDetail.linkedResources.length === 0 ? (
                  <p className="text-xs text-[#523624]">{copy.pmNoLinkedResources}</p>
                ) : (
                  <div className="divide-y divide-[#523624]/15 border border-[#523624]/15 rounded-lg">
                    {selectedDetail.linkedResources.map((res) => (
                      <div
                        key={res.id}
                        className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
                      >
                        <div className="space-y-0.5">
                          <div className="font-bold text-[#26170F]">{res.name}</div>
                          <div className="font-mono text-[#523624]">
                            {res.id} · {res.librarySection} · v{res.version} · Shared: {res.sharedProjectCount}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleUnlinkResource(res.id)}
                          className="min-h-[36px] px-3 py-1 rounded-md border border-[#523624]/25 text-[#3B2419] hover:bg-[#3B2419]/10 font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                        >
                          <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{copy.pmUnlinkOnly}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {independentResources.length === 0 ? (
                  <p className="text-xs text-[#523624]/90">{copy.pmNoLibraryResourcesHint}</p>
                ) : (
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
                    <select
                      value={linkResourceId}
                      onChange={(e) => setLinkResourceId(e.target.value)}
                      className="flex-1 min-h-[42px] px-3 py-1.5 rounded-lg bg-[#FFF8E8] border border-[#523624]/25 text-xs font-mono"
                    >
                      <option value="">{copy.pmLinkResourceLabel}</option>
                      {independentResources.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} ({r.librarySection} · v{r.version})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!linkResourceId}
                      onClick={() => void handleLinkResource()}
                      className="min-h-[42px] px-4 py-2 rounded-lg bg-[#3B2419] text-[#F3D989] disabled:opacity-50 text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{copy.pmLinkResourceBtn}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
