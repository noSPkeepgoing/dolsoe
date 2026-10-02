import type { Draft, DraftBody, DraftStatus, QualityReport } from "@contract/domain.js";

import { isBudgetExceeded } from "../llm/cost.js";
import { renderPostText } from "../publish/renderer.js";
import { missingDisclosures } from "../publish/disclosure.js";

import { deliverCardSafely } from "./deliver.js";
import { generateDraftBody, type BodyGenerator } from "./generate.js";
import { parseReviseInstruction } from "./revise.js";

/** 승인 흐름이 필요로 하는 저장소 경계. 실제 구현은 draft/store.ts(SQLite), 상태 전이는 전부 CAS(ADR-006). */
export interface ApprovalStore {
  getDraft(id: number): Draft | null;
  /** false = 이미 다른 요청이 처리함 → 조용히 무시(REQ-009) */
  transition(id: number, from: DraftStatus, to: DraftStatus): boolean;
  saveRevision(id: number, body: DraftBody, quality: QualityReport): boolean;
  /** 수정 중(drafting)에 멈춘 초안들 — 기동 시 복구용 */
  listDrafting(): Draft[];
  getPendingRevision(): number | null;
  setPendingRevision(id: number | null): void;
}

export interface ApprovalDeps {
  store: ApprovalStore;
  generator: BodyGenerator;
  /** NFR-001: 이번 달 LLM 추정 비용(원). 수정 재생성도 상한을 지킨다. */
  getMonthCostKrw: () => number;
  notify: (text: string) => Promise<void>;
  deliverCard: (draft: Draft) => Promise<void>;
  /** 1.3 임시 핸드오프: 완성 본문을 사람에게 전달한다. 1.4에서 PublishOrchestrator로 대체. */
  deliverPost: (text: string) => Promise<void>;
  /** 테스트용 교체 지점. 기본은 renderPostText. */
  render?: (draft: Draft) => string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 이미 발행·폐기된 초안의 수정 대기가 다음 메시지를 삼키지 않도록 푼다. */
function clearPendingRevisionFor(store: ApprovalStore, id: number): void {
  if (store.getPendingRevision() === id) store.setPendingRevision(null);
}

export type PublishOutcome = "handed_off" | "ignored" | "blocked" | "failed";

/**
 * REQ-007·009·010: 발행 버튼. 대가성 문구 게이트(REQ-010)를 먼저 통과해야 `publishing`으로 넘어가고,
 * 전이는 CAS라 더블탭은 한 번만 처리된다(REQ-009). 이미 처리됐으면 알림 없이 조용히 무시한다.
 */
export async function publishDraft(deps: ApprovalDeps, id: number): Promise<PublishOutcome> {
  const { store, notify } = deps;
  const draft = store.getDraft(id);
  if (draft === null || draft.status !== "awaiting_approval" || draft.body === null) return "ignored";

  const text = (deps.render ?? renderPostText)(draft);
  if (missingDisclosures(text, draft.products).length > 0) {
    await notify(`#${id} 초안에 대가성 문구가 없어 발행을 막았어요. 초안은 그대로 남아 있어요.`);
    return "blocked";
  }
  if (!store.transition(id, "awaiting_approval", "publishing")) return "ignored";
  clearPendingRevisionFor(store, id);

  try {
    await deps.deliverPost(text);
    store.transition(id, "publishing", "handed_off");
  } catch (error) {
    store.transition(id, "publishing", "failed");
    await notify(`#${id} 전달에 실패했어요: ${messageOf(error)}. 초안은 보존돼 있어요.`);
    return "failed";
  }
  await notify(`✅ #${id} 발행 준비 완료 — 위 본문을 복사해 네이버 블로그에 붙여넣어 주세요.`);
  return "handed_off";
}

/** REQ-008: 폐기. 지우지 않고 상태만 바꾼다(기록 보존). */
export async function discardDraft(deps: ApprovalDeps, id: number): Promise<"discarded" | "ignored"> {
  const changed = deps.store.transition(id, "awaiting_approval", "discarded");
  if (changed) clearPendingRevisionFor(deps.store, id);
  if (changed) await deps.notify(`🗑 #${id} 초안을 폐기했어요.`);
  return changed ? "discarded" : "ignored";
}

/** REQ-008: 수정 버튼. 다음에 오는 내 메시지를 수정 지시로 받도록 표시하고 안내한다. */
export async function beginRevision(deps: ApprovalDeps, id: number): Promise<"asked" | "ignored"> {
  const draft = deps.store.getDraft(id);
  if (draft === null || draft.status !== "awaiting_approval") return "ignored";
  deps.store.setPendingRevision(id);
  await deps.notify(
    [
      `✏️ #${id} 초안을 어떻게 고칠까요? 자연어로 답장해 주세요. (예: "표를 더 간단히")`,
      '경험 한 줄은 "경험 한 줄: 소음이 생각보다 컸어요"처럼 보내면 그 문장을 그대로 넣어요.',
    ].join("\n"),
  );
  return "asked";
}

export type RevisionOutcome = "revised" | "failed" | "budget" | "none" | "ignored";

/**
 * REQ-008·011: 수정 지시로 초안을 다시 만든다. 진행 중엔 `drafting`이고, 실패하면 이전 본문 그대로 대기 상태로 되돌린다.
 * 실패해도 내 지시 원문은 알림에 다시 보여준다(데이터 유실 금지).
 */
export async function submitRevision(deps: ApprovalDeps, text: string): Promise<RevisionOutcome> {
  const { store, notify } = deps;
  const id = store.getPendingRevision();
  if (id === null) return "none";
  store.setPendingRevision(null);

  const draft = store.getDraft(id);
  if (draft === null || draft.body === null || draft.status !== "awaiting_approval") {
    await notify(`#${id} 초안은 이미 처리돼서 수정하지 못했어요. 보내주신 내용:\n${text}`);
    return "ignored";
  }
  if (isBudgetExceeded(deps.getMonthCostKrw())) {
    await notify(`이번 달 LLM 비용 상한에 닿아 #${id} 초안을 수정하지 않았어요. 이전 초안은 그대로예요. 보내주신 지시:\n${text}`);
    return "budget";
  }
  if (!store.transition(id, "awaiting_approval", "drafting")) return "ignored";

  const instruction = parseReviseInstruction(id, text);
  try {
    const { body, quality } = await generateDraftBody({
      generator: deps.generator,
      category: draft.category,
      products: draft.products,
      memo: draft.memo,
      revision: {
        previousBody: draft.body,
        instruction: instruction.text,
        experienceLine: instruction.experienceLine,
        clearExperience: instruction.clearExperience,
      },
    });
    if (!store.saveRevision(id, body, quality)) throw new Error("수정 결과를 저장하지 못했습니다");
  } catch (error) {
    store.transition(id, "drafting", "awaiting_approval");
    await notify(
      [`#${id} 수정에 실패해서 이전 초안을 그대로 두었어요: ${messageOf(error)}`, "보내주신 지시:", instruction.text].join("\n"),
    );
    const restored = store.getDraft(id);
    if (restored !== null) await deliverCardSafely(deps, restored);
    return "failed";
  }

  const revised = store.getDraft(id);
  if (revised !== null) await deliverCardSafely(deps, revised);
  return "revised";
}

/**
 * 기동 시 복구: 수정 재생성 중에 프로세스가 죽어 `drafting`에 남은 초안을 이전 본문 그대로 대기 상태로 되돌리고 카드를 다시 보낸다.
 * 안 그러면 버튼도 없이 승인 대기 상한(REQ-004)을 계속 차지한다. 돌려주는 값은 복구한 개수.
 */
export async function recoverStuckDrafts(deps: ApprovalDeps): Promise<number> {
  const stuck = deps.store.listDrafting();
  let recovered = 0;
  for (const draft of stuck) {
    if (!deps.store.transition(draft.id, "drafting", "awaiting_approval")) continue;
    recovered++;
    const restored = deps.store.getDraft(draft.id);
    if (restored !== null) await deliverCardSafely(deps, restored);
  }
  if (recovered > 0) {
    deps.store.setPendingRevision(null);
    await deps.notify(`재시작으로 중단된 수정 ${recovered}건을 이전 초안으로 되돌렸어요.`);
  }
  return recovered;
}
