import type { AppState, TranslationItem } from "./types";
import { supabase, SUPABASE_BUCKET, SUPABASE_SNAPSHOT_ID } from "./supabase";

const SNAPSHOT_ID = SUPABASE_SNAPSHOT_ID;
const SNAPSHOT_TABLE = "app_snapshots";
const SNAPSHOT_BACKUP_TABLE = "app_snapshot_backups";
const SNAPSHOT_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOT_BACKUP_RETENTION_COUNT = 30;

let nextSnapshotBackupCheckAt = 0;
let snapshotBackupTableUnavailable = false;

type PersistedPayload = {
  app_state: AppState;
  translations: TranslationItem[];
  updated_at?: string;
};

type PersistedRow = PersistedPayload & {
  id: string;
  owner_id: string | null;
  updated_at: string;
};

type SupabaseErrorDetails = {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
};

export class SupabaseSnapshotConflictError extends Error {
  constructor() {
    super("다른 곳에서 먼저 저장된 변경사항이 있어 현재 저장을 중단했습니다. 현재 작업을 유지하거나 최신 데이터를 불러올 수 있습니다.");
    this.name = "SupabaseSnapshotConflictError";
  }
}

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

function getStorageSafeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getBackupId(timestamp: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return `${SNAPSHOT_ID}_${timestamp}_${suffix}`;
}

async function pruneOldSnapshotBackups() {
  if (!supabase || snapshotBackupTableUnavailable) return;

  const { data: backups, error: listError } = await supabase
    .from(SNAPSHOT_BACKUP_TABLE)
    .select("id, created_at")
    .eq("snapshot_id", SNAPSHOT_ID)
    .order("created_at", { ascending: false })
    .range(SNAPSHOT_BACKUP_RETENTION_COUNT, SNAPSHOT_BACKUP_RETENTION_COUNT + 49);

  if (listError) {
    throw listError;
  }

  const backupIds = backups?.map((backup) => backup.id).filter(Boolean) ?? [];
  if (backupIds.length === 0) return;

  const { error: deleteError } = await supabase
    .from(SNAPSHOT_BACKUP_TABLE)
    .delete()
    .eq("snapshot_id", SNAPSHOT_ID)
    .in("id", backupIds);

  if (deleteError) {
    throw deleteError;
  }

  console.info("[persistence] Old snapshot backups pruned.", {
    table: SNAPSHOT_BACKUP_TABLE,
    snapshotId: SNAPSHOT_ID,
    retentionCount: SNAPSHOT_BACKUP_RETENTION_COUNT,
    deletedCount: backupIds.length,
  });
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
    .select("app_state, translations, updated_at")
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
    updatedAt: data.updated_at,
  });

  return {
    appState: data.app_state,
    translations: data.translations ?? [],
    updatedAt: data.updated_at,
  };
}

async function backupCurrentSnapshotIfDue() {
  if (!supabase || snapshotBackupTableUnavailable) return;

  const now = Date.now();
  if (now < nextSnapshotBackupCheckAt) return;

  try {
    const { data: latestBackup, error: latestBackupError } = await supabase
      .from(SNAPSHOT_BACKUP_TABLE)
      .select("created_at")
      .eq("snapshot_id", SNAPSHOT_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ created_at: string }>();

    if (latestBackupError) {
      throw latestBackupError;
    }

    const latestBackupAt = latestBackup?.created_at ? new Date(latestBackup.created_at).getTime() : 0;
    if (latestBackupAt && now - latestBackupAt < SNAPSHOT_BACKUP_INTERVAL_MS) {
      nextSnapshotBackupCheckAt = latestBackupAt + SNAPSHOT_BACKUP_INTERVAL_MS;
      console.info("[persistence] Snapshot backup skipped because a recent backup already exists.", {
        table: SNAPSHOT_BACKUP_TABLE,
        snapshotId: SNAPSHOT_ID,
        latestBackupAt: latestBackup?.created_at,
      });
      return;
    }

    const { data: currentSnapshot, error: currentSnapshotError } = await supabase
      .from(SNAPSHOT_TABLE)
      .select("id, owner_id, app_state, translations, updated_at")
      .eq("id", SNAPSHOT_ID)
      .maybeSingle<PersistedRow>();

    if (currentSnapshotError) {
      throw currentSnapshotError;
    }

    if (!currentSnapshot) {
      nextSnapshotBackupCheckAt = now + SNAPSHOT_BACKUP_INTERVAL_MS;
      console.info("[persistence] Snapshot backup skipped because the source snapshot does not exist yet.", {
        table: SNAPSHOT_TABLE,
        id: SNAPSHOT_ID,
      });
      return;
    }

    const backupCreatedAt = new Date().toISOString();
    const { error: insertError } = await supabase.from(SNAPSHOT_BACKUP_TABLE).insert({
      id: getBackupId(getStorageSafeTimestamp()),
      snapshot_id: currentSnapshot.id,
      owner_id: currentSnapshot.owner_id,
      app_state: currentSnapshot.app_state,
      translations: currentSnapshot.translations ?? [],
      snapshot_updated_at: currentSnapshot.updated_at,
      reason: "auto_before_save",
      created_at: backupCreatedAt,
    });

    if (insertError) {
      throw insertError;
    }

    nextSnapshotBackupCheckAt = now + SNAPSHOT_BACKUP_INTERVAL_MS;
    console.info("[persistence] Snapshot backup saved before overwriting default snapshot.", {
      table: SNAPSHOT_BACKUP_TABLE,
      snapshotId: SNAPSHOT_ID,
      createdAt: backupCreatedAt,
    });

    try {
      await pruneOldSnapshotBackups();
    } catch (pruneError) {
      console.warn("[persistence] Snapshot backup pruning failed. Continuing primary save.", getSupabaseErrorDetails(pruneError));
    }
  } catch (error) {
    const errorDetails = getSupabaseErrorDetails(error);
    if (errorDetails.code === "42P01") {
      snapshotBackupTableUnavailable = true;
      console.warn("[persistence] Snapshot backup table is missing. Run supabase-setup.sql to enable automatic backups.", errorDetails);
      return;
    }

    nextSnapshotBackupCheckAt = now + SNAPSHOT_BACKUP_INTERVAL_MS;
    console.warn("[persistence] Snapshot backup failed. Continuing primary save.", errorDetails);
  }
}

