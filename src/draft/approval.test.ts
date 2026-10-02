import { describe, expect, it, vi } from "vitest";

import type { Draft, DraftBody, Product } from "@contract/domain.js";
import { MONTHLY_LLM_BUDGET_KRW } from "@contract/domain.js";

import { getDraft, insertDraft, openDb } from "../db.js";

import {
  beginRevision,
  discardDraft,
  recoverStuckDrafts,
  submitRevision,
  type ApprovalDeps,
} from "./approval.js";
import { GenerationError, expectedExperienceLine, type BodyGenerator, type GenerateBodyInput } from "./generate.js";
import { createApprovalStore } from "./store.js";

const NOW = new Date("2026-10-02T00:00:00.000Z");

const product = (id: string): Product => ({
  externalId: id,
  source: "yes24",
  category: "book",
  affiliate: "yes24",
  title: `책 ${id}`,
  url: `https://www.yes24.com/addon/${id}`,
  priceKrw: 10000,
  priceAsOf: NOW.toISOString(),
  specs: {},
});

const bookBody = (title = "원본 제목", experienceLine: string | null = null): DraftBody => ({
  category: "book",
  title,
  intro: "소개",
  items: [{ productExternalId: "1", oneLiner: "한 줄", reason: "이유" }],
  experienceLine,
});

/** 수정 요청이면 지시문을 제목에 반영하고 지켜야 할 경험 문장을 그대로 넣는 가짜 생성기. */
const fakeGenerator = (): BodyGenerator & { generateBody: ReturnType<typeof vi.fn> } => ({
  generateBody: vi.fn(async (input: GenerateBodyInput): Promise<DraftBody> => {
    const revision = input.revision;
    const experience = revision === undefined ? null : expectedExperienceLine(revision);
    return bookBody(`수정됨: ${revision?.instruction ?? ""}`, experience);
  }),
});

function setup(over: Partial<ApprovalDeps> = {}, seedStatus: Draft["status"] = "awaiting_approval") {
  const db = openDb(":memory:");
  const draft = insertDraft(
    db,
    { category: "book", mode: "daily", status: seedStatus, products: [product("1")], body: bookBody(), memo: null, quality: { bannedPhrasesFound: [], hasExperienceLine: false } },
    NOW,
  );
  const deps: ApprovalDeps = {
    store: createApprovalStore(db, () => NOW),
    generator: fakeGenerator(),
    getMonthCostKrw: () => 0,
    notify: vi.fn(async () => {}),
    deliverCard: vi.fn(async () => {}),
    ...over,
  };
  return { db, draft, deps };
}

describe("discardDraft", () => {
  it("[REQ-008] 폐기는 상태만 바꾸고 기록을 남기며, 두 번 눌러도 조용히 무시한다", async () => {
    const { db, draft, deps } = setup();
    await expect(discardDraft(deps, draft.id)).resolves.toBe("discarded");
    await expect(discardDraft(deps, draft.id)).resolves.toBe("ignored");
    expect(getDraft(db, draft.id)).toMatchObject({ status: "discarded", body: { title: "원본 제목" } });
  });

  it("[REQ-013] 발행에 실패해 failed로 멈춘 초안도 사람이 폐기할 수 있다", async () => {
    const { db, draft, deps } = setup({}, "failed");
    await expect(discardDraft(deps, draft.id)).resolves.toBe("discarded");
    expect(getDraft(db, draft.id)?.status).toBe("discarded");
  });
});

describe("수정 흐름 (beginRevision → submitRevision)", () => {
  it("[REQ-008] 수정을 누르면 지시를 요청하고, 다음 메시지로 다시 만든 초안이 승인 요청으로 온다", async () => {
    const { db, draft, deps } = setup();
    await expect(beginRevision(deps, draft.id)).resolves.toBe("asked");
    expect(vi.mocked(deps.notify).mock.calls[0]![0]).toContain("경험 한 줄");

    await expect(submitRevision(deps, "표를 더 간단히")).resolves.toBe("revised");
    const saved = getDraft(db, draft.id);
    expect(saved).toMatchObject({ status: "awaiting_approval", body: { title: "수정됨: 표를 더 간단히" } });
    expect(deps.deliverCard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.deliverCard).mock.calls[0]![0].id).toBe(draft.id);
  });

  it("[REQ-011] 수정 지시의 '경험 한 줄'이 재생성된 본문에 원문 그대로 들어가고 '경험 있음'이 기록된다", async () => {
    const { db, draft, deps } = setup();
    await beginRevision(deps, draft.id);
    await submitRevision(deps, "경험 한 줄: 소음이 생각보다 컸어요");
    expect(getDraft(db, draft.id)).toMatchObject({
      body: { experienceLine: "소음이 생각보다 컸어요" },
      quality: { hasExperienceLine: true },
    });
  });

  it("[REQ-008] 수정이 끝나면 대기 표시가 풀려, 다음 메시지는 더 이상 수정 지시로 쓰이지 않는다", async () => {
    const { draft, deps } = setup();
    await beginRevision(deps, draft.id);
    await submitRevision(deps, "표를 더 간단히");
    await expect(submitRevision(deps, "아무 말")).resolves.toBe("none");
  });

  it("[REQ-008] 수정 대기 중이 아니면 submitRevision은 아무것도 하지 않는다", async () => {
    const { deps } = setup();
    await expect(submitRevision(deps, "표를 더 간단히")).resolves.toBe("none");
    expect(vi.mocked(deps.generator.generateBody)).not.toHaveBeenCalled();
  });

  it("[REQ-011] 재생성에 실패하면 이전 초안으로 되돌리고, 내 지시 원문과 함께 알리고, 카드를 다시 보낸다(유실 금지)", async () => {
    const generator: BodyGenerator = { generateBody: vi.fn(async () => { throw new GenerationError("경험 문장이 바뀜"); }) };
    const { db, draft, deps } = setup({ generator });
    await beginRevision(deps, draft.id);
    await expect(submitRevision(deps, "경험 한 줄: 소음이 컸어요")).resolves.toBe("failed");

    expect(getDraft(db, draft.id)).toMatchObject({ status: "awaiting_approval", body: { title: "원본 제목" } });
    const messages = vi.mocked(deps.notify).mock.calls.map(([text]) => text).join("\n");
    expect(messages).toContain("경험 한 줄: 소음이 컸어요");
    expect(deps.deliverCard).toHaveBeenCalledTimes(1);
    await expect(submitRevision(deps, "다시")).resolves.toBe("none"); // 대기 해제
  });

  it("[REQ-008] 이미 폐기·발행된 초안은 수정을 시작할 수 없다", async () => {
    const { deps, draft } = setup({}, "discarded");
    await expect(beginRevision(deps, draft.id)).resolves.toBe("ignored");
  });
});

