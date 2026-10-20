/** `withDeadline`이 시간 초과를 알리는 값. 결과·오류와 겹치지 않도록 심볼로 둔다. */
export const TIMED_OUT: unique symbol = Symbol("timed-out");

/**
 * 외부 호출(브라우저 등) 전체에 상한을 건다. 넘기면 `TIMED_OUT`을 돌려준다 — 원래 호출은 멈추지 않으므로 호출자가 정리(예: 브라우저 닫기)한다.
 * 매달린 호출이 `publishing` 고착과 핸들러 블로킹으로 번지는 것을 막기 위함(REQ-013, ADR-006).
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
