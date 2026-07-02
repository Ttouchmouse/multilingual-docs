import type { AppState, TranslationItem } from "./types";

export class SupabaseSnapshotConflictError extends Error {
  constructor(message = "다른 곳에서 먼저 저장된 변경사항이 있어 현재 저장을 중단했습니다. 현재 작업을 유지하거나 최신 데이터를 불러올 수 있습니다.") {
    super(message);
    this.name = "SupabaseSnapshotConflictError";
  }
}

export class SupabaseSnapshotUnavailableError extends Error {
  constructor(message = "Supabase 환경변수가 설정되지 않았습니다.") {
    super(message);
    this.name = "SupabaseSnapshotUnavailableError";
  }
}

export class SupabaseSnapshotUnauthorizedError extends Error {
  constructor(message = "접근 세션이 만료되었습니다. 보안 키를 다시 입력해주세요.") {
    super(message);
    this.name = "SupabaseSnapshotUnauthorizedError";
  }
}

type SnapshotApiResponse = {
  configured?: boolean;
  found?: boolean;
  appState?: AppState;
  translations?: TranslationItem[];
  updatedAt?: string;
  error?: string;
  code?: string;
};

type ImageUploadApiResponse = {
  result?: {
    imageUrl: string;
    imageStoragePath: string;
  };
  error?: string;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function throwSnapshotError(response: Response, payload: SnapshotApiResponse): never {
  const message = payload.error || "Supabase 요청에 실패했습니다.";

  if (response.status === 401) {
    throw new SupabaseSnapshotUnauthorizedError(message);
  }

  if (response.status === 409 || payload.code === "SNAPSHOT_CONFLICT") {
    throw new SupabaseSnapshotConflictError(message);
  }

  if (response.status === 503) {
    throw new SupabaseSnapshotUnavailableError(message);
  }

  throw new Error(message);
}

export async function loadSupabaseSnapshot() {
  console.info("[persistence] Loading Supabase snapshot through app API.");

  const response = await fetch("/api/snapshot", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await readJson<SnapshotApiResponse>(response);

  if (!response.ok) {
    throwSnapshotError(response, payload);
  }

  if (!payload.configured) {
    console.info("[persistence] Supabase is not configured. Skipping cloud snapshot load.");
    return undefined;
  }

  if (!payload.found) {
    console.info("[persistence] Supabase snapshot row is empty.");
    return undefined;
  }

  return {
    appState: payload.appState,
    translations: payload.translations ?? [],
    updatedAt: payload.updatedAt,
  };
}

export async function saveSupabaseSnapshot(
  appState: AppState,
  translations: TranslationItem[] | undefined,
  expectedUpdatedAt?: string,
) {
  const response = await fetch("/api/snapshot", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ appState, translations, expectedUpdatedAt }),
  });
  const payload = await readJson<SnapshotApiResponse>(response);

  if (!response.ok) {
    throwSnapshotError(response, payload);
  }

  return { updatedAt: payload.updatedAt };
}

export async function uploadScreenImage(screenId: string, dataUrl: string) {
  if (!dataUrl.startsWith("data:")) {
    return undefined;
  }

  const response = await fetch("/api/screen-images", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ screenId, dataUrl }),
  });
  const payload = await readJson<ImageUploadApiResponse>(response);

  if (!response.ok) {
    const message = payload.error || "화면 이미지 업로드에 실패했습니다.";
    if (response.status === 401) {
      throw new SupabaseSnapshotUnauthorizedError(message);
    }
    throw new Error(message);
  }

  return payload.result;
}
