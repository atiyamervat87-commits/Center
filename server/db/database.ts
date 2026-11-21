import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDefaultRuntimeConfig } from '../config/runtime.ts';

let dbInstance: DatabaseSync | null = null;

export function setDatabaseForTests(db: DatabaseSync | null): void {
  dbInstance = db;
}

export function getDatabase(): DatabaseSync {
  if (dbInstance) {
    return dbInstance;
  }

  const defaults = getDefaultRuntimeConfig();
  const dbDir = path.dirname(defaults.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new DatabaseSync(defaults.dbPath);
  const schemaPath = path.resolve(process.cwd(), 'server', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  bootstrapDefaultConfig(db, defaults);
  dbInstance = db;
  return db;
}

function bootstrapDefaultConfig(
  db: DatabaseSync,
  defaults: ReturnType<typeof getDefaultRuntimeConfig>,
) {
  const now = new Date().toISOString();
  const initialEntries: Array<{ key: string; value: string; description: string }> = [
    {
      key: 'data_dir',
      value: defaults.dataDir,
      description: 'Internal workspace storage root for SQLite and local factory artifacts',
    },
    {
      key: 'sd_archive_path',
      value: defaults.sdArchivePath,
      description: 'External SD Card Smart Archive directory path',
    },
    {
      key: 'termux_prefix',
      value: defaults.termuxPrefix,
      description: 'Configurable Termux / Android binary prefix path',
    },
    {
      key: 'target_device_model',
      value: defaults.targetDeviceModel,
      description: 'Target handset hardware profile',
    },
    {
      key: 'android_version',
      value: defaults.androidVersion,
      description: 'Target Android operating system version',
    },
    {
      key: 'bridge_endpoint',
      value: defaults.bridgeEndpoint,
      description: 'HTTP(S) endpoint of paired Computer Training Bridge worker (empty if unconfigured)',
    },
    {
      key: 'selected_archive_provider',
      value: 'external_sd',
      description: 'Owner-selected storage provider for Smart Archive (external_sd, android_saf, termux, host_dev)',
    },
    {
      key: 'archive_location_confirmed',
      value: 'false',
      description: 'Explicit owner confirmation flag before initializing NG-ILMF_ARCHIVE',
    },
    {
      key: 'android_saf_uri',
      value: '',
      description: 'Persisted Android Storage Access Framework tree URI (when running on Android)',
    },
    {
      key: 'termux_shared_path',
      value: '/data/data/com.termux/files/home/storage/shared',
      description: 'Configurable Termux shared/external storage path',
    },
    {
      key: 'last_storage_verification_json',
      value: '',
      description: 'Latest verified SHA-256 read/write storage probe report JSON',
    },
    {
      key: 'android_native_attestation_json',
      value: '',
      description: 'Genuine native Android APK wrapper attestation payload (never populated by host)',
    },
    {
      key: 'perm_export_requires_auth',
      value: 'true',
      description: 'Require active Owner Session before exporting project or package reports',
    },
    {
      key: 'perm_delete_requires_auth',
      value: 'true',
      description: 'Require active Owner Session before executing owner-approved file cleanup',
    },
    {
      key: 'perm_pairing_requires_auth',
      value: 'true',
      description: 'Require active Owner Session before modifying device or worker pairing config',
    },
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO system_config (key, value, description, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const entry of initialEntries) {
    insertStmt.run(entry.key, entry.value, entry.description, now);
  }
}

export function getConfigMap(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM system_config').all() as Array<{
    key: string;
    value: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function setConfigValue(
  db: DatabaseSync,
  key: string,
  value: string,
  description?: string,
) {
  const now = new Date().toISOString();
  if (description !== undefined) {
    db.prepare(`
      INSERT INTO system_config (key, value, description, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = excluded.description,
        updated_at = excluded.updated_at
    `).run(key, value, description, now);
  } else {
    db.prepare(`
      INSERT INTO system_config (key, value, description, updated_at)
      VALUES (?, ?, '', ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, now);
  }
}
