import type Database from "better-sqlite3";

import { CategorySchema, PendingMediaSchema } from "@contract/domain.js";

import {
  attachExperienceLine,
  countPendingDrafts,
  deleteKv,
  failOpenPublishAttempts,
  finishPublishAttempt,
  getDraft,
  getKv,
  getMonthLlmCostKrw,
  insertDraft,
  insertPublishAttempt,
  listCoveredProducts,
  listDraftPhotos,
  listDraftsByStatus,
  markCovered,
  removeDraftPhoto,
  saveRevision,
  setDraftPhoto,
  setKv,
  transitionDraft,
} from "../db.js";
import type { DraftStore } from "../jobs/daily-draft.js";
import type { PublishAttemptStore } from "../publish/orchestrator.js";
import { kstMonth } from "../schedule/time.js";

import type { ApprovalStore } from "./approval.js";
import type { MediaStore } from "./media.js";

export const LAST_CATEGORY_KEY = "last_category";
export const PENDING_REVISION_KEY = "pending_revision";
export const PENDING_MEDIA_KEY = "pending_media";

/** 사진이 더는 필요 없는 상태(폐기·발행·전달 완료). */
const CLOSED_STATUSES: readonly string[] = ["discarded", "published", "handed_off"];

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

/** SQLite 위의 ApprovalStore. 상태 전이는 전부 db.ts의 CAS(`transitionDraft`)를 거친다(CONVENTIONS §6). */
export function createApprovalStore(db: Database.Database, now: () => Date): ApprovalStore {
  return {
    getDraft: (id) => getDraft(db, id),
    listDrafting: () => listDraftsByStatus(db, "drafting"),
    transition: (id, from, to) => transitionDraft(db, id, from, to, now()),
    saveRevision: (id, body, quality) => saveRevision(db, id, body, quality, now()),
    getPendingRevision: () => {
      const value = getKv(db, PENDING_REVISION_KEY);
      return value === null ? null : Number(value);
    },
    setPendingRevision: (id) => (id === null ? deleteKv(db, PENDING_REVISION_KEY) : setKv(db, PENDING_REVISION_KEY, String(id))),
  };
}

/** SQLite 위의 발행 시도 로그 + 발행 중 초안 조회. 시도 기록은 발행기를 부르기 전에 쓴다(ADR-006). */
export function createPublishStore(db: Database.Database, now: () => Date): PublishAttemptStore {
  return {
    startAttempt: (draftId, mode) => insertPublishAttempt(db, draftId, mode, now()),
    finishAttempt: (attemptId, result) => finishPublishAttempt(db, attemptId, result, now()),
    listPublishing: () => listDraftsByStatus(db, "publishing"),
    failOpenAttempts: (draftId, reason) => failOpenPublishAttempts(db, draftId, reason, now()),
  };
}

/** SQLite 위의 MediaStore(REQ-034). 대기 중인 사진·메모는 kv `pending_media`에 JSON으로 둔다(ADR-014). */
export function createMediaStore(db: Database.Database, now: () => Date): MediaStore {
  return {
    getPending: () => {
      const value = getKv(db, PENDING_MEDIA_KEY);
      if (value === null) return null;
      const parsed = PendingMediaSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    },
    setPending: (media) => (media === null ? deleteKv(db, PENDING_MEDIA_KEY) : setKv(db, PENDING_MEDIA_KEY, JSON.stringify(media))),
    listAwaiting: () => listDraftsByStatus(db, "awaiting_approval"),
    attachMemo: (id, text) => attachExperienceLine(db, id, text, now()),
    attachPhoto: (id, photo) => setDraftPhoto(db, id, photo, now()),
    detachPhoto: (id) => removeDraftPhoto(db, id),
    listPhotos: () => listDraftPhotos(db).map((p) => ({ draftId: p.draftId, filePath: p.filePath, closed: CLOSED_STATUSES.includes(p.status) })),
  };
}
