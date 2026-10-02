import type { Draft, PublishMode, PublishResult } from "@contract/domain.js";

/** 발행기에 넘기는 최종 산출물. `content`는 그 발행기의 `render`가 만든 것이고, 대가성 게이트(REQ-010)는 바로 이 문자열에 건다. */
export interface Post {
  draftId: number;
  title: string;
  content: string;
}

/**
 * 플랫폼별 발행 어댑터(ADR-005). 플랫폼 지식(형식·API)은 구현체 안에만 둔다(CONVENTIONS §4).
 * `publish`는 명확한 실패는 `ok:false`로 돌려주고, 던지면 Orchestrator가 "결과 불확실"로 본다(자동 재발행 금지, ADR-006).
 */
export interface Publisher {
  readonly mode: PublishMode;
  render(draft: Draft): string;
  publish(post: Post): Promise<PublishResult>;
}
