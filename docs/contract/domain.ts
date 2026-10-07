import { z } from "zod";

/**
 * 돌쇠 도메인 계약 — 유일한 진실.
 * 봇·스케줄러·초안 생성·발행부·저장소가 전부 이 파일만 참조한다(ADR-001~008).
 * 외부 입출력(LLM 응답, 텔레그램 콜백·메시지, 상품 소스 응답, 발행 결과)은
 * 반드시 여기 스키마로 경계에서 검증한다(CONVENTIONS §5).
 */

// ── 상수 (매직값 금지, CONVENTIONS §3) ──────────────────────────────
export const DAILY_DRAFT_HOUR_KST = 8; // REQ-001 일일 초안 시각(08:00 KST), NFR-002
export const TICK_INTERVAL_SECONDS = 60; // ADR-002 DB due_at 확인 주기
export const MAX_PENDING_DRAFTS = 3; // REQ-004 승인 대기 상한(이상이면 기본 모드 중단)
export const DEDUP_DAYS = 30; // REQ-003, PRD Q6 (architect 기본값)
export const REGENERATE_MAX_RETRIES = 1; // REQ-011·015 자동 재생성 횟수
export const PUBLISH_MAX_RETRIES = 1; // REQ-013 명확한 실패에 한한 재시도
export const MONTHLY_LLM_BUDGET_KRW = 10_000; // NFR-001, ADR-007
export const LLM_MODEL_BODY = "claude-sonnet-5-5"; // ADR-007 본문 생성 모델(2026-10 확인)
export const LLM_MODEL_REVIEW = "claude-sonnet-5-5"; // ADR-010 후기 수집(웹검색) 모델. 한국어 의역 품질을 보고 바꿀 수 있게 분리
/** 단가(USD / 1M 토큰, 2026-09-25 공식 표). 바뀌면 여기만 고친다. */
export const LLM_PRICING_USD_PER_MTOK = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
} as const;
/** 웹검색 서버 도구 단가(검색 1회, USD). $10 / 1,000건 — 토큰 비용과 별도로 청구된다(ADR-007·010). */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;
export const USD_TO_KRW = 1500; // 비용 상한용 보수적 고정 환율(추정치)
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096; // 텔레그램 메시지 한 통의 글자 상한 — 넘는 본문은 쪼개 보낸다
export const CARD_PREVIEW_MAX_CHARS = 2500; // REQ-007 초안 카드 본문 미리보기 상한(품질·버튼 줄을 위한 여유 포함)
/** REQ-006 링크 모드에서 수익 링크로 인정하는 쿠팡 파트너스 단축 링크 호스트(ADR-008: 페이지는 긁지 않는다). */
export const COUPANG_PARTNER_HOSTS = ["link.coupang.com", "coupa.ng"] as const;
/** REQ-001 책 후보 범위(ADR-010 결정 2026-10-07): YES24 소설/시/희곡·에세이 베스트셀러만. 시험서·문제집은 리뷰형에 맞지 않아 제외. */
export const BOOK_CANDIDATE_CATEGORY_IDS = ["001001046", "001001047"] as const;
/** REQ-016 후기 수집 시 검색 최대 횟수(비용 상한). */
export const REVIEW_SEARCH_MAX_USES = 3;
/** REQ-016 초안에 보관하는 후기 출처 URL 수 상한. */
export const REVIEW_SOURCES_MAX = 10;
/** REQ-002 모델에 보내는 소개문·목차 각각의 글자 수 상한(토큰 절약, 목차는 수천 자까지 온다). */
export const BOOK_DETAIL_MAX_CHARS = 1500;
/** REQ-016 소개문·목차·후기 근거와 이 글자 수 이상 그대로 이어지면 원문 복사로 본다(ADR-010, 공백 무시). */
export const VERBATIM_MIN_CHARS = 20;
export const YES24_HOST_SUFFIX = "yes24.com"; // REQ-006 YES24 상품 링크 판별(서브도메인 포함)

