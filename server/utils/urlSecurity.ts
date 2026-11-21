import dns from 'node:dns/promises';
import net from 'node:net';

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const RESERVED_ADMIN_PORTS = new Set([22, 23, 25, 53, 110, 135, 139, 445, 3306, 5432, 6379, 27017]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

function inCidr(ipInt: number, baseStr: string, maskBits: number): boolean {
  const base = ipv4ToInt(baseStr);
  if (base === null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

export function classifyIpAddress(ipRaw: string): {
  valid: boolean;
  isLoopback: boolean;
  isPrivate: boolean;
  isMetadataOrLinkLocal: boolean;
  isUnspecifiedOrMulticast: boolean;
} {
  let ip = ipRaw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  // Strip IPv6 zone id
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  // Unwrap IPv4-mapped IPv6 ::ffff:a.b.c.d
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      ip = mapped;
    }
  }

  if (net.isIPv4(ip)) {
    const val = ipv4ToInt(ip);
    if (val === null) {
      return { valid: false, isLoopback: false, isPrivate: false, isMetadataOrLinkLocal: false, isUnspecifiedOrMulticast: false };
    }
    const isLoopback = inCidr(val, '127.0.0.0', 8);
    const isMetadataOrLinkLocal =
      inCidr(val, '169.254.0.0', 16) ||
      inCidr(val, '100.64.0.0', 10);
    const isPrivate =
      inCidr(val, '10.0.0.0', 8) ||
      inCidr(val, '172.16.0.0', 12) ||
      inCidr(val, '192.168.0.0', 16);
    const isUnspecifiedOrMulticast =
      inCidr(val, '0.0.0.0', 8) ||
      inCidr(val, '224.0.0.0', 4) ||
      inCidr(val, '240.0.0.0', 4);
    return { valid: true, isLoopback, isPrivate, isMetadataOrLinkLocal, isUnspecifiedOrMulticast };
  }

  if (net.isIPv6(ip)) {
    const isLoopback = ip === '::1';
    const isUnspecifiedOrMulticast = ip === '::' || ip.startsWith('ff');
    const isMetadataOrLinkLocal = ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
    const isPrivate = ip.startsWith('fc') || ip.startsWith('fd');
    return { valid: true, isLoopback, isPrivate, isMetadataOrLinkLocal, isUnspecifiedOrMulticast };
  }

  return { valid: false, isLoopback: false, isPrivate: false, isMetadataOrLinkLocal: false, isUnspecifiedOrMulticast: false };
}

function getAllowedWorkerHostSet(): Set<string> {
  const raw = process.env.NG_ILMF_ALLOWED_WORKER_HOSTS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function validateWorkerEndpointUrl(rawUrl: string): {
  ok: boolean;
  normalizedUrl: string;
  hostname: string;
  port: number;
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, normalizedUrl: '', hostname: '', port: 0, reason: 'Invalid worker URL syntax' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      normalizedUrl: '',
      hostname: parsed.hostname,
      port: 0,
      reason: 'Worker endpoint must use http:// or https://',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      normalizedUrl: '',
      hostname: parsed.hostname,
      port: 0,
      reason: 'Blocked: Embedded credentials in worker URL are forbidden',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      normalizedUrl: '',
      hostname: parsed.hostname,
      port: 0,
      reason: 'Blocked: Query strings or fragments are not permitted in worker base endpoints',
    };
  }

  const host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { ok: false, normalizedUrl: '', hostname: '', port: 0, reason: 'Missing worker hostname' };
  }

  if (METADATA_HOSTS.has(host) || host.endsWith('.internal')) {
    return {
      ok: false,
      normalizedUrl: '',
      hostname: host,
      port: 0,
      reason: `Blocked SSRF target: metadata/internal hostname '${host}' is prohibited`,
    };
  }

  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, normalizedUrl: '', hostname: host, port: 0, reason: 'Invalid worker TCP port' };
  }

  if (RESERVED_ADMIN_PORTS.has(port)) {
    return {
      ok: false,
      normalizedUrl: '',
      hostname: host,
      port,
      reason: `Blocked SSRF target: system/database port ${port} cannot be probed as a training worker`,
    };
  }

  const allowPrivate = process.env.NG_ILMF_ALLOW_PRIVATE_WORKERS === 'true';
  const allowLocalWorkers = process.env.NG_ILMF_ALLOW_LOCAL_WORKERS !== 'false';
  const explicitAllowHosts = getAllowedWorkerHostSet();
  const isExplicitlyAllowed = explicitAllowHosts.has(host) || explicitAllowHosts.has(`${host}:${port}`);

  const configuredPort = Number(process.env.PORT || 3000) || 3000;
  const blockedSelfPorts = new Set([configuredPort, 3000]);
  const ipClass = classifyIpAddress(host);

  if (ipClass.valid) {
    if (ipClass.isMetadataOrLinkLocal || ipClass.isUnspecifiedOrMulticast) {
      return {
        ok: false,
        normalizedUrl: '',
        hostname: host,
        port,
        reason: `Blocked SSRF IP target '${host}' (link-local/metadata/unspecified/multicast)`,
      };
    }

    if (ipClass.isLoopback) {
      if (blockedSelfPorts.has(port) && !isExplicitlyAllowed) {
        return {
          ok: false,
          normalizedUrl: '',
          hostname: host,
          port,
          reason: `Blocked SSRF self-target: Command Center port (${port}) cannot be registered as a training worker`,
        };
      }
      if (!allowLocalWorkers && !isExplicitlyAllowed) {
        return {
          ok: false,
          normalizedUrl: '',
          hostname: host,
          port,
          reason: 'Blocked loopback worker: NG_ILMF_ALLOW_LOCAL_WORKERS is disabled',
        };
      }
    }

    if (ipClass.isPrivate && !allowPrivate && !isExplicitlyAllowed) {
      return {
        ok: false,
        normalizedUrl: '',
        hostname: host,
        port,
        reason: `Blocked SSRF private network IP '${host}'. Add host to NG_ILMF_ALLOWED_WORKER_HOSTS or set NG_ILMF_ALLOW_PRIVATE_WORKERS=true for authorized LAN GPU nodes.`,
      };
    }
  } else {
    // Domain hostname checks
    if (host === 'localhost' || host.endsWith('.localhost')) {
      if (blockedSelfPorts.has(port) && !isExplicitlyAllowed) {
        return {
          ok: false,
          normalizedUrl: '',
          hostname: host,
          port,
          reason: `Blocked SSRF self-target: localhost:${port} belongs to Command Center`,
        };
      }
      if (!allowLocalWorkers && !isExplicitlyAllowed) {
        return {
          ok: false,
          normalizedUrl: '',
          hostname: host,
          port,
          reason: 'Blocked localhost worker: NG_ILMF_ALLOW_LOCAL_WORKERS is disabled',
        };
      }
    }
  }

  const normalizedUrl = parsed.toString().replace(/\/+$/, '');
  return {
    ok: true,
    normalizedUrl,
    hostname: host,
    port,
  };
}

