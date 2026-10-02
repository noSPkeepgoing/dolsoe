import type Database from "better-sqlite3";

import { CategorySchema } from "@contract/domain.js";

import {
  countPendingDrafts,
  getKv,
  getMonthLlmCostKrw,
  insertDraft,
  listCoveredProducts,
  markCovered,
  setKv,
} from "../db.js";
import type { DraftStore } from "../jobs/daily-draft.js";
import { kstMonth } from "../schedule/time.js";

export const LAST_CATEGORY_KEY = "last_category";

/** SQLite 위의 DraftStore. 저장은 한 트랜잭션이라 중간에 실패하면 아무것도 남지 않는다. */
export function createDraftStore(db: Database.Database, now: () => Date): DraftStore {
  return {
    countPending: () => countPendingDrafts(db),
    getLastCategory: () => {
      const value = getKv(db, LAST_CATEGORY_KEY);
      return value === null ? null : CategorySchema.parse(value);
    },
    listCovered: () => listCoveredProducts(db),
    getMonthCostKrw: () => getMonthLlmCostKrw(db, kstMonth(now())),
    saveDraft: (draft, covered) =>
      db.transaction(() => {
        const saved = insertDraft(db, draft, now());
        markCovered(db, covered, now());
        // 번갈아 순서는 "기본 모드가 마지막으로 만든 초안" 기준 — 링크 모드 글은 건드리지 않는다(PRD REQ-001).
        if (draft.mode === "daily") setKv(db, LAST_CATEGORY_KEY, draft.category);
        return saved;
      })(),
  };
}
