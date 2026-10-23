// 사진 스파이크: 로컬 이미지 파일이 에디터에 들어가는 경로(클립보드 image/png 붙여넣기, 파일 입력)를 실측한다. 저장하지 않는다.
import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";

const IMAGE = process.argv[2] ?? "";
const OUT = process.env.SPIKE_OUT ?? ".";
const b64 = fs.readFileSync(IMAGE).toString("base64");
const context = await chromium.launchPersistentContext(process.env.NAVER_PROFILE_DIR ?? "data/naver-profile", { headless: false, viewport: { width: 1200, height: 1000 } });
try {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://blog.naver.com/GoBlogWrite.naver", { waitUntil: "domcontentloaded" });
  let editor = page.frames().find((f) => f.url().includes("PostWriteForm"));
  for (let i = 0; i < 60 && !editor; i++) { await page.waitForTimeout(500); editor = page.frames().find((f) => f.url().includes("PostWriteForm")); }
  if (!editor) throw new Error("에디터 없음");
  await editor.locator(".se-title-text").first().waitFor({ timeout: 30_000 });
  const popup = editor.locator(".se-popup-alert-confirm").first();
  if (await popup.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) await editor.locator(".se-popup-alert-confirm .se-popup-button-cancel").first().click();
  await page.waitForTimeout(2000);
  const count = () => editor!.evaluate(() => ({ images: document.querySelectorAll(".se-component.se-image img").length, srcs: [...document.querySelectorAll(".se-component.se-image img")].map((i) => (i.getAttribute("src") ?? "").slice(0, 90)) }));

  // 방법 1: 클립보드 image/png 붙여넣기
  await editor.locator(".se-component.se-text .se-text-paragraph").first().click();
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
  }, b64);
  await page.keyboard.press("ControlOrMeta+V");
  await page.waitForTimeout(6000);
  console.log("clipboard-image:", JSON.stringify(await count()));

  // 방법 2: 사진 버튼의 파일 선택창에 파일 주입
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  await editor.locator("button.se-image-toolbar-button, button[data-name='image']").first().click({ timeout: 5000 }).catch((e) => console.log("사진버튼 클릭 실패", String(e).slice(0, 80)));
  const fc = await chooser;
  if (fc) { await fc.setFiles(IMAGE); await page.waitForTimeout(8000); console.log("file-chooser:", JSON.stringify(await count())); } else console.log("file-chooser: 선택창 안 뜸");
  await page.screenshot({ path: `${OUT}/photo.png` });
} finally {
  await context.close();
}