describe("승인 흐름 보강 (audit)", () => {
  it("[REQ-008] 수정 대기 중 초안이 이미 처리됐으면 입력을 삼키지 않고 이유를 알린다", async () => {
    const { draft, deps } = setup();
    await beginRevision(deps, draft.id);
    await discardDraft(deps, draft.id);
    vi.mocked(deps.notify).mockClear();
    // 폐기가 대기도 풀었으므로 다음 입력은 수정 지시가 아니다
    await expect(submitRevision(deps, "표를 더 간단히")).resolves.toBe("none");

    const other = setup();
    await beginRevision(other.deps, other.draft.id);
    other.deps.store.transition(other.draft.id, "awaiting_approval", "discarded"); // 다른 경로로 처리됨
    await expect(submitRevision(other.deps, "표를 더 간단히")).resolves.toBe("ignored");
    expect(vi.mocked(other.deps.notify).mock.calls.at(-1)![0]).toContain("이미 처리");
  });

  it("[NFR-001] 월 비용 상한에 닿으면 수정 재생성을 하지 않고 이전 초안을 그대로 둔다", async () => {
    const { db, draft, deps } = setup({ getMonthCostKrw: () => MONTHLY_LLM_BUDGET_KRW });
    await beginRevision(deps, draft.id);
    await expect(submitRevision(deps, "표를 더 간단히")).resolves.toBe("budget");
    expect(vi.mocked(deps.generator.generateBody)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.notify).mock.calls.at(-1)![0]).toContain("비용");
    expect(getDraft(db, draft.id)).toMatchObject({ status: "awaiting_approval", body: { title: "원본 제목" } });
  });

  it("[REQ-007] 수정 결과 카드 전송이 실패해도 저장된 초안은 유지하고 번호와 함께 알린다", async () => {
    const { db, draft, deps } = setup({ deliverCard: vi.fn(async () => { throw new Error("telegram down"); }) });
    await beginRevision(deps, draft.id);
    await expect(submitRevision(deps, "표를 더 간단히")).resolves.toBe("revised");
    expect(getDraft(db, draft.id)?.status).toBe("awaiting_approval");
    expect(vi.mocked(deps.notify).mock.calls.at(-1)![0]).toMatch(/#\d+.*telegram down/s);
  });

  it("[REQ-011] '경험 한 줄: 없음'으로 이전 경험 문장을 지울 수 있다", async () => {
    const { db, draft, deps } = setup();
    await beginRevision(deps, draft.id);
    await submitRevision(deps, "경험 한 줄: 소음이 컸어요");
    await beginRevision(deps, draft.id);
    await submitRevision(deps, "경험 한 줄: 없음");
    expect(getDraft(db, draft.id)).toMatchObject({ body: { experienceLine: null }, quality: { hasExperienceLine: false } });
  });

  it("[REQ-008] 기동 시 수정 중(drafting)에 멈춘 초안을 대기 상태로 되돌리고 카드를 다시 보낸다", async () => {
    const { db, draft, deps } = setup({}, "drafting");
    deps.store.setPendingRevision(draft.id);
    await expect(recoverStuckDrafts(deps)).resolves.toBe(1);
    expect(getDraft(db, draft.id)?.status).toBe("awaiting_approval");
    expect(deps.deliverCard).toHaveBeenCalledTimes(1);
    expect(deps.store.getPendingRevision()).toBeNull();
    await expect(recoverStuckDrafts(deps)).resolves.toBe(0);
  });
});
