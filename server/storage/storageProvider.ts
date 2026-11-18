import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export interface StorageProvider {
  readonly id: StorageProviderId;
  readonly environmentType: StorageEnvironmentType;
  probe(): StorageProviderProbeResult;
  runIntegrityVerification(): StorageVerificationReport;
}

function inspectPosixPath(targetPath: string): {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  totalBytes: number | null;
  freeBytes: number | null;
  availableBytes: number | null;
  statError: string | null;
} {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return {
      exists: false,
      readable: false,
      writable: false,
      totalBytes: null,
      freeBytes: null,
      availableBytes: null,
      statError: null,
    };
  }

  let readable = false;
  let writable = false;
  try {
    fs.accessSync(targetPath, fs.constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  let availableBytes: number | null = null;
  let statError: string | null = null;

  try {
    const stat = fs.statfsSync(targetPath);
    totalBytes = Number(stat.blocks) * Number(stat.bsize);
    freeBytes = Number(stat.bfree) * Number(stat.bsize);
    availableBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch (err) {
    statError = err instanceof Error ? err.message : 'Unable to read filesystem stats';
  }

  return {
    exists: true,
    readable,
    writable,
    totalBytes,
    freeBytes,
    availableBytes,
    statError,
  };
}

function executeRealWriteReadSha256Test(
  probeResult: StorageProviderProbeResult,
  targetDirectory: string,
): StorageVerificationReport {
  const executedAt = new Date().toISOString();

  if (probeResult.state !== 'AVAILABLE' || !probeResult.exists || !probeResult.writable) {
    return {
      providerId: probeResult.providerId,
      environmentType: probeResult.environmentType,
      configuredPath: probeResult.configuredPath,
      discoveredPaths: probeResult.discoveredPaths,
      readable: probeResult.readable,
      writable: probeResult.writable,
      state: probeResult.state,
      storageReady: false,
      testFilePath: null,
      expectedSha256: null,
      actualSha256: null,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason:
        probeResult.failureReason ||
        `Target directory is not writable (state=${probeResult.state})`,
      executedAt,
    };
  }

  const nonce = crypto.randomUUID();
  const testFileName = `.ng_ilmf_integrity_${nonce.slice(0, 8)}.tmp`;
  const testFilePath = path.join(targetDirectory, testFileName);
  const payload = `NG-ILMF-STORAGE-PROBE|provider=${probeResult.providerId}|ts=${executedAt}|nonce=${nonce}`;
  const expectedBuffer = Buffer.from(payload, 'utf-8');
  const expectedSha256 = crypto.createHash('sha256').update(expectedBuffer).digest('hex');

  try {
    fs.writeFileSync(testFilePath, expectedBuffer);
  } catch (err) {
    return {
      providerId: probeResult.providerId,
      environmentType: probeResult.environmentType,
      configuredPath: probeResult.configuredPath,
      discoveredPaths: probeResult.discoveredPaths,
      readable: probeResult.readable,
      writable: false,
      state: 'WRITE_TEST_FAILED',
      storageReady: false,
      testFilePath,
      expectedSha256,
      actualSha256: null,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason: err instanceof Error ? err.message : 'Failed to write temporary probe file',
      executedAt,
    };
  }

  let readBuffer: Buffer;
  try {
    readBuffer = fs.readFileSync(testFilePath);
  } catch (err) {
    return {
      providerId: probeResult.providerId,
      environmentType: probeResult.environmentType,
      configuredPath: probeResult.configuredPath,
      discoveredPaths: probeResult.discoveredPaths,
      readable: false,
      writable: true,
      state: 'VERIFY_FAILED',
      storageReady: false,
      testFilePath,
      expectedSha256,
      actualSha256: null,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason: err instanceof Error ? err.message : 'Failed to read back temporary probe file',
      executedAt,
    };
  }

  const actualSha256 = crypto.createHash('sha256').update(readBuffer).digest('hex');
  const contentMatched = readBuffer.equals(expectedBuffer) && actualSha256 === expectedSha256;

  if (!contentMatched) {
    // Do not delete on verification mismatch so forensic inspection is possible
    return {
      providerId: probeResult.providerId,
      environmentType: probeResult.environmentType,
      configuredPath: probeResult.configuredPath,
      discoveredPaths: probeResult.discoveredPaths,
      readable: true,
      writable: true,
      state: 'VERIFY_FAILED',
      storageReady: false,
      testFilePath,
      expectedSha256,
      actualSha256,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason: 'SHA-256 or byte comparison mismatch after reading back temporary file',
      executedAt,
    };
  }

  // Delete temporary test file ONLY after content comparison and SHA-256 verification succeeded
  let cleanupCompleted = false;
  try {
    fs.unlinkSync(testFilePath);
    cleanupCompleted = !fs.existsSync(testFilePath);
  } catch (err) {
    return {
      providerId: probeResult.providerId,
      environmentType: probeResult.environmentType,
      configuredPath: probeResult.configuredPath,
      discoveredPaths: probeResult.discoveredPaths,
      readable: true,
      writable: true,
      state: 'VERIFY_FAILED',
      storageReady: false,
      testFilePath,
      expectedSha256,
      actualSha256,
      contentMatched: true,
      cleanupCompleted: false,
      failureReason: `Verification passed but failed to remove temp probe file: ${err instanceof Error ? err.message : 'unlink error'}`,
      executedAt,
    };
  }

  return {
    providerId: probeResult.providerId,
    environmentType: probeResult.environmentType,
    configuredPath: probeResult.configuredPath,
    discoveredPaths: probeResult.discoveredPaths,
    readable: true,
    writable: true,
    state: 'AVAILABLE',
    storageReady: true,
    testFilePath,
    expectedSha256,
    actualSha256,
    contentMatched: true,
    cleanupCompleted,
    failureReason: null,
    executedAt,
  };
}

export class HostDevelopmentStorageProvider implements StorageProvider {
  readonly id = 'host_dev' as const;
  readonly environmentType = 'HOST_DEVELOPMENT' as const;
  private readonly hostDataDir: string;

  constructor(hostDataDir: string) {
    this.hostDataDir = hostDataDir.trim();
  }

  probe(): StorageProviderProbeResult {
    const checkedAt = new Date().toISOString();
    if (!this.hostDataDir) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: '',
        discoveredPaths: [],
        isVirtualHostPath: true,
        exists: false,
        readable: false,
        writable: false,
        state: 'NOT_FOUND',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason: 'Host development data directory is not configured',
        checkedAt,
      };
    }

    const info = inspectPosixPath(this.hostDataDir);
    let state: StorageState = 'NOT_FOUND';
    let failureReason: string | null = null;

    if (!info.exists) {
      state = 'NOT_FOUND';
      failureReason = `Host directory not found: ${this.hostDataDir}`;
    } else if (info.readable && info.writable) {
      state = 'AVAILABLE';
    } else if (info.readable && !info.writable) {
      state = 'READ_ONLY';
      failureReason = `Host directory is read-only: ${this.hostDataDir}`;
    } else {
      state = 'NOT_AUTHORIZED';
      failureReason = `Host directory lacks read/write permission: ${this.hostDataDir}`;
    }

    return {
      providerId: this.id,
      environmentType: this.environmentType,
      configuredPath: this.hostDataDir,
      discoveredPaths: info.exists ? [this.hostDataDir] : [],
      isVirtualHostPath: true,
      exists: info.exists,
      readable: info.readable,
      writable: info.writable,
      state,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      availableBytes: info.availableBytes,
      failureReason: failureReason ?? info.statError,
      checkedAt,
    };
  }

  runIntegrityVerification(): StorageVerificationReport {
    const probe = this.probe();
    return executeRealWriteReadSha256Test(probe, this.hostDataDir);
  }
}

