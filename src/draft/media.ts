import type { Draft, PendingMedia } from "@contract/domain.js";
import { PHOTO_MAX_BYTES } from "@contract/domain.js";

import type { DraftPhotoRecord } from "../db.js";

/** REQ-034 내 한 컷(사진·메모) 부착 흐름이 필요로 하는 저장소 경계. 실제 구현은 draft/store.ts(SQLite). */
export interface MediaStore {
  getPending(): PendingMedia | null;
  setPending(media: PendingMedia | null): void;
  /** 승인 대기(`awaiting_approval`) 초안만 — 발행·폐기된 초안은 목록에 나오지 않는다(EDGE-014). */
  listAwaiting(): Draft[];
  /** false = 그 사이 상태가 바뀜(CAS) */
  attachMemo(id: number, text: string): boolean;
  /** null = 상태가 바뀜. replacedPath = 교체돼 지울 이전 파일 */
  attachPhoto(id: number, photo: DraftPhotoRecord): { replacedPath: string | null } | null;
  /** 사진 행을 지우고 파일 경로를 돌려준다 */
  detachPhoto(id: number): string | null;
  /** 종료(폐기·발행·전달) 상태 초안의 사진 + 어느 초안에도 안 붙은 파일 정리용 */
  listPhotos(): { draftId: number; filePath: string; closed: boolean }[];
}

export interface MediaFiles {
  /** 새 파일로 저장하고 경로를 돌려준다 */
  save(bytes: Uint8Array, mime: DraftPhotoRecord["mime"]): Promise<string>;
  remove(filePath: string): Promise<void>;
  /** 미디어 폴더 안 모든 파일 경로 */
  list(): Promise<string[]>;
}

export interface MediaDeps {
  store: MediaStore;
  files: MediaFiles;
  notify: (text: string) => Promise<void>;
  /** "어느 글에 붙일까요?" + 대기 초안 버튼 + 취소 버튼 */
  askAttach: (drafts: Draft[], media: PendingMedia) => Promise<void>;
  deliverCard: (draft: Draft) => Promise<void>;
}

const NO_DRAFT_TEXT = "붙일 초안이 없어요. 승인 대기 중인 초안이 생기면 다시 보내주세요.";

/** 이전 대기 사진 파일을 지우고(새로 오면 교체) 새 대기를 건다. */
async function replacePending(deps: MediaDeps, next: PendingMedia): Promise<void> {
  const previous = deps.store.getPending();
  deps.store.setPending(next);
  if (previous?.kind === "photo" && !(next.kind === "photo" && next.filePath === previous.filePath)) await safeRemove(deps, previous.filePath);
}

async function safeRemove(deps: MediaDeps, filePath: string): Promise<void> {
  try {
    await deps.files.remove(filePath);
  } catch {
    // 파일이 이미 없거나 지울 수 없음 — 기동 시 정리(sweepMedia)가 다시 시도한다
  }
}

/** REQ-034 ④: 링크 없는 일반 텍스트 = 메모. 대기 초안이 없으면 안내만 한다. */
export async function receiveMemo(deps: MediaDeps, text: string): Promise<"asked" | "no_draft"> {
  const drafts = deps.store.listAwaiting();
  if (drafts.length === 0) {
    await deps.notify(NO_DRAFT_TEXT);
    return "no_draft";
  }
  const media: PendingMedia = { kind: "memo", text };
  await replacePending(deps, media);
  await deps.askAttach(drafts, media);
  return "asked";
}

export type PhotoOutcome = "asked" | "no_draft" | "too_big" | "unsupported";