/** REQ-010 대가성 문구. 렌더러가 삽입하며 LLM 출력에 의존하지 않는다. */
export const DISCLOSURE_TEXTS = {
  coupang: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
  // TODO(YES24 애드온 정책 확인 후 확정): 아래는 임시 문구. 정확한 표기 의무는 미확인(ADR-009)
  yes24: "이 포스팅은 YES24 애드온 링크를 포함하며, 구매 시 일정액의 수수료를 제공받습니다.",
} as const;

/** REQ-015 금지 표현(봇이 만든 문장에만 적용, 사용자가 준 경험 문장은 검사 제외). 시작 목록 — 운영하며 승격. */
export const BANNED_PHRASES = [
  "에 대해 알아보겠습니다",
  "에 대해 알아보도록 하겠습니다",
  "는 매우 중요한 요소입니다",
  "써봤더니",
  "직접 써보니",
  "사용해 본 결과",
] as const;

/**
 * REQ-011 봇이 지어낸 후기·경험 주장 패턴. 봇이 만든 문장에만 적용(사용자가 준 경험 문장은 제외)하고,
 * 걸리면 재시도 후에도 남을 때 생성 실패로 본다(금지 표현과 달리 차단). 시작 목록 — 운영하며 승격.
 */
export const EXPERIENCE_CLAIM_PATTERNS: readonly RegExp[] = [
  /써\s?보(니|았|면|고)/,
  /써\s?봤/,
  /사용해\s?보(니|았|면)/,
  /사용해\s?봤/,
  /사용해\s?본/,
  /(직접|제가|저는)\s*(써|사용|먹어|입어|들어|읽어|구매|구입)/,
  /읽어\s?보(니|았|면)/,
  /읽어\s?봤/,
  /몇\s*(달|주|일)\s*(간|동안)?\s*(써|사용)/,
];

// ── 카테고리·소스 ──────────────────────────────────────────────────
export const CategorySchema = z.enum(["appliance", "book"]); // 생활가전·주방 / 책 추천
export type Category = z.infer<typeof CategorySchema>;
export const CATEGORY_ROTATION: readonly Category[] = ["appliance", "book"]; // REQ-001 번갈아
/** REQ-002 초안 1편에 쓰는 상품 수(G1 비교표 3종 / B3 한 권 리뷰 1권, ADR-010). */
export const PRODUCTS_PER_DRAFT: Record<Category, number> = { appliance: 3, book: 1 };

export const AffiliateProgramSchema = z.enum(["coupang", "yes24"]);
export type AffiliateProgram = z.infer<typeof AffiliateProgramSchema>;

export const ProductSourceKindSchema = z.enum(["yes24", "coupang_link"]); // ADR-008·009 (coupang_api는 승인 확인 후 추가)
export type ProductSourceKind = z.infer<typeof ProductSourceKindSchema>;

// ── 상품 (REQ-002, REQ-003, REQ-006) ───────────────────────────────
/** REQ-002 책 소개문·목차(YES24 contentDetail, HTML 제거·길이 제한 후). 책이 아니거나 없으면 생략. */
export const BookDetailSchema = z.object({
  introduction: z.string().nullable(),
  tableOfContents: z.string().nullable(),
});
export type BookDetail = z.infer<typeof BookDetailSchema>;

export const ProductSchema = z.object({
  externalId: z.string().min(1), // 소스 내 고유 ID(YES24 상품번호, 쿠팡 상품 ID 등) — 중복 제외 키
  source: ProductSourceKindSchema,
  category: CategorySchema,
  affiliate: AffiliateProgramSchema,
  title: z.string().min(1),
  url: z.string().url(), // 제휴 링크
  priceKrw: z.number().int().nonnegative().nullable(),
  priceAsOf: z.string().datetime().nullable(), // REQ-011 가격 기준일
  specs: z.record(z.string(), z.string()), // 비교표 재료(면적·필터비용·저자·출판사 등)
  bookDetail: BookDetailSchema.optional(), // 책 한 권 리뷰의 재료(소개문·목차). 옛 저장 행에는 없다
});
export type Product = z.infer<typeof ProductSchema>;

