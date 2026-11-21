import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { buildZipArchive, extractAndVerifyZipArchive, type ZipInputFile } from '../utils/zipBuilder.ts';
import { resolveSafeRealPath, writeFileAtomic } from '../utils/fsAtomic.ts';
import { inspectBinaryWeightsBuffer } from '../ml/neuralMindEngine.ts';
import { REQUIRED_QC_SUITES_COUNT } from './repairRegistryService.ts';

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

export function listDeliveryPackages(db: DatabaseSync): DeliveryPackageRecord[] {
  const rows = db
    .prepare('SELECT * FROM delivery_packages ORDER BY created_at DESC')
    .all() as unknown as Array<{
    id: string;
    product_id: string;
    zip_path: string;
    manifest_sha256: string;
    package_sha256: string;
    size_bytes: number;
    verified: number;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    zipPath: r.zip_path,
    manifestSha256: r.manifest_sha256,
    packageSha256: r.package_sha256,
    sizeBytes: Number(r.size_bytes ?? 0),
    verified: r.verified === 1,
    createdAt: r.created_at,
  }));
}

const DISALLOWED_IP_LICENSES = new Set(['', 'UNKNOWN', 'NONE', 'UNLICENSED', 'N/A']);

function resolveWorkspaceArtifact(candidate: unknown, dataDir: string): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const check = resolveSafeRealPath(candidate.trim(), dataDir);
  if (!check.allowed) return null;
  if (!fs.existsSync(check.canonicalTarget) || !fs.statSync(check.canonicalTarget).isFile()) {
    return null;
  }
  return check.canonicalTarget;
}

