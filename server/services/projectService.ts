import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';

export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'ARCHIVED';

export interface ProjectRow {
  id: string;
  name: string;
  project_type: string;
  root_path: string;
  version: string;
  status: ProjectStatus;
  dependencies_json: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

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

const VALID_STATUSES = new Set<ProjectStatus>(['ACTIVE', 'PAUSED', 'STOPPED', 'ARCHIVED']);

function parseDependencies(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function mapRowToSummary(row: ProjectRow, linkedCount: number): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    projectType: row.project_type,
    rootPath: row.root_path,
    version: row.version,
    status: row.status,
    dependencies: parseDependencies(row.dependencies_json),
    notes: row.notes,
    linkedResourcesCount: linkedCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inspectProjectRootDirectory(rootPath: string): ProjectDetail['rootPathInspection'] {
  const trimmed = rootPath.trim();
  if (!trimmed) {
    return {
      exists: false,
      readable: false,
      files: [],
      error: 'Root path is empty',
    };
  }

  try {
    if (!fs.existsSync(trimmed)) {
      return {
        exists: false,
        readable: false,
        files: [],
        error: `Directory does not exist on host: ${trimmed}`,
      };
    }

    const stat = fs.statSync(trimmed);
    if (!stat.isDirectory()) {
      return {
        exists: true,
        readable: true,
        files: [
          {
            name: path.basename(trimmed),
            kind: 'FILE',
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          },
        ],
        error: null,
      };
    }

    const entries = fs.readdirSync(trimmed, { withFileTypes: true }).slice(0, 50);
    const files: RootDirectoryFileEntry[] = entries.map((entry) => {
      const full = path.join(trimmed, entry.name);
      let sizeBytes = 0;
      let modifiedAt = '';
      try {
        const entryStat = fs.statSync(full);
        sizeBytes = entryStat.size;
        modifiedAt = entryStat.mtime.toISOString();
      } catch {
        // ignore inaccessible metadata
      }
      return {
        name: entry.name,
        kind: entry.isDirectory() ? 'DIRECTORY' : 'FILE',
        sizeBytes,
        modifiedAt,
      };
    });

    return {
      exists: true,
      readable: true,
      files,
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      readable: false,
      files: [],
      error: err instanceof Error ? err.message : 'Unable to inspect directory',
    };
  }
}

export function listProjects(
  db: DatabaseSync,
  filters: { status?: string; search?: string } = {},
): ProjectSummary[] {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filters.status && filters.status !== 'ALL' && VALID_STATUSES.has(filters.status as ProjectStatus)) {
    clauses.push('p.status = ?');
    params.push(filters.status);
  }

  if (filters.search && filters.search.trim()) {
    clauses.push('(p.name LIKE ? OR p.project_type LIKE ? OR p.root_path LIKE ? OR p.id LIKE ?)');
    const term = `%${filters.search.trim()}%`;
    params.push(term, term, term, term);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
      SELECT p.*, COUNT(pr.resource_id) AS linked_count
      FROM projects p
      LEFT JOIN project_resources pr ON pr.project_id = p.id
      ${whereSql}
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `,
    )
    .all(...params) as unknown as Array<ProjectRow & { linked_count: number }>;

  return rows.map((row) => mapRowToSummary(row, Number(row.linked_count ?? 0)));
}

export function getProjectDetail(db: DatabaseSync, projectId: string): ProjectDetail | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!row) {
    return null;
  }

  const linkedRows = db
    .prepare(
      `
      SELECT
        r.id,
        r.library_section,
        r.name,
        r.resource_type,
        r.origin_source,
        r.license,
        r.file_path,
        r.size_bytes,
        r.version,
        r.sha256,
        r.verification_status,
        pr.role,
        pr.linked_at,
        (SELECT COUNT(*) FROM project_resources pr2 WHERE pr2.resource_id = r.id) AS shared_project_count
      FROM project_resources pr
      INNER JOIN resources r ON r.id = pr.resource_id
      WHERE pr.project_id = ?
      ORDER BY pr.linked_at DESC
    `,
    )
    .all(projectId) as Array<{
    id: string;
    library_section: string;
    name: string;
    resource_type: string;
    origin_source: string;
    license: string;
    file_path: string;
    size_bytes: number;
    version: string;
    sha256: string;
    verification_status: string;
    role: string;
    linked_at: string;
    shared_project_count: number;
  }>;

  const linkedResources: LinkedResourceRecord[] = linkedRows.map((item) => ({
    id: item.id,
    librarySection: item.library_section,
    name: item.name,
    resourceType: item.resource_type,
    originSource: item.origin_source,
    license: item.license,
    filePath: item.file_path,
    sizeBytes: Number(item.size_bytes ?? 0),
    version: item.version,
    sha256: item.sha256,
    verificationStatus: item.verification_status,
    role: item.role,
    linkedAt: item.linked_at,
    sharedProjectCount: Number(item.shared_project_count ?? 1),
  }));

  const summary = mapRowToSummary(row, linkedResources.length);

  return {
    ...summary,
    linkedResources,
    rootPathInspection: inspectProjectRootDirectory(row.root_path),
  };
}

export interface CreateProjectInput {
  name: string;
  projectType: string;
  rootPath: string;
  version?: string;
  status?: ProjectStatus;
  dependencies?: string[];
  notes?: string;
}

export function createProject(db: DatabaseSync, input: CreateProjectInput): ProjectDetail {
  const name = input.name.trim();
  const projectType = input.projectType.trim();
  const rootPath = input.rootPath.trim();
  const version = (input.version ?? '0.1.0').trim() || '0.1.0';
  const status: ProjectStatus =
    input.status && VALID_STATUSES.has(input.status) ? input.status : 'ACTIVE';
  const dependencies = Array.isArray(input.dependencies)
    ? input.dependencies.map((d) => d.trim()).filter(Boolean)
    : [];
  const notes = (input.notes ?? '').trim();

  if (!name) {
    throw new Error('Project name is required');
  }
  if (!projectType) {
    throw new Error('Project type is required');
  }
  if (!rootPath) {
    throw new Error('Project root path is required');
  }

  const id = `PRJ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO projects (
      id, name, project_type, root_path, version, status,
      dependencies_json, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, name, projectType, rootPath, version, status, JSON.stringify(dependencies), notes, now, now);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'PROJECT',
    action: 'REGISTER_PROJECT',
    target: `${id} (${name})`,
    outcome: 'PASS',
    details: { projectType, rootPath, version, status, dependenciesCount: dependencies.length },
  });

