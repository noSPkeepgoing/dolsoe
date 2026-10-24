import { describe, expect, it, vi } from "vitest";

import type { Draft, PendingMedia } from "@contract/domain.js";
import { PHOTO_MAX_BYTES } from "@contract/domain.js";

import { receivePhoto, sweepMedia, type MediaDeps, type MediaStore } from "./media.js";

function setup(photos: { draftId: number; filePath: string; closed: boolean }[], pending: PendingMedia | null, disk: string[]) {
  const removed: string[] = [];
  const store: MediaStore = {
    getPending: () => pending,
    setPending: vi.fn(),
    listAwaiting: () => [{ id: 1 } as Draft],
    attachMemo: () => true,
    attachPhoto: () => ({ replacedPath: null }),
    detachPhoto: (id) => photos.find((p) => p.draftId === id)?.filePath ?? null,
    listPhotos: () => photos,
  };
  const deps: MediaDeps = {
    store,
    files: { save: vi.fn(async () => "/m/new.jpg"), remove: async (p) => void removed.push(p), list: async () => disk },
    notify: vi.fn(async () => undefined),
    askAttach: vi.fn(async () => undefined),
    deliverCard: vi.fn(async () => undefined),
  };
  return { deps, removed };
}

describe("sweepMedia", () => {
  it("[REQ-034] 종료된 초안의 사진과 어디에도 안 붙은 고아 파일은 지우고, 대기 초안·대기 중 사진은 남긴다", async () => {
    const pending: PendingMedia = { kind: "photo", filePath: "/m/pending.jpg", mime: "image/jpeg", bytes: 1 };
    const { deps, removed } = setup(
      [
        { draftId: 1, filePath: "/m/live.jpg", closed: false },
        { draftId: 2, filePath: "/m/done.jpg", closed: true },
      ],
      pending,
      ["/m/live.jpg", "/m/orphan.jpg", "/m/pending.jpg"],
    );
    await sweepMedia(deps);
    expect(removed.sort()).toEqual(["/m/done.jpg", "/m/orphan.jpg"]);
  });
});

describe("receivePhoto", () => {
  it("[REQ-034] 크기 상한을 넘는 사진은 저장하지 않고 거절한다", async () => {
    const { deps } = setup([], null, []);
    const outcome = await receivePhoto(deps, { bytes: new Uint8Array(PHOTO_MAX_BYTES + 1), mime: "image/jpeg" });
    expect(outcome).toBe("too_big");
    expect(deps.files.save).not.toHaveBeenCalled();
  });

  it("[REQ-034] JPEG·PNG가 아닌 형식은 저장하지 않고 거절한다", async () => {
    const { deps } = setup([], null, []);
    expect(await receivePhoto(deps, { bytes: new Uint8Array(5), mime: "image/heic" })).toBe("unsupported");
    expect(deps.files.save).not.toHaveBeenCalled();
  });
});
