import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap, setConfigValue } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { writeFileAtomic } from '../utils/fsAtomic.ts';

export type SessionRole = 'OWNER' | 'OPERATOR' | 'VIEWER';

export interface SecurityPermissions {
  exportRequiresAuth: boolean;
  deleteRequiresAuth: boolean;
  pairingRequiresAuth: boolean;
}

export interface OwnerSessionRecord {
  id: string;
  deviceLabel: string;
  role: SessionRole;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
  isCurrent: boolean;
}

export interface SecuritySnapshot {
  ownerLockConfigured: boolean;
  bootstrapTokenRequired: boolean;
  sessionAuthenticated: boolean;
  activeSessionId: string | null;
  activeRole: SessionRole | null;
  permissions: SecurityPermissions;
  sessions: OwnerSessionRecord[];
}

const SECRET_CONFIG_KEYS = new Set([
  'owner_passkey_hash',
  'owner_bootstrap_secret',
  'bootstrap_token_hash',
  'android_attestation_hmac_key',
  'android_attestation_challenges_json',
  'worker_shared_secret',
  'worker_hmac_secrets_json',
]);

export function sanitizeConfigForClient(config: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    const lower = k.toLowerCase();
    if (
      SECRET_CONFIG_KEYS.has(k) ||
      lower.endsWith('_hash') ||
      lower.endsWith('_secret') ||
      lower.endsWith('_token') ||
      lower.includes('hmac') ||
      lower.includes('passkey')
    ) {
      continue;
    }
    safe[k] = v;
  }
  safe.owner_lock_configured = config.owner_passkey_hash ? 'true' : 'false';
  return safe;
}

interface RateLimitBucket {
  failures: number[];
  lockedUntilMs: number;
}

const authRateBuckets = new Map<string, RateLimitBucket>();
const RATE_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES = 5;
const LOCKOUT_DURATION_MS = 120_000;

