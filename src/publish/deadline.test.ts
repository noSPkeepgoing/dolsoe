import { afterEach, describe, expect, it, vi } from "vitest";

import { TIMED_OUT, withDeadline } from "./deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline — 외부 호출 전체 상한", () => {
  it("[REQ-013] 데드라인 안에 끝나면 그 결과를 그대로 돌려준다", async () => {
    await expect(withDeadline(Promise.resolve("끝"), 1000)).resolves.toBe("끝");
  });

  it("[REQ-013] 데드라인을 넘기면 TIMED_OUT을 돌려줘 매달린 호출이 발행 흐름을 영원히 잡지 못하게 한다", async () => {
    vi.useFakeTimers();
    const hung = new Promise<string>(() => {});
    const result = withDeadline(hung, 5000);
    await vi.advanceTimersByTimeAsync(5001);
    await expect(result).resolves.toBe(TIMED_OUT);
  });

  it("[REQ-013] 데드라인 안에 거부되면 그 오류를 그대로 전달한다", async () => {
    await expect(withDeadline(Promise.reject(new Error("터짐")), 1000)).rejects.toThrow("터짐");
  });
});