export class AndroidSAFStorageProvider implements StorageProvider {
  readonly id = 'android_saf' as const;
  readonly environmentType = 'ANDROID_DEVICE' as const;
  private readonly safUri: string;

  constructor(safUri: string) {
    this.safUri = safUri.trim();
  }

  probe(): StorageProviderProbeResult {
    const checkedAt = new Date().toISOString();
    const isAndroidRuntime =
      Boolean(process.env.ANDROID_ROOT) || fs.existsSync('/system/build.prop');
    const discoveredPaths: string[] = [];
    if (fs.existsSync('/system/build.prop')) discoveredPaths.push('/system/build.prop');
    if (fs.existsSync('/storage/emulated/0')) discoveredPaths.push('/storage/emulated/0');

    if (!isAndroidRuntime) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: this.safUri || 'content://com.android.externalstorage.documents/...',
        discoveredPaths,
        isVirtualHostPath: false,
        exists: false,
        readable: false,
        writable: false,
        state: 'NOT_MOUNTED',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason:
          'Running inside Host Linux/Node runtime; Android Framework & SAF DocumentFile API are unavailable here.',
        checkedAt,
      };
    }

    if (!this.safUri) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: '',
        discoveredPaths,
        isVirtualHostPath: false,
        exists: false,
        readable: false,
        writable: false,
        state: 'NOT_AUTHORIZED',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason: 'Owner has not granted a persisted Android SAF tree URI.',
        checkedAt,
      };
    }

    return {
      providerId: this.id,
      environmentType: this.environmentType,
      configuredPath: this.safUri,
      discoveredPaths,
      isVirtualHostPath: false,
      exists: false,
      readable: false,
      writable: false,
      state: 'NOT_AUTHORIZED',
      totalBytes: null,
      freeBytes: null,
      availableBytes: null,
      failureReason:
        'SAF content:// URIs require native Android ContentResolver bridge (APK/Termux-SAF).',
      checkedAt,
    };
  }

  runIntegrityVerification(): StorageVerificationReport {
    const probe = this.probe();
    return {
      providerId: this.id,
      environmentType: this.environmentType,
      configuredPath: probe.configuredPath,
      discoveredPaths: probe.discoveredPaths,
      readable: false,
      writable: false,
      state: probe.state,
      storageReady: false,
      testFilePath: null,
      expectedSha256: null,
      actualSha256: null,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason: probe.failureReason,
      executedAt: new Date().toISOString(),
    };
  }
}

