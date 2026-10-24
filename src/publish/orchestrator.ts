import type { Draft, PublishMode, PublishResult } from "@contract/domain.js";
import { PUBLISH_MAX_RETRIES, PublishResultSchema } from "@contract/domain.js";

import type { ApprovalStore } from "../draft/approval.js";
import { clearPendingRevisionFor } from "../draft/approval.js";

import { missingDisclosures, requiredDisclosures } from "./disclosure.js";
import type { Post, Publisher } from "./publisher.js";

/** 발행 시도 로그와 발행 중 초안 조회(ADR-006). 실제 구현은 draft/store.ts(SQLite). */
export interface PublishAttemptStore {
  startAttempt(draftId: number, mode: PublishMode): number;
  finishAttempt(attemptId: number, result: PublishResult): void;
  listPublishing(): Draft[];
  failOpenAttempts(draftId: number, reason: string): void;
}

export type PublishStore = Pick<ApprovalStore, "getDraft" | "transition" | "getPendingRevision" | "setPendingRevision"> &
  PublishAttemptStore;

export interface PublishDeps {
  store: PublishStore;
  /** 사다리 순서(위 단계가 먼저). 1차 구현은 [수동 전달]만(ADR-005). */
  publishers: readonly Publisher[];
  notify: (text: string) => Promise<void>;
  /** 실패 알림. 다시 시도/폐기 버튼이 붙는다(failed 초안을 사람이 이어받는 유일한 길). */
  notifyFailure: (draftId: number, text: string) => Promise<void>;
}

export type PublishOutcome = "published" | "handed_off" | "ignored" | "blocked" | "failed";

type FailedResult = Extract<PublishResult, { ok: false }>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const MODE_LABEL: Record<PublishMode, string> = {
  live: "① 즉시 발행",
  private: "② 비공개 등록",
  draft: "③ 네이버 임시저장",
  manual: "④ 텔레그램 전달",
};

/** 사람이 마지막 단계를 이어받는 방식(공개 발행 또는 복붙). 이 방식이 성공하면 초안은 published가 아니라 handed_off다. */
const HUMAN_FINISH_MODES: readonly PublishMode[] = ["draft", "manual"];

/** REQ-013: 네이버 로그인 세션이 만료됐을 때의 재인증 안내. 로그인은 사람이 전용 프로필 창에서 직접 한다(NFR-003). */
const REAUTH_NOTICE = "🔑 재인증 필요: 네이버 로그인 세션이 만료됐어요. 맥에서 `npm run naver:login`을 실행해 다시 로그인해 주세요.";

function successText(id: number, result: Extract<PublishResult, { ok: true }>, fellBack: FailedResult[]): string {
  const where = result.url === null ? "" : `\n${result.url}`;
  const head: Record<PublishMode, string> = {
    live: `✅ #${id} 네이버에 즉시 발행했어요.${where}`,
    private: `✅ #${id} 네이버에 비공개로 등록했어요. 네이버에서 확인하고 공개로 전환해 주세요.${where}`,
    draft: `✅ #${id} 네이버 블로그 임시저장함에 저장했어요. 네이버 블로그(앱·웹)의 임시저장함에서 내용을 확인하고 직접 발행해 주세요.`,
    manual: `✅ #${id} 발행 준비 완료 — 위 본문을 복사해 네이버 블로그에 붙여넣어 주세요.`,
  };
  const reasons = fellBack.map((failure) => `- ${MODE_LABEL[failure.mode]} 실패: ${failure.reason}`);
  const reauth = fellBack.some((failure) => failure.authExpired) ? [REAUTH_NOTICE] : [];
  return reasons.length === 0 ? head[result.mode] : [head[result.mode], "위 단계가 안 돼서 다음 방식으로 처리했어요.", ...reasons, ...reauth].join("\n");
}

function failureText(id: number, failures: FailedResult[], uncertain: boolean): string {
  const lines = failures.map((failure) => `- ${MODE_LABEL[failure.mode]}: ${failure.reason}`);
  const head = uncertain
    ? `⚠️ #${id} 발행 결과가 불확실해요. 이미 올라갔을 수 있으니 네이버(임시저장함 포함)·채팅에서 실제 게시 여부를 먼저 확인한 뒤 다시 시도하거나 폐기해 주세요. 초안은 보존돼 있어요.`
    : `⚠️ #${id} 발행에 실패했어요(${PUBLISH_MAX_RETRIES}회 재시도 포함). 초안은 그대로 보존돼 있어요.`;
  const auth = failures.some((failure) => failure.authExpired) ? [REAUTH_NOTICE] : [];
  return [head, ...lines, ...auth].join("\n");
}

/** 알림이 실패해도 이미 정해진 발행 상태·결과를 뒤집지 않는다. 알림 실패는 로그에 남긴다(CONVENTIONS §6). */
async function alert(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error("[publish] notification failed", error);
  }
}

type RungOutcome = { kind: "ok"; result: Extract<PublishResult, { ok: true }> } | { kind: "failed"; last: FailedResult } | { kind: "uncertain"; last: FailedResult };

/**
 * 한 단계(발행기)를 시도한다. 명확한 실패(retryable)만 `PUBLISH_MAX_RETRIES`회 재시도한다(REQ-013).
 * 던졌거나 계약에 안 맞는 결과를 준 경우는 올라갔는지 알 수 없으므로(ADR-006) 재시도·다음 단계 없이 멈춘다.
 */
