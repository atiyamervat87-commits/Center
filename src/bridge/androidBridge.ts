export interface NativeAndroidBridgeInterface {
  getDiagnosticsJson(): string;
  openArchiveDocumentTree(requestId: string): void;
  openArchiveDocumentTreeWithHint?(requestId: string, initialUri?: string | null): void;
  verifySafUriPermissionsJson(uriString: string): string;
  runSafSha256ProbeJson(uriString: string): string;
  runSafSha256ProbeAsync?(requestId: string, uriString: string): void;
  revokeSafUriPermissionJson(uriString: string): string;
}

export interface NativeAndroidDiagnosticsPayload {
  isNativeAndroid: boolean;
  manufacturer?: string;
  model: string;
  androidRelease: string;
  sdkInt: number;
  termuxPackageInstalled: boolean;
  persistedUriPermissions: Array<{
    uri: string;
    isReadPermission: boolean;
    isWritePermission: boolean;
    persistedTime: number;
  }>;
}

export interface TreePickerResult {
  cancelled: boolean;
  authorized: boolean;
  uri?: string;
  displayName?: string;
  state?: string;
  readable?: boolean;
  writable?: boolean;
  revoked?: boolean;
  model?: string;
  sdkInt?: number;
  reason?: string;
}

export interface SafSha256ProbeResult {
  isNativeAndroidExecution: boolean;
  uri: string;
  testFileName?: string;
  state: string;
  storageReady: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  contentMatched: boolean;
  cleanupCompleted: boolean;
  failureReason?: string;
}

declare global {
  interface Window {
    NgIlmfAndroidBridge?: NativeAndroidBridgeInterface;
    __ngIlmfAndroidBridgeCallback?: (requestId: string, payload: unknown) => void;
  }
}

const pendingBridgeRequests = new Map<string, (result: unknown) => void>();

if (typeof window !== 'undefined') {
  window.__ngIlmfAndroidBridgeCallback = (requestId: string, payload: unknown) => {
    const resolver = pendingBridgeRequests.get(requestId);
    if (resolver) {
      pendingBridgeRequests.delete(requestId);
      resolver(payload);
    }
  };
}

export function isNativeAndroidWrapperAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.NgIlmfAndroidBridge);
}

export function getNativeAndroidDiagnostics(): NativeAndroidDiagnosticsPayload | null {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return null;
  }
  try {
    const raw = window.NgIlmfAndroidBridge.getDiagnosticsJson();
    return JSON.parse(raw) as NativeAndroidDiagnosticsPayload;
  } catch {
    return null;
  }
}

export function launchAndroidDocumentTreePicker(): Promise<TreePickerResult> {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return Promise.resolve({
      cancelled: false,
      authorized: false,
      state: 'NOT_MOUNTED',
      reason:
        'Native Android Bridge (window.NgIlmfAndroidBridge) is not present in this browser/host environment. Build and run the APK wrapper in /android on OPPO CPH1911.',
    });
  }

  const requestId = `tree_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      if (pendingBridgeRequests.has(requestId)) {
        pendingBridgeRequests.delete(requestId);
        resolve({
          cancelled: true,
          authorized: false,
          reason: 'Timed out waiting for Android ACTION_OPEN_DOCUMENT_TREE result',
        });
      }
    }, 120000);

    pendingBridgeRequests.set(requestId, (result) => {
      window.clearTimeout(timeout);
      resolve(result as TreePickerResult);
    });

    window.NgIlmfAndroidBridge!.openArchiveDocumentTree(requestId);
  });
}

export function verifyNativeSafUri(uriString: string): TreePickerResult {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return {
      cancelled: false,
      authorized: false,
      state: 'NOT_AUTHORIZED',
      reason: 'Native Android Bridge unavailable in host browser.',
    };
  }
  const raw = window.NgIlmfAndroidBridge.verifySafUriPermissionsJson(uriString);
  return JSON.parse(raw) as TreePickerResult;
}

export function runNativeSafSha256Probe(uriString: string): SafSha256ProbeResult {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return {
      isNativeAndroidExecution: false,
      uri: uriString,
      state: 'NOT_MOUNTED',
      storageReady: false,
      contentMatched: false,
      cleanupCompleted: false,
      failureReason: 'Native Android Bridge unavailable in host browser.',
    };
  }
  const raw = window.NgIlmfAndroidBridge.runSafSha256ProbeJson(uriString);
  return JSON.parse(raw) as SafSha256ProbeResult;
}

export function runNativeSafSha256ProbeAsync(uriString: string): Promise<SafSha256ProbeResult> {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return Promise.resolve(runNativeSafSha256Probe(uriString));
  }
  if (!window.NgIlmfAndroidBridge.runSafSha256ProbeAsync) {
    return Promise.resolve(runNativeSafSha256Probe(uriString));
  }
  const requestId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      if (pendingBridgeRequests.has(requestId)) {
        pendingBridgeRequests.delete(requestId);
        resolve({
          isNativeAndroidExecution: true,
          uri: uriString,
          state: 'VERIFY_FAILED',
          storageReady: false,
          contentMatched: false,
          cleanupCompleted: false,
          failureReason: 'Timed out waiting for Android SAF integrity probe',
        });
      }
    }, 30000);

    pendingBridgeRequests.set(requestId, (result) => {
      window.clearTimeout(timeout);
      resolve(result as SafSha256ProbeResult);
    });

    window.NgIlmfAndroidBridge!.runSafSha256ProbeAsync!(requestId, uriString);
  });
}

export function revokeNativeSafUri(uriString: string): { revoked: boolean; error?: string } {
  if (!isNativeAndroidWrapperAvailable() || !window.NgIlmfAndroidBridge) {
    return { revoked: true };
  }
  const raw = window.NgIlmfAndroidBridge.revokeSafUriPermissionJson(uriString);
  return JSON.parse(raw) as { revoked: boolean; error?: string };
}
