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
  PublishAttempt,
  PublishMode,
  PublishResult,
  QualityReport,
  ScheduleJob,
  ScheduleJobKind,
} from "@contract/domain.js";
import {
  CoveredProductSchema,
  DRAFT_TRANSITIONS,
  DraftSchema,
  PublishAttemptSchema,
  ScheduleJobSchema,
} from "@contract/domain.js";

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
  // v3 — 1.4 발행 시도 로그(ADR-005·006). 시도 기록을 먼저 쓰므로 result_json은 진행 중엔 NULL
  `CREATE TABLE publish_attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     draft_id INTEGER NOT NULL REFERENCES drafts (id),
     mode TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     result_json TEXT
   );
   CREATE INDEX idx_publish_attempts_draft ON publish_attempts (draft_id)`,
  // v4 — 1.6 책 후기 근거 출처 URL(REQ-016, ADR-010). 발행 본문에는 넣지 않고 여기에만 보관한다. 옛 초안은 NULL
  `ALTER TABLE drafts ADD COLUMN review_sources_json TEXT`,
  // v5 — 1.7c 내 한 컷 사진(REQ-034, ADR-014)과 웹 교차 확인 출처(REQ-028·029, ADR-013). 사진은 파일이고 여기엔 경로만 둔다. 옛 초안은 NULL
  `CREATE TABLE draft_photos (
     draft_id INTEGER PRIMARY KEY REFERENCES drafts (id),
     file_path TEXT NOT NULL,
     mime TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   ALTER TABLE drafts ADD COLUMN quote_sources_json TEXT;
   ALTER TABLE drafts ADD COLUMN spec_sources_json TEXT`,
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
  /** REQ-016 후기 근거 출처 URL. 책 초안만, 없으면 생략 */
  reviewSources?: string[];
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
  review_sources_json: string | null;
  quote_sources_json: string | null;
  spec_sources_json: string | null;
  photo_path: string | null;
  photo_mime: string | null;
  photo_bytes: number | null;
  created_at: string;
  updated_at: string;
}

/** drafts + 사진(없으면 NULL 세 칸). 조회는 모두 이 SELECT를 거쳐 row→도메인 매핑이 한 곳에 남는다. */
const DRAFT_SELECT = `SELECT d.*, p.file_path AS photo_path, p.mime AS photo_mime, p.bytes AS photo_bytes
  FROM drafts d LEFT JOIN draft_photos p ON p.draft_id = d.id`;

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
    reviewSources: row.review_sources_json === null ? undefined : parseJson(row.review_sources_json),
    quoteSources: row.quote_sources_json === null ? undefined : parseJson(row.quote_sources_json),
    specSources: row.spec_sources_json === null ? undefined : parseJson(row.spec_sources_json),
    photo:
      row.photo_path === null ? undefined : { filePath: row.photo_path, mime: row.photo_mime, bytes: row.photo_bytes },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function insertDraft(db: Database.Database, draft: NewDraft, now: Date): Draft {
  const stamp = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO drafts (category, mode, status, products_json, body_json, memo, quality_json, review_sources_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.category,
      draft.mode,
      draft.status,
      JSON.stringify(draft.products),
      draft.body === null ? null : JSON.stringify(draft.body),
      draft.memo,
      draft.quality === null ? null : JSON.stringify(draft.quality),
      draft.reviewSources === undefined ? null : JSON.stringify(draft.reviewSources),
      stamp,
      stamp,
    );
  const row = db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).get(result.lastInsertRowid) as DraftRow;
  return rowToDraft(row);
}

export function getDraft(db: Database.Database, id: number): Draft | null {
  const row = db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).get(id) as DraftRow | undefined;
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
  const rows = db.prepare(`${DRAFT_SELECT} WHERE d.status = ? ORDER BY d.id`).all(status) as DraftRow[];
  return rows.map(rowToDraft);
}

/**
 * REQ-034: 승인 대기 초안에만 메모(경험 한 줄)를 붙인다. LLM 없이 본문 한 필드만 바꾸는 조건부 갱신(CAS)이라
 * 그 사이 수정·발행·폐기로 상태가 바뀌었으면 false. 이미 있던 문장은 교체된다.
 */
export function attachExperienceLine(db: Database.Database, id: number, text: string, now: Date): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT body_json, quality_json FROM drafts WHERE id = ? AND status = 'awaiting_approval'").get(id) as
      | { body_json: string | null; quality_json: string | null }
      | undefined;
    if (row === undefined || row.body_json === null) return false;
    const body = { ...(JSON.parse(row.body_json) as Record<string, unknown>), experienceLine: text };
    const quality = row.quality_json === null ? null : { ...(JSON.parse(row.quality_json) as Record<string, unknown>), hasExperienceLine: true };
    const result = db
      .prepare("UPDATE drafts SET body_json = ?, quality_json = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_approval'")
      .run(JSON.stringify(body), quality === null ? null : JSON.stringify(quality), now.toISOString(), id);
    return result.changes === 1;
  })();
}