export class TermuxStorageProvider implements StorageProvider {
  readonly id = 'termux' as const;
  readonly environmentType = 'TERMUX' as const;
  private readonly termuxPrefix: string;
  private readonly termuxSharedPath: string;

  constructor(termuxPrefix: string, termuxSharedPath: string) {
    this.termuxPrefix = termuxPrefix.trim();
    this.termuxSharedPath = termuxSharedPath.trim();
  }

  probe(): StorageProviderProbeResult {
    const checkedAt = new Date().toISOString();
    const candidates = [
      this.termuxPrefix,
      this.termuxSharedPath,
      '/data/data/com.termux/files/home/storage/external-1',
    ].filter(Boolean);

    const discoveredPaths = candidates.filter((p) => fs.existsSync(p));
    const target = this.termuxSharedPath || this.termuxPrefix;

    if (!target || !fs.existsSync(target)) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: target,
        discoveredPaths,
        isVirtualHostPath: false,
        exists: false,
        readable: false,
        writable: false,
        state: fs.existsSync('/data/data/com.termux') ? 'NOT_FOUND' : 'NOT_MOUNTED',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason: fs.existsSync('/data/data/com.termux')
          ? `Termux storage path not found (run termux-setup-storage): ${target}`
          : 'Termux environment (/data/data/com.termux) is not present on this host.',
        checkedAt,
      };
    }

    const info = inspectPosixPath(target);
    let state: StorageState = 'AVAILABLE';
    let failureReason: string | null = null;

    if (!info.readable && !info.writable) {
      state = 'NOT_AUTHORIZED';
      failureReason = `Termux path exists but lacks permissions: ${target}`;
    } else if (info.readable && !info.writable) {
      state = 'READ_ONLY';
      failureReason = `Termux storage path is read-only: ${target}`;
    }

    return {
      providerId: this.id,
      environmentType: this.environmentType,
      configuredPath: target,
      discoveredPaths,
      isVirtualHostPath: false,
      exists: info.exists,
      readable: info.readable,
      writable: info.writable,
      state,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      availableBytes: info.availableBytes,
      failureReason: failureReason ?? info.statError,
      checkedAt,
    };
  }

  runIntegrityVerification(): StorageVerificationReport {
    const probe = this.probe();
    return executeRealWriteReadSha256Test(probe, this.termuxSharedPath || this.termuxPrefix);
  }
}

export class ExternalSDCardStorageProvider implements StorageProvider {
  readonly id = 'external_sd' as const;
  readonly environmentType = 'EXTERNAL_SD' as const;
  private readonly sdArchivePath: string;

  constructor(sdArchivePath: string) {
    this.sdArchivePath = sdArchivePath.trim();
  }

