# Security Summary

NG-ILMF Mobile Command Center underwent a full-stack security, storage, ML runtime, QC, and packaging remediation while preserving its five constitutional production wings alongside the Master Control & Quality Center.

### Key Security Controls Implemented
- **Unified Authentication & RBAC Enforcement (`server/routes/api.ts`, `server/services/securityService.ts`)**: All mutating, export, delete, pairing, repair, QC, and admin endpoints enforce session token validation (`Authorization: Bearer` / `x-ng-owner-token`), block operations before Owner Lock initialization (`HTTP 403`), enforce `OWNER` / `OPERATOR` / `VIEWER` role permissions, and support immediate session expiration and revocation.
- **Bootstrap Claim Protection & Secret Redaction (`server/services/securityService.ts`, `server.ts`, `server/routes/api.ts`)**: Initial owner setup enforces `NG_ILMF_BOOTSTRAP_TOKEN` or host `.bootstrap_token` (`mode 0600`) for remote claim attempts and atomically sets `owner_passkey_hash` in SQLite to prevent race-condition or duplicate account takeovers. `GET /config` and `PUT /config` strip `owner_passkey_hash`, `worker_hmac_secrets_json`, `android_attestation_challenges_json`, and any secret/hash/token fields via `sanitizeConfigForClient`.
- **Login & Setup Rate Limiting (`server/services/securityService.ts`, `server/routes/api.ts`)**: Consecutive failed logins or owner setup attempts are rate-limited (`5` failures within `60s` trigger a `120s` lockout returning `HTTP 429` + `Retry-After`), keyed strictly by direct socket address.
- **SSRF & Worker Mutual Authentication (`server/utils/urlSecurity.ts`, `server/services/mindFactoryService.ts`, `server/services/realtimeSyncService.ts`)**: Worker endpoints and `bridge_endpoint` reject link-local metadata IPs (`169.254.169.254`), unspecified/multicast ranges, database/admin ports, private LAN ranges (unless explicitly allowlisted), and Command Center's own loopback port (`3000` / `PORT`), plus runtime DNS resolution checks before `fetch()`. Worker transfers, probes, controls, and telemetry endpoints verify HMAC-SHA256 mutual-auth signatures (`x-ng-worker-id`, `x-ng-worker-timestamp`, `x-ng-worker-signature`).
- **Workspace Confinement & Atomic File I/O (`server/utils/fsAtomic.ts`, `server/services/deviceManagerService.ts`)**: `resolveSafeRealPath` canonicalizes ancestors and symlink targets via `fs.realpathSync` so file operations, cleanup targets, weights, checkpoints, and delivery downloads cannot escape `data_dir` or delete `.sqlite`, `.sqlite-wal`, or `.sqlite-shm` files. Critical writes use `writeFileAtomic` (`fsyncSync` + atomic `renameSync`).
- **Cryptographic Android Challenge-Response (`server/storage/androidBridgeDiagnostic.ts`, `android/app/src/main/java/com/ngilmf/commandcenter/SafStorageBridge.kt`, `MainActivity.kt`)**: Attestation requires a single-use server-issued nonce verified via HMAC-SHA256 (`POST /android/challenge` -> `POST /android/attest`) and restricts WebView origins and cleartext traffic (`network_security_config.xml`).
- **Authentic Binary ML Artifacts & Strict QC/NG-IP Packaging (`server/ml/tokenizerEngine.ts`, `server/ml/neuralMindEngine.ts`, `server/services/trustQcService.ts`, `server/services/repairRegistryService.ts`, `server/services/ngIpService.ts`)**: `NGWT-V1` binary tensor weights, `NGCK-V1` binary training checkpoints with AdamW optimizer states, and Unicode-NFC Byte-Fallback BPE tokenizers replace JSON placeholders. QC rejects JSON-as-weights, missing binary containers, `NaN`/`Inf` weights, invalid tokenizers, and unverified restore paths; weight changes automatically invalidate stale QC approvals; NG-IP ZIPs bundle real binary artifacts and pass full central-directory decompression + CRC-32 + per-entry SHA-256 verification.

## PoC Verification

All 30 automated unit and integration tests pass against the remediated backend and API router (`npm test` -> `# tests 30 # pass 30 # fail 0`):

- **HTTP API Security (`tests/remediation_security_and_ml.test.ts` — Test 19)**:
  - Pre-lock `POST /api/v1/projects` and `POST /api/v1/wings/mind/workers` return `403`.
  - Wrong `bootstrapToken` on `POST /api/v1/security/setup-owner` is rejected (`400`); valid token initializes owner (`201`); duplicate claim attempt fails (`403`).
  - `GET /api/v1/config` omits `owner_passkey_hash`, `worker_hmac_secrets_json`, and `android_attestation_challenges_json`.
  - Unauthenticated mutating calls return `401`; `VIEWER` mutations return `403`; `OPERATOR` admin calls return `403`; revoked session token returns `401`.
  - 5 bad logins return `401`; the 6th returns `429` with `Retry-After`.
- **SSRF, Symlink Escapes, Android HMAC Challenge (`tests/remediation_security_and_ml.test.ts` — Test 20)**:
  - Blocks `http://169.254.169.254/latest/meta-data`, `http://10.0.0.12:8000`, `http://192.168.1.25:9000`, `http://127.0.0.1:3000/api/v1`, and `file:///etc/passwd`.
  - Blocks symlink escape outside `data_dir` and `-wal` SQLite file deletion.
  - Rejects forged or replayed Android attestation proofs and accepts a single valid HMAC-signed proof.
- **ML Artifacts, Mutual-Auth HTTP Worker, Binary Checkpoints, Repair, QC & ZIP (`tests/remediation_security_and_ml.test.ts` — Test 21)**:
  - Rejects JSON masquerading as weights, executes mutual-auth chunked `/transfer/init -> /chunk -> /finalize`, rejects forged unsigned worker telemetry (`401`) while accepting HMAC-signed telemetry (`200`), verifies `OFFLINE -> ONLINE` sync recovery, validates binary `NGCK-V1` restore & AdamW optimization steps, repairs `NaN`/`Inf` floats (`SANITIZE_NAN_INF`) & `INT8_QUANTIZE` with automatic QC invalidation, and verifies unpacked delivery ZIP entries.
- **Live Server Boot Verification (`NODE_ENV=production`)**:
  - `npx tsx server.ts` on isolated temp directory & port `3199` responded `200 ONLINE` on `/api/v1/health`, confirmed secret redaction on `/api/v1/config`, and returned `403` pre-lock on `POST /api/v1/projects`.
