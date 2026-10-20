import { chromium, type BrowserContext, type Frame, type Page } from "playwright";

import { TIMED_OUT, withDeadline } from "./deadline.js";
import { missingTexts, type NaverEditorDriver, type NaverEditorOutcome } from "./naver.js";

// 네이버 블로그 에디터 화면 지식(P3: 이 파일 밖으로 새지 않는다). 화면이 바뀌면 여기 선택자만 고친다 — 못 찾으면 editor_unavailable로 보고돼 ④ 텔레그램 전달로 내려간다.
const WRITE_URL = "https://blog.naver.com/GoBlogWrite.naver";
const LOGIN_HOST = "nid.naver.com";
const EDITOR_FRAME_URL_PART = "PostWriteForm";
const TITLE_SELECTOR = ".se-title-text";
// 제목 문단도 .se-text-paragraph라서 본문 컴포넌트(.se-component.se-text) 아래로 좁혀야 한다(스파이크에서 제목칸에 붙는 문제가 있었음).
const BODY_PARAGRAPH_SELECTOR = ".se-component.se-text .se-text-paragraph";
const SAVE_BUTTON_TEXT = "저장";
// 이전에 자동저장된 글이 있으면 에디터를 열 때 "이어서 작성하시겠습니까?"가 뜬다. 항상 취소(=빈 새 글)로 닫는다 — 확인을 누르면 옛 내용이 섞인다.
const RESUME_POPUP_SELECTOR = ".se-popup-alert-confirm";
const RESUME_POPUP_CANCEL_SELECTOR = ".se-popup-alert-confirm .se-popup-button-cancel";
const RESUME_POPUP_WAIT_MS = 3_000;

const EDITOR_LOAD_TIMEOUT_MS = 30_000;
const SETTLE_MS = 2_000;
const SAVE_CONFIRM_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
const TYPE_DELAY_MS = 10;
/** 한 번의 임시저장 전체 상한. 정상은 10초대이고, 단계별 대기 합(최악 약 50초)에 여유를 둔다. 넘기면 브라우저를 닫고 보고한다(M3). */
const DRAFT_DEADLINE_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const stripTags = (html: string): string => html.replace(/<[^>]+>/g, " ");

const unavailable = (detail: string): NaverEditorOutcome => ({ ok: false, reason: "editor_unavailable", detail });

/** 에디터 상단 "저장 | N" — 저장 버튼 바로 뒤 버튼이 임시저장 개수다. 못 읽으면 null. */
async function readSavedCount(editor: Frame): Promise<number | null> {
  const count = await editor.evaluate((label) => {
    const buttons = [...document.querySelectorAll("button")];
    const index = buttons.findIndex((button) => (button.textContent ?? "").trim() === label);
    const next = index === -1 ? undefined : buttons[index + 1];
    const value = Number.parseInt((next?.textContent ?? "").trim(), 10);
    return Number.isNaN(value) ? null : value;
  }, SAVE_BUTTON_TEXT);
  return count;
}

async function findEditorFrame(page: Page): Promise<Frame | null> {
  const deadline = Date.now() + EDITOR_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (new URL(page.url()).hostname === LOGIN_HOST) return null;
    const frame = page.frames().find((candidate) => candidate.url().includes(EDITOR_FRAME_URL_PART));
    if (frame !== undefined && (await frame.locator(TITLE_SELECTOR).count()) > 0) return frame;
    await sleep(POLL_MS);
  }
  return null;
}

/** "작성 중인 글이 있습니다" 팝업이 뜨면 취소로 닫는다. 안 뜨면 그냥 지나간다. */
async function dismissResumePopup(editor: Frame): Promise<void> {
  const popup = editor.locator(RESUME_POPUP_SELECTOR).first();
  const appeared = await popup.waitFor({ state: "visible", timeout: RESUME_POPUP_WAIT_MS }).then(() => true, () => false);
  if (!appeared) return;
  await editor.locator(RESUME_POPUP_CANCEL_SELECTOR).first().click();
  await popup.waitFor({ state: "hidden", timeout: RESUME_POPUP_WAIT_MS });
}

type DraftInput = Parameters<NaverEditorDriver["saveDraft"]>[0];

