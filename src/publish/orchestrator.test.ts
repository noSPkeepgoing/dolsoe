import { describe, expect, it, vi } from "vitest";

import type { DraftBody, Product, PublishMode, PublishResult } from "@contract/domain.js";
import { DISCLOSURE_TEXTS, PUBLISH_MAX_RETRIES } from "@contract/domain.js";

import { getDraft, insertDraft, listPublishAttempts, openDb } from "../db.js";
import { createApprovalStore, createPublishStore } from "../draft/store.js";

import { recoverStuckPublishing, publishDraft, type PublishDeps } from "./orchestrator.js";
import type { Post, Publisher } from "./publisher.js";
import { renderPostText } from "./renderer.js";

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

const body: DraftBody = {
  category: "book",
  title: "원본 제목",
  synopsis: "s",
  mood: "m",
  recommendedFor: "r",
  highlights: "h",
  experienceLine: null,
};

const ok = (mode: PublishMode, url: string | null = null): PublishResult => ({ ok: true, mode, url, externalId: null });
const fail = (mode: PublishMode, over: Partial<{ retryable: boolean; authExpired: boolean; reason: string }> = {}): PublishResult => ({
  ok: false,
  mode,
  retryable: false,
  authExpired: false,
  reason: "실패 사유",
  ...over,
});

/** 호출마다 미리 정한 결과를 차례로 돌려주는 가짜 발행기. 결과가 함수면 호출 시점에 실행한다. */
function fakePublisher(
  mode: PublishMode,
  results: (PublishResult | Error | ((post: Post) => PublishResult))[],
  render: (draft: Parameters<Publisher["render"]>[0]) => string = renderPostText,
) {
  const queue = [...results];
  const publish = vi.fn(async (post: Post): Promise<PublishResult> => {
    const next = queue.shift() ?? ok(mode);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(post) : next;
  });
  return { mode, render, publish } satisfies Publisher;
}

function setup(publishers: Publisher[], seedStatus: "awaiting_approval" | "failed" | "publishing" | "discarded" = "awaiting_approval") {
  const db = openDb(":memory:");
  const draft = insertDraft(
    db,
    { category: "book", mode: "daily", status: seedStatus, products: [product("1")], body, memo: null, quality: { bannedPhrasesFound: [], hasExperienceLine: false } },
    NOW,
  );
  const deps: PublishDeps = {
    store: { ...createApprovalStore(db, () => NOW), ...createPublishStore(db, () => NOW) },
    publishers,
    notify: vi.fn(async () => {}),
    notifyFailure: vi.fn(async () => {}),
  };
  const lastNotice = (fn: "notify" | "notifyFailure" = "notify") => String(vi.mocked(deps[fn]).mock.calls.at(-1)?.at(-1) ?? "");
  return { db, draft, deps, lastNotice, status: () => getDraft(db, draft.id)?.status };
}