export function buildCertifiedDeliveryPackage(
  db: DatabaseSync,
  productId: string,
  options: { ipHolder?: string; licenseTermsNote?: string } = {},
): DeliveryPackageRecord {
  const product = db
    .prepare('SELECT * FROM model_products WHERE id = ?')
    .get(productId) as
    | {
        id: string;
        name: string;
        product_class: string;
        version: string;
        weights_sha256: string;
        architecture_summary: string;
        training_summary: string;
        evaluation_summary: string;
        license: string;
        runtime_requirements_json: string;
        safety_report_json: string;
        changelog: string;
        lifecycle_state: string;
      }
    | undefined;

  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  if (product.lifecycle_state !== 'APPROVED' && product.lifecycle_state !== 'RELEASED') {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'NG_IP',
      action: 'BLOCK_UNAPPROVED_DELIVERY',
      target: productId,
      outcome: 'BLOCKED',
      details: { lifecycleState: product.lifecycle_state },
    });
    throw new Error(
      `Blocked: Product ${productId} is in state ${product.lifecycle_state}. Only APPROVED or RELEASED models can be packaged for customer delivery.`,
    );
  }

  if (DISALLOWED_IP_LICENSES.has(product.license.trim().toUpperCase())) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'NG_IP',
      action: 'BLOCK_INVALID_IP_LICENSE',
      target: productId,
      outcome: 'BLOCKED',
      details: { declaredLicense: product.license },
    });
    throw new Error(
      `Blocked: Declared license '${product.license}' violates NG-IP intellectual property compliance.`,
    );
  }

  const qcReports = db
    .prepare("SELECT test_suite, result, details_json, executed_at FROM qc_reports WHERE product_id = ? ORDER BY test_suite ASC")
    .all(productId) as unknown as Array<{
    test_suite: string;
    result: string;
    details_json: string;
    executed_at: string;
  }>;

  const passedCurrentSuites = new Set<string>();
  let qcEvidenceSha256 = '';
  let qcEvidencePath = '';
  for (const q of qcReports) {
    if (q.result !== 'PASS') continue;
    try {
      const parsed = JSON.parse(q.details_json) as {
        productVersion?: string;
        weightsSha256?: string;
        evidenceSha256?: string;
        evidencePath?: string;
      };
      if (parsed.productVersion === product.version && parsed.weightsSha256 === product.weights_sha256) {
        passedCurrentSuites.add(q.test_suite);
        if (!qcEvidenceSha256 && typeof parsed.evidenceSha256 === 'string') {
          qcEvidenceSha256 = parsed.evidenceSha256;
        }
        if (!qcEvidencePath && typeof parsed.evidencePath === 'string') {
          qcEvidencePath = parsed.evidencePath;
        }
      }
    } catch {
      // ignore unparseable detail
    }
  }

  if (passedCurrentSuites.size < REQUIRED_QC_SUITES_COUNT) {
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'NG_IP',
      action: 'BLOCK_QC_INCOMPLETE_DELIVERY',
      target: productId,
      outcome: 'BLOCKED',
      details: {
        passedSuites: passedCurrentSuites.size,
        requiredSuites: REQUIRED_QC_SUITES_COUNT,
      },
    });
    throw new Error(
      `Blocked: Product ${productId} has only ${passedCurrentSuites.size}/${REQUIRED_QC_SUITES_COUNT} passing QC suites for current weights.`,
    );
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  let runtimeReq: Record<string, unknown> = {};
  try {
    runtimeReq = JSON.parse(product.runtime_requirements_json) as Record<string, unknown>;
  } catch {
    runtimeReq = {};
  }

  const matchingResource = db
    .prepare('SELECT file_path FROM resources WHERE sha256 = ?')
    .get(product.weights_sha256) as { file_path: string } | undefined;

  const weightsFilePath =
    resolveWorkspaceArtifact(runtimeReq.weightsPath, dataDir) ??
    resolveWorkspaceArtifact(runtimeReq.weightsManifestPath, dataDir) ??
    resolveWorkspaceArtifact(matchingResource?.file_path, dataDir);

  if (!weightsFilePath) {
    throw new Error(
      `Blocked: Binary weights file for product ${productId} is missing on disk inside data_dir; cannot assemble certified delivery ZIP.`,
    );
  }

  const weightsBuf = fs.readFileSync(weightsFilePath);
  const weightsInspection = inspectBinaryWeightsBuffer(weightsBuf, weightsFilePath);
  if (!weightsInspection.isBinaryWeights || weightsInspection.sha256 !== product.weights_sha256) {
    throw new Error(
      `Blocked: Weights file failed binary/SHA-256 verification before packaging (${weightsInspection.reason || 'digest mismatch'}).`,
    );
  }

  const mindDir = typeof runtimeReq.mindDir === 'string' ? runtimeReq.mindDir : '';
  const tokenizerFilePath =
    resolveWorkspaceArtifact(runtimeReq.tokenizerPath, dataDir) ??
    (mindDir ? resolveWorkspaceArtifact(path.join(mindDir, 'tokenizer.json'), dataDir) : null);
  const configFilePath =
    resolveWorkspaceArtifact(runtimeReq.configPath, dataDir) ??
    (mindDir ? resolveWorkspaceArtifact(path.join(mindDir, 'model_config.json'), dataDir) : null);
  const evidenceFilePath = resolveWorkspaceArtifact(qcEvidencePath, dataDir);

  const ipHolder = options.ipHolder?.trim() || 'NG-ILMF Owner / Sovereign Factory IP Holder';
  const licenseTermsNote =
    options.licenseTermsNote?.trim() ||
    `Redistribution and deployment are strictly governed by the declared '${product.license}' license terms and verified SHA-256 weights digest.`;

  const weightsArchiveEntryName = `weights/${path.basename(weightsFilePath)}`;
  const generatedAt = new Date().toISOString();
  const manifestObj = {
    factory: 'NG-ILMF — Future Generations Intelligent Minds Factory',
    productId: product.id,
    name: product.name,
    productClass: product.product_class,
    version: product.version,
    lifecycleState: product.lifecycle_state,
    weightsEntry: weightsArchiveEntryName,
    weightsFormat: weightsInspection.detectedFormat,
    weightsSha256: product.weights_sha256,
    weightsSizeBytes: weightsBuf.length,
    tensorCount: weightsInspection.tensorCount,
    parameterCount: weightsInspection.parameterCount,
    tokenizerBundled: Boolean(tokenizerFilePath),
    configBundled: Boolean(configFilePath),
    qcEvidenceBundled: Boolean(evidenceFilePath),
    license: product.license,
    ipHolder,
    qcEvidenceSha256: qcEvidenceSha256 || null,
    architectureSummary: product.architecture_summary,
    qcSuitesPassed: passedCurrentSuites.size,
    generatedAt,
  };

  const manifestJson = JSON.stringify(manifestObj, null, 2);
  const manifestSha256 = crypto.createHash('sha256').update(manifestJson, 'utf-8').digest('hex');

  const technicalDossier = [
    `# NG-ILMF CERTIFIED TECHNICAL DOSSIER`,
    ``,
    `- **Product:** ${product.name} (\`${product.id}\`)`,
    `- **Class:** \`${product.product_class}\``,
    `- **Version:** \`${product.version}\``,
    `- **Lifecycle State:** \`${product.lifecycle_state}\``,
    `- **IP Holder:** ${ipHolder}`,
    `- **License & IP:** \`${product.license}\``,
    `- **Weights Archive Entry:** \`${weightsArchiveEntryName}\` (\`${weightsInspection.detectedFormat}\`, ${weightsBuf.length} bytes)`,
    `- **Weights SHA-256:** \`${product.weights_sha256}\``,
    `- **QC Evidence SHA-256:** \`${qcEvidenceSha256 || 'EMBEDDED_IN_SQLITE_QC'}\``,
    `- **Manifest SHA-256:** \`${manifestSha256}\``,
    `- **Generated At:** \`${generatedAt}\``,
    ``,
    `## Architecture`,
    product.architecture_summary,
    ``,
    `## Training & Adaptation Lineage`,
    product.training_summary || 'Recorded in factory provenance log.',
    ``,
    `## Evaluation Summary`,
    product.evaluation_summary || 'Evaluated via 10-suite Trust & Security QC.',
    ``,
    `## Trust & Security 10-Suite QC Results (${passedCurrentSuites.size}/${REQUIRED_QC_SUITES_COUNT})`,
    ...qcReports.map((q) => `- \`${q.test_suite}\`: **${q.result}** (${q.executed_at})`),
    ``,
    `## Changelog`,
    product.changelog || 'Initial certified release.',
    ``,
  ].join('\n');

  const licenseNotice = [
    `NG-ILMF INTELLECTUAL PROPERTY & LICENSE GOVERNANCE NOTICE`,
    `Product ID: ${product.id}`,
    `Product Name: ${product.name} v${product.version}`,
    `Copyright / IP Holder: ${ipHolder}`,
    `Declared License: ${product.license}`,
    `Governance Terms: ${licenseTermsNote}`,
    `Weights Integrity Digest (SHA-256): ${product.weights_sha256}`,
    `QC Evidence Digest (SHA-256): ${qcEvidenceSha256 || 'N/A'}`,
    `Issued By: NG-ILMF Master Control Center (NG-IP SERVICES)`,
    `Issued At: ${generatedAt}`,
  ].join('\n');

  const bundleFiles: ZipInputFile[] = [
    { name: 'MANIFEST.json', content: manifestJson },
    { name: 'TECHNICAL_REPORT.md', content: technicalDossier },
    { name: 'LICENSE_AND_IP.txt', content: licenseNotice },
    { name: weightsArchiveEntryName, content: weightsBuf },
  ];

  if (tokenizerFilePath) {
    bundleFiles.push({ name: 'tokenizer.json', content: fs.readFileSync(tokenizerFilePath) });
  }
  if (configFilePath) {
    bundleFiles.push({ name: 'model_config.json', content: fs.readFileSync(configFilePath) });
  }
  if (evidenceFilePath) {
    bundleFiles.push({ name: 'QC_EVIDENCE.json', content: fs.readFileSync(evidenceFilePath) });
  }

  const checksumLines = bundleFiles.map((f) => {
    const raw = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8');
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    return `${digest}  ${f.name}`;
  });
  bundleFiles.push({ name: 'CHECKSUMS.sha256', content: checksumLines.join('\n') + '\n' });

  const { buffer: zipBuffer, sha256: packageSha256 } = buildZipArchive(bundleFiles);

  const deliveriesDir = path.join(dataDir, 'exports', 'deliveries');
  fs.mkdirSync(deliveriesDir, { recursive: true });

  const safeSlug = product.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 36) || 'product';
  const zipFileName = `${product.id}_${safeSlug}_v${product.version.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
  const zipPath = path.join(deliveriesDir, zipFileName);
  writeFileAtomic(zipPath, zipBuffer);

  // Decompress & cryptographically verify the written ZIP file before certifying it in SQLite
  const readBackBuf = fs.readFileSync(zipPath);
  const readBackSha = crypto.createHash('sha256').update(readBackBuf).digest('hex');
  const extracted = extractAndVerifyZipArchive(readBackBuf);
  const verified =
    readBackSha === packageSha256 && extracted.validStructure && extracted.allCrcValid;

  const pkgId = `PKG-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  db.prepare(
    `
    INSERT INTO delivery_packages (
      id, product_id, zip_path, manifest_sha256, package_sha256,
      size_bytes, verified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(pkgId, product.id, zipPath, manifestSha256, packageSha256, zipBuffer.length, verified ? 1 : 0, generatedAt);

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'NG_IP',
    action: 'BUILD_CERTIFIED_DELIVERY_ZIP',
    target: zipPath,
    outcome: verified ? 'PASS' : 'FAIL',
    details: {
      pkgId,
      productId: product.id,
      ipHolder,
      manifestSha256,
      packageSha256,
      sizeBytes: zipBuffer.length,
      entriesBundled: bundleFiles.length,
      weightsBundled: weightsArchiveEntryName,
    },
  });

  return listDeliveryPackages(db).find((p) => p.id === pkgId)!;
}

export function verifyDeliveryPackageIntegrity(
  db: DatabaseSync,
  packageId: string,
): {
  deliveryPackage: DeliveryPackageRecord;
  fileExists: boolean;
  validPkzipHeader: boolean;
  sha256Matched: boolean;
  allEntriesVerified: boolean;
  entriesCheckedCount: number;
  containsBinaryWeights: boolean;
  actualSha256: string;
} {
  const pkg = listDeliveryPackages(db).find((p) => p.id === packageId);
  if (!pkg) {
    throw new Error(`Delivery package not found: ${packageId}`);
  }

  if (!fs.existsSync(pkg.zipPath)) {
    db.prepare('UPDATE delivery_packages SET verified = 0 WHERE id = ?').run(packageId);
    recordAuditEvent(db, {
      actor: 'OWNER',
      category: 'NG_IP',
      action: 'VERIFY_DELIVERY_ZIP_MISSING',
      target: pkg.zipPath,
      outcome: 'FAIL',
      details: { packageId },
    });
    return {
      deliveryPackage: listDeliveryPackages(db).find((p) => p.id === packageId)!,
      fileExists: false,
      validPkzipHeader: false,
      sha256Matched: false,
      allEntriesVerified: false,
      entriesCheckedCount: 0,
      containsBinaryWeights: false,
      actualSha256: '',
    };
  }

  const buf = fs.readFileSync(pkg.zipPath);
  const actualSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const validPkzipHeader =
    buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const sha256Matched = actualSha256 === pkg.packageSha256;

  // Extract every entry, verify CRC-32, verify CHECKSUMS.sha256 entries, and inspect binary weights entry
  const extracted = extractAndVerifyZipArchive(buf);
  let checksumsValid = false;
  let containsBinaryWeights = false;

  if (extracted.validStructure && extracted.allCrcValid) {
    const checksumsEntry = extracted.entries.get('CHECKSUMS.sha256');
    const manifestEntry = extracted.entries.get('MANIFEST.json');
    const reportEntry = extracted.entries.get('TECHNICAL_REPORT.md');
    const licenseEntry = extracted.entries.get('LICENSE_AND_IP.txt');

    if (checksumsEntry && manifestEntry && reportEntry && licenseEntry) {
      const lines = checksumsEntry.content
        .toString('utf-8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      checksumsValid = lines.length > 0;
      for (const line of lines) {
        const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
        if (!match) {
          checksumsValid = false;
          break;
        }
        const [, expectedDigest, entryName] = match;
        const entry = extracted.entries.get(entryName.trim());
        if (!entry || entry.sha256 !== expectedDigest) {
          checksumsValid = false;
          break;
        }
      }
    }

    for (const [entryName, entry] of extracted.entries.entries()) {
      if (entryName.startsWith('weights/')) {
        const insp = inspectBinaryWeightsBuffer(entry.content, entryName);
        if (insp.isBinaryWeights) {
          containsBinaryWeights = true;
        }
      }
    }
  }

  const allEntriesVerified = extracted.validStructure && extracted.allCrcValid && checksumsValid;
  const verified = validPkzipHeader && sha256Matched && allEntriesVerified && containsBinaryWeights;

  db.prepare('UPDATE delivery_packages SET verified = ? WHERE id = ?').run(verified ? 1 : 0, packageId);
  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'NG_IP',
    action: 'VERIFY_DELIVERY_ZIP_INTEGRITY',
    target: pkg.zipPath,
    outcome: verified ? 'PASS' : 'FAIL',
    details: {
      packageId,
      expectedSha256: pkg.packageSha256,
      actualSha256,
      validPkzipHeader,
      allEntriesVerified,
      entriesCheckedCount: extracted.entryCount,
      containsBinaryWeights,
    },
  });

  return {
    deliveryPackage: listDeliveryPackages(db).find((p) => p.id === packageId)!,
    fileExists: true,
    validPkzipHeader,
    sha256Matched,
    allEntriesVerified,
    entriesCheckedCount: extracted.entryCount,
    containsBinaryWeights,
    actualSha256,
  };
}
