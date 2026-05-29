import type { AppState, TranslationItem } from "./types";
import { supabase, SUPABASE_BUCKET } from "./supabase";

const SNAPSHOT_ID = "default";
const SNAPSHOT_TABLE = "app_snapshots";

type PersistedPayload = {
  app_state: AppState;
  translations: TranslationItem[];
};

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
  if (!supabase) return undefined;

  const { data, error } = await supabase
    .from(SNAPSHOT_TABLE)
    .select("app_state, translations")
    .eq("id", SNAPSHOT_ID)
    .maybeSingle<PersistedPayload>();

  if (error) {
    throw error;
  }

  if (!data) return undefined;

  return {
    appState: data.app_state,
    translations: data.translations ?? [],
  };
}

export async function saveSupabaseSnapshot(appState: AppState, translations: TranslationItem[]) {
  if (!supabase) return;

  const { error } = await supabase.from(SNAPSHOT_TABLE).upsert({
    id: SNAPSHOT_ID,
    owner_id: null,
    app_state: appState,
    translations,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

export async function uploadScreenImage(screenId: string, dataUrl: string) {
  if (!supabase || !dataUrl.startsWith("data:")) {
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