async function fillAndSave(context: BrowserContext, input: DraftInput, state: { clicked: boolean }): Promise<NaverEditorOutcome> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(WRITE_URL, { waitUntil: "domcontentloaded" });

  const editor = await findEditorFrame(page);
  if (editor === null) {
    if (new URL(page.url()).hostname === LOGIN_HOST) return { ok: false, reason: "auth_expired", detail: "로그인 화면으로 이동됨" };
    return unavailable("글쓰기 에디터를 찾지 못했어요");
  }
  await dismissResumePopup(editor);
  await sleep(SETTLE_MS);

  await editor.locator(TITLE_SELECTOR).first().click();
  await page.keyboard.type(input.title, { delay: TYPE_DELAY_MS });

  await editor.locator(BODY_PARAGRAPH_SELECTOR).first().click();
  await page.evaluate(async (html) => {
    const plain = new Blob([html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')], { type: "text/plain" });
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": plain })]);
  }, input.html);
  await page.keyboard.press("ControlOrMeta+V");
  await sleep(SETTLE_MS);

  // 저장 전에 "화면에 실제로 들어간 것"을 확인한다(입력 문자열이 아니라): 제목이 제목칸에, 대가성 문구 등 필수 문구가 에디터 전체에 있어야 한다.
  // 붙여넣기가 중간에 잘리거나 제목칸에 섞인 글이 임시저장돼 사람이 그대로 공개하는 일을 막는다(P5, REQ-010).
  const titleText = await editor.locator(TITLE_SELECTOR).first().innerText();
  if (missingTexts(titleText, [input.title]).length > 0) return unavailable("제목이 제목칸에 들어가지 않았어요");
  const editorText = await editor.locator("body").innerText();
  const missing = missingTexts(editorText, [stripTags(input.html).slice(0, 20), ...input.mustContain]);
  if (missing.length > 0) return unavailable(`본문이 에디터에 온전히 들어가지 않았어요(빠진 문구 ${missing.length}개)`);

  const before = await readSavedCount(editor);
  if (before === null) return unavailable("임시저장 개수를 읽지 못했어요(저장 버튼 위치 변경 가능성)");

  await editor.getByRole("button", { name: SAVE_BUTTON_TEXT, exact: true }).first().click();
  state.clicked = true; // 클릭이 끝난 뒤에만 "눌렀다"로 본다 — 버튼을 못 찾아 클릭이 실패한 경우는 저장 전 실패다.
  const deadline = Date.now() + SAVE_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const after = await readSavedCount(editor);
    if (after !== null && after > before) return { ok: true };
    await sleep(POLL_MS);
  }
  return { ok: false, reason: "save_unconfirmed", detail: "임시저장 완료를 확인하지 못했어요. 네이버 임시저장함을 확인해 주세요" };
}

/**
 * 전용 Playwright 프로필(로그인 세션 쿠키만 보관, 비밀번호는 다루지 않음 — NFR-003)로 에디터를 채우고 임시저장한다.
 * 같은 프로필은 동시에 둘이 못 열어서 호출을 한 줄로 세운다. 저장을 누르기 전에 막히면 "저장 안 됨이 확실"한 실패, 누른 뒤면 save_unconfirmed로 보고한다.
 */
export function createPlaywrightNaverDriver(deps: { profileDir: string }): NaverEditorDriver {
  let queue: Promise<unknown> = Promise.resolve();
  const run = (input: DraftInput): Promise<NaverEditorOutcome> => {
    const task = async (): Promise<NaverEditorOutcome> => {
      const state = { clicked: false, timedOut: false };
      let context: BrowserContext | undefined;
      const work = (async (): Promise<NaverEditorOutcome> => {
        try {
          context = await chromium.launchPersistentContext(deps.profileDir, { headless: false, viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
        } catch (error) {
          return unavailable(`브라우저를 열지 못했어요(다른 창이 같은 프로필을 쓰는 중일 수 있어요): ${messageOf(error)}`);
        }
        try {
          if (state.timedOut) return unavailable("시간 초과로 중단됐어요");
          return await fillAndSave(context, input, state);
        } catch (error) {
          return state.clicked ? { ok: false, reason: "save_unconfirmed", detail: `저장 확인 중 오류: ${messageOf(error)}` } : unavailable(messageOf(error));
        } finally {
          await context.close().catch(() => {});
        }
      })();
      const outcome = await withDeadline(work, DRAFT_DEADLINE_MS);
      if (outcome !== TIMED_OUT) return outcome;
      // 멈춘 호출을 끊는다: 열려 있으면 닫고, 아직 여는 중이면 열린 직후 work가 스스로 닫는다(state.timedOut).
      state.timedOut = true;
      await context?.close().catch(() => {});
      const detail = `${DRAFT_DEADLINE_MS / 1000}초 안에 끝나지 않아 중단했어요`;
      return state.clicked ? { ok: false, reason: "save_unconfirmed", detail: `${detail}. 네이버 임시저장함을 확인해 주세요` } : unavailable(detail);
    };
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  return { saveDraft: run };
}
