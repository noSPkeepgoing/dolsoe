import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";

import {
  addLlmCostKrw,
  attachExperienceLine,
  removeDraftPhoto,
  setDraftPhoto,
  claimDueJobs,
  failOpenPublishAttempts,
  finishPublishAttempt,
  insertPublishAttempt,
  listPublishAttempts,
  countPendingDrafts,
  deleteKv,
  enqueueJob,
  getDraft,
  getKv,
  getMonthLlmCostKrw,
  insertDraft,
  listCoveredProducts,
  listDraftsByStatus,
  markCovered,
  markUpdateProcessed,
  openDb,
  saveRevision,
  setKv,
  transitionDraft,
} from "./db.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("[ADR-003] 마이그레이션이 processed_updates 테이블을 만든다", () => {
    const db = openDb(":memory:");
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='processed_updates'").get();
    expect(row).toBeDefined();
  });

  it("[ADR-003] 같은 파일을 다시 열어도 마이그레이션이 중복 적용되지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dolsoe-db-"));
    tempDirs.push(dir);
    const file = path.join(dir, "test.db");
    const first = openDb(file);
    const versionAfterFirst = first.pragma("user_version", { simple: true });
    first.close();
    const second = openDb(file);
    expect(second.pragma("user_version", { simple: true })).toBe(versionAfterFirst);
    second.close();
  });
});

describe("markUpdateProcessed", () => {
  it("[ADR-004] 처음 보는 update_id는 true, 같은 update_id를 다시 넣으면 false", () => {
    const db = openDb(":memory:");
    expect(markUpdateProcessed(db, 100, NOW)).toBe(true);
    expect(markUpdateProcessed(db, 100, NOW)).toBe(false);
    expect(markUpdateProcessed(db, 101, NOW)).toBe(true);
  });

  it("[ADR-004] 프로세스가 재기동(DB 재오픈)돼도 처리한 update_id는 기억한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dolsoe-db-"));
    tempDirs.push(dir);
    const file = path.join(dir, "test.db");
    const first = openDb(file);
    markUpdateProcessed(first, 7, NOW);
    first.close();
    const second = openDb(file);
    expect(markUpdateProcessed(second, 7, NOW)).toBe(false);
    second.close();
  });
});

