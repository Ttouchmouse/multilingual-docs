import type { AppState, TranslationItem } from "./types";
import { supabase, SUPABASE_BUCKET } from "./supabase";

const SNAPSHOT_ID = "default";
const SNAPSHOT_TABLE = "app_snapshots";

type PersistedPayload = {
  app_state: AppState;
  translations: TranslationItem[];
};

type SupabaseErrorDetails = {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
};

function getSupabaseErrorDetails(error: unknown): SupabaseErrorDetails {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<SupabaseErrorDetails>;
    return {
      code: candidate.code,
      message: candidate.message ?? "Unknown Supabase error",
      details: candidate.details,
      hint: candidate.hint,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function dataUrlToBlob(dataUrl: string) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mime });
}

function getImageExtension(dataUrl: string) {
  const mime = dataUrl.match(/data:(.*?);base64/)?.[1] || "";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

export async function loadSupabaseSnapshot() {
  if (!supabase) {
    console.info("[persistence] Supabase is not configured. Skipping cloud snapshot load.");
    return undefined;
  }

  console.info("[persistence] Loading Supabase snapshot", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
  });

  const { data, error } = await supabase
    .from(SNAPSHOT_TABLE)
    .select("app_state, translations")
    .eq("id", SNAPSHOT_ID)
    .maybeSingle<PersistedPayload>();

  if (error) {
    console.error("[persistence] Supabase snapshot load error", error);
    throw error;
  }

  if (!data) {
    console.info("[persistence] Supabase snapshot row is empty", {
      table: SNAPSHOT_TABLE,
      id: SNAPSHOT_ID,
    });
    return undefined;
  }

  console.info("[persistence] Supabase snapshot row found", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
    screens: data.app_state?.screens?.length ?? 0,
    regions: data.app_state?.regions?.length ?? 0,
    sources: data.app_state?.sources?.length ?? 0,
    translations: data.translations?.length ?? 0,
  });

  return {
    appState: data.app_state,
    translations: data.translations ?? [],
  };
}

async function performSupabaseSnapshotSave(
  appState: AppState,
  translations: TranslationItem[],
  attempt = 1,
): Promise<void> {
  if (!supabase) return;

  console.info("[persistence] Saving Supabase snapshot", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
    attempt,
    screens: appState.screens.length,
    regions: appState.regions.length,
    sources: appState.sources?.length ?? 0,
    translations: translations.length,
  });

  const { error } = await supabase.from(SNAPSHOT_TABLE).upsert({
    id: SNAPSHOT_ID,
    owner_id: null,
    app_state: appState,
    translations,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    const errorDetails = getSupabaseErrorDetails(error);

    if (errorDetails.code === "57014" && attempt === 1) {
      console.warn("[persistence] Supabase snapshot save timed out. Retrying once.", errorDetails);
      await wait(750);
      return performSupabaseSnapshotSave(appState, translations, attempt + 1);
    }

    console.warn("[persistence] Supabase snapshot save failed", errorDetails);
    throw new Error(
      `[${errorDetails.code ?? "unknown"}] ${errorDetails.message}`,
      { cause: error },
    );
  }

  console.info("[persistence] Supabase snapshot saved", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
  });
}

export function saveSupabaseSnapshot(appState: AppState, translations: TranslationItem[]) {
  if (!supabase) {
    return Promise.reject(new Error("Supabase is not configured."));
  }

  return performSupabaseSnapshotSave(appState, translations);
}

export async function uploadScreenImage(screenId: string, dataUrl: string) {
  if (!supabase) {
    throw new Error("Supabase가 설정되지 않아 이미지를 업로드할 수 없습니다.");
  }

  if (!dataUrl.startsWith("data:")) {
    return undefined;
  }

  const extension = getImageExtension(dataUrl);
  const path = `screens/${screenId}.${extension}`;
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, blob, {
    cacheControl: "3600",
    contentType: blob.type,
    upsert: true,
  });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);

  return {
    imageUrl: data.publicUrl,
    imageStoragePath: path,
  };
}
