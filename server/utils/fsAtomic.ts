import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically writes content to a temporary sibling file, flushes to disk (fsync),
 * and atomically renames over targetPath so partial/corrupted files never survive crashes.
 */
export function writeFileAtomic(
  targetPath: string,
  data: Buffer | string,
  encoding: BufferEncoding = 'utf-8',
): void {
  const resolved = path.resolve(targetPath);
  const parentDir = path.dirname(resolved);
  fs.mkdirSync(parentDir, { recursive: true });

  const tmpName = `.${path.basename(resolved)}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const tmpPath = path.join(parentDir, tmpName);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      // Some virtual filesystems do not support fsync on regular files
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, resolved);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  }
}

/**
 * Resolves candidatePath through realpath (including nearest existing ancestor for not-yet-created files)
 * and asserts it remains strictly confined within canonicalAllowedRoot without symlink escape.
 */
export function resolveSafeRealPath(candidatePath: string, allowedRootDir: string): {
  allowed: boolean;
  canonicalRoot: string;
  canonicalTarget: string;
  reason?: string;
} {
  const rawRoot = path.resolve(allowedRootDir);
  let canonicalRoot = rawRoot;
  try {
    if (fs.existsSync(rawRoot)) {
      canonicalRoot = fs.realpathSync(rawRoot);
    }
  } catch {
    return {
      allowed: false,
      canonicalRoot: rawRoot,
      canonicalTarget: path.resolve(candidatePath),
      reason: `Cannot canonicalize allowed root directory: ${rawRoot}`,
    };
  }

  const resolvedCandidate = path.resolve(candidatePath);
  let canonicalTarget = resolvedCandidate;

  try {
    if (fs.existsSync(resolvedCandidate)) {
      // Check lstat for direct symlink target resolution
      canonicalTarget = fs.realpathSync(resolvedCandidate);
    } else {
      // Walk upwards until an existing directory/ancestor is found and resolve symlinks from there
      const missingSegments: string[] = [];
      let cursor = resolvedCandidate;
      while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        missingSegments.unshift(path.basename(cursor));
        cursor = parent;
      }
      if (fs.existsSync(cursor)) {
        canonicalTarget = path.join(fs.realpathSync(cursor), ...missingSegments);
      }
    }
  } catch (err) {
    return {
      allowed: false,
      canonicalRoot,
      canonicalTarget: resolvedCandidate,
      reason: err instanceof Error ? err.message : 'Symlink resolution failed',
    };
  }

  const rootPrefix = canonicalRoot.endsWith(path.sep)
    ? canonicalRoot
    : `${canonicalRoot}${path.sep}`;
  const inside = canonicalTarget === canonicalRoot || canonicalTarget.startsWith(rootPrefix);

  return {
    allowed: inside,
    canonicalRoot,
    canonicalTarget,
    reason: inside
      ? undefined
      : `Path '${canonicalTarget}' escapes confined directory '${canonicalRoot}'`,
  };
}

export function isSqliteProtectedFile(targetPath: string): boolean {
  const base = path.basename(targetPath).toLowerCase();
  return (
    base.endsWith('.sqlite') ||
    base.endsWith('.sqlite-wal') ||
    base.endsWith('.sqlite-shm') ||
    base.endsWith('.sqlite-journal') ||
    base.includes('.sqlite')
  );
}
