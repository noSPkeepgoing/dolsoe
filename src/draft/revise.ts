import type { ReviseInstruction } from "@contract/domain.js";
import { ReviseInstructionSchema } from "@contract/domain.js";

/** "경험 한 줄: …" / "경험한줄： …" — 이 줄만 경험 문장으로 뽑는다(REQ-011, 별도 버튼 없이 수정 지시로 받는다). */
/** "경험 한 줄: 없음"만 지우기 명령이다. 더 긴 문장의 일부로 쓰인 "없음"은 문장 그대로 둔다. */
const CLEAR_KEYWORD = "없음";
const EXPERIENCE_LINE = /^\s*경험\s*한\s*줄\s*[:：]\s*(.*)$/m;

/**
 * REQ-008·011: 수정 지시 원문에서 경험 한 줄을 결정적으로(LLM 없이) 추출한다.
 * 문장은 앞뒤 공백만 다듬고 한 글자도 바꾸지 않는다 — 이후 "원문 그대로 포함" 검사의 기준이 된다.
 */
export function parseReviseInstruction(draftId: number, text: string): ReviseInstruction {
  const matched = EXPERIENCE_LINE.exec(text)?.[1]?.trim() ?? "";
  const clearExperience = matched === CLEAR_KEYWORD;
  const isSentence = matched.length > 0 && !clearExperience;
  return ReviseInstructionSchema.parse({ draftId, text, experienceLine: isSentence ? matched : null, clearExperience });
}