/**
 * Runtime DNS-rebinding & SSRF pre-flight check before outbound fetch() to a worker.
 */
export async function assertWorkerUrlSafeBeforeFetch(rawUrl: string): Promise<string> {
  const staticCheck = validateWorkerEndpointUrl(rawUrl);
  if (!staticCheck.ok) {
    throw new Error(staticCheck.reason || 'Blocked unsafe worker URL');
  }

  const { hostname, port, normalizedUrl } = staticCheck;
  const ipClass = classifyIpAddress(hostname);
  if (!ipClass.valid && hostname !== 'localhost' && !hostname.endsWith('.localhost')) {
    const allowPrivate = process.env.NG_ILMF_ALLOW_PRIVATE_WORKERS === 'true';
    const explicitAllowHosts = getAllowedWorkerHostSet();
    const isExplicitlyAllowed = explicitAllowHosts.has(hostname) || explicitAllowHosts.has(`${hostname}:${port}`);

    try {
      const records = await dns.lookup(hostname, { all: true });
      for (const rec of records) {
        const resolvedClass = classifyIpAddress(rec.address);
        if (resolvedClass.isMetadataOrLinkLocal || resolvedClass.isUnspecifiedOrMulticast) {
          throw new Error(`Blocked DNS SSRF resolution: ${hostname} resolved to ${rec.address}`);
        }
        if (resolvedClass.isPrivate && !allowPrivate && !isExplicitlyAllowed) {
          throw new Error(`Blocked DNS SSRF private network resolution: ${hostname} -> ${rec.address}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Blocked')) {
        throw err;
      }
      // If offline/unreachable hostname, fetch() itself will report clean network error
    }
  }

  return normalizedUrl;
}
