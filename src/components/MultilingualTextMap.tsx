"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LANGUAGE_DEFS,
  SCREEN_GROUPS,
  STATUS_LABELS,
  type AppState,
  type LanguageCode,
  type Screen,
  type TextRegion,
  type TextRegionStatus,
  type TranslationItem,
  type TranslationSource,
} from "@/lib/types";
import {
  parseTranslationCsv,
  parseTranslationHtml,
  parseTranslationXlsx,
  searchTranslationItems,
} from "@/lib/translation-parser";
import {
  getInitialAppState,
  loadPersistedData,
  saveAppState,
  saveTranslations,
} from "@/lib/storage";
import { saveSupabaseSnapshot, uploadScreenImage } from "@/lib/supabase-storage";

type ImageRect = Pick<TextRegion, "x" | "y" | "width" | "height">;
type AppMode = "view" | "add" | "edit";

type Interaction =
  | { mode: "draw"; startX: number; startY: number }
  | { mode: "move"; regionId: string; startX: number; startY: number; initial: ImageRect }
  | { mode: "resize"; regionId: string; startX: number; startY: number; initial: ImageRect };

type ScreenForm = {
  name: string;
  group: string;
  platform: Screen["platform"];
  baseLanguage: LanguageCode;
  figmaUrl: string;
  memo: string;
};

type ImageDraft = {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  fileName: string;
};

type ImageTarget = {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  name: string;
};

type DialogAnchor = {
  x: number;
  y: number;
};

type EditingCell = {
  regionId: string;
  languageCode: LanguageCode;
};

type EditingGroup = {
  originalName: string;
  value: string;
};

type DeleteTarget =
  | { type: "group"; name: string }
  | { type: "screen"; screenId: string; name: string };

const DRAFT_SCREEN_ID = "__draft_screen__";

const defaultScreenForm: ScreenForm = {
  name: "",
  group: "payment",
  platform: "mobile_web",
  baseLanguage: "kr",
  figmaUrl: "",
  memo: "",
};

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getNormalizedRect(startX: number, startY: number, x: number, y: number): ImageRect {
  return {
    x: Math.min(startX, x),
    y: Math.min(startY, y),
    width: Math.abs(x - startX),
    height: Math.abs(y - startY),
  };
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsArrayBuffer(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function loadImageSize(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("이미지 크기를 읽을 수 없습니다."));
    image.src = dataUrl;
  });
}

function screenToForm(screen: Screen): ScreenForm {
  return {
    name: screen.name,
    group: screen.group,
    platform: screen.platform,
    baseLanguage: screen.baseLanguage,
    figmaUrl: screen.figmaUrl,
    memo: screen.memo,
  };
}

function getScreenGroup(screen: Screen) {
  return screen.group?.trim() || "기타";
}

function getSourceId(source: TranslationSource) {
  return source.sourceId ?? source.id ?? "";
}

function getSourceItemCount(source: TranslationSource) {
  return source.itemCount ?? source.totalCount ?? 0;
}

function getSourceImportedAt(source: TranslationSource) {
  return source.importedAt ?? source.parsedAt ?? source.uploadedAt ?? "";
}

function formatSourceName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function isDuplicateCandidate(item: TranslationItem, items: TranslationItem[]) {
  return items.some((candidate) => {
    if (candidate.id === item.id) return false;
    return candidate.key === item.key || (!!candidate.kr && candidate.kr === item.kr);
  });
}

function createUniqueGroupName(groups: string[], baseName = "기본") {
  if (!groups.includes(baseName)) return baseName;

  let index = 2;
  while (groups.includes(`${baseName} ${index}`)) {
    index += 1;
  }

  return `${baseName} ${index}`;
}

function BackArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M7 3L2 8L7 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 8H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClearFieldIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path d="M7.25 7.25L12.75 12.75M12.75 7.25L7.25 12.75" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function MultilingualTextMap() {
  const [appState, setAppState] = useState<AppState>(getInitialAppState);
  const [translations, setTranslations] = useState<TranslationItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseMessage, setParseMessage] = useState("");
  const [mode, setMode] = useState<AppMode>("view");
  const [screenForm, setScreenForm] = useState<ScreenForm>(defaultScreenForm);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const [draftRegions, setDraftRegions] = useState<TextRegion[]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  const [keyDialogRegionId, setKeyDialogRegionId] = useState<string>();
  const [keyDialogAnchor, setKeyDialogAnchor] = useState<DialogAnchor>();
  const [pendingTranslationItemId, setPendingTranslationItemId] = useState<string>();
  const [translationQuery, setTranslationQuery] = useState("");
  const [viewSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TextRegionStatus>("all");
  const [imageZoom, setImageZoom] = useState(100);
  const [draftRect, setDraftRect] = useState<ImageRect | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingCellValue, setEditingCellValue] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [editingGroup, setEditingGroup] = useState<EditingGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const translationFileInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const defaultDataLoadAttempted = useRef(false);

  const translationSources = appState.sources ?? (appState.source ? [appState.source] : []);
  const enabledSourceIds = useMemo(
    () => new Set(translationSources.filter((source) => source.enabled !== false).map(getSourceId)),
    [translationSources],
  );
  const sourceById = useMemo(() => {
    return new Map(translationSources.map((source) => [getSourceId(source), source]));
  }, [translationSources]);
  const searchableTranslations = useMemo(
    () => translations.filter((item) => enabledSourceIds.has(item.sourceId)),
    [enabledSourceIds, translations],
  );
  const currentScreen = appState.screens.find((screen) => screen.id === appState.activeScreenId);
  const groupedScreens = useMemo(() => {
    const groups = new Map<string, Screen[]>();

    for (const group of appState.groups ?? []) {
      groups.set(group, []);
    }

    for (const screen of appState.screens) {
      const group = getScreenGroup(screen);
      groups.set(group, [...(groups.get(group) ?? []), screen]);
    }

    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [appState.groups, appState.screens]);
  const isEditing = mode === "add" || mode === "edit";
  const editableImage = useMemo<ImageTarget | undefined>(() => {
    if (mode === "add" && imageDraft) {
      return {
        imageUrl: imageDraft.imageUrl,
        imageWidth: imageDraft.imageWidth,
        imageHeight: imageDraft.imageHeight,
        name: screenForm.name || imageDraft.fileName,
      };
    }

    return currentScreen;
  }, [currentScreen, imageDraft, mode, screenForm.name]);

  const translationsById = useMemo(() => {
    return new Map(translations.map((item) => [item.id, item]));
  }, [translations]);

  const regionsForScreen = useMemo(
    () => appState.regions.filter((region) => region.screenId === appState.activeScreenId),
    [appState.activeScreenId, appState.regions],
  );

  const activeRegions = mode === "add" ? draftRegions : regionsForScreen;
  const selectedRegion = activeRegions.find((region) => region.id === selectedRegionId);

  const filteredRegions = useMemo(() => {
    const query = viewSearch.trim().toLowerCase();

    return activeRegions.filter((region) => {
      if (statusFilter !== "all" && region.status !== statusFilter) return false;
      if (!query) return true;

      const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
      const haystack = [
        region.visibleText,
        region.memo,
        region.status,
        item?.key,
        item?.kr,
        item?.en,
        item?.sc,
        item?.tc,
        item?.es,
        item?.it,
        item?.pt,
        item?.de,
        item?.fr,
        item?.jp,
        item?.th,
        ...Object.values(region.translationOverrides ?? {}),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [activeRegions, statusFilter, translationsById, viewSearch]);

  const searchQuery = translationQuery || selectedRegion?.visibleText || "";
  const searchResults = useMemo(
    () => searchTranslationItems(searchableTranslations, searchQuery, 35),
    [searchQuery, searchableTranslations],
  );

  function openKeyDialog(region: TextRegion, anchor: DialogAnchor) {
    setSelectedRegionId(region.id);
    setKeyDialogRegionId(region.id);
    setKeyDialogAnchor(anchor);
    setPendingTranslationItemId(region.translationItemId);
    setTranslationQuery("");
  }

  function closeKeyDialog() {
    setKeyDialogRegionId(undefined);
    setKeyDialogAnchor(undefined);
    setPendingTranslationItemId(undefined);
  }

  useEffect(() => {
    let active = true;

    loadPersistedData()
      .then((data) => {
        if (!active) return;
        const loadedState = data.appState;
        if (!loadedState.activeScreenId && loadedState.screens[0]) {
          loadedState.activeScreenId = loadedState.screens[0].id;
        }
        setAppState(loadedState);
        setTranslations(data.translations);
        setIsLoaded(true);
      })
      .catch((error) => {
        console.error(error);
        setIsLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    saveAppState(appState).catch(console.error);
  }, [appState, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    saveTranslations(translations).catch(console.error);
  }, [translations, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    const timeout = window.setTimeout(() => {
      saveSupabaseSnapshot(appState, translations).catch((error) => {
        console.warn("Supabase save failed. Local IndexedDB data is still saved.", error);
      });
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [appState, isLoaded, translations]);

  useEffect(() => {
    if (!isLoaded || translationSources.length > 0 || translations.length > 0 || defaultDataLoadAttempted.current) return;
    defaultDataLoadAttempted.current = true;
    void loadLocalHtml();
  }, [isLoaded, translationSources.length, translations.length]);

  useEffect(() => {
    if (!selectedRegionId) return;
    itemRefs.current[selectedRegionId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedRegionId]);

  useEffect(() => {
    if (mode !== "edit" || !currentScreen) return;
    setScreenForm(screenToForm(currentScreen));
    setImageDraft(null);
  }, [currentScreen, mode]);

  useEffect(() => {
    if (!interaction || !editableImage || !isEditing) return;

    const toImagePoint = (event: PointerEvent) => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;

      return {
        x: clamp(((event.clientX - rect.left) / rect.width) * editableImage.imageWidth, 0, editableImage.imageWidth),
        y: clamp(((event.clientY - rect.top) / rect.height) * editableImage.imageHeight, 0, editableImage.imageHeight),
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = toImagePoint(event);
      if (!point) return;

      if (interaction.mode === "draw") {
        setDraftRect(getNormalizedRect(interaction.startX, interaction.startY, point.x, point.y));
        return;
      }

      const updateRegion = (region: TextRegion) => {
          if (region.id !== interaction.regionId) return region;

          if (interaction.mode === "move") {
            const nextX = clamp(
              interaction.initial.x + point.x - interaction.startX,
              0,
              editableImage.imageWidth - interaction.initial.width,
            );
            const nextY = clamp(
              interaction.initial.y + point.y - interaction.startY,
              0,
              editableImage.imageHeight - interaction.initial.height,
            );

            return { ...region, x: nextX, y: nextY, updatedAt: new Date().toISOString() };
          }

          const width = clamp(
            interaction.initial.width + point.x - interaction.startX,
            12,
            editableImage.imageWidth - interaction.initial.x,
          );
          const height = clamp(
            interaction.initial.height + point.y - interaction.startY,
            12,
            editableImage.imageHeight - interaction.initial.y,
          );

          return { ...region, width, height, updatedAt: new Date().toISOString() };
      };

      if (mode === "add") {
        setDraftRegions((regions) => regions.map(updateRegion));
        return;
      }

      setAppState((state) => ({
        ...state,
        regions: state.regions.map(updateRegion),
      }));
    };

    const onPointerUp = (event: PointerEvent) => {
      const point = toImagePoint(event);

      if (interaction.mode === "draw" && point && editableImage) {
        const rect = getNormalizedRect(interaction.startX, interaction.startY, point.x, point.y);
        if (rect.width >= 8 && rect.height >= 8) {
          const now = new Date().toISOString();
          const region: TextRegion = {
            id: createId("region"),
            screenId: mode === "add" ? DRAFT_SCREEN_ID : currentScreen?.id ?? DRAFT_SCREEN_ID,
            visibleText: "",
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            status: "unlinked",
            memo: "",
            createdAt: now,
            updatedAt: now,
          };

          if (mode === "add") {
            setDraftRegions((regions) => [...regions, region]);
          } else {
            setAppState((state) => ({ ...state, regions: [...state.regions, region] }));
          }
          openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
        }
      }

      setDraftRect(null);
      setInteraction(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [currentScreen?.id, editableImage, interaction, isEditing, mode]);

  function addTranslationSource(source: TranslationSource, items: TranslationItem[]) {
    setAppState((state) => ({
      ...state,
      source,
      sources: [...(state.sources ?? (state.source ? [state.source] : [])), source],
    }));
    setTranslations((current) => [...current, ...items]);
    setParseMessage(`${source.fileName} · ${items.length.toLocaleString()}개 번역 항목을 불러왔습니다.`);
  }

  async function parseHtml(html: string, fileName: string) {
    setIsParsing(true);
    setParseMessage("번역 데이터를 파싱 중입니다.");

    try {
      const result = parseTranslationHtml(html, fileName);
      addTranslationSource(result.source, result.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      setParseMessage(`파싱 실패: ${message}`);
    } finally {
      setIsParsing(false);
    }
  }

  async function handleHtmlUpload(file?: File) {
    if (!file) return;
    await handleTranslationFileUpload(file);
  }

  async function handleTranslationFileUpload(file?: File) {
    if (!file) return;

    setIsParsing(true);
    setParseMessage("번역 파일을 파싱 중입니다.");

    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const result =
        extension === "xlsx"
          ? parseTranslationXlsx(await readFileAsArrayBuffer(file), file.name)
          : extension === "csv"
            ? parseTranslationCsv(await readFileAsText(file), file.name)
            : parseTranslationHtml(await readFileAsText(file), file.name);

      addTranslationSource(result.source, result.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      setParseMessage(`파싱 실패: ${message}`);
    } finally {
      setIsParsing(false);
      if (translationFileInputRef.current) {
        translationFileInputRef.current.value = "";
      }
    }
  }

  async function loadLocalHtml() {
    setIsParsing(true);
    setParseMessage("로컬 HTML을 읽는 중입니다.");

    try {
      const response = await fetch("/api/local-translations");
      const payload = (await response.json()) as { fileName?: string; html?: string; error?: string };
      if (!response.ok || !payload.html || !payload.fileName) {
        throw new Error(payload.error ?? "로컬 HTML 응답이 올바르지 않습니다.");
      }
      await parseHtml(payload.html, payload.fileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      setParseMessage(`로컬 HTML 로드 실패: ${message}`);
      setIsParsing(false);
    }
  }

  function toggleTranslationSource(sourceId: string) {
    setAppState((state) => ({
      ...state,
      sources: (state.sources ?? []).map((source) =>
        getSourceId(source) === sourceId ? { ...source, enabled: !source.enabled } : source,
      ),
      source: state.source && getSourceId(state.source) === sourceId ? { ...state.source, enabled: !state.source.enabled } : state.source,
    }));
  }

  function deleteTranslationSource(sourceId: string) {
    setAppState((state) => ({
      ...state,
      sources: (state.sources ?? []).filter((source) => getSourceId(source) !== sourceId),
      source: state.source && getSourceId(state.source) === sourceId ? undefined : state.source,
    }));
    setTranslations((current) => current.filter((item) => item.sourceId !== sourceId));
  }

  async function handleImageDraft(file?: File) {
    if (!file) return;

    const imageUrl = await readFileAsDataUrl(file);
    const size = await loadImageSize(imageUrl);
    setImageDraft({
      imageUrl,
      imageWidth: size.width,
      imageHeight: size.height,
      fileName: file.name,
    });
    setDraftRegions([]);
    setSelectedRegionId(undefined);
    closeKeyDialog();
    if (!screenForm.name.trim()) {
      setScreenForm((form) => ({ ...form, name: file.name.replace(/\.[^.]+$/, "") }));
    }
  }

  function openAddMode(group?: string) {
    setMode("add");
    setScreenForm({ ...defaultScreenForm, group: group ?? defaultScreenForm.group });
    setImageDraft(null);
    setDraftRegions([]);
    setSelectedRegionId(undefined);
    setEditingCell(null);
    closeKeyDialog();
  }

  function addGroup() {
    const nextName = createUniqueGroupName(appState.groups ?? []);
    setAppState((state) => ({
      ...state,
      groups: [...(state.groups ?? []), nextName],
    }));
    setOpenGroups((groups) => ({ ...groups, [nextName]: true }));
  }

  function beginGroupEdit(group: string) {
    setEditingGroup({ originalName: group, value: group });
  }

  function commitGroupEdit() {
    if (!editingGroup) return;

    const nextName = editingGroup.value.trim() || editingGroup.originalName;
    const originalName = editingGroup.originalName;
    const existingGroups = appState.groups ?? [];
    const normalizedName = existingGroups.includes(nextName)
      ? createUniqueGroupName(existingGroups, nextName)
      : nextName;
    setEditingGroup(null);

    if (nextName === originalName) return;

    setAppState((state) => {
      return {
        ...state,
        groups: (state.groups ?? []).map((group) => (group === originalName ? normalizedName : group)),
        screens: state.screens.map((screen) =>
          getScreenGroup(screen) === originalName ? { ...screen, group: normalizedName } : screen,
        ),
      };
    });

    setOpenGroups((groups) => {
      const { [originalName]: wasOpen = true, ...rest } = groups;
      return { ...rest, [normalizedName]: wasOpen };
    });
  }

  function confirmDeleteTarget() {
    if (!deleteTarget) return;

    if (deleteTarget.type === "screen") {
      setAppState((state) => {
        const nextScreens = state.screens.filter((screen) => screen.id !== deleteTarget.screenId);
        const nextActiveScreenId =
          state.activeScreenId === deleteTarget.screenId ? nextScreens[0]?.id : state.activeScreenId;

        return {
          ...state,
          screens: nextScreens,
          regions: state.regions.filter((region) => region.screenId !== deleteTarget.screenId),
          activeScreenId: nextActiveScreenId,
        };
      });
    } else {
      setAppState((state) => {
        const deletedScreenIds = new Set(
          state.screens.filter((screen) => getScreenGroup(screen) === deleteTarget.name).map((screen) => screen.id),
        );
        const nextScreens = state.screens.filter((screen) => getScreenGroup(screen) !== deleteTarget.name);
        const nextActiveScreenId = deletedScreenIds.has(state.activeScreenId ?? "")
          ? nextScreens[0]?.id
          : state.activeScreenId;

        return {
          ...state,
          groups: (state.groups ?? []).filter((group) => group !== deleteTarget.name),
          screens: nextScreens,
          regions: state.regions.filter((region) => !deletedScreenIds.has(region.screenId)),
          activeScreenId: nextActiveScreenId,
        };
      });
      setOpenGroups((groups) => {
        const { [deleteTarget.name]: _deleted, ...rest } = groups;
        return rest;
      });
    }

    setSelectedRegionId(undefined);
    setEditingGroup(null);
    setDeleteTarget(null);
    closeKeyDialog();
  }

  function openEditMode() {
    if (!currentScreen) return;
    setMode("edit");
    setScreenForm(screenToForm(currentScreen));
    setImageDraft(null);
    setDraftRegions([]);
    setEditingCell(null);
  }

  function closeEditMode() {
    setMode("view");
    setImageDraft(null);
    setDraftRegions([]);
    setInteraction(null);
    setDraftRect(null);
    setEditingCell(null);
    closeKeyDialog();
  }

  function handleShellPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (!selectedRegionId) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-region-selection-scope='true']")) return;
    setSelectedRegionId(undefined);
  }

  async function saveScreen() {
    const now = new Date().toISOString();

    if (mode === "add") {
      if (!imageDraft) return;
      const screenId = createId("screen");
      let uploadedImage: Awaited<ReturnType<typeof uploadScreenImage>> | undefined;

      try {
        uploadedImage = await uploadScreenImage(screenId, imageDraft.imageUrl);
      } catch (error) {
        console.warn("Supabase image upload failed. Keeping local data URL.", error);
      }

      const screen: Screen = {
        id: screenId,
        name: screenForm.name.trim() || imageDraft.fileName.replace(/\.[^.]+$/, ""),
        group: screenForm.group,
        platform: screenForm.platform,
        baseLanguage: screenForm.baseLanguage,
        figmaUrl: screenForm.figmaUrl.trim(),
        imageUrl: uploadedImage?.imageUrl ?? imageDraft.imageUrl,
        imageStoragePath: uploadedImage?.imageStoragePath,
        imageWidth: imageDraft.imageWidth,
        imageHeight: imageDraft.imageHeight,
        memo: screenForm.memo.trim(),
        createdAt: now,
        updatedAt: now,
      };

      setAppState((state) => ({
        ...state,
        screens: [...state.screens, screen],
        regions: [
          ...state.regions,
          ...draftRegions.map((region) => ({
            ...region,
            screenId: screen.id,
            updatedAt: now,
          })),
        ],
        activeScreenId: screen.id,
      }));
      setMode("view");
      setScreenForm(defaultScreenForm);
      setImageDraft(null);
      setDraftRegions([]);
      setSelectedRegionId(undefined);
      setInteraction(null);
      setDraftRect(null);
      setEditingCell(null);
      closeKeyDialog();
      return;
    }

    if (!currentScreen) return;
    let uploadedImage: Awaited<ReturnType<typeof uploadScreenImage>> | undefined;
    if (imageDraft) {
      try {
        uploadedImage = await uploadScreenImage(currentScreen.id, imageDraft.imageUrl);
      } catch (error) {
        console.warn("Supabase image upload failed. Keeping local data URL.", error);
      }
    }

    setAppState((state) => ({
      ...state,
      screens: state.screens.map((screen) =>
        screen.id === currentScreen.id
          ? {
              ...screen,
              name: screenForm.name.trim() || screen.name,
              group: screenForm.group,
              platform: screenForm.platform,
              baseLanguage: screenForm.baseLanguage,
              figmaUrl: screenForm.figmaUrl.trim(),
              memo: screenForm.memo.trim(),
              imageUrl: uploadedImage?.imageUrl ?? imageDraft?.imageUrl ?? screen.imageUrl,
              imageStoragePath: uploadedImage?.imageStoragePath ?? screen.imageStoragePath,
              imageWidth: imageDraft?.imageWidth ?? screen.imageWidth,
              imageHeight: imageDraft?.imageHeight ?? screen.imageHeight,
              updatedAt: now,
            }
          : screen,
      ),
    }));
    setImageDraft(null);
    setMode("view");
    setSelectedRegionId(undefined);
    setInteraction(null);
    setDraftRect(null);
    setEditingCell(null);
    closeKeyDialog();
  }

  function updateRegion(regionId: string, patch: Partial<TextRegion>) {
    if (mode === "add") {
      setDraftRegions((regions) =>
        regions.map((region) =>
          region.id === regionId
            ? { ...region, ...patch, updatedAt: new Date().toISOString() }
            : region,
        ),
      );
      return;
    }

    setAppState((state) => ({
      ...state,
      regions: state.regions.map((region) =>
        region.id === regionId
          ? { ...region, ...patch, updatedAt: new Date().toISOString() }
          : region,
      ),
    }));
  }

  function updateSelectedRegion(patch: Partial<TextRegion>) {
    if (!selectedRegionId) return;
    updateRegion(selectedRegionId, patch);
  }

  function deleteSelectedRegion() {
    if (!selectedRegionId) return;

    if (mode === "add") {
      setDraftRegions((regions) => regions.filter((region) => region.id !== selectedRegionId));
      setSelectedRegionId(undefined);
      closeKeyDialog();
      return;
    }

    setAppState((state) => ({
      ...state,
      regions: state.regions.filter((region) => region.id !== selectedRegionId),
    }));
    setSelectedRegionId(undefined);
    closeKeyDialog();
  }

  function connectRegion(regionId: string, item: TranslationItem, options?: { closeDialog?: boolean }) {
    const region = activeRegions.find((candidate) => candidate.id === regionId);

    updateRegion(regionId, {
      translationItemId: item.id,
      translationOverrides: undefined,
      visibleText: region?.visibleText || item.kr || item.en || item.key,
      status: region?.status === "unlinked" ? "linked" : region?.status,
    });
    setEditingCell(null);
    setTranslationQuery("");
    if (options?.closeDialog) {
      closeKeyDialog();
    }
  }

  function connectSelectedRegion(item: TranslationItem, options?: { closeDialog?: boolean }) {
    if (!selectedRegionId) return;
    connectRegion(selectedRegionId, item, options);
  }

  function unlinkSelectedRegion() {
    updateSelectedRegion({ translationItemId: undefined, translationOverrides: undefined, status: "unlinked" });
    setEditingCell(null);
  }

  function getCellValue(region: TextRegion, item: TranslationItem | undefined, languageCode: LanguageCode) {
    const hasOverride = Object.prototype.hasOwnProperty.call(region.translationOverrides ?? {}, languageCode);

    return {
      baseValue: item?.[languageCode] ?? "",
      displayValue: hasOverride ? (region.translationOverrides?.[languageCode] ?? "") : (item?.[languageCode] ?? ""),
      hasOverride,
    };
  }

  function beginCellEdit(region: TextRegion, item: TranslationItem | undefined, languageCode: LanguageCode) {
    if (mode !== "add") return;
    const { displayValue } = getCellValue(region, item, languageCode);
    setSelectedRegionId(region.id);
    setEditingCell({ regionId: region.id, languageCode });
    setEditingCellValue(displayValue);
  }

  function commitCellEdit() {
    if (!editingCell) return;

    const region = activeRegions.find((candidate) => candidate.id === editingCell.regionId);
    const item = region?.translationItemId ? translationsById.get(region.translationItemId) : undefined;
    const baseValue = item?.[editingCell.languageCode] ?? "";
    const currentOverrides = region?.translationOverrides ?? {};
    const nextOverrides = { ...currentOverrides };

    if (editingCellValue === baseValue) {
      delete nextOverrides[editingCell.languageCode];
    } else {
      nextOverrides[editingCell.languageCode] = editingCellValue;
    }

    updateRegion(editingCell.regionId, {
      translationOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
    });
    setEditingCell(null);
  }

  function cancelCellEdit() {
    setEditingCell(null);
    setEditingCellValue("");
  }

  function toPointFromReactEvent(event: React.PointerEvent<HTMLElement>) {
    if (!editableImage) return null;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * editableImage.imageWidth, 0, editableImage.imageWidth),
      y: clamp(((event.clientY - rect.top) / rect.height) * editableImage.imageHeight, 0, editableImage.imageHeight),
    };
  }

  function startDrawing(event: React.PointerEvent<HTMLDivElement>) {
    if (!editableImage || !isEditing) return;
    const point = toPointFromReactEvent(event);
    if (!point) return;

    setInteraction({ mode: "draw", startX: point.x, startY: point.y });
    setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function startMoving(event: React.PointerEvent<HTMLButtonElement>, region: TextRegion) {
    if (!isEditing) return;
    event.stopPropagation();
    const point = toPointFromReactEvent(event);
    if (!point) return;

    setSelectedRegionId(region.id);
    setInteraction({
      mode: "move",
      regionId: region.id,
      startX: point.x,
      startY: point.y,
      initial: { x: region.x, y: region.y, width: region.width, height: region.height },
    });
  }

  function startResizing(event: React.PointerEvent<HTMLSpanElement>, region: TextRegion) {
    if (!isEditing) return;
    event.stopPropagation();
    const point = toPointFromReactEvent(event);
    if (!point) return;

    setSelectedRegionId(region.id);
    setInteraction({
      mode: "resize",
      regionId: region.id,
      startX: point.x,
      startY: point.y,
      initial: { x: region.x, y: region.y, width: region.width, height: region.height },
    });
  }

  function renderScreenImage() {
    if (!currentScreen) {
      return (
        <div className="empty-stage">
          <strong>등록된 화면이 없습니다.</strong>
          <span>화면 추가 버튼으로 첫 화면을 등록하세요.</span>
          <button type="button" className="button primary" onClick={() => openAddMode()}>
            화면 추가
          </button>
        </div>
      );
    }

    return (
      <div className="image-frame" style={{ width: isEditing ? "100%" : `${(360 * imageZoom) / 100}px` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={currentScreen.imageUrl} alt={currentScreen.name} />
        <div ref={overlayRef} className="region-layer" onPointerDown={startDrawing}>
          {regionsForScreen.map((region) => {
            const linked = Boolean(region.translationItemId);
            const selected = region.id === selectedRegionId;

            return (
              <button
                type="button"
                key={region.id}
                data-region-selection-scope="true"
                className={`region-box ${selected ? "selected" : ""} ${linked ? "linked" : "unlinked"} ${
                  isEditing ? "editable" : "readonly"
                }`}
                style={{
                  left: `${(region.x / currentScreen.imageWidth) * 100}%`,
                  top: `${(region.y / currentScreen.imageHeight) * 100}%`,
                  width: `${(region.width / currentScreen.imageWidth) * 100}%`,
                  height: `${(region.height / currentScreen.imageHeight) * 100}%`,
                }}
                onPointerDown={(event) => startMoving(event, region)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isEditing) {
                    openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
                    return;
                  }
                  setSelectedRegionId(region.id);
                }}
                aria-label={region.visibleText || "텍스트 영역"}
                title={region.visibleText || "텍스트 영역"}
              >
                {isEditing ? <i onPointerDown={(event) => startResizing(event, region)} aria-hidden="true" /> : null}
              </button>
            );
          })}
          {draftRect ? (
            <div
              className="region-draft"
              style={{
                left: `${(draftRect.x / currentScreen.imageWidth) * 100}%`,
                top: `${(draftRect.y / currentScreen.imageHeight) * 100}%`,
                width: `${(draftRect.width / currentScreen.imageWidth) * 100}%`,
                height: `${(draftRect.height / currentScreen.imageHeight) * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  function renderAddScreenPreview() {
    if (!imageDraft) {
      return (
        <div className="empty-stage">
          <strong>새 화면 이미지가 없습니다.</strong>
          <span>왼쪽 패널에서 화면 이미지를 업로드하세요.</span>
        </div>
      );
    }

    return (
      <div className="image-frame add-image-frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageDraft.imageUrl} alt={screenForm.name || imageDraft.fileName} />
        <div ref={overlayRef} className="region-layer" onPointerDown={startDrawing}>
          {draftRegions.map((region) => {
            const linked = Boolean(region.translationItemId);
            const selected = region.id === selectedRegionId;

            return (
              <button
                type="button"
                key={region.id}
                data-region-selection-scope="true"
                className={`region-box ${selected ? "selected" : ""} ${linked ? "linked" : "unlinked"} editable`}
                style={{
                  left: `${(region.x / imageDraft.imageWidth) * 100}%`,
                  top: `${(region.y / imageDraft.imageHeight) * 100}%`,
                  width: `${(region.width / imageDraft.imageWidth) * 100}%`,
                  height: `${(region.height / imageDraft.imageHeight) * 100}%`,
                }}
                onPointerDown={(event) => startMoving(event, region)}
                onClick={(event) => {
                  event.stopPropagation();
                  openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
                }}
                aria-label={region.visibleText || "텍스트 영역"}
                title={region.visibleText || "텍스트 영역"}
              >
                <i onPointerDown={(event) => startResizing(event, region)} aria-hidden="true" />
              </button>
            );
          })}
          {draftRect ? (
            <div
              className="region-draft"
              style={{
                left: `${(draftRect.x / imageDraft.imageWidth) * 100}%`,
                top: `${(draftRect.y / imageDraft.imageHeight) * 100}%`,
                width: `${(draftRect.width / imageDraft.imageWidth) * 100}%`,
                height: `${(draftRect.height / imageDraft.imageHeight) * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  function renderTranslationTable() {
    return (
      <div className="translation-table-wrap">
        {filteredRegions.length > 0 ? (
          <table className="translation-matrix">
            <thead>
              <tr>
                {LANGUAGE_DEFS.map((language) => (
                  <th key={language.code}>{language.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRegions.map((region) => {
                const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
                const selected = region.id === selectedRegionId;

                return (
                  <tr
                    key={region.id}
                    data-region-selection-scope="true"
                    ref={(element) => {
                      itemRefs.current[region.id] = element;
                    }}
                    className={selected ? "selected" : ""}
                    onClick={() => setSelectedRegionId(region.id)}
                  >
                    {LANGUAGE_DEFS.map((language) => {
                      const { displayValue, hasOverride } = getCellValue(region, item, language.code);
                      const isCellEditing =
                        editingCell?.regionId === region.id && editingCell.languageCode === language.code;

                      return (
                        <td
                          key={language.code}
                          className={`${!displayValue ? "missing" : ""} ${hasOverride ? "modified" : ""} ${
                            isCellEditing ? "editing" : ""
                          }`}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            beginCellEdit(region, item, language.code);
                          }}
                        >
                          {isCellEditing ? (
                            <textarea
                              autoFocus
                              className="translation-cell-editor"
                              value={editingCellValue}
                              onChange={(event) => setEditingCellValue(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onBlur={commitCellEdit}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelCellEdit();
                                  return;
                                }

                                if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  commitCellEdit();
                                }
                              }}
                            />
                          ) : (
                            <>
                              <span className="translation-cell-value">{displayValue || "미연결"}</span>
                              {hasOverride ? <span className="translation-modified-tag">수정됨</span> : null}
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {filteredRegions.length === 0 ? (
          <div className="empty-list">이 조건에 맞는 텍스트 영역이 없습니다.</div>
        ) : null}
      </div>
    );
  }

  function renderKeyDialog() {
    if (!keyDialogRegionId || !keyDialogAnchor) return null;

    const dialogRegion = activeRegions.find((region) => region.id === keyDialogRegionId);
    if (!dialogRegion) return null;

    const linkedItem = dialogRegion.translationItemId
      ? translationsById.get(dialogRegion.translationItemId)
      : undefined;
    const pendingItem = pendingTranslationItemId ? translationsById.get(pendingTranslationItemId) : undefined;

    return (
      <section
        className="key-dialog"
        data-region-selection-scope="true"
        role="dialog"
        aria-modal="false"
        aria-labelledby="key-dialog-title"
        style={
          {
            "--dialog-x": `${keyDialogAnchor.x}px`,
            "--dialog-y": `${keyDialogAnchor.y}px`,
          } as React.CSSProperties
        }
      >
        <div className="key-dialog-head">
          <h2 id="key-dialog-title">번역 Key 연결</h2>
        </div>

        <label className="key-dialog-search">
          <span aria-hidden="true" />
          <input
            autoFocus
            value={translationQuery}
            onChange={(event) => setTranslationQuery(event.target.value)}
            placeholder="플레이스홀더"
          />
        </label>

        <div className="dialog-results">
          {searchResults.map((item) => {
            const source = sourceById.get(item.sourceId);
            const duplicate = isDuplicateCandidate(item, searchableTranslations);

            return (
              <button
                type="button"
                key={item.id}
                className={`key-result-row ${item.id === pendingTranslationItemId ? "selected" : ""}`}
                onClick={() => setPendingTranslationItemId(item.id)}
              >
                <span>{item.key}</span>
                <strong>{item.kr || item.en || "번역 없음"}</strong>
                <em>
                  {source?.fileName ?? "알 수 없는 소스"}
                  {duplicate ? " · 중복 후보" : ""}
                </em>
              </button>
            );
          })}
          {searchResults.length === 0 ? <div className="empty-list">검색 결과가 없습니다.</div> : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-cta secondary" onClick={closeKeyDialog}>
            취소
          </button>
          <button
            type="button"
            className="dialog-cta primary"
            disabled={!pendingItem && !linkedItem}
            onClick={() => {
              const item = pendingItem ?? linkedItem;
              if (!item) return;
              connectRegion(dialogRegion.id, item, { closeDialog: true });
            }}
          >
            연결
          </button>
        </div>
      </section>
    );
  }

  function renderViewSidebar() {
    return (
      <aside className="view-menu">
        <div className="view-menu-head">
          <button type="button" className="add-screen-link" onClick={addGroup}>
            <span aria-hidden="true">+</span>
            그룹 추가
          </button>
        </div>

        <div className="screen-list">
          {groupedScreens.map(([group, screens]) => {
            const expanded = openGroups[group] ?? true;

            return (
              <section className="screen-group" key={group}>
                <div className="screen-group-head">
                  {editingGroup?.originalName === group ? (
                    <input
                      autoFocus
                      className="screen-group-input"
                      value={editingGroup.value}
                      onChange={(event) => setEditingGroup((current) => current ? { ...current, value: event.target.value } : current)}
                      onBlur={commitGroupEdit}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingGroup(null);
                          return;
                        }

                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitGroupEdit();
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="screen-group-toggle"
                      onClick={() => setOpenGroups((groups) => ({ ...groups, [group]: !expanded }))}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setDeleteTarget({ type: "group", name: group });
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        beginGroupEdit(group);
                      }}
                      aria-expanded={expanded}
                    >
                      <span aria-hidden="true" />
                      {group}
                    </button>
                  )}
                  <button
                    type="button"
                    className="screen-group-add"
                    onClick={() => openAddMode(group)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setDeleteTarget({ type: "group", name: group });
                    }}
                    aria-label={`${group} 그룹에 화면 추가`}
                  >
                    +
                  </button>
                </div>

                {expanded ? (
                  <div className="screen-group-items">
                    {screens.map((screen) => {
                      const active = screen.id === appState.activeScreenId;

                      return (
                        <button
                          type="button"
                          key={screen.id}
                          className={`screen-list-item ${active ? "active" : ""}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setDeleteTarget({ type: "screen", screenId: screen.id, name: screen.name });
                          }}
                          onClick={() => {
                            setAppState((state) => ({ ...state, activeScreenId: screen.id }));
                            setSelectedRegionId(undefined);
                          }}
                        >
                          <strong>{screen.name}</strong>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
          {appState.screens.length === 0 ? (
            <div className="screen-list-empty">추가된 화면이 없습니다.</div>
          ) : null}
        </div>
      </aside>
    );
  }

  function renderTranslationSourceDialog() {
    if (!sourceDialogOpen) return null;

    return (
      <div className="source-modal-backdrop" role="presentation" onClick={() => setSourceDialogOpen(false)}>
        <section
          className="source-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="source-modal-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="source-modal-head">
            <h2 id="source-modal-title">번역 데이터 관리</h2>
            <button
              type="button"
              className="source-upload-button"
              onClick={() => translationFileInputRef.current?.click()}
              disabled={isParsing}
            >
              업로드
            </button>
          </div>

          <input
            ref={translationFileInputRef}
            hidden
            type="file"
            accept=".html,text/html,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => handleTranslationFileUpload(event.target.files?.[0])}
          />

          <div className="source-list">
            {translationSources.map((source) => {
              const sourceId = getSourceId(source);

              return (
                <div className={`source-row ${source.enabled === false ? "disabled" : ""}`} key={sourceId}>
                  <button
                    type="button"
                    className="source-main"
                    onClick={() => toggleTranslationSource(sourceId)}
                    title={source.enabled === false ? "비활성화됨" : "활성화됨"}
                  >
                    <span className="source-chip">{source.fileType}</span>
                    <span className="source-name">{formatSourceName(source.fileName)}</span>
                    <span className="source-meta-small">
                      {getSourceItemCount(source).toLocaleString()}개 · {getSourceImportedAt(source).slice(0, 10)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="source-delete"
                    onClick={() => deleteTranslationSource(sourceId)}
                    aria-label={`${source.fileName} 삭제`}
                  >
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <path
                        d="M7 21C6.45 21 5.97933 20.8043 5.588 20.413C5.19667 20.0217 5.00067 19.5507 5 19V6H4V4H9V3H15V4H20V6H19V19C19 19.55 18.8043 20.021 18.413 20.413C18.0217 20.805 17.5507 21.0007 17 21H7ZM9 17H11V8H9V17ZM13 17H15V8H13V17Z"
                        fill="#D5DAE1"
                      />
                    </svg>
                  </button>
                </div>
              );
            })}
            {translationSources.length === 0 ? (
              <div className="source-empty">등록된 번역 데이터가 없습니다.</div>
            ) : null}
          </div>

          <button type="button" className="source-confirm-button" onClick={() => setSourceDialogOpen(false)}>
            확인
          </button>
        </section>
      </div>
    );
  }

  function renderDeleteConfirmDialog() {
    if (!deleteTarget) return null;

    return (
      <div className="confirm-modal-backdrop" role="presentation" onClick={() => setDeleteTarget(null)}>
        <section
          className="confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="delete-confirm-title">삭제하시겠습니까?</h2>
          <p>
            {deleteTarget.type === "group"
              ? `${deleteTarget.name} 그룹과 그룹 안의 화면이 삭제됩니다.`
              : `${deleteTarget.name} 화면이 삭제됩니다.`}
          </p>
          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={() => setDeleteTarget(null)}>
              취소
            </button>
            <button type="button" className="confirm-delete" onClick={confirmDeleteTarget}>
              삭제
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderAddMode() {
    const isEditMode = mode === "edit";
    const hasScreenImage = Boolean(imageDraft || (isEditMode && currentScreen));
    const hasRegions = filteredRegions.length > 0;

    return (
      <section className="add-workspace">
        <input
          ref={imageFileInputRef}
          hidden
          type="file"
          accept="image/*"
          onChange={(event) => handleImageDraft(event.target.files?.[0])}
        />

        <div className="add-mode-title">
          <button type="button" className="add-back-button" onClick={closeEditMode} aria-label="뒤로가기">
            <BackArrowIcon />
          </button>
          <h1>{isEditMode ? "화면 수정" : "화면 추가"}</h1>
        </div>

        <section className={`add-screen-pane ${hasScreenImage ? "has-image" : ""}`}>
          {imageDraft ? (
            renderAddScreenPreview()
          ) : isEditMode && currentScreen ? (
            renderScreenImage()
          ) : (
            <div className="add-upload-empty">
              <p>
                텍스트 영역을 지정할 화면을
                <br />
                업로드해주세요.
              </p>
              <button type="button" onClick={() => imageFileInputRef.current?.click()}>
                업로드
              </button>
            </div>
          )}
        </section>

        <section className="add-detail-pane">
          <div className="add-form-bar">
            <label className="add-field">
              <span>화면명</span>
              <div className="add-input-shell">
                <input
                  value={screenForm.name}
                  onChange={(event) => setScreenForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="GNB, Subscription 등"
                />
                {screenForm.name ? (
                  <button
                    type="button"
                    className="add-input-clear"
                    onClick={() => setScreenForm((form) => ({ ...form, name: "" }))}
                    aria-label="화면명 지우기"
                  >
                    <ClearFieldIcon />
                  </button>
                ) : null}
              </div>
            </label>

            <label className="add-field add-field-memo">
              <span>메모</span>
              <div className="add-input-shell">
                <input
                  value={screenForm.memo}
                  onChange={(event) => setScreenForm((form) => ({ ...form, memo: event.target.value }))}
                  placeholder="메모 입력"
                />
                {screenForm.memo ? (
                  <button
                    type="button"
                    className="add-input-clear"
                    onClick={() => setScreenForm((form) => ({ ...form, memo: "" }))}
                    aria-label="메모 지우기"
                  >
                    <ClearFieldIcon />
                  </button>
                ) : null}
              </div>
            </label>

            <button type="button" className="add-save-button" onClick={saveScreen} disabled={!isEditMode && !imageDraft}>
              저장
            </button>
          </div>

          <div className="add-main-content">
            <h2 className="add-results-title">연결 결과</h2>
            {hasScreenImage ? (
              hasRegions ? (
                renderTranslationTable()
              ) : (
                <div className="add-empty-copy">
                  <strong>연결한 텍스트가 없어요</strong>
                  <span>
                    화면을 업로드하고
                    <br />
                    텍스트 영역 지정 후
                    <br />
                    키를 연결하면 보여요.
                  </span>
                </div>
              )
            ) : (
              <div className="add-empty-copy">
                <strong>연결한 텍스트가 없어요</strong>
                <span>
                  화면을 업로드하고
                  <br />
                  텍스트 영역 지정 후
                  <br />
                  키를 연결하면 보여요.
                </span>
              </div>
            )}
          </div>
        </section>
      </section>
    );
  }

  return (
    <main className="app-shell" onPointerDownCapture={handleShellPointerDown}>
      {mode === "view" ? (
        <header className="topbar">
          <div className="brand-block">
            <h1>TG 다국어 위키</h1>
          </div>
          <button type="button" className="translation-source-button" onClick={() => setSourceDialogOpen(true)}>
            번역 데이터 관리
          </button>
        </header>
      ) : null}

      {mode === "view" ? (
        <section className="view-workspace">
          {currentScreen ? (
            <>
              {renderViewSidebar()}

              <section className="canvas-panel">
                <div className="view-zoom-controls" aria-label="화면 확대 축소">
                  <button
                    type="button"
                    onClick={() => setImageZoom((zoom) => clamp(zoom - 10, 50, 220))}
                    title="줌아웃"
                  >
                    -
                  </button>
                  <span>{imageZoom}%</span>
                  <button
                    type="button"
                    onClick={() => setImageZoom((zoom) => clamp(zoom + 10, 50, 220))}
                    title="줌인"
                  >
                    +
                  </button>
                </div>
                <div className="image-stage">{renderScreenImage()}</div>
              </section>

              <aside className="translation-panel">
                <div className="panel-title">
                  <div>
                    <h2>{currentScreen.name}</h2>
                    <p>
                      {[getScreenGroup(currentScreen), `${filteredRegions.length}개 텍스트 영역`, currentScreen.memo]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <button type="button" className="edit-title-button" onClick={openEditMode}>
                    편집
                  </button>
                </div>
                {renderTranslationTable()}
              </aside>
            </>
          ) : (
            <>
              {renderViewSidebar()}
              <section className="empty-view">
                <strong>등록된 화면이 없습니다.</strong>
                <span>첫 화면을 추가하면 이후 앱 진입 시 조회 화면이 먼저 표시됩니다.</span>
                <button type="button" className="button primary" onClick={() => openAddMode()}>
                  화면 추가
                </button>
              </section>
            </>
          )}
        </section>
      ) : mode === "add" || mode === "edit" ? (
        renderAddMode()
      ) : (
        <section className="edit-workspace">
          <aside className="edit-panel">
            <section className="panel-section">
              <div className="panel-title compact">
                <div>
                  <h2>화면 수정</h2>
                  <p>등록과 편집 작업은 이 모드에서만 수행합니다.</p>
                </div>
                <button type="button" className="button secondary" onClick={closeEditMode}>
                  조회로 돌아가기
                </button>
              </div>
              <label>
                화면명
                <input
                  value={screenForm.name}
                  onChange={(event) => setScreenForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="예: 결제 페이지 - 모바일"
                />
              </label>
              <div className="form-grid">
                <label>
                  그룹
                  <select
                    value={screenForm.group}
                    onChange={(event) => setScreenForm((form) => ({ ...form, group: event.target.value }))}
                  >
                    {SCREEN_GROUPS.map((group) => (
                      <option key={group} value={group}>
                        {group}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  플랫폼
                  <select
                    value={screenForm.platform}
                    onChange={(event) =>
                      setScreenForm((form) => ({ ...form, platform: event.target.value as Screen["platform"] }))
                    }
                  >
                    <option value="mobile_web">mobile_web</option>
                    <option value="pc_web">pc_web</option>
                    <option value="app">app</option>
                    <option value="common">common</option>
                  </select>
                </label>
              </div>
              <label>
                Figma URL
                <input
                  value={screenForm.figmaUrl}
                  onChange={(event) => setScreenForm((form) => ({ ...form, figmaUrl: event.target.value }))}
                  placeholder="https://figma.com/..."
                />
              </label>
              <label>
                화면 메모
                <textarea
                  rows={3}
                  value={screenForm.memo}
                  onChange={(event) => setScreenForm((form) => ({ ...form, memo: event.target.value }))}
                />
              </label>
              <label className="upload-box">
                화면 이미지 업로드
                <input type="file" accept="image/*" onChange={(event) => handleImageDraft(event.target.files?.[0])} />
              </label>
              <button
                type="button"
                className="button primary"
                onClick={saveScreen}
              >
                수정 저장
              </button>
            </section>

            <section className="panel-section">
              <h2>번역 데이터</h2>
              <div className="data-row">
                <button type="button" className="button secondary" onClick={loadLocalHtml} disabled={isParsing}>
                  로컬 HTML 불러오기
                </button>
                <label className="button secondary">
                  파일 업로드
                  <input
                    hidden
                    type="file"
                    accept=".html,text/html,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(event) => handleTranslationFileUpload(event.target.files?.[0])}
                  />
                </label>
              </div>
              <p className="muted">
                {parseMessage ||
                  (translationSources.length > 0
                    ? `${translationSources.length.toLocaleString()}개 파일 · ${translations.length.toLocaleString()}개`
                    : "아직 번역 데이터가 로드되지 않았습니다.")}
              </p>
            </section>

            <section className="panel-section">
              <div className="panel-title compact">
                <div>
                  <h2>텍스트 영역 편집</h2>
                  <p>이미지 위에서 바로 드래그해 영역을 만들고, 선택 영역을 수정합니다.</p>
                </div>
              </div>
              {selectedRegion ? (
                <div className="region-editor">
                  <label>
                    화면 표시 문구
                    <textarea
                      rows={3}
                      value={selectedRegion.visibleText}
                      onChange={(event) => updateSelectedRegion({ visibleText: event.target.value })}
                    />
                  </label>
                  <label>
                    연결 상태
                    <select
                      value={selectedRegion.status}
                      onChange={(event) =>
                        updateSelectedRegion({ status: event.target.value as TextRegionStatus })
                      }
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    메모
                    <textarea
                      rows={4}
                      value={selectedRegion.memo}
                      onChange={(event) => updateSelectedRegion({ memo: event.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <button type="button" className="button secondary" onClick={unlinkSelectedRegion}>
                      연결 해제
                    </button>
                    <button type="button" className="button danger" onClick={deleteSelectedRegion}>
                      영역 삭제
                    </button>
                  </div>
                </div>
              ) : (
                <p className="muted">편집할 텍스트 영역을 선택하세요.</p>
              )}
            </section>
          </aside>

          <section className="canvas-panel">
            <div className="canvas-toolbar">
              <div>
                <h2>{currentScreen?.name ?? "화면 이미지"}</h2>
                <p>이미지 위 빈 영역을 드래그해 새 영역을 만들고, 기존 영역을 선택해 수정합니다.</p>
              </div>
            </div>
            <div className={`image-stage ${isEditing && editableImage ? "is-drawing" : ""}`}>
              {currentScreen ? (
                renderScreenImage()
              ) : (
                <div className="empty-stage">화면을 먼저 저장하세요.</div>
              )}
            </div>
          </section>

          <aside className="edit-panel">
            <section className="panel-section">
              <h2>번역 key 연결</h2>
              <input
                value={translationQuery}
                onChange={(event) => setTranslationQuery(event.target.value)}
                placeholder="key, KR, EN 또는 다른 언어로 검색"
              />
              <div className="search-results">
                {searchResults.map((item) => {
                  const source = sourceById.get(item.sourceId);
                  const duplicate = isDuplicateCandidate(item, searchableTranslations);

                  return (
                    <button
                      type="button"
                      key={item.id}
                      className="result-row"
                      disabled={!selectedRegion}
                      onClick={() => connectSelectedRegion(item)}
                    >
                      <strong>{item.key}</strong>
                      <span>{item.kr || item.en || "번역 없음"}</span>
                      <em>
                        {source?.fileName ?? "알 수 없는 소스"}
                        {duplicate ? " · 중복 후보" : ""}
                      </em>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="panel-section grow">
              <div className="panel-title compact">
                <div>
                  <h2>연결 결과</h2>
                  <p>선택한 화면 기준 다국어 번역입니다.</p>
                </div>
              </div>
              {renderTranslationTable()}
            </section>
          </aside>
        </section>
      )}
      {renderKeyDialog()}
      {renderTranslationSourceDialog()}
      {renderDeleteConfirmDialog()}
    </main>
  );
}