  private getMountCandidate(archivePath: string): string {
    // e.g. /storage/857A-1AED/V5/NG-ILMF_ARCHIVE -> /storage/857A-1AED
    const match = archivePath.match(/^(\/storage\/[^/]+)/);
    if (match) return match[1];
    return path.dirname(archivePath);
  }

  probe(): StorageProviderProbeResult {
    const checkedAt = new Date().toISOString();
    const discoveredPaths: string[] = [];

    if (fs.existsSync('/storage')) {
      try {
        const entries = fs.readdirSync('/storage');
        for (const entry of entries) {
          if (entry !== 'self' && entry !== 'emulated') {
            discoveredPaths.push(`/storage/${entry}`);
          }
        }
      } catch {
        // ignore /storage list permission denied
      }
    }

    if (!this.sdArchivePath) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: '',
        discoveredPaths,
        isVirtualHostPath: false,
        exists: false,
        readable: false,
        writable: false,
        state: 'NOT_FOUND',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason: 'External SD archive path is not configured',
        checkedAt,
      };
    }

    const mountRoot = this.getMountCandidate(this.sdArchivePath);
    const mountExists = fs.existsSync(mountRoot);

    if (!mountExists) {
      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: this.sdArchivePath,
        discoveredPaths,
        isVirtualHostPath: false,
        exists: false,
        readable: false,
        writable: false,
        state: 'NOT_MOUNTED',
        totalBytes: null,
        freeBytes: null,
        availableBytes: null,
        failureReason: `External SD medium not mounted at ${mountRoot}`,
        checkedAt,
      };
    }

    // Never auto-create NG-ILMF_ARCHIVE before owner discovery & approval!
    if (!fs.existsSync(this.sdArchivePath)) {
      const mountInfo = inspectPosixPath(mountRoot);
      const state: StorageState = !mountInfo.readable
        ? 'NOT_AUTHORIZED'
        : !mountInfo.writable
          ? 'READ_ONLY'
          : 'NOT_FOUND';

      return {
        providerId: this.id,
        environmentType: this.environmentType,
        configuredPath: this.sdArchivePath,
        discoveredPaths: [...new Set([mountRoot, ...discoveredPaths])],
        isVirtualHostPath: false,
        exists: false,
        readable: mountInfo.readable,
        writable: mountInfo.writable,
        state,
        totalBytes: mountInfo.totalBytes,
        freeBytes: mountInfo.freeBytes,
        availableBytes: mountInfo.availableBytes,
        failureReason:
          state === 'NOT_FOUND'
            ? `SD card is mounted at ${mountRoot}, but archive directory has not been initialized/approved: ${this.sdArchivePath}`
            : `SD card mount ${mountRoot} lacks writable permission (${state})`,
        checkedAt,
      };
    }

    const info = inspectPosixPath(this.sdArchivePath);
    let state: StorageState = 'AVAILABLE';
    let failureReason: string | null = null;

    if (!info.readable && !info.writable) {
      state = 'NOT_AUTHORIZED';
      failureReason = `Permission denied on SD archive directory: ${this.sdArchivePath}`;
    } else if (info.readable && !info.writable) {
      state = 'READ_ONLY';
      failureReason = `SD archive directory is mounted read-only (Scoped Storage restriction): ${this.sdArchivePath}`;
    }

    return {
      providerId: this.id,
      environmentType: this.environmentType,
      configuredPath: this.sdArchivePath,
      discoveredPaths: [...new Set([this.sdArchivePath, mountRoot, ...discoveredPaths])],
      isVirtualHostPath: false,
      exists: info.exists,
      readable: info.readable,
      writable: info.writable,
      state,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      availableBytes: info.availableBytes,
      failureReason: failureReason ?? info.statError,
      checkedAt,
    };
  }

  runIntegrityVerification(): StorageVerificationReport {
    const probe = this.probe();
    return executeRealWriteReadSha256Test(probe, this.sdArchivePath);
  }
}

export function createStorageProviders(config: Record<string, string>): Record<StorageProviderId, StorageProvider> {
  return {
    host_dev: new HostDevelopmentStorageProvider(config.data_dir ?? ''),
    android_saf: new AndroidSAFStorageProvider(config.android_saf_uri ?? ''),
    termux: new TermuxStorageProvider(
      config.termux_prefix ?? '',
      config.termux_shared_path ?? '/data/data/com.termux/files/home/storage/shared',
    ),
    external_sd: new ExternalSDCardStorageProvider(config.sd_archive_path ?? ''),
  };
}
