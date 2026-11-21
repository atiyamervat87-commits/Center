import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface ZipInputFile {
  name: string;
  content: Buffer | string;
}

export interface VerifiedZipEntry {
  name: string;
  content: Buffer;
  sizeBytes: number;
  sha256: string;
  crc32: number;
  method: number;
  crc32Valid: boolean;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a valid RFC-1951 standard ZIP archive buffer in pure Node.js
 * without requiring third-party native or npm compression dependencies.
 */
export function buildZipArchive(files: ZipInputFile[]): {
  buffer: Buffer;
  sha256: string;
} {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(now.getFullYear(), 1980) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const file of files) {
    const cleanName = file.name.replace(/^\/+/, '');
    const nameBuf = Buffer.from(cleanName, 'utf-8');
    const rawBuf = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf-8');
    const compressed = zlib.deflateRawSync(rawBuf);
    const useDeflate = compressed.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed : rawBuf;
    const checksum = crc32(rawBuf);

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localChunks.push(localHeader, payload);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralChunks.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDirSize = centralChunks.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const buffer = Buffer.concat([...localChunks, ...centralChunks, eocd]);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256 };
}

/**
 * Parses Central Directory and Local File Headers of a PKZIP buffer, decompresses every
 * entry, verifies CRC-32 checksums, and computes per-entry SHA-256 digests.
 */
export function extractAndVerifyZipArchive(zipBuffer: Buffer): {
  validStructure: boolean;
  entryCount: number;
  allCrcValid: boolean;
  entries: Map<string, VerifiedZipEntry>;
  error?: string;
} {
  const empty = new Map<string, VerifiedZipEntry>();
  if (zipBuffer.length < 22) {
    return { validStructure: false, entryCount: 0, allCrcValid: false, entries: empty, error: 'Archive too small for EOCD' };
  }

  // Locate EOCD signature 0x06054b50 backwards
  let eocdOffset = -1;
  const minSearch = Math.max(0, zipBuffer.length - 65558);
  for (let i = zipBuffer.length - 22; i >= minSearch; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    return { validStructure: false, entryCount: 0, allCrcValid: false, entries: empty, error: 'PKZIP End of Central Directory not found' };
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset + centralDirSize > eocdOffset) {
    return { validStructure: false, entryCount: 0, allCrcValid: false, entries: empty, error: 'Corrupted Central Directory bounds' };
  }

  const entries = new Map<string, VerifiedZipEntry>();
  let cursor = centralDirOffset;
  let allCrcValid = true;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > eocdOffset || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      return { validStructure: false, entryCount: entries.size, allCrcValid: false, entries, error: `Invalid Central Directory entry at #${idx}` };
    }

    const method = zipBuffer.readUInt16LE(cursor + 10);
    const expectedCrc = zipBuffer.readUInt32LE(cursor + 16);
    const compSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localOffset = zipBuffer.readUInt32LE(cursor + 42);

    const entryName = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf-8');
    cursor += 46 + nameLen + extraLen + commentLen;

    // Prevent ZipSlip traversal inside parsed entry paths
    if (entryName.startsWith('/') || entryName.includes('..')) {
      return { validStructure: false, entryCount: entries.size, allCrcValid: false, entries, error: `Unsafe zip entry path blocked: ${entryName}` };
    }

    if (localOffset + 30 > centralDirOffset || zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
      return { validStructure: false, entryCount: entries.size, allCrcValid: false, entries, error: `Invalid local file header for ${entryName}` };
    }

    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > centralDirOffset) {
      return { validStructure: false, entryCount: entries.size, allCrcValid: false, entries, error: `Truncated compressed payload for ${entryName}` };
    }

    const compressedSlice = zipBuffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    try {
      if (method === 0) {
        content = Buffer.from(compressedSlice);
      } else if (method === 8) {
        content = zlib.inflateRawSync(compressedSlice);
      } else {
        return { validStructure: false, entryCount: entries.size, allCrcValid: false, entries, error: `Unsupported compression method ${method} for ${entryName}` };
      }
    } catch (err) {
      return {
        validStructure: false,
        entryCount: entries.size,
        allCrcValid: false,
        entries,
        error: `Decompression failed for ${entryName}: ${err instanceof Error ? err.message : 'corrupt stream'}`,
      };
    }

    const actualCrc = crc32(content);
    const crcValid = actualCrc === expectedCrc && content.length === uncompSize;
    if (!crcValid) allCrcValid = false;

    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    entries.set(entryName, {
      name: entryName,
      content,
      sizeBytes: content.length,
      sha256,
      crc32: actualCrc,
      method,
      crc32Valid: crcValid,
    });
  }

  return {
    validStructure: true,
    entryCount: entries.size,
    allCrcValid,
    entries,
  };
}
