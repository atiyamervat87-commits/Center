import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { probeDeviceEnvironment } from '../storage/storageProbe.ts';
import { normalizeArchiveRootPath } from '../storage/storageProvider.ts';
import { writeFileAtomic } from '../utils/fsAtomic.ts';
import { extractAndVerifyZipArchive } from '../utils/zipBuilder.ts';
import {
  loadTokenizerFile,
  tokenizeDatasetLines,
  trainTokenizerFromCorpus,
} from '../ml/tokenizerEngine.ts';

export type LibrarySection = 'MODEL' | 'DATASET' | 'SOFTWARE' | 'KNOWLEDGE';
export type VerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'QUARANTINED';
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
  verificationStatus: VerificationStatus;
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

const VALID_SECTIONS = new Set<LibrarySection>(['MODEL', 'DATASET', 'SOFTWARE', 'KNOWLEDGE']);
const VALID_CATEGORIES = new Set<ArchiveCategoryFolder>([
  'INVENTORY',
  'LIBRARIES',
  'AI_MODELS',
  'DATASETS',
  'CHECKPOINTS',
  'BUILD_TOOLS',
  'CONFIGURATIONS',
  'RESTORE_PACKAGES',
  'MANIFESTS',
]);

function computeFileSha256(filePath: string): { exists: boolean; sizeBytes: number; sha256: string } {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, sizeBytes: 0, sha256: '' };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { exists: false, sizeBytes: 0, sha256: '' };
  }
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { exists: true, sizeBytes: buf.length, sha256 };
}

async function computeFileSha256Async(
  filePath: string,
): Promise<{ exists: boolean; sizeBytes: number; sha256: string }> {
  if (!filePath) {
    return { exists: false, sizeBytes: 0, sha256: '' };
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return { exists: false, sizeBytes: 0, sha256: '' };
    }
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
    return { exists: true, sizeBytes: stat.size, sha256 };
  } catch {
    return { exists: false, sizeBytes: 0, sha256: '' };
  }
}

