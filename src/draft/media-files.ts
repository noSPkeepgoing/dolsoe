import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { MediaFiles } from "./media.js";

const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;

/** 디스크 위의 MediaFiles. 파일명은 무작위라 사용자 입력이 경로에 섞이지 않는다. */
export function createMediaFiles(dir: string): MediaFiles {
  return {
    async save(bytes, mime) {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${randomUUID()}.${EXTENSION[mime]}`);
      await fs.writeFile(filePath, bytes);
      return filePath;
    },
    remove: (filePath) => fs.rm(filePath, { force: true }),
    async list() {
      try {
        return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
      } catch {
        return []; // 폴더가 아직 없음
      }
    },
  };
}

/** 텔레그램 file_id → 바이트. getFile로 경로를 받아 봇 파일 서버에서 내려받는다. */
export function createTelegramDownloader(
  api: { getFile(fileId: string): Promise<{ file_path?: string }> },
  token: string,
  fetchImpl: typeof fetch = fetch,
): (fileId: string) => Promise<Uint8Array> {
  return async (fileId) => {
    const file = await api.getFile(fileId);
    if (file.file_path === undefined) throw new Error("file_path 없음");
    const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error(`사진 다운로드 실패: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}
