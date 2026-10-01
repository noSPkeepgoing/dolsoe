import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { markUpdateProcessed, openDb } from "./db.js";

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
