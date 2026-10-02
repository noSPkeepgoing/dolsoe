import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DraftBody, Product } from "@contract/domain.js";

import {
  addLlmCostKrw,
  claimDueJobs,
  countPendingDrafts,
  enqueueJob,
  getKv,
  getMonthLlmCostKrw,
  insertDraft,
  listCoveredProducts,
  markCovered,
  markUpdateProcessed,
  openDb,
  setKv,
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
  intro: "소개",
  items: [{ productExternalId: "1", oneLiner: "한 줄", reason: "이유" }],
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