export function listResources(
  db: DatabaseSync,
  filters: { section?: string; search?: string } = {},
): ResourceRecord[] {
  const clauses: string[] = [];
  const params: string[] = [];

  if (
    filters.section &&
    filters.section !== 'ALL' &&
    VALID_SECTIONS.has(filters.section as LibrarySection)
  ) {
    clauses.push('r.library_section = ?');
    params.push(filters.section);
  }
  if (filters.search && filters.search.trim()) {
    const q = `%${filters.search.trim()}%`;
    clauses.push('(r.name LIKE ? OR r.resource_type LIKE ? OR r.sha256 LIKE ? OR r.license LIKE ?)');
    params.push(q, q, q, q);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
      SELECT r.*, COUNT(pr.project_id) AS linked_count
      FROM resources r
      LEFT JOIN project_resources pr ON pr.resource_id = r.id
      ${whereSql}
      GROUP BY r.id
      ORDER BY r.imported_at DESC
    `,
    )
    .all(...params) as unknown as Array<{
    id: string;
    library_section: LibrarySection;
    name: string;
    resource_type: string;
    origin_source: string;
    license: string;
    file_path: string;
    size_bytes: number;
    version: string;
    sha256: string;
    verification_status: VerificationStatus;
    dependencies_json: string;
    transferable: number;
    linked_count: number;
    imported_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => {
    let dependencies: string[] = [];
    try {
      const parsed = JSON.parse(r.dependencies_json) as unknown;
      if (Array.isArray(parsed)) {
        dependencies = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      dependencies = [];
    }
    return {
      id: r.id,
      librarySection: r.library_section,
      name: r.name,
      resourceType: r.resource_type,
      originSource: r.origin_source,
      license: r.license,
      filePath: r.file_path,
      sizeBytes: Number(r.size_bytes ?? 0),
      version: r.version,
      sha256: r.sha256,
      verificationStatus: r.verification_status,
      dependencies,
      transferable: r.transferable === 1,
      linkedProjectCount: Number(r.linked_count ?? 0),
      importedAt: r.imported_at,
      updatedAt: r.updated_at,
    };
  });
}

export function registerResource(
  db: DatabaseSync,
  input: {
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
    dependencies?: string[];
    transferable?: boolean;
  },
): { resource: ResourceRecord; deduplicated: boolean } {
  if (!VALID_SECTIONS.has(input.librarySection)) {
    throw new Error(`Invalid librarySection: ${input.librarySection}`);
  }
  const name = input.name.trim();
  const resourceType = input.resourceType.trim();
  const originSource = input.originSource.trim();
  const license = input.license.trim();
  if (!name || !resourceType || !originSource || !license) {
    throw new Error('name, resourceType, originSource, and license are required');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  let resolvedPath = (input.filePath ?? '').trim();
  let sha256 = '';
  let sizeBytes = 0;
  let verificationStatus: VerificationStatus = 'UNVERIFIED';

  if (resolvedPath) {
    const fileProbe = computeFileSha256(resolvedPath);
    if (fileProbe.exists) {
      sha256 = fileProbe.sha256;
      sizeBytes = fileProbe.sizeBytes;
      verificationStatus = 'VERIFIED';
    } else if (
      (input.contentText && input.contentText.trim().length > 0) ||
      (input.contentBase64 && input.contentBase64.trim().length > 0)
    ) {
      throw new Error(`Provided filePath does not exist: ${resolvedPath}`);
    } else {
      throw new Error(`File not found on filesystem: ${resolvedPath}`);
    }
  } else if (input.contentBase64 && input.contentBase64.trim().length > 0) {
    const libDir = path.join(dataDir, 'library', input.librarySection.toLowerCase());
    fs.mkdirSync(libDir, { recursive: true });
    const ext = input.originalFileName ? path.extname(input.originalFileName).replace(/[^a-zA-Z0-9.]/g, '') : '.bin';
    const safeSlug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 48) || 'artifact';
    const fileName = `${safeSlug}_${Date.now()}${ext || '.bin'}`;
    resolvedPath = path.join(libDir, fileName);
    const buf = Buffer.from(input.contentBase64.trim(), 'base64');
    if (buf.length === 0) {
      throw new Error('Uploaded base64 file content is empty');
    }
    fs.writeFileSync(resolvedPath, buf);
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
    verificationStatus = 'VERIFIED';
  } else if (input.contentText && input.contentText.trim().length > 0) {
    // Store submitted artifact cleanly under managed data_dir/library/<section>/
    const libDir = path.join(dataDir, 'library', input.librarySection.toLowerCase());
    fs.mkdirSync(libDir, { recursive: true });
    const ext = input.originalFileName ? path.extname(input.originalFileName).replace(/[^a-zA-Z0-9.]/g, '') : '.dat';
    const safeSlug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 48) || 'artifact';
    const fileName = `${safeSlug}_${Date.now()}${ext || '.dat'}`;
    resolvedPath = path.join(libDir, fileName);
    const buf = Buffer.from(input.contentText, 'utf-8');
    fs.writeFileSync(resolvedPath, buf);
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
    verificationStatus = 'VERIFIED';
  } else {
    throw new Error('Either an existing filePath, contentBase64, or contentText payload must be provided');
  }

  // SHA-256 deduplication check
  const existing = db
    .prepare('SELECT id FROM resources WHERE sha256 = ?')
    .get(sha256) as { id: string } | undefined;

  if (existing) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'DATA_FACTORY',
      action: 'RESOURCE_SHA256_DEDUPLICATED',
      target: existing.id,
      outcome: 'INFO',
      details: { sha256, attemptedName: name },
    });
    const found = listResources(db).find((item) => item.id === existing.id);
    if (!found) throw new Error('Deduplicated resource lookup failed');
    return { resource: found, deduplicated: true };
  }

  const id = `RES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const version = (input.version ?? '1.0.0').trim() || '1.0.0';
  const deps = Array.isArray(input.dependencies)
    ? input.dependencies.map((d) => d.trim()).filter(Boolean)
    : [];

  db.prepare(
    `
    INSERT INTO resources (
      id, library_section, name, resource_type, origin_source, license,
      file_path, size_bytes, version, sha256, verification_status,
      dependencies_json, transferable, imported_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.librarySection,
    name,
    resourceType,
    originSource,
    license,
    resolvedPath,
    sizeBytes,
    version,
    sha256,
    verificationStatus,
    JSON.stringify(deps),
    input.transferable === false ? 0 : 1,
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'DATA_FACTORY',
    action: 'REGISTER_INDEPENDENT_RESOURCE',
    target: `${id} (${name})`,
    outcome: 'PASS',
    details: { librarySection: input.librarySection, sha256, sizeBytes, license },
  });

  const created = listResources(db).find((item) => item.id === id);
  if (!created) throw new Error('Created resource reload failed');
  return { resource: created, deduplicated: false };
}

export function verifyResourceIntegrity(db: DatabaseSync, resourceId: string): ResourceRecord {
  const row = db
    .prepare('SELECT id, file_path, sha256 FROM resources WHERE id = ?')
    .get(resourceId) as { id: string; file_path: string; sha256: string } | undefined;

  if (!row) {
    throw new Error(`Resource not found: ${resourceId}`);
  }

  const probe = computeFileSha256(row.file_path);
  let nextStatus: VerificationStatus = 'FAILED';
  if (!probe.exists) {
    nextStatus = 'UNVERIFIED';
  } else if (probe.sha256 === row.sha256) {
    nextStatus = 'VERIFIED';
  } else {
    nextStatus = 'QUARANTINED';
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE resources SET verification_status = ?, updated_at = ? WHERE id = ?').run(
    nextStatus,
    now,
    resourceId,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'DATA_FACTORY',
    action: 'VERIFY_RESOURCE_SHA256',
    target: resourceId,
    outcome: nextStatus === 'VERIFIED' ? 'PASS' : 'FAIL',
    details: { expectedSha256: row.sha256, actualSha256: probe.sha256, nextStatus },
  });

  const updated = listResources(db).find((item) => item.id === resourceId);
  if (!updated) throw new Error('Resource reload failed');
  return updated;
}

export function deleteResourceSafely(db: DatabaseSync, resourceId: string): { deletedId: string } {
  const existing = db
    .prepare('SELECT id, name FROM resources WHERE id = ?')
    .get(resourceId) as { id: string; name: string } | undefined;

  if (!existing) {
    throw new Error(`Resource not found: ${resourceId}`);
  }

  const linkedProjects = db
    .prepare('SELECT COUNT(*) AS count FROM project_resources WHERE resource_id = ?')
    .get(resourceId) as { count: number };

  if (linkedProjects.count > 0) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'DATA_FACTORY',
      action: 'BLOCK_DELETE_SHARED_RESOURCE',
      target: resourceId,
      outcome: 'BLOCKED',
      details: { linkedProjectCount: linkedProjects.count },
    });
    throw new Error(
      `Blocked: Resource ${resourceId} is still linked to ${linkedProjects.count} project(s). Unlink first.`,
    );
  }

  const linkedTraining = db
    .prepare('SELECT COUNT(*) AS count FROM training_jobs WHERE model_id = ? OR dataset_id = ?')
    .get(resourceId, resourceId) as { count: number };

  if (linkedTraining.count > 0) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'DATA_FACTORY',
      action: 'BLOCK_DELETE_TRAINING_RESOURCE',
      target: resourceId,
      outcome: 'BLOCKED',
      details: { linkedTrainingJobs: linkedTraining.count },
    });
    throw new Error(
      `Blocked: Resource ${resourceId} is bound to ${linkedTraining.count} training job(s) and cannot be deleted.`,
    );
  }

  db.prepare('DELETE FROM resources WHERE id = ?').run(resourceId);
  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'DATA_FACTORY',
    action: 'DELETE_UNLINKED_RESOURCE',
    target: `${resourceId} (${existing.name})`,
    outcome: 'PASS',
  });

  return { deletedId: resourceId };
}

export function listArchiveEntries(db: DatabaseSync): ArchiveEntryRecord[] {
  const rows = db
    .prepare('SELECT * FROM archive_entries ORDER BY archived_at DESC')
    .all() as unknown as Array<{
    id: string;
    resource_id: string | null;
    category_folder: ArchiveCategoryFolder;
    archive_path: string;
    source_path: string;
    sha256: string;
    size_bytes: number;
    verify_status: 'VERIFIED' | 'MISSING' | 'MISMATCH' | 'PENDING';
    last_verified_at: string | null;
    archived_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    resourceId: r.resource_id,
    categoryFolder: r.category_folder,
    archivePath: r.archive_path,
    sourcePath: r.source_path,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes ?? 0),
    verifyStatus: r.verify_status,
    lastVerifiedAt: r.last_verified_at,
    archivedAt: r.archived_at,
  }));
}

function getVerifiedArchiveRoot(db: DatabaseSync): string {
  const config = getConfigMap(db);
  const env = probeDeviceEnvironment(config);
  const selectedId = env.selectedArchiveProvider;
  const ownerConfirmed = config.archive_location_confirmed === 'true';
  const lastReport = env.lastVerificationReport;

  const selectedProbe =
    selectedId === 'host_dev'
      ? env.hostEnvironment.provider
      : selectedId === 'termux'
        ? env.termuxEnvironment.provider
        : selectedId === 'android_saf'
          ? env.androidDeviceEnvironment.provider
          : env.externalSdStorage.provider;

  const isVerified =
    ownerConfirmed &&
    Boolean(lastReport) &&
    lastReport?.providerId === selectedId &&
    lastReport?.storageReady === true &&
    lastReport?.contentMatched === true &&
    selectedProbe.state === 'AVAILABLE';

  if (!isVerified) {
    throw new Error(
      `Archive storage is NOT READY (provider=${selectedId}, state=${selectedProbe.state}, confirmed=${ownerConfirmed}). Approve and verify archive storage first.`,
    );
  }

  if (selectedId === 'android_saf') {
    throw new Error(
      'Selected provider is android_saf (content:// URI); filesystem archiving must run through Android SAF wrapper.',
    );
  }

  return normalizeArchiveRootPath(selectedProbe.configuredPath);
}

export function archiveResourceToSmartArchive(
  db: DatabaseSync,
  input: { resourceId: string; categoryFolder: ArchiveCategoryFolder },
): ArchiveEntryRecord {
  if (!VALID_CATEGORIES.has(input.categoryFolder)) {
    throw new Error(`Invalid category folder: ${input.categoryFolder}`);
  }

  const archiveRoot = getVerifiedArchiveRoot(db);
  const resource = listResources(db).find((r) => r.id === input.resourceId);
  if (!resource) {
    throw new Error(`Resource not found: ${input.resourceId}`);
  }

  const sourceProbe = computeFileSha256(resource.filePath);
  if (!sourceProbe.exists || sourceProbe.sha256 !== resource.sha256) {
    throw new Error('Source resource file missing or fails SHA-256 check prior to archiving');
  }

  const folderPath = path.join(archiveRoot, input.categoryFolder);
  fs.mkdirSync(folderPath, { recursive: true });
  const destPath = path.join(folderPath, `${resource.id}_${path.basename(resource.filePath)}`);
  writeFileAtomic(destPath, fs.readFileSync(resource.filePath));

  const destProbe = computeFileSha256(destPath);
  if (!destProbe.exists || destProbe.sha256 !== resource.sha256) {
    throw new Error('Archive copy SHA-256 verification failed');
  }

  const id = `ARC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO archive_entries (
      id, resource_id, category_folder, archive_path, source_path,
      sha256, size_bytes, verify_status, last_verified_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)
    ON CONFLICT(archive_path) DO UPDATE SET
      sha256 = excluded.sha256,
      size_bytes = excluded.size_bytes,
      verify_status = 'VERIFIED',
      last_verified_at = excluded.last_verified_at
  `,
  ).run(
    id,
    resource.id,
    input.categoryFolder,
    destPath,
    resource.filePath,
    destProbe.sha256,
    destProbe.sizeBytes,
    now,
    now,
  );

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'ARCHIVE',
    action: 'ARCHIVE_RESOURCE_VERIFIED',
    target: destPath,
    outcome: 'PASS',
    details: { resourceId: resource.id, categoryFolder: input.categoryFolder, sha256: destProbe.sha256 },
  });

  const saved = listArchiveEntries(db).find((e) => e.archivePath === destPath);
  if (!saved) throw new Error('Archive entry reload failed');
  return saved;
}

export function generateDataFactoryManifest(db: DatabaseSync): {
  filePath: string;
  sha256: string;
  resourceCount: number;
  archiveCount: number;
  markdown: string;
} {
  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const exportsDir = path.join(dataDir, 'exports', 'manifests');
  fs.mkdirSync(exportsDir, { recursive: true });

  const resources = listResources(db);
  const archives = listArchiveEntries(db);
  const generatedAt = new Date().toISOString();

  const lines = [
    `# NG-ILMF DATA FACTORY — Verified Inventory Manifest`,
    `- Generated At: \`${generatedAt}\``,
    `- Total Registered Resources: \`${resources.length}\``,
    `- Total Smart Archive Entries: \`${archives.length}\``,
    ``,
    `## Independent Resources`,
    ...(resources.length > 0
      ? resources.map(
          (r) =>
            `- \`${r.id}\` | ${r.librarySection} | **${r.name}** v${r.version} | License: \`${r.license}\` | Status: \`${r.verificationStatus}\` | SHA-256: \`${r.sha256}\``,
        )
      : [`- No resources registered yet.`]),
    ``,
    `## Smart Archive Entries`,
    ...(archives.length > 0
      ? archives.map(
          (a) =>
            `- \`${a.id}\` | ${a.categoryFolder} | \`${a.archivePath}\` | Status: \`${a.verifyStatus}\` | SHA-256: \`${a.sha256}\``,
        )
      : [`- No archive entries recorded yet.`]),
    ``,
  ];

  const markdown = lines.join('\n');
  const filePath = path.join(exportsDir, `data_factory_manifest_${Date.now()}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  const sha256 = crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex');

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'DATA_FACTORY',
    action: 'GENERATE_INVENTORY_MANIFEST',
    target: filePath,
    outcome: 'PASS',
    details: { sha256, resourceCount: resources.length, archiveCount: archives.length },
  });

  return {
    filePath,
    sha256,
    resourceCount: resources.length,
    archiveCount: archives.length,
    markdown,
  };
}

function decodeHtmlAndXmlEntities(text: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => named[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ' ';
    });
}

/**
 * Full RFC-4180 CSV parser supporting quoted fields, escaped "" double quotes,
 * embedded commas, and embedded multiline cells.
 */
function parseRfc4180Csv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (csvText[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

function extractTextFromDocxBuffer(buf: Buffer): string[] {
  const extracted = extractAndVerifyZipArchive(buf);
  if (!extracted.validStructure) {
    throw new Error(`Invalid DOCX ZIP archive: ${extracted.error || 'malformed package'}`);
  }
  const docEntry = extracted.entries.get('word/document.xml');
  if (!docEntry) {
    throw new Error('DOCX archive missing word/document.xml');
  }
  const xml = docEntry.content.toString('utf-8');
  // Split paragraphs <w:p ...>...</w:p> and join <w:t> runs cleanly
  const paragraphs = xml.split(/<\/w:p>/i);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const tMatches = para.match(/<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/gi) ?? [];
    if (tMatches.length > 0) {
      const joined = tMatches
        .map((m) => decodeHtmlAndXmlEntities(m.replace(/<\/?w:t(?:\s+[^>]*)?>/gi, '')))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (joined) lines.push(joined);
    }
  }
  return lines;
}

function extractTextLinesFromBuffer(
  fileBuf: Buffer,
  fileExt: string,
  stripHtml: boolean,
): string[] {
  const ext = fileExt.toLowerCase();
  if (ext === '.pdf' || (fileBuf.length >= 5 && fileBuf.subarray(0, 5).toString('ascii') === '%PDF-')) {
    throw new Error(
      'Native PDF binary parser (pdftotext/poppler) is not installed on this host. Convert PDF to .docx, .txt, or .jsonl prior to ingestion.',
    );
  }

  let segments: string[] = [];

  if (ext === '.docx') {
    segments = extractTextFromDocxBuffer(fileBuf);
  } else {
    const rawText = fileBuf.toString('utf-8');
    if (ext === '.jsonl' || ext === '.ndjson') {
      for (const line of rawText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof obj === 'string') {
            segments.push(obj);
          } else if (obj && typeof obj === 'object') {
            const textParts = ['text', 'prompt', 'instruction', 'input', 'question', 'answer', 'output', 'content', 'body']
              .map((k) => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : ''))
              .filter(Boolean);
            segments.push(textParts.length > 0 ? textParts.join(' | ') : JSON.stringify(obj));
          }
        } catch {
          segments.push(trimmed);
        }
      }
    } else if (ext === '.json') {
      try {
        const parsed = JSON.parse(rawText) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string') segments.push(item);
            else if (item && typeof item === 'object') {
              const rec = item as Record<string, unknown>;
              const joined = Object.values(rec)
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
                .join(' | ');
              if (joined) segments.push(joined);
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          const vals = Object.values(parsed as Record<string, unknown>)
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
          segments.push(...vals);
        }
      } catch {
        segments.push(...rawText.split(/\r?\n/));
      }
    } else if (ext === '.csv') {
      const parsedRows = parseRfc4180Csv(rawText);
      for (const cols of parsedRows) {
        const cleaned = cols.filter((c) => c.length > 0).join(' | ');
        if (cleaned) segments.push(cleaned);
      }
    } else {
      segments.push(...rawText.split(/\r?\n/));
    }
  }

  return segments.map((line) => {
    let normalized = line.normalize('NFC');
    if (stripHtml || ext === '.html' || ext === '.htm') {
      normalized = normalized
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      normalized = decodeHtmlAndXmlEntities(normalized);
    }
    return normalized
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFC');
  });
}

export function processAndBuildDatasetPackage(
  db: DatabaseSync,
  input: {
    datasetName: string;
    license: string;
    originSource: string;
    version?: string;
    sourceResourceIds?: string[];
    rawFiles?: Array<{ fileName: string; contentText?: string; contentBase64?: string }>;
    stripHtml?: boolean;
    deduplicateLines?: boolean;
    minLineLength?: number;
    format?: 'JSONL' | 'TXT';
    tokenizerPath?: string;
    splitSeed?: string;
  },
): {
  resource: ResourceRecord;
  packageDir: string;
  dataFilePath: string;
  dataFileSha256: string;
  manifestPath: string;
  manifestSha256: string;
  splits: {
    trainPath: string;
    valPath: string;
    testPath: string;
    trainCount: number;
    valCount: number;
    testCount: number;
  };
  tokenStats: {
    totalLines: number;
    totalTokens: number;
    avgTokensPerLine: number;
    unkTokens: number;
    unkRate: number;
  };
  qualityGate: {
    readyForTraining: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  };
  stats: {
    inputSourcesCount: number;
    rawLinesCount: number;
    cleanedLinesCount: number;
    droppedShortOrEmpty: number;
    deduplicatedCount: number;
    outputBytes: number;
  };
} {
  const datasetName = input.datasetName.trim();
  const license = input.license.trim();
  const originSource = input.originSource.trim() || 'DATA_FACTORY_PIPELINE';
  if (!datasetName || !license) {
    throw new Error('datasetName and license are required');
  }

  const minLen = Math.max(1, Number(input.minLineLength ?? 4));
  const stripHtml = input.stripHtml !== false;
  const dedupLines = input.deduplicateLines !== false;
  const format = input.format === 'TXT' ? 'TXT' : 'JSONL';
  const version = (input.version ?? '1.0.0').trim() || '1.0.0';

  const sourceIds = Array.isArray(input.sourceResourceIds)
    ? input.sourceResourceIds.map((s) => s.trim()).filter(Boolean)
    : [];
  const rawFiles = Array.isArray(input.rawFiles) ? input.rawFiles : [];
  if (sourceIds.length === 0 && rawFiles.length === 0) {
    throw new Error('Provide at least one sourceResourceId or uploaded rawFile for extraction and cleaning');
  }

  const rawExtracted: string[] = [];
  const provenanceSources: Array<{ kind: string; ref: string; sha256: string }> = [];

  for (const resId of sourceIds) {
    const res = listResources(db).find((r) => r.id === resId);
    if (!res) throw new Error(`Source resource not found: ${resId}`);
    if (!fs.existsSync(res.filePath)) {
      throw new Error(`Source resource file missing on disk: ${res.filePath}`);
    }
    const rawBuf = fs.readFileSync(res.filePath);
    const actualSha = crypto.createHash('sha256').update(rawBuf).digest('hex');
    if (actualSha !== res.sha256) {
      throw new Error(`Source resource ${resId} failed SHA-256 check prior to extraction`);
    }
    provenanceSources.push({ kind: 'LIBRARY_RESOURCE', ref: res.id, sha256: actualSha });
    rawExtracted.push(
      ...extractTextLinesFromBuffer(rawBuf, path.extname(res.filePath), stripHtml),
    );
  }

  for (const file of rawFiles) {
    const fileBuf = file.contentBase64?.trim()
      ? Buffer.from(file.contentBase64.trim(), 'base64')
      : Buffer.from(file.contentText ?? '', 'utf-8');
    if (fileBuf.length === 0) continue;
    const sha = crypto.createHash('sha256').update(fileBuf).digest('hex');
    provenanceSources.push({ kind: 'UPLOADED_FILE', ref: file.fileName, sha256: sha });
    rawExtracted.push(
      ...extractTextLinesFromBuffer(fileBuf, path.extname(file.fileName), stripHtml),
    );
  }

  let droppedShortOrEmpty = 0;
  let deduplicatedCount = 0;
  const seen = new Set<string>();
  const cleanedLines: string[] = [];

  for (const line of rawExtracted) {
    if (!line || line.length < minLen) {
      droppedShortOrEmpty += 1;
      continue;
    }
    if (dedupLines) {
      if (seen.has(line)) {
        deduplicatedCount += 1;
        continue;
      }
      seen.add(line);
    }
    cleanedLines.push(line);
  }

  if (cleanedLines.length === 0) {
    throw new Error('No clean text lines remained after extraction and filtering');
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const safeSlug = datasetName.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 40) || 'dataset';
  const packageDir = path.join(dataDir, 'datasets', `${safeSlug}_v${version}_${Date.now()}`);
  fs.mkdirSync(packageDir, { recursive: true });

  const ext = format === 'TXT' ? '.txt' : '.jsonl';
  const dataFilePath = path.join(packageDir, `${safeSlug}_cleaned${ext}`);
  const outputBody =
    format === 'TXT'
      ? cleanedLines.join('\n') + '\n'
      : cleanedLines
          .map((text, idx) => JSON.stringify({ id: idx + 1, text }))
          .join('\n') + '\n';

  const outputBuf = Buffer.from(outputBody, 'utf-8');
  writeFileAtomic(dataFilePath, outputBuf);
  const dataFileSha256 = crypto.createHash('sha256').update(outputBuf).digest('hex');

  // Deterministic reproducible Train / Validation / Test split (80/10/10 by SHA-256 keyed order)
  const splitSeed = input.splitSeed || `${datasetName}:${version}`;
  const keyed = cleanedLines.map((line, index) => ({
    line,
    sortKey: crypto.createHash('sha256').update(`${splitSeed}:${index}:${line}`).digest('hex'),
  }));
  keyed.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const trainLines: string[] = [];
  const valLines: string[] = [];
  const testLines: string[] = [];

  if (keyed.length < 3) {
    trainLines.push(...keyed.map((k) => k.line));
  } else {
    const valCountTarget = Math.max(1, Math.floor(keyed.length * 0.1));
    const testCountTarget = Math.max(1, Math.floor(keyed.length * 0.1));
    const trainCountTarget = Math.max(1, keyed.length - valCountTarget - testCountTarget);
    for (let i = 0; i < keyed.length; i++) {
      if (i < trainCountTarget) trainLines.push(keyed[i].line);
      else if (i < trainCountTarget + valCountTarget) valLines.push(keyed[i].line);
      else testLines.push(keyed[i].line);
    }
  }

  const splitsDir = path.join(packageDir, 'splits');
  fs.mkdirSync(splitsDir, { recursive: true });
  const serializeJsonl = (arr: string[]) =>
    arr.map((text, idx) => JSON.stringify({ id: idx + 1, text })).join('\n') + (arr.length ? '\n' : '');

  const trainPath = path.join(splitsDir, 'train.jsonl');
  const valPath = path.join(splitsDir, 'val.jsonl');
  const testPath = path.join(splitsDir, 'test.jsonl');
  writeFileAtomic(trainPath, serializeJsonl(trainLines), 'utf-8');
  writeFileAtomic(valPath, serializeJsonl(valLines), 'utf-8');
  writeFileAtomic(testPath, serializeJsonl(testLines), 'utf-8');

  // Tokenize cleaned corpus for quality gate metrics
  const tokenizer =
    input.tokenizerPath && fs.existsSync(input.tokenizerPath)
      ? loadTokenizerFile(input.tokenizerPath)
      : trainTokenizerFromCorpus(cleanedLines, { spec: 'DATASET-AUDIT-BPE-V1', targetMerges: 48 });
  const tokenStats = tokenizeDatasetLines(tokenizer, cleanedLines);

  const disallowedLicenses = new Set(['', 'UNKNOWN', 'NONE', 'UNLICENSED', 'N/A']);
  const qualityChecks = [
    {
      name: 'NON_EMPTY_CLEAN_SAMPLES',
      passed: cleanedLines.length >= 1,
      detail: `${cleanedLines.length} cleaned lines retained`,
    },
    {
      name: 'LICENSE_DECLARED',
      passed: !disallowedLicenses.has(license.toUpperCase()),
      detail: `License: ${license}`,
    },
    {
      name: 'TOKENIZATION_UNK_RATE_ACCEPTABLE',
      passed: tokenStats.unkRate <= 0.05 && tokenStats.totalTokens > 0,
      detail: `Total tokens=${tokenStats.totalTokens}, UNK rate=${tokenStats.unkRate}`,
    },
    {
      name: 'SPLITS_MATERIALIZED',
      passed: fs.existsSync(trainPath) && trainLines.length >= 1,
      detail: `train=${trainLines.length}, val=${valLines.length}, test=${testLines.length}`,
    },
  ];
  const readyForTraining = qualityChecks.every((c) => c.passed);

  const manifestObj = {
    factory: 'NG-ILMF DATA FACTORY',
    datasetName,
    version,
    license,
    originSource,
    format,
    dataFile: path.basename(dataFilePath),
    dataFileSha256,
    outputBytes: outputBuf.length,
    splits: {
      trainPath,
      valPath,
      testPath,
      trainCount: trainLines.length,
      valCount: valLines.length,
      testCount: testLines.length,
    },
    tokenStats,
    qualityGate: {
      readyForTraining,
      checks: qualityChecks,
    },
    stats: {
      inputSourcesCount: provenanceSources.length,
      rawLinesCount: rawExtracted.length,
      cleanedLinesCount: cleanedLines.length,
      droppedShortOrEmpty,
      deduplicatedCount,
      outputBytes: outputBuf.length,
    },
    provenanceSources,
    createdAt: new Date().toISOString(),
  };

  const manifestPath = path.join(packageDir, 'DATASET_MANIFEST.json');
  const manifestJson = JSON.stringify(manifestObj, null, 2);
  writeFileAtomic(manifestPath, manifestJson, 'utf-8');
  const manifestSha256 = crypto.createHash('sha256').update(manifestJson, 'utf-8').digest('hex');

  const registered = registerResource(db, {
    librarySection: 'DATASET',
    name: `${datasetName} (Cleaned Package)`,
    resourceType: `CLEANED_${format}`,
    originSource,
    license,
    filePath: dataFilePath,
    version,
    dependencies: sourceIds,
  });

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'DATA_FACTORY',
    action: 'BUILD_CLEANED_DATASET_PACKAGE',
    target: `${registered.resource.id} (${dataFilePath})`,
    outcome: readyForTraining ? 'PASS' : 'WARNING',
    details: {
      dataFileSha256,
      manifestSha256,
      cleanedLinesCount: cleanedLines.length,
      deduplicatedCount,
      totalTokens: tokenStats.totalTokens,
      readyForTraining,
    },
  });

  return {
    resource: registered.resource,
    packageDir,
    dataFilePath,
    dataFileSha256,
    manifestPath,
    manifestSha256,
    splits: manifestObj.splits,
    tokenStats,
    qualityGate: manifestObj.qualityGate,
    stats: manifestObj.stats,
  };
}

export function verifyArchiveIntegrityBatch(db: DatabaseSync): {
  totalChecked: number;
  verifiedCount: number;
  mismatchCount: number;
  missingCount: number;
  entries: ArchiveEntryRecord[];
} {
  const entries = listArchiveEntries(db);
  const now = new Date().toISOString();
  let verifiedCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  for (const entry of entries) {
    const probe = computeFileSha256(entry.archivePath);
    let nextStatus: ArchiveEntryRecord['verifyStatus'] = 'MISSING';
    if (!probe.exists) {
      missingCount += 1;
      nextStatus = 'MISSING';
    } else if (probe.sha256 === entry.sha256) {
      verifiedCount += 1;
      nextStatus = 'VERIFIED';
    } else {
      mismatchCount += 1;
      nextStatus = 'MISMATCH';
    }
    db.prepare(
      'UPDATE archive_entries SET verify_status = ?, last_verified_at = ? WHERE id = ?',
    ).run(nextStatus, now, entry.id);
  }

  const allPass = mismatchCount === 0 && missingCount === 0;
  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'ARCHIVE',
    action: 'VERIFY_ARCHIVE_INTEGRITY_BATCH',
    target: `${entries.length} archive entries`,
    outcome: allPass ? 'PASS' : 'FAIL',
    details: { verifiedCount, mismatchCount, missingCount },
  });

  return {
    totalChecked: entries.length,
    verifiedCount,
    mismatchCount,
    missingCount,
    entries: listArchiveEntries(db),
  };
}

export type ResourceLibraryHealthStatus = 'HEALTHY' | 'CORRUPTED';

export interface ResourceIntegrityItem {
  id: string;
  name: string;
  librarySection: LibrarySection;
  verificationStatus: VerificationStatus;
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

interface BackgroundIntegrityJobState {
  running: boolean;
  checkedCount: number;
  checkTotalCount: number;
  startedAt: string | null;
  lastCheckedAt: string | null;
  activePromise: Promise<ResourceLibraryIntegrityStatus> | null;
}

const backgroundIntegrityJobs = new WeakMap<DatabaseSync, BackgroundIntegrityJobState>();

function getOrCreateJobState(db: DatabaseSync): BackgroundIntegrityJobState {
  let state = backgroundIntegrityJobs.get(db);
  if (!state) {
    state = {
      running: false,
      checkedCount: 0,
      checkTotalCount: 0,
      startedAt: null,
      lastCheckedAt: null,
      activePromise: null,
    };
    backgroundIntegrityJobs.set(db, state);
  }
  return state;
}

export function getResourceLibraryIntegrityStatus(
  db: DatabaseSync,
): ResourceLibraryIntegrityStatus {
  const resources = listResources(db);
  const state = getOrCreateJobState(db);

  let verifiedCount = 0;
  let corruptedCount = 0;
  let unverifiedCount = 0;
  let totalBytes = 0;

  const items: ResourceIntegrityItem[] = resources.map((r) => {
    totalBytes += r.sizeBytes;
    if (r.verificationStatus === 'VERIFIED') {
      verifiedCount += 1;
    } else if (r.verificationStatus === 'UNVERIFIED') {
      unverifiedCount += 1;
      corruptedCount += 1;
    } else {
      corruptedCount += 1;
    }

    return {
      id: r.id,
      name: r.name,
      librarySection: r.librarySection,
      verificationStatus: r.verificationStatus,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes,
      filePath: r.filePath,
      updatedAt: r.updatedAt,
    };
  });

  const overallStatus: ResourceLibraryHealthStatus =
    corruptedCount > 0 ? 'CORRUPTED' : 'HEALTHY';

  return {
    overallStatus,
    totalResources: resources.length,
    verifiedCount,
    corruptedCount,
    unverifiedCount,
    totalBytes,
    running: state.running,
    checkedCount: state.checkedCount,
    checkTotalCount: state.checkTotalCount,
    startedAt: state.startedAt,
    lastCheckedAt: state.lastCheckedAt,
    resources: items,
  };
}

export function startBackgroundResourceIntegrityCheck(
  db: DatabaseSync,
  onComplete?: (status: ResourceLibraryIntegrityStatus) => void,
): { started: boolean; status: ResourceLibraryIntegrityStatus } {
  const state = getOrCreateJobState(db);
  if (state.running && state.activePromise) {
    return { started: false, status: getResourceLibraryIntegrityStatus(db) };
  }

  const rows = db
    .prepare('SELECT id, file_path, sha256 FROM resources ORDER BY imported_at DESC')
    .all() as unknown as Array<{ id: string; file_path: string; sha256: string }>;

  state.running = true;
  state.checkedCount = 0;
  state.checkTotalCount = rows.length;
  state.startedAt = new Date().toISOString();

  const runPromise = (async () => {
    try {
      for (const row of rows) {
        const probe = await computeFileSha256Async(row.file_path);
        let nextStatus: VerificationStatus = 'FAILED';
        if (!probe.exists) {
          nextStatus = 'UNVERIFIED';
        } else if (probe.sha256 === row.sha256) {
          nextStatus = 'VERIFIED';
        } else {
          nextStatus = 'QUARANTINED';
        }

        const now = new Date().toISOString();
        db.prepare('UPDATE resources SET verification_status = ?, updated_at = ? WHERE id = ?').run(
          nextStatus,
          now,
          row.id,
        );
        state.checkedCount += 1;
      }

      state.running = false;
      state.lastCheckedAt = new Date().toISOString();
      const finalStatus = getResourceLibraryIntegrityStatus(db);

      recordAuditEvent(db, {
        actor: 'OWNER',
        category: 'DATA_FACTORY',
        action: 'VERIFY_RESOURCE_LIBRARY_INTEGRITY_BATCH',
        target: `${finalStatus.totalResources} registered resources`,
        outcome: finalStatus.overallStatus === 'HEALTHY' ? 'PASS' : 'FAIL',
        details: {
          overallStatus: finalStatus.overallStatus,
          totalResources: finalStatus.totalResources,
          verifiedCount: finalStatus.verifiedCount,
          corruptedCount: finalStatus.corruptedCount,
          unverifiedCount: finalStatus.unverifiedCount,
        },
      });

      onComplete?.(finalStatus);
      return finalStatus;
    } finally {
      state.running = false;
      state.activePromise = null;
    }
  })();

  state.activePromise = runPromise;
  return { started: true, status: getResourceLibraryIntegrityStatus(db) };
}

export async function awaitBackgroundIntegrityCheck(
  db: DatabaseSync,
): Promise<ResourceLibraryIntegrityStatus> {
  const state = getOrCreateJobState(db);
  if (state.activePromise) {
    return await state.activePromise;
  }
  return getResourceLibraryIntegrityStatus(db);
}