async function runRung(deps: PublishDeps, publisher: Publisher, post: Post, draftId: number): Promise<RungOutcome> {
  let last: FailedResult | null = null;
  for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
    const attemptId = deps.store.startAttempt(draftId, publisher.mode);
    let result: PublishResult;
    try {
      result = PublishResultSchema.parse(await publisher.publish(post));
      // 상태·안내가 result.mode를 따르므로 발행기가 자기 단계와 다른 mode를 주면 신뢰하지 않는다.
      if (result.mode !== publisher.mode) throw new Error(`발행기(${publisher.mode})가 다른 방식(${result.mode})의 결과를 돌려줬어요`);
    } catch (error) {
      const uncertain: FailedResult = { ok: false, mode: publisher.mode, retryable: false, authExpired: false, reason: messageOf(error) };
      deps.store.finishAttempt(attemptId, uncertain);
      return { kind: "uncertain", last: uncertain };
    }
    deps.store.finishAttempt(attemptId, result);
    if (result.ok) return { kind: "ok", result };
    last = result;
    if (!result.retryable) break;
  }
  if (last === null) throw new Error("unreachable: no attempt was made");
  return { kind: "failed", last };
}

/**
 * REQ-009·010·012·013: 발행 버튼(과 failed 초안의 재시도). 흐름:
 * ① 사다리 모든 단계의 **최종 산출물**에 대가성 게이트(REQ-010) → ② CAS로 `publishing` 진입(더블탭 한 번만, REQ-009)
 * → ③ 위 단계부터 시도(시도 기록 먼저, ADR-006) → ④ 성공한 방식을 알리거나, 끝까지 실패하면 `failed` + 알림(초안 보존).
 */
export async function publishDraft(deps: PublishDeps, id: number): Promise<PublishOutcome> {
  const { store } = deps;
  const draft = store.getDraft(id);
  if (draft === null || draft.body === null) return "ignored";
  if (draft.status !== "awaiting_approval" && draft.status !== "failed") return "ignored";

  const posts = deps.publishers.map((publisher) => ({ publisher, post: { draftId: id, title: draft.body!.title, content: publisher.render(draft), mustContain: requiredDisclosures(draft.products), ...(draft.photo == null ? {} : { photoPath: draft.photo.filePath }) } }));
  if (posts.some(({ post }) => missingDisclosures(post.content, draft.products).length > 0)) {
    await alert(() => deps.notify(`#${id} 초안에 대가성 문구가 없어 발행을 막았어요. 초안은 그대로 남아 있어요.`));
    return "blocked";
  }
  if (!store.transition(id, draft.status, "publishing")) return "ignored";

  // CAS로 publishing에 들어간 뒤에는 어떤 예외 경로도 publishing에 남기지 않는다(ADR-006) — 올라갔는지 알 수 없으므로 불확실로 본다.
  try {
    clearPendingRevisionFor(store, id);
    return await runLadder(deps, id, posts);
  } catch (error) {
    console.error("[publish] unexpected error after entering publishing", error);
    try {
      store.transition(id, "publishing", "failed");
    } catch (transitionError) {
      console.error("[publish] could not mark draft failed; startup recovery will", transitionError);
    }
    const failure: FailedResult = { ok: false, mode: deps.publishers[0]?.mode ?? "manual", retryable: false, authExpired: false, reason: messageOf(error) };
    await alert(() => deps.notifyFailure(id, failureText(id, [failure], true)));
    return "failed";
  }
}

async function runLadder(deps: PublishDeps, id: number, posts: { publisher: Publisher; post: Post }[]): Promise<PublishOutcome> {
  const { store } = deps;
  const failures: FailedResult[] = [];
  let uncertain = false;
  for (const { publisher, post } of posts) {
    const outcome = await runRung(deps, publisher, post, id);
    if (outcome.kind === "ok") {
      const next = HUMAN_FINISH_MODES.includes(outcome.result.mode) ? "handed_off" : "published";
      store.transition(id, "publishing", next);
      await alert(() => deps.notify(successText(id, outcome.result, failures)));
      return next;
    }
    failures.push(outcome.last);
    if (outcome.kind === "uncertain") {
      uncertain = true;
      break;
    }
  }

  store.transition(id, "publishing", "failed");
  await alert(() => deps.notifyFailure(id, failureText(id, failures, uncertain)));
  return "failed";
}

/**
 * 기동 시 복구: 발행 도중 프로세스가 죽어 `publishing`에 남은 초안은 올라갔는지 알 수 없다.
 * 자동 재발행은 금지(ADR-006) — `failed`로 돌리고 열린 시도를 닫은 뒤 사람 확인을 요청한다. 돌려주는 값은 복구한 개수.
 */
export async function recoverStuckPublishing(deps: PublishDeps): Promise<number> {
  let recovered = 0;
  for (const draft of deps.store.listPublishing()) {
    if (!deps.store.transition(draft.id, "publishing", "failed")) continue;
    recovered++;
    deps.store.failOpenAttempts(draft.id, "재시작으로 발행이 중단됨");
    await alert(() =>
      deps.notifyFailure(
        draft.id,
        `⚠️ #${draft.id} 발행 도중 재시작돼 결과가 불확실해요. 이미 올라갔을 수 있으니 네이버·채팅에서 먼저 확인한 뒤 다시 시도하거나 폐기해 주세요. 초안은 보존돼 있어요.`,
      ),
    );
  }
  return recovered;
}