export interface DraftPhotoRecord {
  filePath: string;
  mime: "image/jpeg" | "image/png";
  bytes: number;
}

/**
 * REQ-034: 승인 대기 초안에 사진 1장을 붙인다(다시 보내면 교체). 상태가 바뀌어 붙이지 못했으면 null,
 * 붙였으면 `replacedPath` = 교체돼 쓸모없어진 이전 파일 경로(없으면 null) — 파일 삭제는 호출 쪽.
 */
export function setDraftPhoto(db: Database.Database, id: number, photo: DraftPhotoRecord, now: Date): { replacedPath: string | null } | null {
  return db.transaction(() => {
    const alive = db.prepare("SELECT 1 FROM drafts WHERE id = ? AND status = 'awaiting_approval'").get(id);
    if (alive === undefined) return null;
    const previous = db.prepare("SELECT file_path FROM draft_photos WHERE draft_id = ?").get(id) as { file_path: string } | undefined;
    db.prepare(
      `INSERT INTO draft_photos (draft_id, file_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (draft_id) DO UPDATE SET file_path = excluded.file_path, mime = excluded.mime, bytes = excluded.bytes, created_at = excluded.created_at`,
    ).run(id, photo.filePath, photo.mime, photo.bytes, now.toISOString());
    const replaced = previous?.file_path;
    return { replacedPath: replaced === undefined || replaced === photo.filePath ? null : replaced };
  })();
}

/** 사진 행을 지우고 파일 경로를 돌려준다(파일 삭제는 호출 쪽). 없으면 null. */
export function removeDraftPhoto(db: Database.Database, id: number): string | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT file_path FROM draft_photos WHERE draft_id = ?").get(id) as { file_path: string } | undefined;
    if (row === undefined) return null;
    db.prepare("DELETE FROM draft_photos WHERE draft_id = ?").run(id);
    return row.file_path;
  })();
}

/** 기동 시 정리용: 모든 사진 행과 그 초안의 상태. */
export function listDraftPhotos(db: Database.Database): { draftId: number; filePath: string; status: DraftStatus }[] {
  const rows = db
    .prepare("SELECT p.draft_id AS draft_id, p.file_path AS file_path, d.status AS status FROM draft_photos p JOIN drafts d ON d.id = p.draft_id")
    .all() as { draft_id: number; file_path: string; status: string }[];
  return rows.map((row) => ({ draftId: row.draft_id, filePath: row.file_path, status: row.status as DraftStatus }));
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

interface PublishAttemptRow {
  id: number;
  draft_id: number;
  mode: string;
  started_at: string;
  finished_at: string | null;
  result_json: string | null;
}

function rowToPublishAttempt(row: PublishAttemptRow): PublishAttempt {
  return PublishAttemptSchema.parse({
    id: row.id,
    draftId: row.draft_id,
    mode: row.mode,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: parseJson(row.result_json),
  });
}

/** ADR-006: 발행기를 부르기 전에 먼저 쓴다. 결과는 `finishPublishAttempt`가 채운다. */
export function insertPublishAttempt(db: Database.Database, draftId: number, mode: PublishMode, now: Date): number {
  const result = db
    .prepare("INSERT INTO publish_attempts (draft_id, mode, started_at) VALUES (?, ?, ?)")
    .run(draftId, mode, now.toISOString());
  return Number(result.lastInsertRowid);
}

export function finishPublishAttempt(db: Database.Database, attemptId: number, result: PublishResult, now: Date): void {
  db.prepare("UPDATE publish_attempts SET finished_at = ?, result_json = ? WHERE id = ?").run(
    now.toISOString(),
    JSON.stringify(result),
    attemptId,
  );
}

export function listPublishAttempts(db: Database.Database, draftId: number): PublishAttempt[] {
  const rows = db.prepare("SELECT * FROM publish_attempts WHERE draft_id = ? ORDER BY id").all(draftId) as PublishAttemptRow[];
  return rows.map(rowToPublishAttempt);
}

/** 기동 시 복구: 끝나지 않은 시도(결과 NULL)를 "결과 불확실"로 닫는다(자동 재발행 금지, ADR-006). */
export function failOpenPublishAttempts(db: Database.Database, draftId: number, reason: string, now: Date): void {
  const open = db.prepare("SELECT id, mode FROM publish_attempts WHERE draft_id = ? AND result_json IS NULL").all(draftId) as {
    id: number;
    mode: PublishMode;
  }[];
  for (const attempt of open) {
    finishPublishAttempt(db, attempt.id, { ok: false, mode: attempt.mode, retryable: false, authExpired: false, reason }, now);
  }
}
