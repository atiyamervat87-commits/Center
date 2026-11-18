import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap, setConfigValue } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';

export interface SecurityPermissions {
  exportRequiresAuth: boolean;
  deleteRequiresAuth: boolean;
  pairingRequiresAuth: boolean;
}

export interface OwnerSessionRecord {
  id: string;
  deviceLabel: string;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
  isCurrent: boolean;
}

export interface SecuritySnapshot {
  ownerLockConfigured: boolean;
  sessionAuthenticated: boolean;
  activeSessionId: string | null;
  permissions: SecurityPermissions;
  sessions: OwnerSessionRecord[];
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

export function getSecurityPermissions(config: Record<string, string>): SecurityPermissions {
  return {
    exportRequiresAuth: config.perm_export_requires_auth !== 'false',
    deleteRequiresAuth: config.perm_delete_requires_auth !== 'false',
    pairingRequiresAuth: config.perm_pairing_requires_auth !== 'false',
  };
}

export function validateOwnerToken(
  db: DatabaseSync,
  rawToken: string | undefined,
): { valid: boolean; sessionId: string | null } {
  if (!rawToken || !rawToken.trim()) {
    return { valid: false, sessionId: null };
  }
  const tokenHash = hashSessionToken(rawToken.trim());
  const row = db
    .prepare(
      'SELECT id, expires_at, revoked FROM owner_sessions WHERE session_token_hash = ?',
    )
    .get(tokenHash) as { id: string; expires_at: string; revoked: number } | undefined;

  if (!row || row.revoked === 1) {
    return { valid: false, sessionId: null };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { valid: false, sessionId: null };
  }
  return { valid: true, sessionId: row.id };
}

export function isAuthorizedForAction(
  db: DatabaseSync,
  actionType: 'export' | 'delete' | 'pairing',
  rawToken: string | undefined,
): { allowed: boolean; reason: string | null } {
  const config = getConfigMap(db);
  const ownerLockConfigured = Boolean(config.owner_passkey_hash);
  if (!ownerLockConfigured) {
    return { allowed: true, reason: null };
  }

  const perms = getSecurityPermissions(config);
  const requiresAuth =
    actionType === 'export'
      ? perms.exportRequiresAuth
      : actionType === 'delete'
        ? perms.deleteRequiresAuth
        : perms.pairingRequiresAuth;

  if (!requiresAuth) {
    return { allowed: true, reason: null };
  }

  const tokenCheck = validateOwnerToken(db, rawToken);
  if (!tokenCheck.valid) {
    recordAuditEvent(db, {
      actor: 'UNAUTHENTICATED',
      category: 'SECURITY',
      action: `BLOCK_UNAUTHORIZED_${actionType.toUpperCase()}`,
      target: actionType,
      outcome: 'BLOCKED',
      details: { reason: 'Missing or invalid owner session token' },
    });
    return {
      allowed: false,
      reason: `Owner authorization required for ${actionType}. Sign in via Owner Security Center.`,
    };
  }

  return { allowed: true, reason: null };
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

  const sessions: OwnerSessionRecord[] = rows.map((r) => ({
    id: r.id,
    deviceLabel: r.device_label,
    expiresAt: r.expires_at,
    revoked: r.revoked === 1,
    createdAt: r.created_at,
    isCurrent: tokenStatus.sessionId === r.id,
  }));

  return {
    ownerLockConfigured,
    sessionAuthenticated: tokenStatus.valid,
    activeSessionId: tokenStatus.sessionId,
    permissions: getSecurityPermissions(config),
    sessions,
  };
}

export function setupOwnerPasskey(
  db: DatabaseSync,
  input: { passkey: string; deviceLabel?: string; currentToken?: string },
): { sessionId: string; sessionToken: string; snapshot: SecuritySnapshot } {
  const passkey = input.passkey.trim();
  if (passkey.length < 6) {
    throw new Error('Owner passkey must be at least 6 characters.');
  }

  const config = getConfigMap(db);
  if (config.owner_passkey_hash) {
    const valid = validateOwnerToken(db, input.currentToken);
    if (!valid.valid) {
      throw new Error('Active owner session required to rotate an existing passkey.');
    }
  }

  const hashed = hashPasskey(passkey);
  setConfigValue(db, 'owner_passkey_hash', hashed, 'Salted scrypt owner passkey hash');

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'SECURITY',
    action: config.owner_passkey_hash ? 'ROTATE_OWNER_PASSKEY' : 'SETUP_OWNER_PASSKEY',
    target: 'owner_passkey_hash',
    outcome: 'PASS',
    details: { algorithm: 'scrypt' },
  });

  return createOwnerSessionRecord(db, input.deviceLabel || 'Owner Console');
}

export function loginOwnerSession(
  db: DatabaseSync,
  input: { passkey: string; deviceLabel?: string },
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

  return createOwnerSessionRecord(db, input.deviceLabel || 'Owner Console');
}

function createOwnerSessionRecord(
  db: DatabaseSync,
  deviceLabel: string,
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
  ).run(sessionId, tokenHash, deviceLabel.trim() || 'Owner Console', expiresAt, now.toISOString());

  recordAuditEvent(db, {
    actor: 'OWNER',
    category: 'SECURITY',
    action: 'CREATE_OWNER_SESSION',
    target: `${sessionId} (${deviceLabel})`,
    outcome: 'PASS',
    details: { expiresAt },
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
  const config = getConfigMap(db);
  if (config.owner_passkey_hash && !validateOwnerToken(db, rawToken).valid) {
    throw new Error('Active owner session required to revoke sessions.');
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
  const config = getConfigMap(db);
  if (config.owner_passkey_hash && !validateOwnerToken(db, rawToken).valid) {
    throw new Error('Active owner session required to modify security permissions.');
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