/** REQ-034 ③: 텔레그램 압축 사진(JPEG)을 받는다. 크기 초과·붙일 초안 없음이면 파일을 저장하지 않는다. */
export async function receivePhoto(deps: MediaDeps, photo: { bytes: Uint8Array; mime: string }): Promise<PhotoOutcome> {
  if (photo.mime !== "image/jpeg" && photo.mime !== "image/png") {
    await deps.notify("사진 형식을 읽지 못했어요. 사진을 '파일'이 아니라 일반 사진으로 보내주세요.");
    return "unsupported";
  }
  if (photo.bytes.byteLength > PHOTO_MAX_BYTES) {
    await deps.notify(`사진이 너무 커요(최대 ${Math.floor(PHOTO_MAX_BYTES / 1024 / 1024)}MB). 다시 보내주세요.`);
    return "too_big";
  }
  const drafts = deps.store.listAwaiting();
  if (drafts.length === 0) {
    await deps.notify(NO_DRAFT_TEXT);
    return "no_draft";
  }
  const filePath = await deps.files.save(photo.bytes, photo.mime);
  const media: PendingMedia = { kind: "photo", filePath, mime: photo.mime, bytes: photo.bytes.byteLength };
  await replacePending(deps, media);
  await deps.askAttach(drafts, media);
  return "asked";
}

/** REQ-034: 파일(document)로 보낸 사진은 원본이라 위치정보가 남을 수 있어 안내 후 거절한다(EDGE-018). */
export async function rejectDocumentPhoto(deps: Pick<MediaDeps, "notify">): Promise<void> {
  await deps.notify("사진을 '파일'로 보내면 받지 않아요(원본에 위치정보가 남을 수 있어요). 일반 사진으로 다시 보내주세요.");
}

export type AttachOutcome = "attached" | "ignored";

/** 버튼으로 초안을 골랐을 때: 대기 중인 사진·메모를 그 초안에 붙이고 카드를 다시 보낸다. */
export async function attachPending(deps: MediaDeps, draftId: number): Promise<AttachOutcome> {
  const pending = deps.store.getPending();
  if (pending === null) {
    await deps.notify("붙일 사진·메모가 없어요. 다시 보내주세요.");
    return "ignored";
  }
  let attached = false;
  if (pending.kind === "memo") {
    attached = deps.store.attachMemo(draftId, pending.text);
  } else {
    const result = deps.store.attachPhoto(draftId, { filePath: pending.filePath, mime: pending.mime, bytes: pending.bytes });
    attached = result !== null;
    if (result?.replacedPath != null) await safeRemove(deps, result.replacedPath);
  }
  if (!attached) {
    // 선택하는 사이 발행·폐기됐다 — 대기는 남겨 다른 초안을 다시 고를 수 있게 한다
    await deps.notify(`#${draftId} 초안은 이미 처리돼서 붙이지 못했어요.`);
    const drafts = deps.store.listAwaiting();
    if (drafts.length > 0) await deps.askAttach(drafts, pending);
    return "ignored";
  }
  deps.store.setPending(null);
  const draft = deps.store.listAwaiting().find((candidate) => candidate.id === draftId);
  if (draft !== undefined) await deps.deliverCard(draft);
  return "attached";
}

/** 취소 버튼: 대기 중인 사진·메모를 버린다(사진 파일도 삭제). */
export async function cancelPending(deps: MediaDeps): Promise<void> {
  const pending = deps.store.getPending();
  deps.store.setPending(null);
  if (pending?.kind === "photo") await safeRemove(deps, pending.filePath);
}

/** 폐기 시 그 초안의 사진 삭제(REQ-034). */
export async function removePhotoOf(deps: MediaDeps, draftId: number): Promise<void> {
  const filePath = deps.store.detachPhoto(draftId);
  if (filePath !== null) await safeRemove(deps, filePath);
}

/**
 * 기동 시 정리: 종료 상태 초안의 사진 행·파일과, 어느 초안·대기에도 안 붙은 고아 파일을 지운다. 지운 파일 수를 돌려준다.
 * 종료 상태에는 발행·전달이 끝난 `published`·`handed_off`도 포함된다(사진은 그때까지만 필요).
 */
export async function sweepMedia(deps: MediaDeps): Promise<number> {
  let removed = 0;
  const keep = new Set<string>();
  const pending = deps.store.getPending();
  if (pending?.kind === "photo") keep.add(pending.filePath);
  for (const photo of deps.store.listPhotos()) {
    if (photo.closed) {
      await removePhotoOf(deps, photo.draftId);
      removed++;
    } else {
      keep.add(photo.filePath);
    }
  }
  for (const filePath of await deps.files.list()) {
    if (keep.has(filePath)) continue;
    await safeRemove(deps, filePath);
    removed++;
  }
  return removed;
}
