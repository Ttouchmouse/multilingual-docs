import type { AppState, TranslationItem, TranslationSource } from "./types";
import {
  loadSupabaseSnapshot,
  saveSupabaseSnapshot,
  SupabaseSnapshotUnavailableError,
} from "./supabase-storage";

const DB_NAME = "multilingual-text-map";
const STORE_NAME = "kv";
const APP_STATE_KEY = "app-state";
const TRANSLATIONS_KEY = "translations";

export type PersistedDataSource = "supabase" | "indexeddb" | "empty";
export type SupabaseLoadStatus = "success" | "empty" | "failed" | "unconfigured";

type PersistedSnapshot = {
  appState: AppState;
  translations: TranslationItem[];
  translationsChanged: boolean;
  expectedUpdatedAt?: string;
};

let pendingPersistedSnapshot: PersistedSnapshot | undefined;
let persistedSaveLoop: Promise<{ updatedAt?: string }> | null = null;
let lastPersistedTranslationsSignature: string | undefined;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function setValue<T>(key: string, value: T): Promise<void> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(value, key);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export function getInitialAppState(): AppState {
  return {
    sources: [],
    groups: [],
    screens: [],
    regions: [],
  };
}

function normalizeSource(source: TranslationSource): TranslationSource {
  const sourceId = source.sourceId ?? source.id ?? `src_${Date.now()}`;
  const itemCount = source.itemCount ?? source.totalCount ?? 0;
  const importedAt = source.importedAt ?? source.parsedAt ?? source.uploadedAt ?? new Date().toISOString();
  const fileType = source.fileType ?? (source.fileName.split(".").pop()?.toLowerCase() === "csv" ? "csv" : "html");

  return {
    ...source,
    sourceId,
    id: source.id ?? sourceId,
    fileType: fileType === "xlsx" || fileType === "csv" ? fileType : "html",
    importedAt,
    uploadedAt: source.uploadedAt ?? importedAt,
    parsedAt: source.parsedAt ?? importedAt,
    itemCount,
    totalCount: source.totalCount ?? itemCount,
    enabled: source.enabled ?? true,
  };
}

function normalizeAppState(appState: AppState | undefined): AppState {
  const base = appState ?? getInitialAppState();
  const sources = [...(base.sources ?? [])];
  const groups = new Set(base.groups ?? []);

  if (base.source && !sources.some((source) => (source.sourceId ?? source.id) === (base.source?.sourceId ?? base.source?.id))) {
    sources.push(base.source);
  }

  for (const screen of base.screens ?? []) {
    groups.add(screen.group?.trim() || "기타");
  }

  return {
    ...base,
    sources: sources.map(normalizeSource),
    groups: Array.from(groups),
    screens: base.screens ?? [],
    regions: base.regions ?? [],
  };
}

function hasPersistedData(appState: AppState | undefined, translations: TranslationItem[] | undefined) {
  return Boolean(
    appState?.screens?.length ||
      appState?.regions?.length ||
      appState?.sources?.length ||
      appState?.source ||
      appState?.groups?.length ||
      translations?.length,
  );
}

function getTranslationsSignature(translations: TranslationItem[]) {
  return translations
    .map((item) => `${item.id}:${item.sourceId}:${item.key}:${item.updatedAt}`)
    .join("|");
}