  const detail = getProjectDetail(db, id);
  if (!detail) {
    throw new Error('Created project could not be reloaded');
  }
  return detail;
}

export interface UpdateProjectInput {
  name?: string;
  projectType?: string;
  rootPath?: string;
  version?: string;
  status?: ProjectStatus;
  dependencies?: string[];
  notes?: string;
}

export function updateProject(
  db: DatabaseSync,
  projectId: string,
  updates: UpdateProjectInput,
): ProjectDetail | null {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined;
  if (!existing) {
    return null;
  }

  const nextName = updates.name !== undefined ? updates.name.trim() : existing.name;
  const nextType = updates.projectType !== undefined ? updates.projectType.trim() : existing.project_type;
  const nextRootPath = updates.rootPath !== undefined ? updates.rootPath.trim() : existing.root_path;
  const nextVersion = updates.version !== undefined ? updates.version.trim() : existing.version;
  const nextStatus =
    updates.status !== undefined && VALID_STATUSES.has(updates.status)
      ? updates.status
      : existing.status;
  const nextDeps =
    updates.dependencies !== undefined
      ? JSON.stringify(updates.dependencies.map((d) => d.trim()).filter(Boolean))
      : existing.dependencies_json;
  const nextNotes = updates.notes !== undefined ? updates.notes.trim() : existing.notes;

  if (!nextName || !nextType || !nextRootPath || !nextVersion) {
    throw new Error('Name, project type, root path, and version cannot be empty');
  }

  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE projects
    SET name = ?, project_type = ?, root_path = ?, version = ?, status = ?,
        dependencies_json = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(nextName, nextType, nextRootPath, nextVersion, nextStatus, nextDeps, nextNotes, now, projectId);

  const action =
    updates.status === 'STOPPED' && existing.status !== 'STOPPED'
      ? 'STOP_PROJECT'
      : updates.version && updates.version !== existing.version
        ? 'UPDATE_PROJECT_VERSION'
        : 'UPDATE_PROJECT';

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'PROJECT',
    action,
    target: `${projectId} (${nextName})`,
    outcome: 'PASS',
    details: {
      previousStatus: existing.status,
      newStatus: nextStatus,
      previousVersion: existing.version,
      newVersion: nextVersion,
    },
  });

  return getProjectDetail(db, projectId);
}

