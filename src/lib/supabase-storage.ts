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

type SnapshotUploadApiResponse = {
  result?: {
    signedUrl: string;
    path: string;
  };
  error?: string;
};

type ImageUploadApiResponse = {
  result?: {
    signedUrl?: string;
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

async function uploadFileToSignedUrl(signedUrl: string, file: File) {
  const formData = new FormData();
  formData.append("cacheControl", "3600");
  formData.append("", file);

  const response = await fetch(signedUrl, {
    method: "PUT",
    body: formData,
  });

  if (!response.ok) {
    const payload = await readJson<{ error?: string; message?: string }>(response);
    throw new Error(payload.error || payload.message || "화면 이미지 업로드에 실패했습니다.");
  }
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

async function uploadTranslationsSnapshot(translations: TranslationItem[]) {
  const uploadResponse = await fetch("/api/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ uploadKind: "translations" }),
  });
  const uploadPayload = await readJson<SnapshotUploadApiResponse>(uploadResponse);

  if (!uploadResponse.ok || !uploadPayload.result?.signedUrl) {
    throwSnapshotError(uploadResponse, uploadPayload);
  }

  const file = new File(
    [JSON.stringify(translations)],
    `translations-${Date.now()}.json`,
    { type: "application/json" },
  );
  await uploadFileToSignedUrl(uploadPayload.result.signedUrl, file);

  return uploadPayload.result.path;
}

export async function saveSupabaseSnapshot(
  appState: AppState,
  translations: TranslationItem[] | undefined,
  expectedUpdatedAt?: string,
) {
  const translationsUploadPath = translations ? await uploadTranslationsSnapshot(translations) : undefined;
  const response = await fetch("/api/snapshot", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ appState, translationsUploadPath, expectedUpdatedAt }),
  });
  const payload = await readJson<SnapshotApiResponse>(response);

  if (!response.ok) {
    throwSnapshotError(response, payload);
  }

  return { updatedAt: payload.updatedAt };
}

export async function uploadScreenImage(screenId: string, dataUrl: string, file?: File) {
  if (file) {
    const response = await fetch("/api/screen-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        screenId,
        fileName: file.name,
        contentType: file.type,
        uploadMode: "signed",
      }),
    });
    const payload = await readJson<ImageUploadApiResponse>(response);

    if (!response.ok || !payload.result?.signedUrl) {
      const message = payload.error || "화면 이미지 업로드 URL을 만들 수 없습니다.";
      if (response.status === 401) {
        throw new SupabaseSnapshotUnauthorizedError(message);
      }
      throw new Error(message);
    }

    await uploadFileToSignedUrl(payload.result.signedUrl, file);

    return {
      imageUrl: payload.result.imageUrl,
      imageStoragePath: payload.result.imageStoragePath,
    };
  }

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
