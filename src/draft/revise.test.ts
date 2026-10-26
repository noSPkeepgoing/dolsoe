import { describe, expect, it } from "vitest";

import { parseReviseInstruction } from "./revise.js";

describe("parseReviseInstruction", () => {
  it("[REQ-008] 경험 한 줄이 없는 지시는 그대로 지시문이 되고 경험은 null", () => {
    expect(parseReviseInstruction(3, "표를 더 간단히")).toEqual({ draftId: 3, text: "표를 더 간단히", experienceLine: null, clearExperience: false, quote: null, clearQuote: false });
  });

  it("[REQ-011] '경험 한 줄:' 뒤의 문장을 원문 그대로 뽑는다(공백만 다듬음)", () => {
    const parsed = parseReviseInstruction(3, "경험 한 줄:  소음이 생각보다 컸어요 ");
    expect(parsed.experienceLine).toBe("소음이 생각보다 컸어요");
  });

  it("[REQ-011] 다른 지시와 같이 와도 경험 줄만 뽑고, 전각 콜론·띄어쓰기 변형도 받는다", () => {
    const parsed = parseReviseInstruction(3, "표를 더 간단히\n경험한줄：  따뜻해서 좋아요");
    expect(parsed.experienceLine).toBe("따뜻해서 좋아요");
    expect(parsed.text).toContain("표를 더 간단히");
  });

  it("[REQ-011] 경험 줄의 문장은 따옴표·기호까지 한 글자도 바꾸지 않는다", () => {
    expect(parseReviseInstruction(3, '경험 한 줄: "진짜 조용해요!" 라고 느꼈다').experienceLine).toBe('"진짜 조용해요!" 라고 느꼈다');
  });

  it("[REQ-011] '경험 한 줄:'만 있고 내용이 비면 경험 없음으로 본다", () => {
    expect(parseReviseInstruction(3, "경험 한 줄:   ").experienceLine).toBeNull();
  });

  it("[REQ-011] '경험 한 줄: 없음'은 경험 문장을 지우라는 뜻이다(문장으로 취급하지 않는다)", () => {
    expect(parseReviseInstruction(3, "경험 한 줄: 없음")).toMatchObject({ experienceLine: null, clearExperience: true });
    expect(parseReviseInstruction(3, "경험 한 줄: 없음이 아니라 소음이 컸어요").experienceLine).toBe("없음이 아니라 소음이 컸어요");
  });

  it("[REQ-029] '문구: …'는 사용자 필사 문구로, '문구: 없음'은 코너 제거로 읽는다 (경험 줄과 독립)", () => {
    expect(parseReviseInstruction(3, "표 간단히\n문구: “좋은 문장이에요.”")).toMatchObject({ quote: "좋은 문장이에요.", clearQuote: false, experienceLine: null });
    expect(parseReviseInstruction(3, "문구: 없음")).toMatchObject({ quote: null, clearQuote: true });
    expect(parseReviseInstruction(3, "경험 한 줄: 좋았어요\n문구: 문장")).toMatchObject({ experienceLine: "좋았어요", quote: "문장" });
  });
});