describe("publishDraft — 성공 경로", () => {
  it("[REQ-012] 수동(③) 전달이 성공하면 handed_off가 되고 복붙 안내가 나온다", async () => {
    const manual = fakePublisher("manual", []);
    const { db, draft, deps, lastNotice, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    expect(lastNotice()).toContain("붙여넣");
    expect(listPublishAttempts(db, draft.id)).toMatchObject([{ mode: "manual", result: { ok: true } }]);
  });

  it("[REQ-012] 발행기에는 대가성 문구가 붙은 최종 본문이 넘어간다", async () => {
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([manual]);
    await publishDraft(deps, draft.id);
    const post = manual.publish.mock.calls[0]![0];
    expect(post).toMatchObject({ draftId: draft.id, title: "원본 제목" });
    expect(post.content).toContain(DISCLOSURE_TEXTS.yes24);
  });

  it("[REQ-010] 발행기에는 화면에서 반드시 확인해야 할 대가성 문구 목록(mustContain)도 넘어간다", async () => {
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([manual]);
    await publishDraft(deps, draft.id);
    expect(manual.publish.mock.calls[0]![0].mustContain).toEqual([DISCLOSURE_TEXTS.yes24]);
  });

  it("[REQ-012] ① 즉시 발행(live)이 되면 published, 알림에 즉시 발행과 주소가 표시된다", async () => {
    const live = fakePublisher("live", [ok("live", "https://blog.naver.com/me/1")]);
    const { draft, deps, lastNotice, status } = setup([live]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("published");
    expect(status()).toBe("published");
    expect(lastNotice()).toContain("즉시 발행");
    expect(lastNotice()).toContain("https://blog.naver.com/me/1");
  });

  it("[REQ-012] ② 비공개 등록(private)이면 published이고 공개 전환 안내가 나온다", async () => {
    const priv = fakePublisher("private", [ok("private")]);
    const { draft, deps, lastNotice, status } = setup([priv]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("published");
    expect(status()).toBe("published");
    expect(lastNotice()).toContain("비공개");
    expect(lastNotice()).toContain("공개");
  });

  it("[REQ-012] 위 단계가 안 되면 사다리의 다음 단계로 처리하고, 어떤 방식이었는지·왜 내려왔는지 알린다", async () => {
    const live = fakePublisher("live", [fail("live", { reason: "API 종료" })]);
    const manual = fakePublisher("manual", []);
    const { db, draft, deps, lastNotice, status } = setup([live, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    expect(lastNotice()).toContain("API 종료");
    expect(lastNotice()).toContain("붙여넣");
    expect(listPublishAttempts(db, draft.id).map((attempt) => [attempt.mode, attempt.result?.ok])).toEqual([
      ["live", false],
      ["manual", true],
    ]);
  });
});

describe("publishDraft — 실패·재시도 (REQ-013)", () => {
  it("[REQ-013] 시도 기록은 발행기를 부르기 전에 먼저 남고, 그때 초안은 publishing이다", async () => {
    let seen: { attempts: number; open: boolean; status: string | undefined } | null = null;
    const manual = fakePublisher("manual", [
      () => {
        const attempts = listPublishAttempts(ctx.db, ctx.draft.id);
        seen = { attempts: attempts.length, open: attempts[0]?.result === null, status: ctx.status() };
        return ok("manual");
      },
    ]);
    const ctx = setup([manual]);
    await publishDraft(ctx.deps, ctx.draft.id);
    expect(seen).toEqual({ attempts: 1, open: true, status: "publishing" });
  });

  it("[REQ-013] 명확한 실패(retryable)는 1회만 재시도하고, 재시도가 성공하면 그대로 성공 처리한다", async () => {
    const manual = fakePublisher("manual", [fail("manual", { retryable: true }), ok("manual")]);
    const { db, draft, deps, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(manual.publish).toHaveBeenCalledTimes(2);
    expect(status()).toBe("handed_off");
    expect(listPublishAttempts(db, draft.id)).toHaveLength(2);
  });

  it("[REQ-013] 재시도해도 실패하면 failed로 두고 실패 알림이 오며, 초안은 그대로 보존된다", async () => {
    const manual = fakePublisher("manual", [
      fail("manual", { retryable: true, reason: "네이버 500" }),
      fail("manual", { retryable: true, reason: "네이버 500" }),
      ok("manual"), // 호출되면 안 된다
    ]);
    const { db, draft, deps, lastNotice, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(manual.publish).toHaveBeenCalledTimes(1 + PUBLISH_MAX_RETRIES);
    expect(getDraft(db, draft.id)).toMatchObject({ status: "failed", body: { title: "원본 제목" } });
    expect(status()).toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("네이버 500");
    expect(lastNotice("notifyFailure")).toContain("보존");
  });

  it("[REQ-013] 재시도할 수 없는 실패(retryable=false)는 재시도 없이 바로 다음 단계로 넘어간다", async () => {
    const live = fakePublisher("live", [fail("live", { retryable: false })]);
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([live, manual]);
    await publishDraft(deps, draft.id);
    expect(live.publish).toHaveBeenCalledTimes(1);
    expect(manual.publish).toHaveBeenCalledTimes(1);
  });

  it("[REQ-013] 인증 만료로 끝까지 실패하면 \"재인증 필요\"를 명시한다", async () => {
    const live = fakePublisher("live", [fail("live", { authExpired: true, reason: "401" })]);
    const { draft, deps, lastNotice } = setup([live]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("재인증 필요");
  });

  it("[REQ-013] 발행기가 예외를 던지면 결과 불확실로 보고 재시도·다음 단계 없이 멈추며, 사람 확인을 요청한다(ADR-006)", async () => {
    const live = fakePublisher("live", [new Error("socket hang up")]);
    const manual = fakePublisher("manual", []);
    const { db, draft, deps, lastNotice, status } = setup([live, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(live.publish).toHaveBeenCalledTimes(1);
    expect(manual.publish).not.toHaveBeenCalled();
    expect(status()).toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("확인");
    expect(listPublishAttempts(db, draft.id)).toMatchObject([
      { mode: "live", result: { ok: false, retryable: false, reason: expect.stringContaining("socket hang up") } },
    ]);
  });

  it("[REQ-013] 발행기가 계약에 맞지 않는 결과를 돌려줘도 불확실로 취급한다(경계 검증)", async () => {
    const live = fakePublisher("live", [{ ok: "maybe" } as unknown as PublishResult]);
    const { draft, deps, status } = setup([live]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(status()).toBe("failed");
  });

  it("[REQ-013] failed 초안은 사람이 다시 눌러 재시도할 수 있고, 성공하면 완료 상태가 된다", async () => {
    const manual = fakePublisher("manual", [fail("manual", { retryable: false }), ok("manual")]);
    const { db, draft, deps, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    expect(listPublishAttempts(db, draft.id)).toHaveLength(2);
  });
});

describe("publishDraft — 가드", () => {
  it("[REQ-009] 발행을 동시에 두 번 눌러도 한 번만 처리된다", async () => {
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([manual]);
    const outcomes = await Promise.all([publishDraft(deps, draft.id), publishDraft(deps, draft.id)]);
    expect([...outcomes].sort()).toEqual(["handed_off", "ignored"]);
    expect(manual.publish).toHaveBeenCalledTimes(1);
  });

  it("[REQ-009] 이미 발행됐거나 폐기됐거나 없는 초안은 조용히 무시한다(알림도 없음)", async () => {
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([manual], "discarded");
    await expect(publishDraft(deps, draft.id)).resolves.toBe("ignored");
    await expect(publishDraft(deps, 9999)).resolves.toBe("ignored");
    expect(manual.publish).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("[REQ-010] 최종 산출물에 대가성 문구가 없으면 발행을 막고, 시도 기록도 상태 전이도 없다", async () => {
    const manual = fakePublisher("manual", [], () => "대가성 문구 없는 본문");
    const { db, draft, deps, lastNotice, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("blocked");
    expect(manual.publish).not.toHaveBeenCalled();
    expect(lastNotice()).toContain("대가성");
    expect(status()).toBe("awaiting_approval");
    expect(listPublishAttempts(db, draft.id)).toHaveLength(0);
  });

  it("[REQ-010] 게이트는 사다리의 모든 발행기가 만든 산출물에 걸린다(아래 단계가 문구를 빼먹어도 막는다)", async () => {
    const live = fakePublisher("live", []);
    const manual = fakePublisher("manual", [], () => "문구 없음");
    const { draft, deps } = setup([live, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("blocked");
    expect(live.publish).not.toHaveBeenCalled();
  });

  it("[REQ-009] 발행하면 그 초안의 수정 대기도 풀린다", async () => {
    const manual = fakePublisher("manual", []);
    const { draft, deps } = setup([manual]);
    deps.store.setPendingRevision(draft.id);
    await publishDraft(deps, draft.id);
    expect(deps.store.getPendingRevision()).toBeNull();
  });
});

describe("publishing 고착 방지 (ADR-006)", () => {
  it("[REQ-013] 최종 전이가 DB 오류로 던져져도 초안이 publishing에 남지 않고 failed + 확인 요청이 간다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manual = fakePublisher("manual", []);
    const { draft, deps, status, lastNotice } = setup([manual]);
    const realTransition = deps.store.transition;
    deps.store.transition = (id, from, to) => {
      if (to === "handed_off") throw new Error("database is locked");
      return realTransition(id, from, to);
    };
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(status()).toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("확인");
    error.mockRestore();
  });

  it("[REQ-013] 시도 기록을 못 써서(startAttempt 예외) 발행을 시작도 못 했어도 publishing에 남지 않는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manual = fakePublisher("manual", []);
    const { draft, deps, status } = setup([manual]);
    deps.store.startAttempt = () => {
      throw new Error("disk full");
    };
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(manual.publish).not.toHaveBeenCalled();
    expect(status()).toBe("failed");
    error.mockRestore();
  });
});

describe("결과 mode 검증", () => {
  it("[REQ-012] 발행기가 자기 mode와 다른 성공 결과를 주면 불확실로 취급한다(상태·안내가 틀어지지 않게)", async () => {
    const manual = fakePublisher("manual", [ok("live", "https://blog.naver.com/me/1")]);
    const { draft, deps, status } = setup([manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(status()).toBe("failed");
  });
});

describe("알림 실패 (CONVENTIONS §6)", () => {
  it("[REQ-013] 실패 알림 전송이 실패해도 상태는 failed로 남고 예외로 번지지 않는다(로그만)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manual = fakePublisher("manual", [fail("manual")]);
    const { draft, deps, status } = setup([manual]);
    vi.mocked(deps.notifyFailure).mockRejectedValue(new Error("telegram down"));
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(status()).toBe("failed");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("[REQ-012] 성공 알림 전송이 실패해도 발행 결과(handed_off)는 그대로다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manual = fakePublisher("manual", []);
    const { draft, deps, status } = setup([manual]);
    vi.mocked(deps.notify).mockRejectedValue(new Error("telegram down"));
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    error.mockRestore();
  });
});

describe("recoverStuckPublishing", () => {
  it("[REQ-013] 발행 중 재시작으로 멈춘 초안은 failed로 돌리고 열린 시도를 닫고 사람 확인을 요청한다", async () => {
    const { db, draft, deps, lastNotice, status } = setup([fakePublisher("manual", [])], "publishing");
    const attemptId = deps.store.startAttempt(draft.id, "manual");
    expect(attemptId).toBeGreaterThan(0);

    await expect(recoverStuckPublishing(deps)).resolves.toBe(1);
    expect(status()).toBe("failed");
    expect(listPublishAttempts(db, draft.id)).toMatchObject([{ result: { ok: false, retryable: false } }]);
    expect(lastNotice("notifyFailure")).toContain("확인");
    await expect(recoverStuckPublishing(deps)).resolves.toBe(0);
  });
});

describe("publishDraft — 네이버 임시저장(draft) 단계 (ADR-005 개정)", () => {
  it("[REQ-012] 임시저장이 되면 handed_off(사람이 공개)가 되고, 임시저장함에서 확인·발행하라고 안내한다", async () => {
    const draftPublisher = fakePublisher("draft", [ok("draft")]);
    const manual = fakePublisher("manual", []);
    const { db, draft, deps, lastNotice, status } = setup([draftPublisher, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    expect(lastNotice()).toContain("임시저장");
    expect(lastNotice()).toContain("발행");
    expect(manual.publish).not.toHaveBeenCalled();
    expect(listPublishAttempts(db, draft.id).map((attempt) => [attempt.mode, attempt.result?.ok])).toEqual([["draft", true]]);
  });

  it("[REQ-013] 세션 만료로 임시저장이 안 되면 텔레그램 전달로 내려가되, 재인증 필요와 로그인 방법을 같이 알린다", async () => {
    const draftPublisher = fakePublisher("draft", [fail("draft", { authExpired: true, reason: "네이버 로그인 세션 만료" })]);
    const manual = fakePublisher("manual", []);
    const { draft, deps, lastNotice, status } = setup([draftPublisher, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("handed_off");
    expect(status()).toBe("handed_off");
    expect(lastNotice()).toContain("붙여넣");
    expect(lastNotice()).toContain("재인증 필요");
    expect(lastNotice()).toContain("naver:login");
  });

  it("[REQ-013] 임시저장 단계가 인증 만료로 끝까지 실패하면 글쓰기 API가 아니라 로그인 재실행을 안내한다", async () => {
    const draftPublisher = fakePublisher("draft", [fail("draft", { authExpired: true })]);
    const { draft, deps, lastNotice } = setup([draftPublisher]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("재인증 필요");
    expect(lastNotice("notifyFailure")).toContain("naver:login");
    expect(lastNotice("notifyFailure")).not.toContain("API");
  });

  it("[REQ-013] 임시저장 단계가 던지면(결과 불확실) 텔레그램 전달로 내려가지 않고 사람 확인을 요청한다", async () => {
    const draftPublisher = fakePublisher("draft", [new Error("브라우저가 죽음")]);
    const manual = fakePublisher("manual", []);
    const { draft, deps, lastNotice, status } = setup([draftPublisher, manual]);
    await expect(publishDraft(deps, draft.id)).resolves.toBe("failed");
    expect(manual.publish).not.toHaveBeenCalled();
    expect(status()).toBe("failed");
    expect(lastNotice("notifyFailure")).toContain("임시저장함");
  });
});
