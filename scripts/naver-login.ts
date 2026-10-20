import "dotenv/config";
// 전용 프로필 창을 열어 사람이 네이버에 직접 로그인한다(최초 1회·세션 만료 시). 글쓰기 화면이 열리면 자동 종료. 비밀번호는 다루지 않는다(NFR-003).
import { chromium } from "playwright";

const PROFILE = process.env.NAVER_PROFILE_DIR ?? "data/naver-profile";
const context = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null, locale: "ko-KR" });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://nid.naver.com/nidlogin.login?mode=form&url=https://blog.naver.com/GoBlogWrite.naver");
console.log("창에서 네이버에 로그인하세요('로그인 상태 유지' 체크 필수). 글쓰기 화면이 열리면 자동으로 창을 닫습니다.");
await page.waitForURL((u) => u.hostname === "blog.naver.com", { timeout: 0 });
await page.waitForTimeout(5000);
await context.close();
console.log("프로필 저장 완료:", PROFILE);