// ── 1.2 저장소 (마이그레이션 v2) ─────────────────────────────────────
const sampleProduct = (externalId: string): Product => ({
  externalId,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${externalId}`,
  url: "https://example.com/" + externalId,
  priceKrw: 10000,
  priceAsOf: NOW.toISOString(),
  specs: { 저자: "누구" },
});
const sampleBody: DraftBody = {
  category: "book",
  title: "이번 주 베스트셀러",
  synopsis: "s",
  mood: "m",
  recommendedFor: "r",
  highlights: "h",
  experienceLine: null,
};

describe("insertDraft / countPendingDrafts", () => {
  it("[REQ-002] 초안을 저장하면 계약 스키마대로 읽혀 나온다(상품·본문·품질 JSON 왕복)", () => {
    const db = openDb(":memory:");
    const draft = insertDraft(
      db,
      {
        category: "book",
        mode: "daily",
        status: "awaiting_approval",
        products: [sampleProduct("1")],
        body: sampleBody,
        memo: null,
        quality: { bannedPhrasesFound: [], hasExperienceLine: false },
      },
      NOW,
    );
    expect(draft.id).toBeGreaterThan(0);
    expect(draft.body).toEqual(sampleBody);
    expect(draft.products[0]?.specs).toEqual({ 저자: "누구" });
    expect(draft.createdAt).toBe(NOW.toISOString());
  });

  it("[REQ-016] 후기 출처 URL과 책 소개문·목차가 저장·조회 왕복되고, 출처 없이 저장한 초안은 reviewSources가 없다", () => {
    const db = openDb(":memory:");
    const product: Product = { ...sampleProduct("1"), bookDetail: { introduction: "소개문", tableOfContents: null } };
    const base = { category: "book" as const, mode: "daily" as const, status: "awaiting_approval" as const, products: [product], body: sampleBody, memo: null, quality: null };
    const withSources = insertDraft(db, { ...base, reviewSources: ["https://blog.example.com/a", "https://blog.example.com/b"] }, NOW);
    expect(withSources.reviewSources).toEqual(["https://blog.example.com/a", "https://blog.example.com/b"]);
    expect(getDraft(db, withSources.id)?.products[0]?.bookDetail).toEqual({ introduction: "소개문", tableOfContents: null });
    const without = insertDraft(db, base, NOW);
    expect(without.reviewSources).toBeUndefined();
  });

  it("[REQ-016] 마이그레이션이 옛 DB(v3)의 초안을 지우지 않고 후기 출처 컬럼만 더한다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dolsoe-"));
    tempDirs.push(dir);
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    // v1~v3까지만 적용된 DB를 흉내 낸다 — 이 컬럼이 생기기 전에 저장된 초안
    old.exec(`CREATE TABLE processed_updates (update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL);
      CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, products_json TEXT NOT NULL, body_json TEXT, memo TEXT, quality_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE covered_products (source TEXT NOT NULL, external_id TEXT NOT NULL, covered_at TEXT NOT NULL, PRIMARY KEY (source, external_id));
      CREATE TABLE schedule_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, due_at TEXT NOT NULL, done_at TEXT);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE llm_usage (month TEXT PRIMARY KEY, estimated_cost_krw REAL NOT NULL);
      CREATE TABLE publish_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id INTEGER NOT NULL REFERENCES drafts (id), mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, result_json TEXT);`);
    old.prepare("INSERT INTO drafts (category, mode, status, products_json, body_json, created_at, updated_at) VALUES ('book','daily','published',?,?,?,?)")
      .run(JSON.stringify([sampleProduct("1")]), JSON.stringify(sampleBody), NOW.toISOString(), NOW.toISOString());
    old.pragma("user_version = 3");
    old.close();

    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    const [draft] = listDraftsByStatus(db, "published");
    expect(draft?.body).toEqual(sampleBody);
    expect(draft?.reviewSources).toBeUndefined();
    expect(draft?.photo).toBeUndefined(); // [REQ-034] v5 이전 초안은 사진 없음
    db.close();
  });

  it("[REQ-004] 승인 대기 수는 drafting + awaiting_approval만 센다(발행·폐기된 것은 제외)", () => {
    const db = openDb(":memory:");
    const base = { category: "book" as const, mode: "daily" as const, products: [sampleProduct("1")], body: sampleBody, memo: null, quality: null };
    insertDraft(db, { ...base, status: "awaiting_approval" }, NOW);
    insertDraft(db, { ...base, status: "drafting" }, NOW);
    insertDraft(db, { ...base, status: "published" }, NOW);
    insertDraft(db, { ...base, status: "discarded" }, NOW);
    expect(countPendingDrafts(db)).toBe(2);
  });
});

describe("covered products", () => {
  it("[REQ-003] 다룬 상품을 기록하고 다시 기록하면 날짜만 갱신한다(중복 행 없음)", () => {
    const db = openDb(":memory:");
    markCovered(db, [sampleProduct("1"), sampleProduct("2")], new Date("2026-09-01T00:00:00Z"));
    markCovered(db, [sampleProduct("1")], new Date("2026-09-20T00:00:00Z"));
    const covered = listCoveredProducts(db);
    expect(covered).toHaveLength(2);
    expect(covered.find((c) => c.externalId === "1")?.coveredAt).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("kv / llm cost", () => {
  it("[REQ-001] kv는 없으면 null, 쓰면 읽히고, 덮어쓸 수 있다", () => {
    const db = openDb(":memory:");
    expect(getKv(db, "last_category")).toBeNull();
    setKv(db, "last_category", "book");
    setKv(db, "last_category", "appliance");
    expect(getKv(db, "last_category")).toBe("appliance");
  });

  it("[NFR-001] LLM 비용은 월별로 누적되고, 기록 없는 달은 0", () => {
    const db = openDb(":memory:");
    expect(getMonthLlmCostKrw(db, "2026-10")).toBe(0);
    addLlmCostKrw(db, "2026-10", 120.5);
    addLlmCostKrw(db, "2026-10", 30);
    addLlmCostKrw(db, "2026-11", 1);
    expect(getMonthLlmCostKrw(db, "2026-10")).toBeCloseTo(150.5);
    expect(getMonthLlmCostKrw(db, "2026-11")).toBe(1);
  });
});

describe("schedule jobs", () => {
  it("[REQ-001] 시각이 된 잡만 한 번 가져가고, 다시 가져가면 비어 있다(중복 실행 방지)", () => {
    const db = openDb(":memory:");
    enqueueJob(db, "daily_draft", new Date("2026-10-01T23:00:00Z"));
    expect(claimDueJobs(db, new Date("2026-10-01T22:59:59Z"))).toEqual([]);
    const claimed = claimDueJobs(db, new Date("2026-10-01T23:00:00Z"));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe("daily_draft");
    expect(claimDueJobs(db, new Date("2026-10-02T23:00:00Z"))).toEqual([]);
  });

  it("[REQ-001] 같은 종류의 미완료 잡이 이미 있으면 새로 넣지 않는다(재기동해도 잡이 쌓이지 않음)", () => {
    const db = openDb(":memory:");
    expect(enqueueJob(db, "daily_draft", new Date("2026-10-01T23:00:00Z"))).toBe(true);
    expect(enqueueJob(db, "daily_draft", new Date("2026-10-02T23:00:00Z"))).toBe(false);
  });
});

describe("draft transitions (CAS)", () => {
  const product: Product = {
    externalId: "1",
    source: "yes24",
    category: "book",
    affiliate: "yes24",
    title: "책",
    url: "https://example.com/1",
    priceKrw: 1000,
    priceAsOf: NOW.toISOString(),
    specs: {},
  };
  const body = (title: string, experienceLine: string | null = null): DraftBody => ({
    category: "book",
    title,
    synopsis: "s",
    mood: "m",
    recommendedFor: "r",
    highlights: "h",
    experienceLine,
  });
  const seed = (db: ReturnType<typeof openDb>) =>
    insertDraft(db, { category: "book", mode: "daily", status: "awaiting_approval", products: [product], body: body("원본"), memo: null, quality: null }, NOW);

  it("[REQ-009] 같은 상태에서 한 번만 전이된다: 두 번째 시도는 변경 행 0(false)", () => {
    const db = openDb(":memory:");
    const draft = seed(db);
    expect(transitionDraft(db, draft.id, "awaiting_approval", "publishing", NOW)).toBe(true);
    expect(transitionDraft(db, draft.id, "awaiting_approval", "publishing", NOW)).toBe(false);
    expect(getDraft(db, draft.id)?.status).toBe("publishing");
  });

  it("[REQ-009] 허용되지 않은 전이는 예외다(DRAFT_TRANSITIONS)", () => {
    const db = openDb(":memory:");
    const draft = seed(db);
    expect(() => transitionDraft(db, draft.id, "awaiting_approval", "published", NOW)).toThrow();
  });

  it("[REQ-008] 폐기는 초안을 지우지 않고 상태만 바꾼다(기록 보존)", () => {
    const db = openDb(":memory:");
    const draft = seed(db);
    expect(transitionDraft(db, draft.id, "awaiting_approval", "discarded", NOW)).toBe(true);
    expect(getDraft(db, draft.id)).toMatchObject({ status: "discarded", body: { title: "원본" } });
  });

  it("[REQ-008][REQ-011] 수정 결과 저장은 drafting일 때만 본문·품질을 바꾸고 대기 상태로 되돌린다", () => {
    const db = openDb(":memory:");
    const draft = seed(db);
    const quality = { bannedPhrasesFound: [], hasExperienceLine: true };
    expect(saveRevision(db, draft.id, body("수정본", "소음이 컸어요"), quality, NOW)).toBe(false); // 아직 drafting 아님
    transitionDraft(db, draft.id, "awaiting_approval", "drafting", NOW);
    expect(saveRevision(db, draft.id, body("수정본", "소음이 컸어요"), quality, NOW)).toBe(true);
    expect(getDraft(db, draft.id)).toMatchObject({ status: "awaiting_approval", body: { title: "수정본", experienceLine: "소음이 컸어요" }, quality });
  });

  it("[REQ-008] 없는 초안은 null", () => {
    expect(getDraft(openDb(":memory:"), 999)).toBeNull();
  });

  it("[REQ-008] kv 값을 지울 수 있다(수정 대기 표시 해제)", () => {
    const db = openDb(":memory:");
    setKv(db, "k", "v");
    deleteKv(db, "k");
    expect(getKv(db, "k")).toBeNull();
  });

  it("[REQ-008] 상태별 초안 목록을 오래된 순으로 돌려준다(기동 시 drafting 복구용)", () => {
    const db = openDb(":memory:");
    const a = seed(db);
    const b = seed(db);
    transitionDraft(db, b.id, "awaiting_approval", "drafting", NOW);
    expect(listDraftsByStatus(db, "drafting").map((x) => x.id)).toEqual([b.id]);
    expect(listDraftsByStatus(db, "awaiting_approval").map((x) => x.id)).toEqual([a.id]);
  });
});

describe("publish attempts (ADR-006)", () => {
  const draftInput = () => ({
    category: "book" as const,
    mode: "daily" as const,
    status: "awaiting_approval" as const,
    products: [sampleProduct("1")],
    body: null,
    memo: null,
    quality: null,
  });

  it("[REQ-013] 시도 기록은 결과 없이 먼저 쓰이고, 끝나면 결과와 종료 시각이 채워진다", () => {
    const db = openDb(":memory:");
    const draft = insertDraft(db, draftInput(), NOW);
    const id = insertPublishAttempt(db, draft.id, "manual", NOW);
    expect(listPublishAttempts(db, draft.id)).toMatchObject([{ id, mode: "manual", finishedAt: null, result: null }]);

    const later = new Date("2026-09-30T00:01:00.000Z");
    finishPublishAttempt(db, id, { ok: true, mode: "manual", url: null, externalId: null }, later);
    expect(listPublishAttempts(db, draft.id)).toMatchObject([
      { id, finishedAt: later.toISOString(), result: { ok: true, mode: "manual" } },
    ]);
  });

  it("[REQ-013] 시도는 초안별로 시작 순서대로 나온다", () => {
    const db = openDb(":memory:");
    const a = insertDraft(db, draftInput(), NOW);
    const b = insertDraft(db, draftInput(), NOW);
    insertPublishAttempt(db, a.id, "live", NOW);
    insertPublishAttempt(db, b.id, "manual", NOW);
    insertPublishAttempt(db, a.id, "manual", NOW);
    expect(listPublishAttempts(db, a.id).map((attempt) => attempt.mode)).toEqual(["live", "manual"]);
  });

  it("[REQ-013] 끝나지 않은 시도만 실패(결과 불확실)로 닫는다", () => {
    const db = openDb(":memory:");
    const draft = insertDraft(db, draftInput(), NOW);
    const done = insertPublishAttempt(db, draft.id, "live", NOW);
    finishPublishAttempt(db, done, { ok: true, mode: "live", url: null, externalId: null }, NOW);
    insertPublishAttempt(db, draft.id, "manual", NOW);

    failOpenPublishAttempts(db, draft.id, "재시작으로 중단", NOW);
    const [first, second] = listPublishAttempts(db, draft.id);
    expect(first?.result).toMatchObject({ ok: true });
    expect(second?.result).toMatchObject({ ok: false, mode: "manual", retryable: false, reason: "재시작으로 중단" });
    expect(second?.finishedAt).not.toBeNull();
  });
});

describe("내 한 컷 (REQ-034, DB v5)", () => {
  const base = { category: "book" as const, mode: "daily" as const, products: [sampleProduct("1")], body: sampleBody, memo: null, quality: { bannedPhrasesFound: [], hasExperienceLine: false } };
  const photo = (filePath: string) => ({ filePath, mime: "image/jpeg" as const, bytes: 10 });

  it("[REQ-034] 사진은 승인 대기 초안에만 붙고, 다시 붙이면 교체되며 이전 경로를 돌려준다", () => {
    const db = openDb(":memory:");
    const waiting = insertDraft(db, { ...base, status: "awaiting_approval" }, NOW);
    const done = insertDraft(db, { ...base, status: "handed_off" }, NOW);
    expect(setDraftPhoto(db, done.id, photo("/m/x.jpg"), NOW)).toBeNull();
    expect(setDraftPhoto(db, waiting.id, photo("/m/a.jpg"), NOW)).toEqual({ replacedPath: null });
    expect(setDraftPhoto(db, waiting.id, photo("/m/b.jpg"), NOW)).toEqual({ replacedPath: "/m/a.jpg" });
    expect(getDraft(db, waiting.id)?.photo).toEqual(photo("/m/b.jpg"));
    expect(removeDraftPhoto(db, waiting.id)).toBe("/m/b.jpg");
    expect(getDraft(db, waiting.id)?.photo).toBeUndefined();
    expect(removeDraftPhoto(db, waiting.id)).toBeNull();
    db.close();
  });

  it("[REQ-034][REQ-011] 메모는 승인 대기일 때만 경험 한 줄로 붙고 품질의 경험 표시도 켠다", () => {
    const db = openDb(":memory:");
    const waiting = insertDraft(db, { ...base, status: "awaiting_approval" }, NOW);
    const drafting = insertDraft(db, { ...base, status: "drafting" }, NOW);
    expect(attachExperienceLine(db, drafting.id, "메모", NOW)).toBe(false);
    expect(attachExperienceLine(db, waiting.id, "메모", NOW)).toBe(true);
    expect(getDraft(db, waiting.id)).toMatchObject({ body: { experienceLine: "메모" }, quality: { hasExperienceLine: true } });
    expect(getDraft(db, drafting.id)?.body).toMatchObject({ experienceLine: sampleBody.experienceLine });
    db.close();
  });
});
