import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AuditOutcome = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' | 'INFO' | 'WARNING' | 'ERROR';

export interface AuditEventInput {
  actor?: string;
  category: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export interface AuditLogRow {
  id: string;
  actor: string;
  category: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  details_json: string;
  created_at: string;
}

export function recordAuditEvent(db: DatabaseSync, input: AuditEventInput): AuditLogRow {
  const id = `AUD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const actor = input.actor ?? 'OWNER';
  const target = input.target ?? '';
  const detailsJson = JSON.stringify(input.details ?? {});

  db.prepare(`
    INSERT INTO audit_logs (id, actor, category, action, target, outcome, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, actor, input.category, input.action, target, input.outcome, detailsJson, createdAt);

  return {
    id,
    actor,
    category: input.category,
    action: input.action,
    target,
    outcome: input.outcome,
    details_json: detailsJson,
    created_at: createdAt,
  };
}

export function listAuditLogs(
  db: DatabaseSync,
  options: { limit?: number; outcome?: string; search?: string } = {},
): AuditLogRow[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.outcome && options.outcome !== 'ALL') {
    clauses.push('outcome = ?');
    params.push(options.outcome);
  }

  if (options.search && options.search.trim().length > 0) {
    clauses.push('(action LIKE ? OR category LIKE ? OR target LIKE ? OR details_json LIKE ?)');
    const term = `%${options.search.trim()}%`;
    params.push(term, term, term, term);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as unknown as AuditLogRow[];
}
