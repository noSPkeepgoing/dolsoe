import type { Draft } from "@contract/domain.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 초안을 저장한 뒤 카드 전송이 실패해도 초안은 승인 대기에 남는다. 조용한 고아가 되지 않도록 번호와 함께 알린다(NFR-004).
 * 전송이 실패한 초안은 다음 기동 시 복구 경로가 아니라 사람이 목록으로 확인한다.
 */
export async function deliverCardSafely(
  deps: { deliverCard: (draft: Draft) => Promise<void>; notify: (text: string) => Promise<void> },
  draft: Draft,
): Promise<void> {
  try {
    await deps.deliverCard(draft);
  } catch (error) {
    await deps.notify(`초안 #${draft.id}은 저장됐지만 카드 전송에 실패했어요: ${messageOf(error)}. 승인 대기 목록에 남아 있어요.`);
  }
}
