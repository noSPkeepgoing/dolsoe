import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  Category,
  CoveredProduct,
  Draft,
  DraftBody,
  DraftMode,
  DraftStatus,
  Product,
  QualityReport,
  ScheduleJob,
  ScheduleJobKind,
} from "@contract/domain.js";
import { CoveredProductSchema, DRAFT_TRANSITIONS, DraftSchema, ScheduleJobSchema } from "@contract/domain.js";

/**
 * 버전별 마이그레이션. 인덱스 + 1 = user_version. 스키마는 docs/PLAN.md, 저장소 결정은 ADR-003.
 * 이후 페이즈는 여기에 항목을 "추가"만 한다(적용된 항목은 수정 금지).
 */
const MIGRATIONS: readonly string[] = [
  // v1 — 텔레그램 update 중복 방지(ADR-004)
  `CREATE TABLE processed_updates (
     update_id INTEGER PRIMARY KEY,
     processed_at TEXT NOT NULL
   )`,
  // v2 — 1.2 초안·중복 제외·스케줄·kv·LLM 비용
  `CREATE TABLE drafts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     category TEXT NOT NULL,
     mode TEXT NOT NULL,
     status TEXT NOT NULL,
     products_json TEXT NOT NULL,
     body_json TEXT,
     memo TEXT,
     quality_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_drafts_status ON drafts (status);
   CREATE TABLE covered_products (
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     covered_at TEXT NOT NULL,
     PRIMARY KEY (source, external_id)
   );
   CREATE TABLE schedule_jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     due_at TEXT NOT NULL,
     done_at TEXT
   );
   CREATE TABLE kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE llm_usage (
     month TEXT PRIMARY KEY,
     estimated_cost_krw REAL NOT NULL
   )`,
];

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) throw new Error(`Missing migration v${version + 1}`);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function openDb(file: string): Database.Database {
  const isMemory = file === ":memory:";
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!isMemory) db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** 처음 보는 update_id면 기록하고 true, 이미 처리한 것이면 false(ADR-004). */
export function markUpdateProcessed(db: Database.Database, updateId: number, now: Date): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)")
    .run(updateId, now.toISOString());
  return result.changes === 1;
}

export interface NewDraft {
  category: Category;
  mode: DraftMode;
  status: DraftStatus;
  products: Product[];
  body: DraftBody | null;
  memo: string | null;
  quality: QualityReport | null;
}

interface DraftRow {
  id: number;
  category: string;
  mode: string;
  status: string;
  products_json: string;
  body_json: string | null;
  memo: string | null;
  quality_json: string | null;
  created_at: string;
  updated_at: string;
}

const parseJson = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