async function performSupabaseSnapshotSave(
  appState: AppState,
  translations: TranslationItem[],
  expectedUpdatedAt?: string,
  attempt = 1,
): Promise<{ updatedAt?: string }> {
  if (!supabase) return {};

  console.info("[persistence] Saving Supabase snapshot", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
    attempt,
    screens: appState.screens.length,
    regions: appState.regions.length,
    sources: appState.sources?.length ?? 0,
    translations: translations.length,
    expectedUpdatedAt,
  });

  await backupCurrentSnapshotIfDue();
  const nextUpdatedAt = new Date().toISOString();

  const saveResult = expectedUpdatedAt
    ? await supabase
        .from(SNAPSHOT_TABLE)
        .update({
          owner_id: null,
          app_state: appState,
          translations,
          updated_at: nextUpdatedAt,
        })
        .eq("id", SNAPSHOT_ID)
        .eq("updated_at", expectedUpdatedAt)
        .select("updated_at")
        .maybeSingle<{ updated_at: string }>()
    : await supabase
        .from(SNAPSHOT_TABLE)
        .upsert({
          id: SNAPSHOT_ID,
          owner_id: null,
          app_state: appState,
          translations,
          updated_at: nextUpdatedAt,
        })
        .select("updated_at")
        .single<{ updated_at: string }>();

  const { data, error } = saveResult;

  if (error) {
    const errorDetails = getSupabaseErrorDetails(error);

    if (errorDetails.code === "57014" && attempt === 1) {
      console.warn("[persistence] Supabase snapshot save timed out. Retrying once.", errorDetails);
      await wait(750);
      return performSupabaseSnapshotSave(appState, translations, expectedUpdatedAt, attempt + 1);
    }

    console.warn("[persistence] Supabase snapshot save failed", errorDetails);
    throw new Error(
      `[${errorDetails.code ?? "unknown"}] ${errorDetails.message}`,
      { cause: error },
    );
  }

  if (expectedUpdatedAt && !data) {
    console.warn("[persistence] Supabase snapshot save blocked by revision conflict", {
      table: SNAPSHOT_TABLE,
      id: SNAPSHOT_ID,
      expectedUpdatedAt,
    });
    throw new SupabaseSnapshotConflictError();
  }

  console.info("[persistence] Supabase snapshot saved", {
    table: SNAPSHOT_TABLE,
    id: SNAPSHOT_ID,
    updatedAt: data?.updated_at,
  });

  return { updatedAt: data?.updated_at ?? nextUpdatedAt };
}

export function saveSupabaseSnapshot(appState: AppState, translations: TranslationItem[], expectedUpdatedAt?: string) {
  if (!supabase) {
    return Promise.reject(new Error("Supabase is not configured."));
  }

  return performSupabaseSnapshotSave(appState, translations, expectedUpdatedAt);
}

export async function uploadScreenImage(screenId: string, dataUrl: string) {
  if (!supabase) {
    throw new Error("Supabase가 설정되지 않아 이미지를 업로드할 수 없습니다.");
  }

  if (!dataUrl.startsWith("data:")) {
    return undefined;
  }

  const extension = getImageExtension(dataUrl);
  const pathPrefix = SNAPSHOT_ID === "default" ? "" : `snapshots/${SNAPSHOT_ID}/`;
  const path = `${pathPrefix}screens/${screenId}/${getStorageSafeTimestamp()}.${extension}`;
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, blob, {
    cacheControl: "3600",
    contentType: blob.type,
    upsert: false,
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