export function linkResourceToProject(
  db: DatabaseSync,
  projectId: string,
  resourceId: string,
  role = 'DEPENDENCY',
): ProjectDetail {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const resource = db.prepare('SELECT id, name FROM resources WHERE id = ?').get(resourceId) as
    | { id: string; name: string }
    | undefined;
  if (!resource) {
    throw new Error(`Independent resource not found: ${resourceId}`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO project_resources (project_id, resource_id, role, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, resource_id) DO UPDATE SET role = excluded.role
  `,
  ).run(projectId, resourceId, role.trim() || 'DEPENDENCY', now);

  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'PROJECT',
    action: 'LINK_SHARED_RESOURCE',
    target: `${projectId} <- ${resourceId}`,
    outcome: 'PASS',
    details: { projectName: project.name, resourceName: resource.name, role },
  });

  const detail = getProjectDetail(db, projectId);
  if (!detail) throw new Error('Project reload failed');
  return detail;
}

export function unlinkResourceFromProject(
  db: DatabaseSync,
  projectId: string,
  resourceId: string,
): ProjectDetail {
  const result = db
    .prepare('DELETE FROM project_resources WHERE project_id = ? AND resource_id = ?')
    .run(projectId, resourceId);

  if (result.changes === 0) {
    throw new Error('Resource link not found on this project');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'PROJECT',
    action: 'UNLINK_SHARED_RESOURCE_PRESERVED',
    target: `${projectId} -/- ${resourceId}`,
    outcome: 'PASS',
    details: { resourcePreservedInLibrary: true },
  });

  const detail = getProjectDetail(db, projectId);
  if (!detail) throw new Error('Project reload failed');
  return detail;
}

export function listAvailableIndependentResources(db: DatabaseSync) {
  return db
    .prepare(
      `
      SELECT
        r.id,
        r.library_section AS librarySection,
        r.name,
        r.resource_type AS resourceType,
        r.version,
        r.sha256,
        r.verification_status AS verificationStatus,
        (SELECT COUNT(*) FROM project_resources pr WHERE pr.resource_id = r.id) AS linkedProjectCount
      FROM resources r
      ORDER BY r.imported_at DESC
    `,
    )
    .all() as Array<{
    id: string;
    librarySection: string;
    name: string;
    resourceType: string;
    version: string;
    sha256: string;
    verificationStatus: string;
    linkedProjectCount: number;
  }>;
}

export function exportProjectReport(db: DatabaseSync, projectId: string): {
  fileName: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  markdown: string;
  generatedAt: string;
} {
  const detail = getProjectDetail(db, projectId);
  if (!detail) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const generatedAt = new Date().toISOString();
  const config = getConfigMap(db);
  const exportsDir = path.join(config.data_dir, 'exports', 'projects');
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  const fileName = `${detail.id}_v${detail.version.replace(/[^a-zA-Z0-9._-]/g, '_')}_report.md`;
  const filePath = path.join(exportsDir, fileName);

  const lines: string[] = [
    `# NG-ILMF Project Engineering Report — ${detail.name}`,
    ``,
    `- **Project ID:** \`${detail.id}\``,
    `- **Type:** \`${detail.projectType}\``,
    `- **Status:** \`${detail.status}\``,
    `- **Version:** \`${detail.version}\``,
    `- **Root Path:** \`${detail.rootPath}\``,
    `- **Created At:** \`${detail.createdAt}\``,
    `- **Updated At:** \`${detail.updatedAt}\``,
    `- **Report Generated At:** \`${generatedAt}\``,
    ``,
    `## Dependencies`,
    ...(detail.dependencies.length > 0
      ? detail.dependencies.map((d) => `- \`${d}\``)
      : [`- None recorded`]),
    ``,
    `## Linked Independent Shared Resources (${detail.linkedResources.length})`,
    ...(detail.linkedResources.length > 0
      ? detail.linkedResources.map(
          (r) =>
            `- **${r.name}** (\`${r.id}\`) · Section: \`${r.librarySection}\` · Version: \`${r.version}\` · SHA-256: \`${r.sha256}\` · Shared Across ${r.sharedProjectCount} project(s)`,
        )
      : [`- No independent library resources linked yet`]),
    ``,
    `## Host Root Path Inspection`,
    `- **Exists on Host:** \`${detail.rootPathInspection.exists}\``,
    `- **Readable:** \`${detail.rootPathInspection.readable}\``,
    ...(detail.rootPathInspection.error
      ? [`- **Probe Note:** ${detail.rootPathInspection.error}`]
      : []),
    ...(detail.rootPathInspection.files.length > 0
      ? detail.rootPathInspection.files.map(
          (f) => `- [${f.kind}] \`${f.name}\` (${f.sizeBytes} bytes)`,
        )
      : [`- No files scanned at root path`]),
    ``,
    `## Notes`,
    detail.notes || 'No engineering notes recorded.',
    ``,
  ];

  const markdown = lines.join('\n');
  fs.writeFileSync(filePath, markdown, 'utf-8');

  // Verify written file existence & compute real SHA-256
  const writtenBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(writtenBuffer).digest('hex');

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'EXPORT',
    action: 'EXPORT_PROJECT_REPORT',
    target: filePath,
    outcome: 'PASS',
    details: { projectId: detail.id, version: detail.version, sha256, sizeBytes: writtenBuffer.length },
  });

  return {
    fileName,
    filePath,
    sha256,
    sizeBytes: writtenBuffer.length,
    markdown,
    generatedAt,
  };
}
