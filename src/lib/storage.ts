import type { AppState, TranslationItem, TranslationSource } from "./types";
import { loadSupabaseSnapshot } from "./supabase-storage";

const DB_NAME = "multilingual-text-map";
const STORE_NAME = "kv";
const APP_STATE_KEY = "app-state";
const TRANSLATIONS_KEY = "translations";

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

export async function loadPersistedData() {
  try {
    const cloudData = await loadSupabaseSnapshot();
    if (cloudData) {
      await Promise.all([
        setValue(APP_STATE_KEY, normalizeAppState(cloudData.appState)),
        setValue(TRANSLATIONS_KEY, cloudData.translations ?? []),
      ]);

      return {
        appState: normalizeAppState(cloudData.appState),
        translations: cloudData.translations ?? [],
      };
    }
  } catch (error) {
    console.warn("Supabase load failed. Falling back to local IndexedDB.", error);
  }

  const [appState, translations] = await Promise.all([
    getValue<AppState>(APP_STATE_KEY),
    getValue<TranslationItem[]>(TRANSLATIONS_KEY),
  ]);

  return {
    appState: normalizeAppState(appState),
    translations: translations ?? [],
  };
}

export async function saveAppState(appState: AppState) {
  await setValue(APP_STATE_KEY, appState);
}

export async function saveTranslations(translations: TranslationItem[]) {
  await setValue(TRANSLATIONS_KEY, translations);
}
