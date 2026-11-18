PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. System Runtime Configuration (mutable paths, bridge URLs, preferences)
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- 2. Projects (Phase 2+)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_type TEXT NOT NULL,
  root_path TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.1.0',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'STOPPED', 'ARCHIVED')),
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. Central Resource Library (Independent from Projects — Phase 2+)
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  library_section TEXT NOT NULL CHECK (library_section IN ('MODEL', 'DATASET', 'SOFTWARE', 'KNOWLEDGE')),
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  origin_source TEXT NOT NULL,
  license TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '1.0.0',
  sha256 TEXT NOT NULL UNIQUE,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('VERIFIED', 'UNVERIFIED', 'FAILED', 'QUARANTINED')),
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  transferable INTEGER NOT NULL DEFAULT 1,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. Project-Resource Many-to-Many Mapping (Prevents deleting shared resources)
CREATE TABLE IF NOT EXISTS project_resources (
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'DEPENDENCY',
  linked_at TEXT NOT NULL,
  PRIMARY KEY (project_id, resource_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE RESTRICT
);

-- 5. Smart Archive Index (SD Card /storage/.../NG-ILMF_ARCHIVE — Phase 2+)
CREATE TABLE IF NOT EXISTS archive_entries (
  id TEXT PRIMARY KEY,
  resource_id TEXT,
  category_folder TEXT NOT NULL CHECK (category_folder IN (
    'INVENTORY', 'LIBRARIES', 'AI_MODELS', 'DATASETS',
    'CHECKPOINTS', 'BUILD_TOOLS', 'CONFIGURATIONS',
    'RESTORE_PACKAGES', 'MANIFESTS'
  )),
  archive_path TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  verify_status TEXT NOT NULL CHECK (verify_status IN ('VERIFIED', 'MISSING', 'MISMATCH', 'PENDING')),
  last_verified_at TEXT,
  archived_at TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL
);

-- 6. Computer Training Workers (Phase 4+)
CREATE TABLE IF NOT EXISTS training_workers (
  id TEXT PRIMARY KEY,
  worker_name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  pairing_fingerprint TEXT NOT NULL DEFAULT '',
  auth_token_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'READY', 'BUSY', 'WARNING', 'ERROR', 'NOT CONFIGURED')),
  last_heartbeat_at TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 7. Training Jobs (Phase 5+)
CREATE TABLE IF NOT EXISTS training_jobs (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  architecture TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  job_status TEXT NOT NULL CHECK (job_status IN ('QUEUED', 'TRANSFERRING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  training_loss REAL,
  validation_loss REAL,
  checkpoint_path TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES training_workers(id) ON DELETE RESTRICT
);

-- 8. Model Library & Product Registry (Phase 6+)
CREATE TABLE IF NOT EXISTS model_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product_class TEXT NOT NULL CHECK (product_class IN (
    'NG-BASE', 'NG-DOMAIN', 'NG-ADAPTED', 'NG-REPAIRED',
    'NG-REENGINEERED', 'NG-QUANTIZED', 'NG-SECURED', 'NG-SOFTWARE'
  )),
  version TEXT NOT NULL,
  weights_sha256 TEXT NOT NULL,
  architecture_summary TEXT NOT NULL,
  training_summary TEXT NOT NULL DEFAULT '',
  evaluation_summary TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL,
  runtime_requirements_json TEXT NOT NULL DEFAULT '{}',
  safety_report_json TEXT NOT NULL DEFAULT '{}',
  changelog TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'IMPORTED', 'INSPECTED', 'READY_FOR_TRAINING', 'TRAINING',
    'EVALUATION', 'FAILED', 'APPROVED', 'RELEASED', 'ARCHIVED'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 9. Quality Control Reports (Phase 7+)
CREATE TABLE IF NOT EXISTS qc_reports (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  test_suite TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'BLOCKED', 'PARTIAL', 'NOT TESTED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  executed_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES model_products(id) ON DELETE CASCADE
);

-- 10. Customer Delivery Packages (Phase 7+)
CREATE TABLE IF NOT EXISTS delivery_packages (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  zip_path TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES model_products(id) ON DELETE RESTRICT
);

-- 11. Transfer & Operation Audit Log (Active from Phase 1)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'OWNER',
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'FAIL', 'BLOCKED', 'PARTIAL', 'INFO', 'WARNING', 'ERROR')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- 12. Owner Security Sessions (Phase 8+)
CREATE TABLE IF NOT EXISTS owner_sessions (
  id TEXT PRIMARY KEY,
  session_token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
