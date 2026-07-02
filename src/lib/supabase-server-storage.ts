import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AppState, TranslationItem } from "./types";

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

export class SupabaseServerSnapshotConflictError extends Error {
  constructor() {
    super("다른 곳에서 먼저 저장된 변경사항이 있어 현재 저장을 중단했습니다. 현재 작업을 유지하거나 최신 데이터를 불러올 수 있습니다.");
    this.name = "SupabaseSnapshotConflictError";
  }
}

function getSnapshotId() {
  return process.env.NEXT_PUBLIC_APP_SNAPSHOT_ID || "default";
}

function getBucketName() {
  return process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || "screen-images";
}

function createServerSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) return null;

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
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
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getStorageSafeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getBackupId(timestamp: string) {
  return `${getSnapshotId()}_${timestamp}_${randomUUID()}`;
}

function getImageExtension(dataUrl: string) {
  const mime = dataUrl.match(/data:(.*?);base64/)?.[1] || "";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

function dataUrlToFile(dataUrl: string) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
  return {
    buffer: Buffer.from(data, "base64"),
    mime,
  };
}

async function pruneOldSnapshotBackups() {
  const supabase = createServerSupabaseClient();
  if (!supabase || snapshotBackupTableUnavailable) return;

  const snapshotId = getSnapshotId();
  const { data: backups, error: listError } = await supabase
    .from(SNAPSHOT_BACKUP_TABLE)
    .select("id, created_at")
    .eq("snapshot_id", snapshotId)
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
    .eq("snapshot_id", snapshotId)
    .in("id", backupIds);

  if (deleteError) {
    throw deleteError;
  }

  console.info("[persistence] Old snapshot backups pruned.", {
    table: SNAPSHOT_BACKUP_TABLE,
    snapshotId,
    retentionCount: SNAPSHOT_BACKUP_RETENTION_COUNT,
    deletedCount: backupIds.length,
  });
}

export async function loadServerSupabaseSnapshot() {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    console.info("[persistence] Server Supabase is not configured. Skipping cloud snapshot load.");
    return { configured: false as const };
  }

  const snapshotId = getSnapshotId();
  console.info("[persistence] Loading Supabase snapshot through server API", {
    table: SNAPSHOT_TABLE,
    id: snapshotId,
  });

  const { data, error } = await supabase
    .from(SNAPSHOT_TABLE)
    .select("app_state, translations, updated_at")
    .eq("id", snapshotId)
    .maybeSingle<PersistedPayload>();

  if (error) {
    console.error("[persistence] Supabase snapshot load error", error);
    throw error;
  }

  if (!data) {
    console.info("[persistence] Supabase snapshot row is empty", {
      table: SNAPSHOT_TABLE,
      id: snapshotId,
    });
    return { configured: true as const, found: false as const };
  }

  console.info("[persistence] Supabase snapshot row found", {
    table: SNAPSHOT_TABLE,
    id: snapshotId,
    screens: data.app_state?.screens?.length ?? 0,
    regions: data.app_state?.regions?.length ?? 0,
    sources: data.app_state?.sources?.length ?? 0,
    translations: data.translations?.length ?? 0,
    updatedAt: data.updated_at,
  });

  return {
    configured: true as const,
    found: true as const,
    appState: data.app_state,
    translations: data.translations ?? [],
    updatedAt: data.updated_at,
  };
}