export function checkAuthRateLimit(clientKey: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const key = clientKey || 'unknown';
  const bucket = authRateBuckets.get(key);
  if (!bucket) return { allowed: true, retryAfterSeconds: 0 };

  if (bucket.lockedUntilMs > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntilMs - now) / 1000)),
    };
  }

  bucket.failures = bucket.failures.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (bucket.failures.length === 0 && bucket.lockedUntilMs <= now) {
    authRateBuckets.delete(key);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordAuthFailure(clientKey: string): void {
  const now = Date.now();
  const key = clientKey || 'unknown';
  const bucket = authRateBuckets.get(key) ?? { failures: [], lockedUntilMs: 0 };
  bucket.failures = bucket.failures.filter((ts) => now - ts < RATE_WINDOW_MS);
  bucket.failures.push(now);
  if (bucket.failures.length >= MAX_AUTH_FAILURES) {
    bucket.lockedUntilMs = now + LOCKOUT_DURATION_MS;
  }
  authRateBuckets.set(key, bucket);
}

export function clearAuthFailures(clientKey: string): void {
  authRateBuckets.delete(clientKey || 'unknown');
}

export function resetAuthRateLimiterForTests(): void {
  authRateBuckets.clear();
}

function hashPasskey(passkey: string, saltHex?: string): string {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passkey, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasskey(passkey: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(passkey, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expectedBuf);
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function ensureLocalBootstrapFile(db: DatabaseSync): string | null {
  const config = getConfigMap(db);
  if (config.owner_passkey_hash) return null;
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const tokenFile = path.join(dataDir, '.bootstrap_token');
  if (fs.existsSync(tokenFile)) {
    return fs.readFileSync(tokenFile, 'utf-8').trim() || null;
  }
  const generated = `ng_boot_${crypto.randomBytes(12).toString('hex')}`;
  writeFileAtomic(tokenFile, `${generated}\n`, 'utf-8');
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  return generated;
}

function verifyBootstrapAuthorization(
  db: DatabaseSync,
  suppliedBootstrapToken: string | undefined,
  isRemoteHttpRequest: boolean,
): void {
  const envBootstrap = (process.env.NG_ILMF_BOOTSTRAP_TOKEN ?? '').trim();
  const supplied = (suppliedBootstrapToken ?? '').trim();

  if (envBootstrap) {
    if (!supplied || !timingSafeTextEqual(supplied, envBootstrap)) {
      throw new Error('Invalid or missing NG_ILMF_BOOTSTRAP_TOKEN required for initial owner claim.');
    }
    return;
  }

  const config = getConfigMap(db);
  const dataDir = path.resolve(config.data_dir || process.cwd());
  const tokenFile = path.join(dataDir, '.bootstrap_token');

  if (isRemoteHttpRequest) {
    if (!fs.existsSync(tokenFile)) {
      throw new Error(
        'Initial owner setup from remote hosts requires NG_ILMF_BOOTSTRAP_TOKEN env var or host .bootstrap_token.',
      );
    }
    const fileToken = fs.readFileSync(tokenFile, 'utf-8').trim();
    if (!supplied || !fileToken || !timingSafeTextEqual(supplied, fileToken)) {
      throw new Error('Blocked: Valid bootstrap token is required for remote initial owner claim.');
    }
  }
}

export function getSecurityPermissions(config: Record<string, string>): SecurityPermissions {
  return {
    exportRequiresAuth: config.perm_export_requires_auth !== 'false',
    deleteRequiresAuth: config.perm_delete_requires_auth !== 'false',
    pairingRequiresAuth: config.perm_pairing_requires_auth !== 'false',
  };
}

function encodeDeviceLabelWithRole(deviceLabel: string, role: SessionRole): string {
  const cleanLabel = (deviceLabel || 'Owner Console').replace(/\[role:[^\]]+\]/gi, '').trim() || 'Owner Console';
  return `${cleanLabel} [role:${role}]`;
}

function parseDeviceLabelAndRole(raw: string): { deviceLabel: string; role: SessionRole } {
  const match = raw.match(/\[role:(OWNER|OPERATOR|VIEWER)\]\s*$/i);
  if (!match) {
    return { deviceLabel: raw, role: 'OWNER' };
  }
  const role = match[1].toUpperCase() as SessionRole;
  const deviceLabel = raw.slice(0, match.index).trim() || 'Console';
  return { deviceLabel, role };
}

export function validateOwnerToken(
  db: DatabaseSync,
  rawToken: string | undefined,
): { valid: boolean; sessionId: string | null; role: SessionRole | null; expired: boolean } {
  if (!rawToken || !rawToken.trim()) {
    return { valid: false, sessionId: null, role: null, expired: false };
  }
  const tokenHash = hashSessionToken(rawToken.trim());
  const row = db
    .prepare(
      'SELECT id, device_label, expires_at, revoked FROM owner_sessions WHERE session_token_hash = ?',
    )
    .get(tokenHash) as { id: string; device_label: string; expires_at: string; revoked: number } | undefined;

  if (!row || row.revoked === 1) {
    return { valid: false, sessionId: null, role: null, expired: false };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('UPDATE owner_sessions SET revoked = 1 WHERE id = ?').run(row.id);
    return { valid: false, sessionId: null, role: null, expired: true };
  }
  const parsed = parseDeviceLabelAndRole(row.device_label);
  return { valid: true, sessionId: row.id, role: parsed.role, expired: false };
}

export function isAuthorizedForAction(
  db: DatabaseSync,
  actionType: 'export' | 'delete' | 'pairing' | 'mutate' | 'admin',
  rawToken: string | undefined,
): { allowed: boolean; reason: string | null; role?: SessionRole | null } {
  const config = getConfigMap(db);
  const ownerLockConfigured = Boolean(config.owner_passkey_hash);

  // SECURITY MANDATE: Never permit sensitive actions before Owner Lock is initialized!
  if (!ownerLockConfigured) {
    recordAuditEvent(db, {
      actor: 'UNAUTHENTICATED',
      category: 'SECURITY',
      action: `BLOCK_PRE_LOCK_SETUP_${actionType.toUpperCase()}`,
      target: actionType,
      outcome: 'BLOCKED',
      details: { reason: 'Owner Lock passkey must be configured before sensitive actions' },
    });
    return {
      allowed: false,
      reason: 'Blocked: Configure Owner Lock passkey via Security Center before executing sensitive factory operations.',
    };
  }

  const tokenCheck = validateOwnerToken(db, rawToken);
  if (!tokenCheck.valid) {
    recordAuditEvent(db, {
      actor: 'UNAUTHENTICATED',
      category: 'SECURITY',
      action: `BLOCK_UNAUTHORIZED_${actionType.toUpperCase()}`,
      target: actionType,
      outcome: 'BLOCKED',
      details: {
        reason: tokenCheck.expired
          ? 'Owner session token expired'
          : 'Missing or invalid owner session token',
      },
    });
    return {
      allowed: false,
      reason: tokenCheck.expired
        ? 'Owner session expired. Sign in again via Owner Security Center.'
        : `Owner authorization required for ${actionType}. Sign in via Owner Security Center.`,
    };
  }

  // Enforce RBAC role restrictions
  const role = tokenCheck.role ?? 'OWNER';
  if (role === 'VIEWER') {
    return {
      allowed: false,
      reason: `Role VIEWER is read-only and cannot perform '${actionType}'.`,
      role,
    };
  }
  if (role === 'OPERATOR' && (actionType === 'admin' || actionType === 'delete')) {
    return {
      allowed: false,
      reason: `Role OPERATOR lacks privilege for '${actionType}'. OWNER session required.`,
      role,
    };
  }

  return { allowed: true, reason: null, role };
}

export function getSecuritySnapshot(db: DatabaseSync, rawToken?: string): SecuritySnapshot {
  const config = getConfigMap(db);
  const ownerLockConfigured = Boolean(config.owner_passkey_hash);
  const tokenStatus = validateOwnerToken(db, rawToken);

  const rows = db
    .prepare(
      'SELECT id, device_label, expires_at, revoked, created_at FROM owner_sessions ORDER BY created_at DESC LIMIT 25',
    )
    .all() as unknown as Array<{
    id: string;
    device_label: string;
    expires_at: string;
    revoked: number;
    created_at: string;
  }>;

  const sessions: OwnerSessionRecord[] = rows.map((r) => {
    const parsed = parseDeviceLabelAndRole(r.device_label);
    return {
      id: r.id,
      deviceLabel: parsed.deviceLabel,
      role: parsed.role,
      expiresAt: r.expires_at,
      revoked: r.revoked === 1 || new Date(r.expires_at).getTime() <= Date.now(),
      createdAt: r.created_at,
      isCurrent: tokenStatus.sessionId === r.id,
    };
  });

  return {
    ownerLockConfigured,
    bootstrapTokenRequired: !ownerLockConfigured && Boolean(process.env.NG_ILMF_BOOTSTRAP_TOKEN?.trim()),
    sessionAuthenticated: tokenStatus.valid,
    activeSessionId: tokenStatus.sessionId,
    activeRole: tokenStatus.role,
    permissions: getSecurityPermissions(config),
    sessions,
  };
}

export function setupOwnerPasskey(
  db: DatabaseSync,
  input: {
    passkey: string;
    deviceLabel?: string;
    currentToken?: string;
    bootstrapToken?: string;
    isRemoteHttpRequest?: boolean;
  },
): { sessionId: string; sessionToken: string; snapshot: SecuritySnapshot } {
  const passkey = input.passkey.trim();
  if (passkey.length < 8) {
    throw new Error('Owner passkey must be at least 8 characters.');
  }

  const config = getConfigMap(db);
  if (config.owner_passkey_hash) {
    const valid = validateOwnerToken(db, input.currentToken);
    if (!valid.valid || valid.role !== 'OWNER') {
      throw new Error('Active OWNER session required to rotate an existing passkey.');
    }
  } else {
    verifyBootstrapAuthorization(db, input.bootstrapToken, Boolean(input.isRemoteHttpRequest));
  }

  const hashed = hashPasskey(passkey);

  if (!config.owner_passkey_hash) {
    // Atomic first-claim check in SQLite to prevent race hijack
    const now = new Date().toISOString();
    const res = db
      .prepare(
        "UPDATE system_config SET value = ?, updated_at = ? WHERE key = 'owner_passkey_hash' AND (value IS NULL OR value = '')",
      )
      .run(hashed, now);

    if (res.changes === 0) {
      const existingCheck = getConfigMap(db).owner_passkey_hash;
      if (existingCheck) {
        throw new Error('Owner passkey was already initialized by another request.');
      }
      setConfigValue(db, 'owner_passkey_hash', hashed, 'Salted scrypt owner passkey hash');
    }

    // Consume one-time local bootstrap file if present
    const dataDir = path.resolve(config.data_dir || process.cwd());
    const tokenFile = path.join(dataDir, '.bootstrap_token');
    if (fs.existsSync(tokenFile)) {
      try {
        fs.unlinkSync(tokenFile);
      } catch {
        // ignore cleanup failure
      }
    }
  } else {
    setConfigValue(db, 'owner_passkey_hash', hashed, 'Salted scrypt owner passkey hash');
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'SECURITY',
    action: config.owner_passkey_hash ? 'ROTATE_OWNER_PASSKEY' : 'SETUP_OWNER_PASSKEY',
    target: 'owner_passkey_hash',
    outcome: 'PASS',
    details: { algorithm: 'scrypt' },
  });

  return createOwnerSessionRecord(db, input.deviceLabel || 'Owner Console', 'OWNER');
}

export function loginOwnerSession(
  db: DatabaseSync,
  input: { passkey: string; deviceLabel?: string; role?: SessionRole },
): { sessionId: string; sessionToken: string; snapshot: SecuritySnapshot } {
  const config = getConfigMap(db);
  if (!config.owner_passkey_hash) {
    throw new Error('Owner passkey has not been configured yet.');
  }

  if (!verifyPasskey(input.passkey.trim(), config.owner_passkey_hash)) {
    recordAuditEvent(db, {
      actor: 'UNKNOWN',
      category: 'SECURITY',
      action: 'OWNER_LOGIN_FAILED',
      target: input.deviceLabel || 'Console',
      outcome: 'FAIL',
      details: { reason: 'Invalid passkey' },
    });
    throw new Error('Invalid owner passkey.');
  }

  const requestedRole: SessionRole =
    input.role === 'OPERATOR' || input.role === 'VIEWER' ? input.role : 'OWNER';
  return createOwnerSessionRecord(db, input.deviceLabel || 'Owner Console', requestedRole);
}

function createOwnerSessionRecord(
  db: DatabaseSync,
  deviceLabel: string,
  role: SessionRole,
): { sessionId: string; sessionToken: string; snapshot: SecuritySnapshot } {
  const sessionId = `SES-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const sessionToken = `ng_owner_${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = hashSessionToken(sessionToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `
    INSERT INTO owner_sessions (id, session_token_hash, device_label, expires_at, revoked, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `,
  ).run(
    sessionId,
    tokenHash,
    encodeDeviceLabelWithRole(deviceLabel, role),
    expiresAt,
    now.toISOString(),
  );

  recordAuditEvent(db, {
    actor: role,
    category: 'SECURITY',
    action: 'CREATE_OWNER_SESSION',
    target: `${sessionId} (${deviceLabel})`,
    outcome: 'PASS',
    details: { expiresAt, role },
  });

  return {
    sessionId,
    sessionToken,
    snapshot: getSecuritySnapshot(db, sessionToken),
  };
}

export function revokeOwnerSession(
  db: DatabaseSync,
  sessionId: string,
  rawToken?: string,
): SecuritySnapshot {
  const auth = isAuthorizedForAction(db, 'admin', rawToken);
  if (!auth.allowed) {
    throw new Error(auth.reason || 'Active OWNER session required to revoke sessions.');
  }

  const res = db
    .prepare('UPDATE owner_sessions SET revoked = 1 WHERE id = ?')
    .run(sessionId);

  if (res.changes === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'SECURITY',
    action: 'REVOKE_OWNER_SESSION',
    target: sessionId,
    outcome: 'PASS',
    details: { revoked: true },
  });

  return getSecuritySnapshot(db, rawToken);
}

export function updateSecurityPermissions(
  db: DatabaseSync,
  permissions: Partial<SecurityPermissions>,
  rawToken?: string,
): SecuritySnapshot {
  const auth = isAuthorizedForAction(db, 'admin', rawToken);
  if (!auth.allowed) {
    throw new Error(auth.reason || 'Active OWNER session required to modify security permissions.');
  }

  if (typeof permissions.exportRequiresAuth === 'boolean') {
    setConfigValue(
      db,
      'perm_export_requires_auth',
      permissions.exportRequiresAuth ? 'true' : 'false',
    );
  }
  if (typeof permissions.deleteRequiresAuth === 'boolean') {
    setConfigValue(
      db,
      'perm_delete_requires_auth',
      permissions.deleteRequiresAuth ? 'true' : 'false',
    );
  }
  if (typeof permissions.pairingRequiresAuth === 'boolean') {
    setConfigValue(
      db,
      'perm_pairing_requires_auth',
      permissions.pairingRequiresAuth ? 'true' : 'false',
    );
  }

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'SECURITY',
    action: 'UPDATE_PERMISSION_CONTROLS',
    target: 'owner_permissions',
    outcome: 'PASS',
    details: permissions as Record<string, unknown>,
  });

  return getSecuritySnapshot(db, rawToken);
}