// ── 초안 본문 (플랫폼 중립, ADR-005) ────────────────────────────────
// 구매 링크·대가성 문구는 여기 없다: 렌더러가 products와 DISCLOSURE_TEXTS로 붙인다(REQ-010).
export const ApplianceBodySchema = z.object({
  category: z.literal("appliance"),
  title: z.string().min(1), // G1: "20평대 공기청정기 3종 비교"
  verdict: z.string().min(1), // 한 줄 결론
  comparison: z.object({
    headers: z.array(z.string().min(1)).min(2),
    rows: z.array(z.array(z.string())).min(1),
  }),
  recommendations: z
    .array(
      z.object({
        forWhom: z.string().min(1),
        productExternalId: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .min(1),
  experienceLine: z.string().nullable(), // REQ-011 사용자가 준 문장만. 봇이 창작 금지
});
export type ApplianceBody = z.infer<typeof ApplianceBodySchema>;

/** REQ-002 B3 한 권 리뷰: 제목 → 줄거리 → 분위기·읽는 느낌 → 이런 사람에게 → 인상 깊은 대목 → (렌더러가 구매 링크) → 내 경험 한 줄. */
export const BookBodySchema = z.object({
  category: z.literal("book"),
  title: z.string().min(1), // B3: 책 제목이 드러나는 제목
  synopsis: z.string().min(1), // 줄거리(소개문 근거, 원문 복사 금지)
  mood: z.string().min(1), // 분위기·읽는 느낌(후기 근거 의역)
  recommendedFor: z.string().min(1), // 이런 사람에게
  highlights: z.string().min(1), // 인상 깊은 대목(후기·소개문에서 확인된 것만 의역, 직접 인용 금지)
  experienceLine: z.string().nullable(),
});
export type BookBody = z.infer<typeof BookBodySchema>;

export const DraftBodySchema = z.discriminatedUnion("category", [ApplianceBodySchema, BookBodySchema]);
export type DraftBody = z.infer<typeof DraftBodySchema>;

// ── 품질 검사 결과 (REQ-015) ───────────────────────────────────────
export const QualityReportSchema = z.object({
  bannedPhrasesFound: z.array(z.string()),
  hasExperienceLine: z.boolean(),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

// ── 초안 상태머신 (ADR-006) ────────────────────────────────────────
export const DraftStatusSchema = z.enum([
  "drafting",
  "awaiting_approval",
  "publishing",
  "published", // 자동 발행(live/private) 성공
  "handed_off", // ③ 텔레그램으로 본문 전달 완료(사람이 복붙)
  "discarded",
  "failed", // 발행 실패·결과 불확실 — 사람 확인 필요
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/** 허용 전이. 전이는 `UPDATE … WHERE status=?`의 변경 행 수로 판정한다(멱등, REQ-009). */
export const DRAFT_TRANSITIONS: Record<DraftStatus, readonly DraftStatus[]> = {
  drafting: ["awaiting_approval", "failed"],
  awaiting_approval: ["drafting", "publishing", "discarded"], // drafting = 수정(REQ-008) 재생성
  publishing: ["published", "handed_off", "failed"],
  published: [],
  handed_off: [],
  discarded: [],
  failed: ["publishing", "discarded"], // 사람이 확인 후 재시도/폐기
};

export const DraftModeSchema = z.enum(["daily", "link"]); // 기본 모드 / 링크 모드
export type DraftMode = z.infer<typeof DraftModeSchema>;

export const DraftSchema = z.object({
  id: z.number().int().positive(),
  category: CategorySchema,
  mode: DraftModeSchema,
  status: DraftStatusSchema,
  products: z.array(ProductSchema).min(1),
  body: DraftBodySchema.nullable(), // drafting 중 null
  memo: z.string().nullable(), // 링크 모드 메모(REQ-006)
  quality: QualityReportSchema.nullable(),
  /** REQ-016 후기 근거 출처 URL(발행 본문에는 넣지 않는다). 책 초안만 의미 있고, 없으면 생략. */
  reviewSources: z.array(z.string().url()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Draft = z.infer<typeof DraftSchema>;

// ── 발행 (REQ-012·013, ADR-005) ────────────────────────────────────
export const PublishModeSchema = z.enum(["live", "private", "manual"]); // 사다리 ①②③
export type PublishMode = z.infer<typeof PublishModeSchema>;
/** 사다리 시도 순서. 실제 활성 목록은 config가 결정(1차 구현은 ["manual"]만). */
export const PUBLISH_LADDER: readonly PublishMode[] = ["live", "private", "manual"];

export const PublishResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    mode: PublishModeSchema,
    url: z.string().url().nullable(),
    externalId: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    mode: PublishModeSchema,
    retryable: z.boolean(),
    authExpired: z.boolean(), // REQ-013 "재인증 필요" 안내
    reason: z.string(),
  }),
]);
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const PublishAttemptSchema = z.object({
  id: z.number().int().positive(),
  draftId: z.number().int().positive(),
  mode: PublishModeSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  result: PublishResultSchema.nullable(), // 시도 기록을 먼저 쓰므로 진행 중엔 null (ADR-006)
});
export type PublishAttempt = z.infer<typeof PublishAttemptSchema>;

// ── 텔레그램 입력 (REQ-006~009, REQ-014) ───────────────────────────
/** 인라인 버튼 콜백. REQ-007: 발행/수정/폐기 3개. */
export const BotCallbackSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), draftId: z.number().int().positive() }),
  z.object({ action: z.literal("revise"), draftId: z.number().int().positive() }),
  z.object({ action: z.literal("discard"), draftId: z.number().int().positive() }),
]);
export type BotCallback = z.infer<typeof BotCallbackSchema>;

/** 링크 모드 메시지: 링크 + 선택적 메모(REQ-006). */
export const LinkRequestSchema = z.object({
  url: z.string().url(),
  memo: z.string().nullable(),
});
export type LinkRequest = z.infer<typeof LinkRequestSchema>;

/** `수정` 후 사용자가 보낸 지시문(자연어). 경험 한 줄은 여기 포함될 수 있다(REQ-011, 결정 B). */
export const ReviseInstructionSchema = z.object({
  draftId: z.number().int().positive(),
  text: z.string().min(1),
  experienceLine: z.string().nullable(), // 파서가 지시문에서 추출한 경험 문장(없으면 null)
  clearExperience: z.boolean(), // "경험 한 줄: 없음" — 이전에 넣은 경험 문장을 지운다
});
export type ReviseInstruction = z.infer<typeof ReviseInstructionSchema>;

// ── 스케줄 (ADR-002) ───────────────────────────────────────────────
export const ScheduleJobKindSchema = z.enum(["daily_draft"]); // REQ-025 예약 발행은 P2에서 추가
export type ScheduleJobKind = z.infer<typeof ScheduleJobKindSchema>;

export const ScheduleJobSchema = z.object({
  id: z.number().int().positive(),
  kind: ScheduleJobKindSchema,
  dueAt: z.string().datetime(),
  doneAt: z.string().datetime().nullable(),
});
export type ScheduleJob = z.infer<typeof ScheduleJobSchema>;

// ── 중복 제외 기록 (REQ-003) ───────────────────────────────────────
export const CoveredProductSchema = z.object({
  source: ProductSourceKindSchema,
  externalId: z.string().min(1),
  coveredAt: z.string().datetime(),
});
export type CoveredProduct = z.infer<typeof CoveredProductSchema>;

// ── LLM 사용량 (ADR-007) ───────────────────────────────────────────
export const LlmUsageSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/), // KST 기준 YYYY-MM
  estimatedCostKrw: z.number().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;