async function backupCurrentSnapshotIfDue() {
  const supabase = createServerSupabaseClient();
  if (!supabase || snapshotBackupTableUnavailable) return;

  const now = Date.now();
  if (now < nextSnapshotBackupCheckAt) return;

  const snapshotId = getSnapshotId();

  try {
    const { data: latestBackup, error: latestBackupError } = await supabase
      .from(SNAPSHOT_BACKUP_TABLE)
      .select("created_at")
      .eq("snapshot_id", snapshotId)
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
        snapshotId,
        latestBackupAt: latestBackup?.created_at,
      });
      return;
    }

    const { data: currentSnapshot, error: currentSnapshotError } = await supabase
      .from(SNAPSHOT_TABLE)
      .select("id, owner_id, app_state, translations, updated_at")
      .eq("id", snapshotId)
      .maybeSingle<PersistedRow>();

    if (currentSnapshotError) {
      throw currentSnapshotError;
    }

    if (!currentSnapshot) {
      nextSnapshotBackupCheckAt = now + SNAPSHOT_BACKUP_INTERVAL_MS;
      console.info("[persistence] Snapshot backup skipped because the source snapshot does not exist yet.", {
        table: SNAPSHOT_TABLE,
        id: snapshotId,
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
      snapshotId,
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

export async function saveServerSupabaseSnapshot(
  appState: AppState,
  translations: TranslationItem[] | undefined,
  expectedUpdatedAt?: string,
  attempt = 1,
): Promise<{ updatedAt?: string }> {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase 환경변수가 설정되지 않아 원본 데이터를 저장할 수 없습니다.");
  }

  const snapshotId = getSnapshotId();
  console.info("[persistence] Saving Supabase snapshot through server API", {
    table: SNAPSHOT_TABLE,
    id: snapshotId,
    attempt,
    screens: appState.screens.length,
    regions: appState.regions.length,
    sources: appState.sources?.length ?? 0,
    translations: translations?.length ?? "unchanged",
    expectedUpdatedAt,
  });

  await backupCurrentSnapshotIfDue();
  const nextUpdatedAt = new Date().toISOString();

  const updatePayload = {
          owner_id: null,
          app_state: appState,
          updated_at: nextUpdatedAt,
          ...(translations ? { translations } : {}),
        };
  const upsertPayload = {
          id: snapshotId,
          owner_id: null,
          app_state: appState,
          translations: translations ?? [],
          updated_at: nextUpdatedAt,
        };

  const saveResult = expectedUpdatedAt
    ? await supabase
        .from(SNAPSHOT_TABLE)
        .update(updatePayload)
        .eq("id", snapshotId)
        .eq("updated_at", expectedUpdatedAt)
        .select("updated_at")
        .maybeSingle<{ updated_at: string }>()
    : await supabase
        .from(SNAPSHOT_TABLE)
        .upsert(upsertPayload)
        .select("updated_at")
        .single<{ updated_at: string }>();

  const { data, error } = saveResult;

  if (error) {
    const errorDetails = getSupabaseErrorDetails(error);

    if (errorDetails.code === "57014" && attempt === 1) {
      console.warn("[persistence] Supabase snapshot save timed out. Retrying once.", errorDetails);
      await wait(750);
      return saveServerSupabaseSnapshot(appState, translations, expectedUpdatedAt, attempt + 1);
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
      id: snapshotId,
      expectedUpdatedAt,
    });
    throw new SupabaseServerSnapshotConflictError();
  }

  console.info("[persistence] Supabase snapshot saved", {
    table: SNAPSHOT_TABLE,
    id: snapshotId,
    updatedAt: data?.updated_at,
  });

  return { updatedAt: data?.updated_at ?? nextUpdatedAt };
}

export async function uploadServerScreenImage(screenId: string, dataUrl: string) {
  const supabase = createServerSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase가 설정되지 않아 이미지를 업로드할 수 없습니다.");
  }

  if (!dataUrl.startsWith("data:")) {
    return undefined;
  }

  const extension = getImageExtension(dataUrl);
  const snapshotId = getSnapshotId();
  const pathPrefix = snapshotId === "default" ? "" : `snapshots/${snapshotId}/`;
  const path = `${pathPrefix}screens/${screenId}/${getStorageSafeTimestamp()}.${extension}`;
  const file = dataUrlToFile(dataUrl);
  const { error } = await supabase.storage.from(getBucketName()).upload(path, file.buffer, {
    cacheControl: "3600",
    contentType: file.mime,
    upsert: false,
  });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from(getBucketName()).getPublicUrl(path);

  return {
    imageUrl: data.publicUrl,
    imageStoragePath: path,
  };
}
