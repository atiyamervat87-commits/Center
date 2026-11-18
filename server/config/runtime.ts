import path from 'node:path';
import os from 'node:os';

export interface RuntimePathsConfig {
  dataDir: string;
  dbPath: string;
  sdArchivePath: string;
  termuxPrefix: string;
  targetDeviceModel: string;
  androidVersion: string;
  bridgeEndpoint: string;
}

export function getDefaultRuntimeConfig(): RuntimePathsConfig {
  const cwd = process.cwd();
  const dataDir = process.env.NG_ILMF_DATA_DIR || path.join(cwd, 'var', 'ng-ilmf');
  return {
    dataDir,
    dbPath: process.env.NG_ILMF_DB_PATH || path.join(dataDir, 'ng_ilmf_command.sqlite'),
    sdArchivePath:
      process.env.NG_ILMF_SD_ARCHIVE_PATH || '/storage/857A-1AED/V5/NG-ILMF_ARCHIVE',
    termuxPrefix: process.env.PREFIX || process.env.NG_ILMF_TERMUX_PREFIX || '/data/data/com.termux/files/usr',
    targetDeviceModel: process.env.NG_ILMF_DEVICE_MODEL || 'OPPO CPH1911',
    androidVersion: process.env.NG_ILMF_ANDROID_VERSION || 'Android 11',
    bridgeEndpoint: process.env.NG_ILMF_BRIDGE_URL || '',
  };
}

export function getHostPlatformSnapshot() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    nodeVersion: process.version,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuCount: os.cpus().length,
    uptimeSeconds: Math.floor(os.uptime()),
  };
}