/** row → 도메인 매핑은 여기 한 곳에서만(CONVENTIONS §5). 계약 스키마로 검증해 깨진 행은 즉시 드러난다. */
function rowToDraft(row: DraftRow): Draft {
  return DraftSchema.parse({
    id: row.id,
    category: row.category,
    mode: row.mode,
    status: row.status,
    products: parseJson(row.products_json),
    body: parseJson(row.body_json),
    memo: row.memo,
    quality: parseJson(row.quality_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function insertDraft(db: Database.Database, draft: NewDraft, now: Date): Draft {
  const stamp = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO drafts (category, mode, status, products_json, body_json, memo, quality_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.category,
      draft.mode,
      draft.status,
      JSON.stringify(draft.products),
      draft.body === null ? null : JSON.stringify(draft.body),
      draft.memo,
      draft.quality === null ? null : JSON.stringify(draft.quality),
      stamp,
      stamp,
    );
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(result.lastInsertRowid) as DraftRow;
  return rowToDraft(row);
}

export function getDraft(db: Database.Database, id: number): Draft | null {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return row === undefined ? null : rowToDraft(row);
}

/**
 * 상태 전이는 반드시 이 함수를 거친다(CONVENTIONS §6, ADR-006): `WHERE id=? AND status=?`의 변경 행 수로 판정하는 compare-and-swap.
 * false = 이미 다른 요청이 처리함(더블탭 등) → 호출 쪽은 조용히 무시한다(REQ-009). 허용 전이가 아니면 예외.
 */
export function transitionDraft(db: Database.Database, id: number, from: DraftStatus, to: DraftStatus, now: Date): boolean {
  if (!DRAFT_TRANSITIONS[from].includes(to)) throw new Error(`Invalid draft transition: ${from} -> ${to}`);
  const result = db
    .prepare("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, now.toISOString(), id, from);
  return result.changes === 1;
}

/**
 * REQ-008: 수정 재생성 결과 저장. `drafting`인 초안에만 본문·품질을 쓰고, 대기 상태로의 전이는 `transitionDraft`를 거친다(CONVENTIONS §6).
 * 둘은 한 트랜잭션이라 본문만 바뀌고 상태가 남는 일이 없다.
 */
export function saveRevision(db: Database.Database, id: number, body: DraftBody, quality: QualityReport, now: Date): boolean {
  return db.transaction(() => {
    const result = db
      .prepare("UPDATE drafts SET body_json = ?, quality_json = ? WHERE id = ? AND status = 'drafting'")
      .run(JSON.stringify(body), JSON.stringify(quality), id);
    return result.changes === 1 && transitionDraft(db, id, "drafting", "awaiting_approval", now);
  })();
}

export function listDraftsByStatus(db: Database.Database, status: DraftStatus): Draft[] {
  const rows = db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY id").all(status) as DraftRow[];
  return rows.map(rowToDraft);
}

/** REQ-004: 승인을 기다리는 초안(drafting + awaiting_approval) 수. */
export function countPendingDrafts(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM drafts WHERE status IN ('drafting', 'awaiting_approval')")
    .get() as { count: number };
  return row.count;
}

/** REQ-003: 다룬 상품 기록. 다시 다루면 날짜만 갱신한다. */
export function markCovered(db: Database.Database, products: readonly Product[], now: Date): void {
  const upsert = db.prepare(
    `INSERT INTO covered_products (source, external_id, covered_at) VALUES (?, ?, ?)
     ON CONFLICT (source, external_id) DO UPDATE SET covered_at = excluded.covered_at`,
  );
  db.transaction(() => {
    for (const product of products) upsert.run(product.source, product.externalId, now.toISOString());
  })();
}

export function listCoveredProducts(db: Database.Database): CoveredProduct[] {
  const rows = db.prepare("SELECT source, external_id, covered_at FROM covered_products").all() as {
    source: string;
    external_id: string;
    covered_at: string;
  }[];
  return rows.map((row) =>
    CoveredProductSchema.parse({ source: row.source, externalId: row.external_id, coveredAt: row.covered_at }),
  );
}

export function getKv(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function deleteKv(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

export function getMonthLlmCostKrw(db: Database.Database, month: string): number {
  const row = db.prepare("SELECT estimated_cost_krw AS cost FROM llm_usage WHERE month = ?").get(month) as
    | { cost: number }
    | undefined;
  return row?.cost ?? 0;
}

export function addLlmCostKrw(db: Database.Database, month: string, krw: number): void {
  db.prepare(
    `INSERT INTO llm_usage (month, estimated_cost_krw) VALUES (?, ?)
     ON CONFLICT (month) DO UPDATE SET estimated_cost_krw = estimated_cost_krw + excluded.estimated_cost_krw`,
  ).run(month, krw);
}

/** ADR-002: 같은 종류의 미완료 잡이 이미 있으면 넣지 않는다(재기동해도 잡이 쌓이지 않음). */
export function enqueueJob(db: Database.Database, kind: ScheduleJobKind, dueAt: Date): boolean {
  return db.transaction(() => {
    const existing = db.prepare("SELECT 1 FROM schedule_jobs WHERE kind = ? AND done_at IS NULL").get(kind);
    if (existing !== undefined) return false;
    db.prepare("INSERT INTO schedule_jobs (kind, due_at) VALUES (?, ?)").run(kind, dueAt.toISOString());
    return true;
  })();
}

/** 시각이 된 잡을 완료 처리하며 가져간다. 한 번 가져간 잡은 다시 안 나온다(중복 실행 방지). */
export function claimDueJobs(db: Database.Database, now: Date): ScheduleJob[] {
  const stamp = now.toISOString();
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT id, kind, due_at FROM schedule_jobs WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at")
      .all(stamp) as { id: number; kind: string; due_at: string }[];
    const markDone = db.prepare("UPDATE schedule_jobs SET done_at = ? WHERE id = ?");
    return rows.map((row) => {
      markDone.run(stamp, row.id);
      return ScheduleJobSchema.parse({ id: row.id, kind: row.kind, dueAt: row.due_at, doneAt: stamp });
    });
  })();
}
