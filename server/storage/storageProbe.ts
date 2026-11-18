import fs from 'node:fs';
import { getHostPlatformSnapshot } from '../config/runtime.ts';
import {
  createStorageProviders,
  type StorageProviderId,
  type StorageProviderProbeResult,
  type StorageVerificationReport,
} from './storageProvider.ts';

export interface SeparatedEnvironmentProbe {
  hostEnvironment: {
    environmentType: 'HOST_DEVELOPMENT';
    label: string;
    host: ReturnType<typeof getHostPlatformSnapshot>;
    provider: StorageProviderProbeResult;
  };
  androidDeviceEnvironment: {
    environmentType: 'ANDROID_DEVICE';
    targetDeviceModel: string;
    targetAndroidVersion: string;
    runningOnActualAndroidHardware: boolean;
    provider: StorageProviderProbeResult;
  };
  termuxEnvironment: {
    environmentType: 'TERMUX';
    termuxDetected: boolean;
    termuxPrefix: string;
    provider: StorageProviderProbeResult;
  };
  externalSdStorage: {
    environmentType: 'EXTERNAL_SD';
    archiveLocationConfirmedByOwner: boolean;
    provider: StorageProviderProbeResult;
  };
  selectedArchiveProvider: StorageProviderId;
  lastVerificationReport: StorageVerificationReport | null;
}

export function probeDeviceEnvironment(config: Record<string, string>): SeparatedEnvironmentProbe {
  const host = getHostPlatformSnapshot();
  const providers = createStorageProviders(config);

  const hostProbe = providers.host_dev.probe();
  const androidProbe = providers.android_saf.probe();
  const termuxProbe = providers.termux.probe();
  const sdProbe = providers.external_sd.probe();

  const runningOnActualAndroidHardware =
    Boolean(process.env.ANDROID_ROOT) || fs.existsSync('/system/build.prop');
  const termuxDetected =
    Boolean(process.env.TERMUX_VERSION) || fs.existsSync('/data/data/com.termux');

  const selectedRaw = config.selected_archive_provider as StorageProviderId | undefined;
  const selectedArchiveProvider: StorageProviderId =
    selectedRaw && selectedRaw in providers ? selectedRaw : 'external_sd';

  let lastVerificationReport: StorageVerificationReport | null = null;
  if (config.last_storage_verification_json) {
    try {
      lastVerificationReport = JSON.parse(
        config.last_storage_verification_json,
      ) as StorageVerificationReport;
    } catch {
      lastVerificationReport = null;
    }
  }

  return {
    hostEnvironment: {
      environmentType: 'HOST_DEVELOPMENT',
      label: `${host.platform} ${host.arch} · Node ${host.nodeVersion}`,
      host,
      provider: hostProbe,
    },
    androidDeviceEnvironment: {
      environmentType: 'ANDROID_DEVICE',
      targetDeviceModel: config.target_device_model || 'OPPO CPH1911',
      targetAndroidVersion: config.android_version || 'Android 11',
      runningOnActualAndroidHardware,
      provider: androidProbe,
    },
    termuxEnvironment: {
      environmentType: 'TERMUX',
      termuxDetected,
      termuxPrefix: config.termux_prefix || '',
      provider: termuxProbe,
    },
    externalSdStorage: {
      environmentType: 'EXTERNAL_SD',
      archiveLocationConfirmedByOwner: config.archive_location_confirmed === 'true',
      provider: sdProbe,
    },
    selectedArchiveProvider,
    lastVerificationReport,
  };
}

export function runProviderIntegrityTest(
  config: Record<string, string>,
  providerId: StorageProviderId,
): StorageVerificationReport {
  const providers = createStorageProviders(config);
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown storage provider: ${providerId}`);
  }
  return provider.runIntegrityVerification();
}
