import type { DatabaseSync } from 'node:sqlite';
import { getConfigMap } from '../db/database.ts';
import { recordAuditEvent } from '../audit/auditService.ts';
import { probeTrainingBridge } from './dashboardService.ts';

export interface SanitizedDemoProduct {
  id: string;
  name: string;
  productClass: string;
  version: string;
  architectureSummary: string;
  trainingSummary: string;
  evaluationSummary: string;
  license: string;
  lifecycleState: 'APPROVED' | 'RELEASED';
  updatedAt: string;
}

export interface DemoCatalogSnapshot {
  isolatedMode: true;
  generatedAt: string;
  approvedProducts: SanitizedDemoProduct[];
  inferenceEngine: {
    available: boolean;
    status: string;
    detail: string;
  };
  restrictions: {
    weightsAccessBlocked: true;
    archiveAccessBlocked: true;
    settingsModificationBlocked: true;
  };
}

export async function getIsolatedDemoCatalog(db: DatabaseSync): Promise<DemoCatalogSnapshot> {
  const config = getConfigMap(db);
  const bridge = await probeTrainingBridge(config.bridge_endpoint ?? '');

  // Strict SQL projection: ONLY APPROVED / RELEASED products, ZERO weights paths, ZERO private config
  const rows = db
    .prepare(
      `
      SELECT
        id,
        name,
        product_class,
        version,
        architecture_summary,
        training_summary,
        evaluation_summary,
        license,
        lifecycle_state,
        updated_at
      FROM model_products
      WHERE lifecycle_state IN ('APPROVED', 'RELEASED')
      ORDER BY updated_at DESC
    `,
    )
    .all() as unknown as Array<{
    id: string;
    name: string;
    product_class: string;
    version: string;
    architecture_summary: string;
    training_summary: string;
    evaluation_summary: string;
    license: string;
    lifecycle_state: 'APPROVED' | 'RELEASED';
    updated_at: string;
  }>;

  const approvedProducts: SanitizedDemoProduct[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    productClass: r.product_class,
    version: r.version,
    architectureSummary: r.architecture_summary,
    trainingSummary: r.training_summary,
    evaluationSummary: r.evaluation_summary,
    license: r.license,
    lifecycleState: r.lifecycle_state,
    updatedAt: r.updated_at,
  }));

  return {
    isolatedMode: true,
    generatedAt: new Date().toISOString(),
    approvedProducts,
    inferenceEngine: {
      available: bridge.status === 'ONLINE',
      status: bridge.status,
      detail:
        bridge.status === 'ONLINE'
          ? `Connected to verified inference worker (${bridge.latencyMs ?? 0}ms)`
          : 'No real inference engine paired/online. Demo inference is disabled (zero fake replies).',
    },
    restrictions: {
      weightsAccessBlocked: true,
      archiveAccessBlocked: true,
      settingsModificationBlocked: true,
    },
  };
}

export async function runIsolatedDemoInference(
  db: DatabaseSync,
  input: { productId: string; prompt: string },
): Promise<{ output: string; latencyMs: number }> {
  const product = db
    .prepare(
      "SELECT id, name, lifecycle_state FROM model_products WHERE id = ? AND lifecycle_state IN ('APPROVED', 'RELEASED')",
    )
    .get(input.productId) as { id: string; name: string; lifecycle_state: string } | undefined;

  if (!product) {
    throw new Error('Product is not approved/released for demo inference.');
  }

  const config = getConfigMap(db);
  const endpoint = (config.bridge_endpoint ?? '').trim();
  if (!endpoint) {
    throw new Error('No real inference engine configured. Cannot produce simulated AI output.');
  }

  const inferUrl = endpoint.endsWith('/') ? `${endpoint}infer` : `${endpoint}/infer`;
  const start = Date.now();
  const response = await fetch(inferUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: product.id, prompt: input.prompt }),
  });

  if (!response.ok) {
    throw new Error(`Inference worker returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as { output?: string };
  recordAuditEvent(db, {
    actor: 'DEMO_VISITOR',
    category: 'DEMO',
    action: 'RUN_ISOLATED_DEMO_INFERENCE',
    target: product.id,
    outcome: 'PASS',
    details: { latencyMs: Date.now() - start },
  });

  return {
    output: data.output ?? '',
    latencyMs: Date.now() - start,
  };
}

export function resetDemoSession(db: DatabaseSync): { resetAt: string } {
  const resetAt = new Date().toISOString();
  recordAuditEvent(db, {
    actor: 'DEMO_VISITOR',
    category: 'DEMO',
    action: 'RESET_DEMO_SESSION',
    target: 'demo_sandbox',
    outcome: 'INFO',
    details: { resetAt },
  });
  return { resetAt };
}