export async function loadPersistedData() {
  let supabaseStatus: SupabaseLoadStatus = "unconfigured";

  try {
    const cloudData = await loadSupabaseSnapshot();
    if (cloudData) {
      supabaseStatus = "success";
      const normalizedCloudState = normalizeAppState(cloudData.appState);
      const cloudTranslations = cloudData.translations ?? [];
      lastPersistedTranslationsSignature = getTranslationsSignature(cloudTranslations);
      console.info("[persistence] Supabase snapshot loaded", {
        screens: normalizedCloudState.screens.length,
        regions: normalizedCloudState.regions.length,
        sources: normalizedCloudState.sources?.length ?? 0,
        translations: cloudTranslations.length,
      });

      await Promise.all([
        setValue(APP_STATE_KEY, normalizedCloudState),
        setValue(TRANSLATIONS_KEY, cloudTranslations),
      ]);
      console.info("[persistence] IndexedDB cache refreshed from Supabase snapshot.");

      return {
        appState: normalizedCloudState,
        translations: cloudTranslations,
        source: "supabase" as PersistedDataSource,
        supabaseStatus,
        supabaseUpdatedAt: cloudData.updatedAt,
      };
    }
    supabaseStatus = "empty";
    console.info("[persistence] Supabase snapshot not found. Checking IndexedDB fallback.");
  } catch (error) {
    supabaseStatus = error instanceof SupabaseSnapshotUnavailableError ? "unconfigured" : "failed";
    console.error("[persistence] Supabase load failed. Falling back to local IndexedDB.", error);
  }

  const [appState, translations] = await Promise.all([
    getValue<AppState>(APP_STATE_KEY),
    getValue<TranslationItem[]>(TRANSLATIONS_KEY),
  ]);
  const normalizedLocalState = normalizeAppState(appState);
  const localTranslations = translations ?? [];
  lastPersistedTranslationsSignature = hasPersistedData(normalizedLocalState, localTranslations)
    ? getTranslationsSignature(localTranslations)
    : undefined;
  const source: PersistedDataSource = hasPersistedData(normalizedLocalState, localTranslations) ? "indexeddb" : "empty";

  console.info("[persistence] Local IndexedDB load result", {
    source,
    supabaseStatus,
    screens: normalizedLocalState.screens.length,
    regions: normalizedLocalState.regions.length,
    sources: normalizedLocalState.sources?.length ?? 0,
    translations: localTranslations.length,
  });

  return {
    appState: normalizedLocalState,
    translations: localTranslations,
    source,
    supabaseStatus,
    supabaseUpdatedAt: undefined,
  };
}

export function savePersistedData(appState: AppState, translations: TranslationItem[], expectedUpdatedAt?: string) {
  const translationsSignature = getTranslationsSignature(translations);
  const translationsChanged = translationsSignature !== lastPersistedTranslationsSignature;
  pendingPersistedSnapshot = { appState, translations, translationsChanged, expectedUpdatedAt };

  if (persistedSaveLoop) {
    console.info("[persistence] Save already in progress. Queued latest application snapshot.");
    return persistedSaveLoop;
  }

  persistedSaveLoop = (async () => {
    let latestUpdatedAt = expectedUpdatedAt;

    while (pendingPersistedSnapshot) {
      const snapshot = pendingPersistedSnapshot;
      pendingPersistedSnapshot = undefined;
      const snapshotExpectedUpdatedAt = latestUpdatedAt ?? snapshot.expectedUpdatedAt;

      console.info("[persistence] Cloud-first save started", {
        screens: snapshot.appState.screens.length,
        regions: snapshot.appState.regions.length,
        sources: snapshot.appState.sources?.length ?? 0,
        translations: snapshot.translations.length,
        translationsChanged: snapshot.translationsChanged,
        expectedUpdatedAt: snapshotExpectedUpdatedAt,
      });

      const saveResult = await saveSupabaseSnapshot(
        snapshot.appState,
        snapshot.translationsChanged ? snapshot.translations : undefined,
        snapshotExpectedUpdatedAt,
      );
      latestUpdatedAt = saveResult.updatedAt ?? latestUpdatedAt;
      if (snapshot.translationsChanged) {
        lastPersistedTranslationsSignature = getTranslationsSignature(snapshot.translations);
      }
      await Promise.all([
        setValue(APP_STATE_KEY, snapshot.appState),
        setValue(TRANSLATIONS_KEY, snapshot.translations),
      ]);

      console.info("[persistence] Cloud save succeeded. IndexedDB cache refreshed.");
    }

    return { updatedAt: latestUpdatedAt };
  })().finally(() => {
    persistedSaveLoop = null;
  });

  return persistedSaveLoop;
}
