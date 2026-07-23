"use client";

import { startTransition, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
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
  searchTranslationCandidates,
  searchTranslationItems,
} from "@/lib/translation-parser";
import {
  getInitialAppState,
  loadPersistedData,
  savePersistedData,
  type PersistedDataSource,
  type SupabaseLoadStatus,
} from "@/lib/storage";
import { uploadScreenImage } from "@/lib/supabase-storage";

type ImageRect = Pick<TextRegion, "x" | "y" | "width" | "height">;
type AppMode = "view" | "add" | "edit";
type MoveAxis = "x" | "y";
type ResizeEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean };

type Interaction =
  | { mode: "draw"; startX: number; startY: number; beforeRegions: TextRegion[] }
  | {
      mode: "move";
      regionId: string;
      startX: number;
      startY: number;
      initial: ImageRect;
      beforeRegions: TextRegion[];
      duplicatedRegion?: TextRegion;
      constrainAxis?: boolean;
    }
  | {
      mode: "resize";
      regionId: string;
      startX: number;
      startY: number;
      initial: ImageRect;
      beforeRegions: TextRegion[];
      edges: ResizeEdges;
    };

type RegionHistory = {
  scope: string;
  undo: TextRegion[][];
  redo: TextRegion[][];
};

type RowContextMenu = {
  regionId: string;
  x: number;
  y: number;
};

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
  file?: File;
  imageWidth: number;
  imageHeight: number;
  imageContentWidth: number;
  imageContentHeight: number;
  fileName: string;
};

const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const TRANSLATION_MAX_BYTES = 30 * 1024 * 1024;
const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif";
const TRANSLATION_ACCEPT =
  ".html,.htm,text/html,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ALLOWED_TRANSLATION_EXTENSIONS = new Set(["html", "htm", "csv", "xlsx"]);

function SupabaseLoadingLogo() {
  return (
    <svg
      className="supabase-loading-logo"
      width="27"
      height="28"
      viewBox="0 0 27 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g clipPath="url(#supabase-loading-clip)">
        <path
          d="M15.7859 27.3267C15.0774 28.219 13.6407 27.7301 13.6237 26.5908L13.374 9.92676H24.5789C26.6084 9.92676 27.7403 12.2709 26.4783 13.8603L15.7859 27.3267Z"
          fill="url(#supabase-loading-gradient-primary)"
        />
        <path
          d="M15.7859 27.3267C15.0774 28.219 13.6407 27.7301 13.6237 26.5908L13.374 9.92676H24.5789C26.6084 9.92676 27.7403 12.2709 26.4783 13.8603L15.7859 27.3267Z"
          fill="url(#supabase-loading-gradient-shadow)"
          fillOpacity="0.2"
        />
        <path
          d="M11.2287 0.512605C11.9373 -0.379777 13.374 0.109184 13.391 1.24853L13.5004 17.9125H2.43578C0.406215 17.9125 -0.725711 15.5684 0.536333 13.979L11.2287 0.512605Z"
          fill="#3ECF8E"
        />
      </g>
      <defs>
        <linearGradient
          id="supabase-loading-gradient-primary"
          x1="13.374"
          y1="13.6216"
          x2="23.3325"
          y2="17.7982"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#249361" />
          <stop offset="1" stopColor="#3ECF8E" />
        </linearGradient>
        <linearGradient
          id="supabase-loading-gradient-shadow"
          x1="8.95894"
          y1="7.57657"
          x2="13.5005"
          y2="16.1259"
          gradientUnits="userSpaceOnUse"
        >
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <clipPath id="supabase-loading-clip">
          <rect width="27.0089" height="28" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

type ImageTarget = {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  imageContentWidth?: number;
  imageContentHeight?: number;
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

type MenuDragItem =
  | { type: "group"; group: string }
  | { type: "screen"; screenId: string; group: string };

type MenuDropTarget = MenuDragItem & {
  position: "before" | "after";
};

type GlobalSearchMatch = {
  id: string;
  screen: Screen;
  region: TextRegion;
  item?: TranslationItem;
  fieldLabel: string;
  value: string;
};

type RegionOcrState = {
  status: "idle" | "running" | "success" | "failed";
  confidence?: number;
  error?: string;
};

type PersistenceStatus = {
  phase: "loading" | "ready" | "saving" | "saved" | "warning" | "error";
  message: string;
  recovery?: "save" | "reload";
};

const DRAFT_SCREEN_ID = "__draft_screen__";
const OPEN_GROUPS_STORAGE_KEY = "tg-multilingual-docs:open-groups";

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

function isScreenRegion(region: TextRegion) {
  return region.width > 0 && region.height > 0;
}

function isEditableTextTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function getMovedRect(
  initial: ImageRect,
  startX: number,
  startY: number,
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  moveAxis?: MoveAxis,
): ImageRect {
  let deltaX = x - startX;
  let deltaY = y - startY;

  if (moveAxis === "x") deltaY = 0;
  if (moveAxis === "y") deltaX = 0;

  return {
    ...initial,
    x: clamp(initial.x + deltaX, 0, imageWidth - initial.width),
    y: clamp(initial.y + deltaY, 0, imageHeight - initial.height),
  };
}

function cloneRegions(regions: TextRegion[]) {
  return regions.map((region) => ({
    ...region,
    translationOverrides: region.translationOverrides ? { ...region.translationOverrides } : undefined,
    translationOverrideHistory: region.translationOverrideHistory
      ? Object.fromEntries(
          Object.entries(region.translationOverrideHistory).map(([languageCode, history]) => [
            languageCode,
            history ? [...history] : history,
          ]),
        )
      : undefined,
  }));
}

function scaleRegionsToImageSize(
  regions: TextRegion[],
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
) {
  const displayScale = fromWidth > 0 ? toWidth / fromWidth : 1;

  return cloneRegions(regions).map((region) => {
    if (!isScreenRegion(region)) return region;

    const width = Math.min(Math.max(1, Math.round(region.width * displayScale)), toWidth);
    const height = Math.min(Math.max(1, Math.round(region.height * displayScale)), toHeight);

    return {
      ...region,
      x: clamp(Math.round(region.x * displayScale), 0, Math.max(0, toWidth - width)),
      y: clamp(Math.round(region.y * displayScale), 0, Math.max(0, toHeight - height)),
      width,
      height,
    };
  });
}

function getImageContentSize(image: Pick<ImageTarget, "imageWidth" | "imageHeight" | "imageContentWidth" | "imageContentHeight">) {
  return {
    width: image.imageContentWidth ?? image.imageWidth,
    height: image.imageContentHeight ?? image.imageHeight,
  };
}

function getRenderedImageContentHeight(
  image: Pick<ImageTarget, "imageWidth" | "imageHeight" | "imageContentWidth" | "imageContentHeight">,
) {
  const content = getImageContentSize(image);
  if (content.width <= 0) return image.imageHeight;
  return (image.imageWidth * content.height) / content.width;
}

function getImageLetterboxHeight(
  image: Pick<ImageTarget, "imageWidth" | "imageHeight" | "imageContentWidth" | "imageContentHeight">,
) {
  return Math.max(0, image.imageHeight - getRenderedImageContentHeight(image));
}

function replaceScreenRegions(allRegions: TextRegion[], screenId: string, nextScreenRegions: TextRegion[]) {
  let inserted = false;
  const nextRegions = cloneRegions(nextScreenRegions);
  const mergedRegions = allRegions.flatMap((region) => {
    if (region.screenId !== screenId) return [region];
    if (inserted) return [];
    inserted = true;
    return nextRegions;
  });

  return inserted ? mergedRegions : [...mergedRegions, ...nextRegions];
}

function getOrderedGroupNames(state: AppState) {
  const names: string[] = [];
  const addName = (name: string) => {
    if (names.includes(name)) return;
    names.push(name);
  };

  for (const group of state.groups ?? []) {
    addName(group);
  }

  for (const screen of state.screens) {
    addName(getScreenGroup(screen));
  }

  return names;
}

function moveItemToPosition<T>(
  items: T[],
  sourceIndex: number,
  targetIndex: number,
  position: "before" | "after",
) {
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;

  const item = items[sourceIndex];
  const targetItem = items[targetIndex];
  const nextItems = [...items];
  nextItems.splice(sourceIndex, 1);

  const nextTargetIndex = nextItems.indexOf(targetItem);
  if (nextTargetIndex < 0) return items;

  nextItems.splice(position === "after" ? nextTargetIndex + 1 : nextTargetIndex, 0, item);
  return nextItems;
}

function getMenuDropPosition(event: React.DragEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
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

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function getFileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function getImageValidationError(file: File) {
  const extension = getFileExtension(file.name);
  if (file.size > IMAGE_MAX_BYTES) {
    return `이미지는 최대 ${formatFileSize(IMAGE_MAX_BYTES)}까지 업로드할 수 있습니다.`;
  }
  if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
    return "지원하지 않는 이미지 형식입니다. PNG, JPG, WEBP, GIF만 사용할 수 있습니다.";
  }
  if (extension && !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    return "지원하지 않는 이미지 확장자입니다. PNG, JPG, WEBP, GIF만 사용할 수 있습니다.";
  }
  if (!file.type && !extension) {
    return "이미지 형식을 확인할 수 없습니다. PNG, JPG, WEBP, GIF 파일을 사용해주세요.";
  }
  return undefined;
}

function getTranslationFileValidationError(file: File) {
  const extension = getFileExtension(file.name);
  if (file.size > TRANSLATION_MAX_BYTES) {
    return `번역 파일은 최대 ${formatFileSize(TRANSLATION_MAX_BYTES)}까지 업로드할 수 있습니다.`;
  }
  if (!ALLOWED_TRANSLATION_EXTENSIONS.has(extension)) {
    return "지원하지 않는 번역 파일입니다. HTML, CSV, XLSX 파일만 업로드할 수 있습니다.";
  }
  return undefined;
}

function getClipboardImageFile(event: ClipboardEvent) {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  const file = imageItem?.getAsFile();
  if (!file) return undefined;

  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const fileName = file.name && file.name !== "image.png" ? file.name : `pasted-screen-${Date.now()}.${extension}`;
  return new File([file], fileName, { type: file.type || "image/png" });
}

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("OCR용 이미지를 읽을 수 없습니다."));
    image.src = src;
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

async function cropImageRegion(imageTarget: ImageTarget, region: ImageRect) {
  const image = await loadImageElement(imageTarget.imageUrl);
  const content = getImageContentSize(imageTarget);
  const scale = 2;
  const sourceX = Math.max(0, Math.round(region.x));
  const sourceY = Math.max(0, Math.round(region.y));
  if (sourceX >= content.width || sourceY >= content.height) {
    throw new Error("OCR 대상 영역이 현재 이미지 밖에 있습니다.");
  }

  const sourceWidth = Math.max(1, Math.min(Math.round(region.width), content.width - sourceX));
  const sourceHeight = Math.max(1, Math.min(Math.round(region.height), content.height - sourceY));
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth * scale;
  canvas.height = sourceHeight * scale;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("OCR crop 캔버스를 생성할 수 없습니다.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas.toDataURL("image/png");
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

function screenFormsEqual(left: ScreenForm, right: ScreenForm) {
  return (
    left.name === right.name &&
    left.group === right.group &&
    left.platform === right.platform &&
    left.baseLanguage === right.baseLanguage &&
    left.figmaUrl === right.figmaUrl &&
    left.memo === right.memo
  );
}

function regionsEqual(left: TextRegion[], right: TextRegion[]) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function getImportedAtTimestamp(source: TranslationSource | undefined, item?: TranslationItem) {
  const sourceTimestamp = source ? Date.parse(getSourceImportedAt(source)) : Number.NaN;
  if (Number.isFinite(sourceTimestamp)) return sourceTimestamp;

  const itemTimestamp = item ? Date.parse(item.createdAt) : Number.NaN;
  return Number.isFinite(itemTimestamp) ? itemTimestamp : 0;
}

function formatImportedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || "-";

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
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

function loadStoredOpenGroups() {
  if (typeof window === "undefined") return {};

  try {
    const rawValue = window.localStorage.getItem(OPEN_GROUPS_STORAGE_KEY);
    if (!rawValue) return {};

    const parsedValue: unknown = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) return {};

    return Object.fromEntries(
      Object.entries(parsedValue).filter((entry): entry is [string, boolean] => {
        const [group, expanded] = entry;
        return typeof group === "string" && typeof expanded === "boolean";
      }),
    );
  } catch (error) {
    console.warn("[ui] Failed to load stored group open states.", error);
    return {};
  }
}

function saveStoredOpenGroups(openGroups: Record<string, boolean>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(OPEN_GROUPS_STORAGE_KEY, JSON.stringify(openGroups));
  } catch (error) {
    console.warn("[ui] Failed to save group open states.", error);
  }
}

function BackArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M19 12H5M11 6L5 12L11 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function SelectChevronIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MultilingualTextMap() {
  const [appState, setAppState] = useState<AppState>(getInitialAppState);
  const [selectedScreenId, setSelectedScreenId] = useState<string>();
  const [translations, setTranslations] = useState<TranslationItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseMessage, setParseMessage] = useState("");
  const [mode, setMode] = useState<AppMode>("view");
  const [screenForm, setScreenForm] = useState<ScreenForm>(defaultScreenForm);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const [draftRegions, setDraftRegions] = useState<TextRegion[]>([]);
  const [editDraftRegions, setEditDraftRegions] = useState<TextRegion[] | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string>();
  const [keyDialogRegionId, setKeyDialogRegionId] = useState<string>();
  const [keyDialogAnchor, setKeyDialogAnchor] = useState<DialogAnchor>();
  const [pendingTranslationItemId, setPendingTranslationItemId] = useState<string>();
  const [translationQuery, setTranslationQuery] = useState("");
  const [viewSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TextRegionStatus>("all");
  const [draftRect, setDraftRect] = useState<ImageRect | null>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingCellValue, setEditingCellValue] = useState("");
  const [draggedRegionId, setDraggedRegionId] = useState<string>();
  const [dragOverRegionId, setDragOverRegionId] = useState<string>();
  const [draggedMenuItem, setDraggedMenuItem] = useState<MenuDragItem | null>(null);
  const [menuDropTarget, setMenuDropTarget] = useState<MenuDropTarget | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [editingGroup, setEditingGroup] = useState<EditingGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [regionDeleteTargetId, setRegionDeleteTargetId] = useState<string>();
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [disabledSourcesOpen, setDisabledSourcesOpen] = useState(false);
  const [saveConflictOpen, setSaveConflictOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [pendingGlobalFocusRegionId, setPendingGlobalFocusRegionId] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState<{ id: number; message: string }>();
  const [copiedRowValues, setCopiedRowValues] = useState<string[] | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<RowContextMenu | null>(null);
  const [updateCandidateRegionId, setUpdateCandidateRegionId] = useState<string>();
  const [ocrByRegion, setOcrByRegion] = useState<Record<string, RegionOcrState>>({});
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>({
    phase: "loading",
    message: "데이터 불러오는 중",
  });
  const [persistenceRetryVersion, setPersistenceRetryVersion] = useState(0);

  const overlayRef = useRef<HTMLDivElement>(null);
  const imageViewportRef = useRef<HTMLElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const translationFileInputRef = useRef<HTMLInputElement>(null);
  const globalSearchRef = useRef<HTMLDivElement>(null);
  const translationTableWrapRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const defaultDataLoadAttempted = useRef(false);
  const skipNextSupabaseSaveRef = useRef(true);
  const persistedDataSourceRef = useRef<PersistedDataSource>("empty");
  const supabaseLoadStatusRef = useRef<SupabaseLoadStatus>("unconfigured");
  const supabaseSnapshotUpdatedAtRef = useRef<string | undefined>(undefined);
  const persistenceRevisionRef = useRef(0);
  const saveBlockedByConflictRef = useRef(false);
  const showNextSaveFeedbackRef = useRef(false);
  const suppressedRegionClickRef = useRef<string | undefined>(undefined);
  const regionHistoryRef = useRef<RegionHistory>({ scope: "", undo: [], redo: [] });
  const interactionHistoryRecordedRef = useRef(false);
  const duplicateMoveAxisRef = useRef<MoveAxis | undefined>(undefined);
  const rowKeyDialogTimerRef = useRef<number | undefined>(undefined);
  const editorHistoryEntryActiveRef = useRef(false);
  const allowEditorHistoryPopRef = useRef(false);
  const initialScreenFormRef = useRef<ScreenForm>(defaultScreenForm);
  const initialEditRegionsRef = useRef<TextRegion[]>([]);
  const openGroupsLoadedRef = useRef(false);
  const skipNextOpenGroupsSaveRef = useRef(true);
  const immediateSelectedRegionIdRef = useRef<string | undefined>(undefined);

  const translationSources = appState.sources ?? (appState.source ? [appState.source] : []);
  const enabledSourceIds = useMemo(
    () => new Set(translationSources.filter((source) => source.enabled !== false).map(getSourceId)),
    [translationSources],
  );
  const sourceById = useMemo(() => {
    return new Map(translationSources.map((source) => [getSourceId(source), source]));
  }, [translationSources]);
  const sourceDuplicateCountById = useMemo(() => {
    const counts = new Map<string, number>();

    for (const source of translationSources) {
      const sourceId = getSourceId(source);
      if (!sourceId) continue;
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }

    return counts;
  }, [translationSources]);
  const searchableTranslations = useMemo(
    () => translations.filter((item) => enabledSourceIds.has(item.sourceId)),
    [enabledSourceIds, translations],
  );
  const currentScreen = appState.screens.find((screen) => screen.id === selectedScreenId);
  const screenById = useMemo(() => {
    return new Map(appState.screens.map((screen) => [screen.id, screen]));
  }, [appState.screens]);
  const groupedScreens = useMemo(() => {
    const groups = new Map<string, Screen[]>();

    for (const group of appState.groups ?? []) {
      groups.set(group, []);
    }

    for (const screen of appState.screens) {
      const group = getScreenGroup(screen);
      groups.set(group, [...(groups.get(group) ?? []), screen]);
    }

    return Array.from(groups.entries());
  }, [appState.groups, appState.screens]);
  const groupOptions = useMemo(() => {
    return Array.from(
      new Set([
        ...(appState.groups ?? []),
        ...appState.screens.map(getScreenGroup),
        screenForm.group,
      ].filter(Boolean)),
    );
  }, [appState.groups, appState.screens, screenForm.group]);
  const isEditing = mode === "add" || mode === "edit";
  const hasScreenFormChanges = !screenFormsEqual(screenForm, initialScreenFormRef.current);
  const isEditorDirty =
    mode === "add"
      ? Boolean(imageDraft || draftRegions.length > 0 || hasScreenFormChanges)
      : mode === "edit"
        ? Boolean(
            imageDraft ||
              hasScreenFormChanges ||
              (editDraftRegions && !regionsEqual(editDraftRegions, initialEditRegionsRef.current)),
          )
        : false;
  const editableImage = useMemo<ImageTarget | undefined>(() => {
    if (mode === "add" && imageDraft) {
      return {
        imageUrl: imageDraft.imageUrl,
        imageWidth: imageDraft.imageWidth,
        imageHeight: imageDraft.imageHeight,
        imageContentWidth: imageDraft.imageContentWidth,
        imageContentHeight: imageDraft.imageContentHeight,
        name: screenForm.name || imageDraft.fileName,
      };
    }

    if (mode === "edit" && imageDraft) {
      return {
        imageUrl: imageDraft.imageUrl,
        imageWidth: imageDraft.imageWidth,
        imageHeight: imageDraft.imageHeight,
        imageContentWidth: imageDraft.imageContentWidth,
        imageContentHeight: imageDraft.imageContentHeight,
        name: screenForm.name || imageDraft.fileName,
      };
    }

    return currentScreen;
  }, [currentScreen, imageDraft, mode, screenForm.name]);

  const translationsById = useMemo(() => {
    return new Map(translations.map((item) => [item.id, item]));
  }, [translations]);
  const globalSearchMatches = useMemo<GlobalSearchMatch[]>(() => {
    const query = globalSearchQuery.trim().toLowerCase();
    if (!query) return [];

    const matches: GlobalSearchMatch[] = [];

    for (const region of appState.regions) {
      const screen = screenById.get(region.screenId);
      if (!screen) continue;

      const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
      const fields: Array<{ label: string; value: string }> = [
        { label: "화면 텍스트", value: region.visibleText },
        { label: "비고", value: region.memo },
      ];

      if (item) {
        fields.push({ label: "key", value: item.key });
        for (const language of LANGUAGE_DEFS) {
          fields.push({
            label: language.label,
            value: getCellValue(region, item, language.code).displayValue,
          });
        }
      }

      const seenFields = new Set<string>();
      for (const field of fields) {
        const value = field.value.trim();
        if (!value || !value.toLowerCase().includes(query)) continue;
        const fieldKey = `${region.id}:${field.label}:${value}`;
        if (seenFields.has(fieldKey)) continue;
        seenFields.add(fieldKey);
        matches.push({
          id: fieldKey,
          screen,
          region,
          item,
          fieldLabel: field.label,
          value,
        });
      }
    }

    return matches.slice(0, 80);
  }, [appState.regions, globalSearchQuery, screenById, translationsById]);
  const updateCandidatesByItemId = useMemo(() => {
    const itemsByKey = new Map<string, TranslationItem[]>();
    const candidatesByItemId = new Map<string, TranslationItem[]>();

    for (const item of translations) {
      if (!item.key) continue;
      const items = itemsByKey.get(item.key);
      if (items) {
        items.push(item);
      } else {
        itemsByKey.set(item.key, [item]);
      }
    }

    for (const currentItem of translations) {
      const currentSource = sourceById.get(currentItem.sourceId);
      const currentImportedAt = getImportedAtTimestamp(currentSource, currentItem);
      const candidates = (itemsByKey.get(currentItem.key) ?? [])
        .filter((candidate) => {
          if (candidate.id === currentItem.id || candidate.sourceId === currentItem.sourceId) return false;
          if (!enabledSourceIds.has(candidate.sourceId)) return false;

          const candidateSource = sourceById.get(candidate.sourceId);
          return getImportedAtTimestamp(candidateSource, candidate) > currentImportedAt;
        })
        .sort((left, right) => {
          const leftImportedAt = getImportedAtTimestamp(sourceById.get(left.sourceId), left);
          const rightImportedAt = getImportedAtTimestamp(sourceById.get(right.sourceId), right);
          return rightImportedAt - leftImportedAt;
        });

      if (candidates.length > 0) {
        candidatesByItemId.set(currentItem.id, candidates);
      }
    }

    return candidatesByItemId;
  }, [enabledSourceIds, sourceById, translations]);
  const regionsForUsage = useMemo(() => {
    if (mode === "add") return [...appState.regions, ...draftRegions];
    if (mode === "edit" && currentScreen && editDraftRegions) {
      return replaceScreenRegions(appState.regions, currentScreen.id, editDraftRegions);
    }
    return appState.regions;
  }, [appState.regions, currentScreen, draftRegions, editDraftRegions, mode]);
  const linkedTranslationUsage = useMemo(() => {
    const usage = new Map<string, number>();

    for (const region of regionsForUsage) {
      if (!region.translationItemId) continue;
      usage.set(region.translationItemId, (usage.get(region.translationItemId) ?? 0) + 1);
    }

    return usage;
  }, [regionsForUsage]);
  const linkedSourceUsage = useMemo(() => {
    const usage = new Map<string, number>();

    for (const region of regionsForUsage) {
      if (!region.translationItemId) continue;
      const item = translationsById.get(region.translationItemId);
      if (!item) continue;
      usage.set(item.sourceId, (usage.get(item.sourceId) ?? 0) + 1);
    }

    return usage;
  }, [regionsForUsage, translationsById]);

  const regionsForScreen = useMemo(
    () => appState.regions.filter((region) => region.screenId === selectedScreenId),
    [appState.regions, selectedScreenId],
  );

  const activeRegions = mode === "add" ? draftRegions : editDraftRegions ?? regionsForScreen;
  const activeRegionIndexById = useMemo(() => {
    const indexById = new Map<string, number>();
    activeRegions.forEach((region, index) => indexById.set(region.id, index));
    return indexById;
  }, [activeRegions]);
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
  const searchCandidates = useMemo(
    () => searchTranslationCandidates(searchableTranslations, searchQuery, 35),
    [searchQuery, searchableTranslations],
  );
  const searchResults = useMemo(
    () => searchTranslationItems(searchableTranslations, searchQuery, 35),
    [searchQuery, searchableTranslations],
  );
  function openKeyDialog(region: TextRegion, anchor: DialogAnchor) {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    applyImmediateRegionSelection(region.id);
    setSelectedRegionId(region.id);
    setKeyDialogRegionId(region.id);
    setKeyDialogAnchor(anchor);
    setPendingTranslationItemId(region.translationItemId);
    setTranslationQuery(region.visibleText);
  }

  function closeKeyDialog() {
    cancelPendingRowKeyDialog();
    setKeyDialogRegionId(undefined);
    setKeyDialogAnchor(undefined);
    setPendingTranslationItemId(undefined);
    setTranslationQuery("");
  }

  function cancelPendingRowKeyDialog() {
    if (rowKeyDialogTimerRef.current === undefined) return;
    window.clearTimeout(rowKeyDialogTimerRef.current);
    rowKeyDialogTimerRef.current = undefined;
  }

  function getRegionHistoryScope() {
    return mode === "add" ? `add:${DRAFT_SCREEN_ID}` : `edit:${currentScreen?.id ?? ""}`;
  }

  function getRegionHistory() {
    const scope = getRegionHistoryScope();
    if (regionHistoryRef.current.scope !== scope) {
      regionHistoryRef.current = { scope, undo: [], redo: [] };
    }
    return regionHistoryRef.current;
  }

  function resetRegionHistory() {
    regionHistoryRef.current = { scope: getRegionHistoryScope(), undo: [], redo: [] };
    interactionHistoryRecordedRef.current = false;
  }

  function recordRegionHistory(regions: TextRegion[]) {
    const history = getRegionHistory();
    history.undo = [...history.undo.slice(-49), cloneRegions(regions)];
    history.redo = [];
  }

  function replaceActiveRegions(regions: TextRegion[]) {
    const nextRegions = cloneRegions(regions);
    if (mode === "add") {
      setDraftRegions(nextRegions);
      return;
    }

    if (editDraftRegions) {
      setEditDraftRegions(nextRegions);
      return;
    }

    const screenId = currentScreen?.id;
    if (!screenId) return;

    setAppState((state) => ({
      ...state,
      regions: replaceScreenRegions(state.regions, screenId, nextRegions),
    }));
  }

  function undoRegionChange() {
    const history = getRegionHistory();
    const previousRegions = history.undo.pop();
    if (!previousRegions) return;

    history.redo.push(cloneRegions(activeRegions));
    replaceActiveRegions(previousRegions);
    setSelectedRegionId(undefined);
    setInteraction(null);
    setDraftRect(null);
    setEditingCell(null);
    setRegionDeleteTargetId(undefined);
    closeKeyDialog();
  }

  function redoRegionChange() {
    const history = getRegionHistory();
    const nextRegions = history.redo.pop();
    if (!nextRegions) return;

    history.undo.push(cloneRegions(activeRegions));
    replaceActiveRegions(nextRegions);
    setSelectedRegionId(undefined);
    setInteraction(null);
    setDraftRect(null);
    setEditingCell(null);
    setRegionDeleteTargetId(undefined);
    closeKeyDialog();
  }

  function pushEditorHistoryEntry() {
    if (editorHistoryEntryActiveRef.current) return;
    const currentState =
      typeof window.history.state === "object" && window.history.state !== null ? window.history.state : {};
    window.history.pushState({ ...currentState, tgEditorMode: true }, "", window.location.href);
    editorHistoryEntryActiveRef.current = true;
  }

  function consumeEditorHistoryEntry() {
    if (!editorHistoryEntryActiveRef.current) return;
    allowEditorHistoryPopRef.current = true;
    window.history.back();
  }

  function leaveEditorMode() {
    setLeaveConfirmOpen(false);
    closeEditMode();
    consumeEditorHistoryEntry();
  }

  function requestLeaveEditorMode() {
    if (isEditorDirty) {
      setLeaveConfirmOpen(true);
      return;
    }

    leaveEditorMode();
  }

  useEffect(() => {
    let active = true;

    loadPersistedData()
      .then((data) => {
        if (!active) return;
        const loadedState = data.appState;
        const initialScreenId =
          loadedState.screens.find((screen) => screen.id === loadedState.activeScreenId)?.id ??
          loadedState.screens[0]?.id;
        const stateForView = { ...loadedState, activeScreenId: undefined };
        persistedDataSourceRef.current = data.source;
        supabaseLoadStatusRef.current = data.supabaseStatus;
        supabaseSnapshotUpdatedAtRef.current = data.supabaseUpdatedAt;
        saveBlockedByConflictRef.current = false;
        skipNextSupabaseSaveRef.current = true;
        console.info("[persistence] Applying loaded data to View Mode", {
          source: data.source,
          supabaseStatus: data.supabaseStatus,
          supabaseUpdatedAt: data.supabaseUpdatedAt,
          selectedScreenId: initialScreenId,
          screens: loadedState.screens.length,
          regions: loadedState.regions.length,
          sources: loadedState.sources?.length ?? 0,
          translations: data.translations.length,
        });
        setAppState(stateForView);
        setSelectedScreenId(initialScreenId);
        setTranslations(data.translations);
        if (data.supabaseStatus === "success") {
          setPersistenceStatus({
            phase: "ready",
            message: "데이터 로드 완료",
          });
        } else if (data.source === "indexeddb") {
          setPersistenceStatus({
            phase: "ready",
            message: "로컬 캐시 표시 중",
          });
        } else {
          setPersistenceStatus({
            phase: data.supabaseStatus === "failed" ? "error" : "ready",
            message: data.supabaseStatus === "failed" ? "데이터 로드 실패" : "저장된 데이터 없음",
            recovery: data.supabaseStatus === "failed" ? "reload" : undefined,
          });
        }
        setIsLoaded(true);
      })
      .catch((error) => {
        persistedDataSourceRef.current = "empty";
        supabaseLoadStatusRef.current = "failed";
        skipNextSupabaseSaveRef.current = true;
        console.error("[persistence] Persisted data load failed. Showing empty state only after all stores failed.", error);
        setPersistenceStatus({
          phase: "error",
          message: "데이터 로드 실패",
          recovery: "reload",
        });
        setIsLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    openGroupsLoadedRef.current = true;
    setOpenGroups(loadStoredOpenGroups());
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (selectedScreenId && appState.screens.some((screen) => screen.id === selectedScreenId)) return;
    setSelectedScreenId(appState.screens[0]?.id);
  }, [appState.screens, isLoaded, selectedScreenId]);

  useEffect(() => {
    if (!openGroupsLoadedRef.current) return;
    if (skipNextOpenGroupsSaveRef.current) {
      skipNextOpenGroupsSaveRef.current = false;
      return;
    }
    saveStoredOpenGroups(openGroups);
  }, [openGroups]);

  useEffect(() => {
    const onPopState = () => {
      if (!editorHistoryEntryActiveRef.current) return;

      if (allowEditorHistoryPopRef.current) {
        allowEditorHistoryPopRef.current = false;
        editorHistoryEntryActiveRef.current = false;
        return;
      }

      if (!isEditing) {
        editorHistoryEntryActiveRef.current = false;
        return;
      }

      editorHistoryEntryActiveRef.current = false;
      if (isEditorDirty) {
        pushEditorHistoryEntry();
        setLeaveConfirmOpen(true);
        return;
      }

      closeEditMode();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isEditing, isEditorDirty]);

  useEffect(() => {
    if (!isLoaded) return;
    if (skipNextSupabaseSaveRef.current) {
      skipNextSupabaseSaveRef.current = false;
      console.info("[persistence] Skipping initial Supabase save after hydration.");
      return;
    }
    if (supabaseLoadStatusRef.current === "failed") {
      console.error("[persistence] Cloud-first save blocked because the Supabase source failed to load.");
      setPersistenceStatus({
        phase: "ready",
        message: "저장 차단됨",
      });
      return;
    }
    if (persistedDataSourceRef.current === "indexeddb" && supabaseLoadStatusRef.current !== "success") {
      console.error("[persistence] Cloud-first save blocked because the app is showing IndexedDB fallback data.");
      setPersistenceStatus({
        phase: "ready",
        message: "로컬 캐시 표시 중",
      });
      return;
    }
    if (saveBlockedByConflictRef.current) {
      console.warn("[persistence] Cloud-first save skipped because the local revision is stale.");
      setPersistenceStatus({
        phase: "error",
        message: "최신 데이터 필요",
        recovery: "reload",
      });
      return;
    }
    const revision = ++persistenceRevisionRef.current;
    const showSaveFeedback = showNextSaveFeedbackRef.current;
    showNextSaveFeedbackRef.current = false;

    if (showSaveFeedback) {
      setPersistenceStatus({
        phase: "saving",
        message: "데이터 저장 중",
      });
    }

    const timeout = window.setTimeout(() => {
      const expectedUpdatedAt = supabaseSnapshotUpdatedAtRef.current;
      savePersistedData(appState, translations, expectedUpdatedAt)
        .then((saveResult) => {
          supabaseSnapshotUpdatedAtRef.current = saveResult.updatedAt ?? supabaseSnapshotUpdatedAtRef.current;
          persistedDataSourceRef.current = "supabase";
          supabaseLoadStatusRef.current = "success";
          if (persistenceRevisionRef.current !== revision) return;
          if (showSaveFeedback) {
            setPersistenceStatus({
              phase: "ready",
              message: "데이터 저장 완료",
            });
          }
        })
        .catch((error) => {
          if (persistenceRevisionRef.current !== revision) return;
          const message = error instanceof Error ? error.message : "알 수 없는 저장 오류";
          console.error("[persistence] Cloud-first save failed. IndexedDB cache was not updated.", error);
          if (error instanceof Error && error.name === "SupabaseSnapshotConflictError") {
            saveBlockedByConflictRef.current = true;
            setSaveConflictOpen(true);
            setPersistenceStatus({
              phase: "error",
              message: "최신 데이터 필요",
              recovery: "reload",
            });
            return;
          }

          setPersistenceStatus({
            phase: "error",
            message: "데이터 저장 실패",
            recovery: "save",
          });
        });
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [appState, isLoaded, persistenceRetryVersion, translations]);

  useEffect(() => {
    if (persistenceStatus.phase !== "saved") return;

    const timeout = window.setTimeout(() => {
      setPersistenceStatus({
        phase: "ready",
        message: "Supabase 원본 데이터를 사용 중입니다.",
      });
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [persistenceStatus.phase]);

  useEffect(() => {
    if (!isEditorDirty && persistenceStatus.phase !== "saving") return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isEditorDirty, persistenceStatus.phase]);

  useEffect(() => {
    if (!copyFeedback) return;

    const timeout = window.setTimeout(() => setCopyFeedback(undefined), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (!rowContextMenu) return;

    const closeMenu = () => setRowContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rowContextMenu]);

  useEffect(() => {
    if (!isLoaded || translationSources.length > 0 || translations.length > 0 || defaultDataLoadAttempted.current) return;
    defaultDataLoadAttempted.current = true;
    void loadLocalHtml();
  }, [isLoaded, translationSources.length, translations.length]);

  useEffect(() => {
    if (!selectedRegionId) {
      immediateSelectedRegionIdRef.current = undefined;
      return;
    }

    window.requestAnimationFrame(() => applyImmediateRegionSelection(selectedRegionId));
  }, [selectedRegionId]);

  useEffect(() => {
    if (!globalSearchOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (globalSearchRef.current?.contains(event.target as Node)) return;
      setGlobalSearchOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [globalSearchOpen]);

  useEffect(() => {
    if (!pendingGlobalFocusRegionId || selectedRegionId !== pendingGlobalFocusRegionId) return;

    const region = activeRegions.find((candidate) => candidate.id === pendingGlobalFocusRegionId);
    if (!region) return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        scrollTableRowIntoView(region.id);
        scrollRegionIntoView(region);
        setPendingGlobalFocusRegionId(undefined);
      });
    });
  }, [activeRegions, pendingGlobalFocusRegionId, selectedRegionId]);

  useEffect(() => {
    if (!isEditing || !selectedRegionId || keyDialogRegionId || regionDeleteTargetId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const isDeleteKey =
        event.key === "Backspace" ||
        event.key === "Delete" ||
        event.code === "Backspace" ||
        event.code === "Delete" ||
        event.keyCode === 8 ||
        event.keyCode === 46;
      if (!isDeleteKey || event.repeat || isEditableTextTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      setEditingCell(null);
      closeKeyDialog();
      setRegionDeleteTargetId(selectedRegionId);
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [isEditing, keyDialogRegionId, regionDeleteTargetId, selectedRegionId]);

  useEffect(() => {
    if (!isEditing) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const isUndoShortcut =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z";
      if (!isUndoShortcut || event.repeat || isEditableTextTarget(event.target)) return;

      const history = getRegionHistory();
      const canApplyHistory = event.shiftKey ? history.redo.length > 0 : history.undo.length > 0;
      if (!canApplyHistory) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        redoRegionChange();
      } else {
        undoRegionChange();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeRegions, currentScreen?.id, isEditing, mode]);

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

    const getDuplicateMoveAxis = (event: PointerEvent, point: { x: number; y: number }) => {
      if (interaction.mode !== "move" || !interaction.duplicatedRegion) return undefined;
      if (!interaction.constrainAxis && !event.shiftKey && !duplicateMoveAxisRef.current) return undefined;

      if (!duplicateMoveAxisRef.current) {
        duplicateMoveAxisRef.current =
          Math.abs(point.x - interaction.startX) >= Math.abs(point.y - interaction.startY) ? "x" : "y";
      }
      return duplicateMoveAxisRef.current;
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = toImagePoint(event);
      if (!point) return;

      if (interaction.mode === "draw") {
        setDraftRect(getNormalizedRect(interaction.startX, interaction.startY, point.x, point.y));
        return;
      }

      if (
        !interactionHistoryRecordedRef.current &&
        (Math.abs(point.x - interaction.startX) > 0.01 || Math.abs(point.y - interaction.startY) > 0.01)
      ) {
        recordRegionHistory(interaction.beforeRegions);
        interactionHistoryRecordedRef.current = true;
      }

      const updateRegion = (region: TextRegion) => {
          if (region.id !== interaction.regionId) return region;

          if (interaction.mode === "move") {
            const movedRect = getMovedRect(
              interaction.initial,
              interaction.startX,
              interaction.startY,
              point.x,
              point.y,
              editableImage.imageWidth,
              editableImage.imageHeight,
              getDuplicateMoveAxis(event, point),
            );

            return { ...region, ...movedRect, updatedAt: new Date().toISOString() };
          }

          const deltaX = point.x - interaction.startX;
          const deltaY = point.y - interaction.startY;
          let x = interaction.initial.x;
          let y = interaction.initial.y;
          let width = interaction.initial.width;
          let height = interaction.initial.height;

          if (interaction.edges.left) {
            x = clamp(interaction.initial.x + deltaX, 0, interaction.initial.x + interaction.initial.width - 12);
            width = interaction.initial.width + interaction.initial.x - x;
          } else if (interaction.edges.right) {
            width = clamp(interaction.initial.width + deltaX, 12, editableImage.imageWidth - interaction.initial.x);
          }

          if (interaction.edges.top) {
            y = clamp(interaction.initial.y + deltaY, 0, interaction.initial.y + interaction.initial.height - 12);
            height = interaction.initial.height + interaction.initial.y - y;
          } else if (interaction.edges.bottom) {
            height = clamp(interaction.initial.height + deltaY, 12, editableImage.imageHeight - interaction.initial.y);
          }

          return { ...region, x, y, width, height, updatedAt: new Date().toISOString() };
      };

      if (mode === "add") {
        setDraftRegions((regions) => regions.map(updateRegion));
        return;
      }

      if (editDraftRegions) {
        setEditDraftRegions((regions) => regions?.map(updateRegion) ?? regions);
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
          } else if (editDraftRegions) {
            setEditDraftRegions((regions) => [...(regions ?? []), region]);
          } else {
            setAppState((state) => ({ ...state, regions: [...state.regions, region] }));
          }
          recordRegionHistory(interaction.beforeRegions);
          openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
          void runOcrForRegion(region, editableImage);
        }
      }

      if (interaction.mode === "move" && interaction.duplicatedRegion && point && editableImage) {
        const movedRect = getMovedRect(
          interaction.initial,
          interaction.startX,
          interaction.startY,
          point.x,
          point.y,
          editableImage.imageWidth,
          editableImage.imageHeight,
          getDuplicateMoveAxis(event, point),
        );
        const region = {
          ...interaction.duplicatedRegion,
          ...movedRect,
          updatedAt: new Date().toISOString(),
        };
        const applyFinalRect = (candidate: TextRegion) =>
          candidate.id === region.id ? { ...candidate, ...movedRect, updatedAt: region.updatedAt } : candidate;

        if (mode === "add") {
          setDraftRegions((regions) => regions.map(applyFinalRect));
        } else if (editDraftRegions) {
          setEditDraftRegions((regions) => regions?.map(applyFinalRect) ?? regions);
        } else {
          setAppState((state) => ({ ...state, regions: state.regions.map(applyFinalRect) }));
        }

        openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
        void runOcrForRegion(region, editableImage);
      }

      setDraftRect(null);
      setInteraction(null);
      interactionHistoryRecordedRef.current = false;
      duplicateMoveAxisRef.current = undefined;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [currentScreen?.id, editDraftRegions, editableImage, interaction, isEditing, mode]);

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

    const validationError = getTranslationFileValidationError(file);
    if (validationError) {
      setParseMessage(`업로드 실패: ${validationError}`);
      if (translationFileInputRef.current) {
        translationFileInputRef.current.value = "";
      }
      return;
    }

    setIsParsing(true);
    setParseMessage("번역 파일을 파싱 중입니다.");

    try {
      const extension = getFileExtension(file.name);
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
    const duplicateCount = sourceDuplicateCountById.get(sourceId) ?? 0;
    if (duplicateCount > 1) {
      const duplicateSources = translationSources.filter((source) => getSourceId(source) === sourceId);
      const allDisabled = duplicateSources.every((source) => source.enabled === false);
      const actionLabel = allDisabled ? "활성화" : "비활성화";
      const confirmed = window.confirm(
        `동일한 내부 ID를 가진 번역 파일 ${duplicateCount}개가 함께 ${actionLabel}됩니다. 기존 중복 파일은 개별로 분리할 수 없습니다. 계속하시겠습니까?`,
      );
      if (!confirmed) return;
    }

    setAppState((state) => ({
      ...state,
      sources: (state.sources ?? []).map((source) =>
        getSourceId(source) === sourceId ? { ...source, enabled: !source.enabled } : source,
      ),
      source: state.source && getSourceId(state.source) === sourceId ? { ...state.source, enabled: !state.source.enabled } : state.source,
    }));
  }

  function deleteTranslationSource(sourceId: string) {
    const duplicateCount = sourceDuplicateCountById.get(sourceId) ?? 0;
    if (duplicateCount > 1) {
      window.alert(
        "동일한 내부 ID를 가진 번역 파일이 여러 개 있어 안전하게 삭제할 수 없습니다. 기존 중복 파일은 삭제하지 말고 유지해주세요.",
      );
      return;
    }

    const linkedCount = linkedSourceUsage.get(sourceId) ?? 0;
    if (linkedCount > 0) {
      window.alert(
        `이 번역 파일은 ${linkedCount.toLocaleString()}개 텍스트 영역에 연결되어 있어 삭제할 수 없습니다. 필요하면 삭제 대신 비활성화해주세요.`,
      );
      return;
    }

    if (!window.confirm("이 번역 파일을 삭제하시겠습니까? 삭제 후에는 이 파일의 번역 항목이 검색되지 않습니다.")) {
      return;
    }

    setAppState((state) => ({
      ...state,
      sources: (state.sources ?? []).filter((source) => getSourceId(source) !== sourceId),
      source: state.source && getSourceId(state.source) === sourceId ? undefined : state.source,
    }));
    setTranslations((current) => current.filter((item) => item.sourceId !== sourceId));
  }

  async function handleImageDraft(file?: File) {
    if (!file) return;

    const validationError = getImageValidationError(file);
    if (validationError) {
      throw new Error(validationError);
    }

    const imageUrl = await readFileAsDataUrl(file);
    const size = await loadImageSize(imageUrl);
    const previousImage = imageDraft ?? currentScreen;
    const nextCoordinateWidth = size.width;
    const nextCoordinateHeight =
      mode === "edit" && previousImage
        ? Math.max(
            size.height,
            Math.round(previousImage.imageHeight * (previousImage.imageWidth > 0 ? size.width / previousImage.imageWidth : 1)),
          )
        : size.height;

    setImageDraft({
      imageUrl,
      file,
      imageWidth: nextCoordinateWidth,
      imageHeight: nextCoordinateHeight,
      imageContentWidth: size.width,
      imageContentHeight: size.height,
      fileName: file.name,
    });
    if (mode === "add") {
      setDraftRegions((regions) => regions.filter((region) => !isScreenRegion(region)));
      setEditDraftRegions(null);
    } else if (mode === "edit" && previousImage) {
      setEditDraftRegions(
        scaleRegionsToImageSize(
          editDraftRegions ?? regionsForScreen,
          previousImage.imageWidth,
          previousImage.imageHeight,
          nextCoordinateWidth,
          nextCoordinateHeight,
        ),
      );
    }
    setSelectedRegionId(undefined);
    resetRegionHistory();
    closeKeyDialog();
    if (!screenForm.name.trim()) {
      setScreenForm((form) => ({ ...form, name: file.name.replace(/\.[^.]+$/, "") }));
    }
  }

  function handleImageFileInput(file?: File) {
    void handleImageDraft(file).catch((error) => {
      const message = error instanceof Error ? error.message : "이미지를 업로드할 수 없습니다.";
      setCopyFeedback({ id: Date.now(), message });
      console.error("[image] Failed to apply image.", error);
    });
  }

  useEffect(() => {
    if (!isEditing) return;

    const handlePaste = (event: ClipboardEvent) => {
      const file = getClipboardImageFile(event);
      if (!file) return;

      event.preventDefault();
      void handleImageDraft(file)
        .then(() => {
          setCopyFeedback({ id: Date.now(), message: "붙여넣은 이미지를 적용했습니다." });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "이미지 붙여넣기에 실패했습니다.";
          console.error("[image] Failed to apply pasted image.", error);
          setCopyFeedback({ id: Date.now(), message });
        });
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [currentScreen, editDraftRegions, imageDraft, isEditing, regionsForScreen, screenForm.name]);

  async function runOcrForRegion(region: TextRegion, imageTarget = editableImage) {
    if (!imageTarget) return;

    setOcrByRegion((state) => ({
      ...state,
      [region.id]: { status: "running" },
    }));

    try {
      const cropDataUrl = await cropImageRegion(imageTarget, region);
      const { recognize } = await import("tesseract.js");
      const result = await recognize(cropDataUrl, "kor+eng");
      const text = result.data.text.replace(/\s+/g, " ").trim();
      const confidence = Number.isFinite(result.data.confidence) ? Math.round(result.data.confidence) : undefined;
      if (!text) {
        throw new Error("OCR로 인식된 텍스트가 없습니다.");
      }

      updateRegion(region.id, {
        visibleText: text,
        status: region.status === "unlinked" ? "needs_check" : region.status,
      });
      setTranslationQuery(text);
      setOcrByRegion((state) => ({
        ...state,
        [region.id]: { status: "success", confidence },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "OCR을 실행할 수 없습니다.";
      setOcrByRegion((state) => ({
        ...state,
        [region.id]: { status: "failed", error: message },
      }));
    }
  }

  function openAddMode(group?: string) {
    const initialForm = { ...defaultScreenForm, group: group ?? appState.groups?.[0] ?? defaultScreenForm.group };
    initialScreenFormRef.current = initialForm;
    initialEditRegionsRef.current = [];
    pushEditorHistoryEntry();
    setLeaveConfirmOpen(false);
    setMode("add");
    setScreenForm(initialForm);
    setImageDraft(null);
    setDraftRegions([]);
    setEditDraftRegions(null);
    setSelectedRegionId(undefined);
    setEditingCell(null);
    resetRegionHistory();
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

        return {
          ...state,
          screens: nextScreens,
          regions: state.regions.filter((region) => region.screenId !== deleteTarget.screenId),
        };
      });
      if (selectedScreenId === deleteTarget.screenId) {
        const nextScreen = appState.screens.find((screen) => screen.id !== deleteTarget.screenId);
        setSelectedScreenId(nextScreen?.id);
      }
    } else {
      setAppState((state) => {
        const deletedScreenIds = new Set(
          state.screens.filter((screen) => getScreenGroup(screen) === deleteTarget.name).map((screen) => screen.id),
        );
        const nextScreens = state.screens.filter((screen) => getScreenGroup(screen) !== deleteTarget.name);

        return {
          ...state,
          groups: (state.groups ?? []).filter((group) => group !== deleteTarget.name),
          screens: nextScreens,
          regions: state.regions.filter((region) => !deletedScreenIds.has(region.screenId)),
        };
      });
      const deletedScreenIds = new Set(
        appState.screens.filter((screen) => getScreenGroup(screen) === deleteTarget.name).map((screen) => screen.id),
      );
      if (deletedScreenIds.has(selectedScreenId ?? "")) {
        const nextScreen = appState.screens.find((screen) => !deletedScreenIds.has(screen.id));
        setSelectedScreenId(nextScreen?.id);
      }
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
    const initialForm = screenToForm(currentScreen);
    const initialRegions = cloneRegions(regionsForScreen);
    initialScreenFormRef.current = initialForm;
    initialEditRegionsRef.current = initialRegions;
    pushEditorHistoryEntry();
    setMode("edit");
    setLeaveConfirmOpen(false);
    setScreenForm(initialForm);
    setImageDraft(null);
    setDraftRegions([]);
    setEditDraftRegions(cloneRegions(initialRegions));
    setEditingCell(null);
    resetRegionHistory();
  }

  function closeEditMode() {
    setLeaveConfirmOpen(false);
    setMode("view");
    setImageDraft(null);
    setDraftRegions([]);
    setEditDraftRegions(null);
    setInteraction(null);
    setDraftRect(null);
    setEditingCell(null);
    resetRegionHistory();
    closeKeyDialog();
  }

  function handleShellPointerDown(event: React.PointerEvent<HTMLElement>) {
    cancelPendingRowKeyDialog();
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (keyDialogRegionId && !target.closest(".key-dialog")) {
      closeKeyDialog();
    }
    if (!selectedRegionId) return;
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
        uploadedImage = await uploadScreenImage(screenId, imageDraft.imageUrl, imageDraft.file);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 이미지 업로드 오류";
        console.error("[persistence] Supabase image upload failed. Screen save was cancelled.", error);
        setPersistenceStatus({
          phase: "error",
          message: "이미지 업로드 실패",
        });
        return;
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
        imageContentWidth: imageDraft.imageContentWidth,
        imageContentHeight: imageDraft.imageContentHeight,
        memo: screenForm.memo.trim(),
        createdAt: now,
        updatedAt: now,
      };

      showNextSaveFeedbackRef.current = true;
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
      }));
      setSelectedScreenId(screen.id);
      consumeEditorHistoryEntry();
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
        uploadedImage = await uploadScreenImage(currentScreen.id, imageDraft.imageUrl, imageDraft.file);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 이미지 업로드 오류";
        console.error("[persistence] Supabase image upload failed. Screen update was cancelled.", error);
        setPersistenceStatus({
          phase: "error",
          message: "이미지 업로드 실패",
        });
        return;
      }
    }

    showNextSaveFeedbackRef.current = true;
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
              imageContentWidth: imageDraft?.imageContentWidth ?? screen.imageContentWidth,
              imageContentHeight: imageDraft?.imageContentHeight ?? screen.imageContentHeight,
              updatedAt: now,
            }
          : screen,
      ),
      regions: editDraftRegions
        ? replaceScreenRegions(
            state.regions,
            currentScreen.id,
            editDraftRegions.map((region) => ({ ...region, screenId: currentScreen.id, updatedAt: now })),
          )
        : state.regions,
    }));
    consumeEditorHistoryEntry();
    setImageDraft(null);
    setEditDraftRegions(null);
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

    if (editDraftRegions) {
      setEditDraftRegions((regions) =>
        regions
          ? regions.map((region) =>
              region.id === regionId
                ? { ...region, ...patch, updatedAt: new Date().toISOString() }
                : region,
            )
          : regions,
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

  function deleteRegion(regionId: string) {
    recordRegionHistory(activeRegions);
    if (mode === "add") {
      setDraftRegions((regions) => regions.filter((region) => region.id !== regionId));
      setSelectedRegionId(undefined);
      closeKeyDialog();
      return;
    }

    if (editDraftRegions) {
      setEditDraftRegions((regions) => regions?.filter((region) => region.id !== regionId) ?? regions);
      setSelectedRegionId(undefined);
      closeKeyDialog();
      return;
    }

    setAppState((state) => ({
      ...state,
      regions: state.regions.filter((region) => region.id !== regionId),
    }));
    setSelectedRegionId(undefined);
    closeKeyDialog();
  }

  function deleteSelectedRegion() {
    if (!selectedRegionId) return;
    deleteRegion(selectedRegionId);
  }

  function confirmDeleteSelectedRegion() {
    if (!regionDeleteTargetId) return;
    deleteRegion(regionDeleteTargetId);
    setRegionDeleteTargetId(undefined);
  }

  function reorderRegion(sourceRegionId: string, targetRegionId: string) {
    if (sourceRegionId === targetRegionId) return;

    const reorder = (regions: TextRegion[]) => {
      const sourceIndex = regions.findIndex((region) => region.id === sourceRegionId);
      const targetIndex = regions.findIndex((region) => region.id === targetRegionId);
      if (sourceIndex < 0 || targetIndex < 0) return regions;

      const nextRegions = [...regions];
      const [movedRegion] = nextRegions.splice(sourceIndex, 1);
      nextRegions.splice(targetIndex, 0, movedRegion);
      return nextRegions;
    };

    recordRegionHistory(activeRegions);
    setSelectedRegionId(sourceRegionId);

    if (mode === "add") {
      setDraftRegions((regions) => reorder(regions));
      return;
    }

    if (editDraftRegions) {
      setEditDraftRegions((regions) => (regions ? reorder(regions) : regions));
      return;
    }

    const screenId = currentScreen?.id;
    if (!screenId) return;

    setAppState((state) => {
      const reorderedScreenRegions = reorder(state.regions.filter((region) => region.screenId === screenId));
      let screenRegionIndex = 0;

      return {
        ...state,
        regions: state.regions.map((region) =>
          region.screenId === screenId ? reorderedScreenRegions[screenRegionIndex++] : region,
        ),
      };
    });
  }

  function reorderGroup(sourceGroup: string, targetGroup: string, position: "before" | "after") {
    if (sourceGroup === targetGroup) return;

    setAppState((state) => {
      const groupNames = getOrderedGroupNames(state);
      const sourceIndex = groupNames.indexOf(sourceGroup);
      const targetIndex = groupNames.indexOf(targetGroup);
      if (sourceIndex < 0 || targetIndex < 0) return state;

      return {
        ...state,
        groups: moveItemToPosition(groupNames, sourceIndex, targetIndex, position),
      };
    });
  }

  function reorderScreenInGroup(
    sourceScreenId: string,
    targetScreenId: string,
    group: string,
    position: "before" | "after",
  ) {
    if (sourceScreenId === targetScreenId) return;

    setAppState((state) => {
      const groupScreens = state.screens.filter((screen) => getScreenGroup(screen) === group);
      const sourceIndex = groupScreens.findIndex((screen) => screen.id === sourceScreenId);
      const targetIndex = groupScreens.findIndex((screen) => screen.id === targetScreenId);
      if (sourceIndex < 0 || targetIndex < 0) return state;

      const reorderedGroupScreens = moveItemToPosition(groupScreens, sourceIndex, targetIndex, position);
      let groupScreenIndex = 0;

      return {
        ...state,
        screens: state.screens.map((screen) =>
          getScreenGroup(screen) === group ? reorderedGroupScreens[groupScreenIndex++] : screen,
        ),
      };
    });
  }

  function handleMenuDrop(target: MenuDropTarget) {
    if (!draggedMenuItem) return;

    if (draggedMenuItem.type === "group" && target.type === "group") {
      reorderGroup(draggedMenuItem.group, target.group, target.position);
    }

    if (
      draggedMenuItem.type === "screen" &&
      target.type === "screen" &&
      draggedMenuItem.group === target.group
    ) {
      reorderScreenInGroup(draggedMenuItem.screenId, target.screenId, target.group, target.position);
    }

    setDraggedMenuItem(null);
    setMenuDropTarget(null);
  }

  function insertTableOnlyRegion(insertIndex: number, anchor?: DialogAnchor) {
    const now = new Date().toISOString();
    const screenId = mode === "add" ? DRAFT_SCREEN_ID : currentScreen?.id;
    if (!screenId) return;

    const region: TextRegion = {
      id: createId("region"),
      screenId,
      visibleText: "",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      status: "unlinked",
      memo: "",
      createdAt: now,
      updatedAt: now,
    };

    const nextIndex = clamp(insertIndex, 0, activeRegions.length);
    recordRegionHistory(activeRegions);
    setSelectedRegionId(region.id);
    setEditingCell(null);

    if (mode === "add") {
      setDraftRegions((regions) => {
        const nextRegions = [...regions];
        nextRegions.splice(nextIndex, 0, region);
        return nextRegions;
      });
    } else if (editDraftRegions) {
      setEditDraftRegions((regions) => {
        const nextRegions = [...(regions ?? [])];
        nextRegions.splice(nextIndex, 0, region);
        return nextRegions;
      });
    } else {
      setAppState((state) => {
        const nextRegions = [...state.regions];
        const screenRegionIndexes = nextRegions
          .map((candidate, index) => (candidate.screenId === screenId ? index : -1))
          .filter((index) => index >= 0);
        const insertBeforeGlobalIndex = screenRegionIndexes[nextIndex];
        const globalIndex = insertBeforeGlobalIndex ?? nextRegions.length;
        nextRegions.splice(globalIndex, 0, region);

        return {
          ...state,
          regions: nextRegions,
        };
      });
    }

    window.requestAnimationFrame(() => scrollTableRowIntoView(region.id));
    openKeyDialog(region, anchor ?? { x: window.innerWidth - 420, y: 160 });
  }

  function connectRegion(regionId: string, item: TranslationItem, options?: { closeDialog?: boolean }) {
    const region = activeRegions.find((candidate) => candidate.id === regionId);

    if (region?.translationItemId === item.id) {
      const shouldUpdateVisibleText = !region.visibleText;
      const shouldUpdateStatus = region.status === "unlinked" || region.status === "needs_check";
      if (shouldUpdateVisibleText || shouldUpdateStatus) {
        updateRegion(regionId, {
          visibleText: shouldUpdateVisibleText ? item.kr || item.en || item.key : region.visibleText,
          status: shouldUpdateStatus ? "linked" : region.status,
        });
      }
      setEditingCell(null);
      setTranslationQuery("");
      if (options?.closeDialog) {
        closeKeyDialog();
      }
      return;
    }

    updateRegion(regionId, {
      translationItemId: item.id,
      translationOverrides: undefined,
      translationOverrideHistory: undefined,
      visibleText: region?.visibleText || item.kr || item.en || item.key,
      status: region?.status === "unlinked" || region?.status === "needs_check" ? "linked" : region?.status,
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

  function replaceRegionTranslationItem(regionId: string, item: TranslationItem) {
    updateRegion(regionId, {
      translationItemId: item.id,
      translationOverrides: undefined,
      translationOverrideHistory: undefined,
    });
    setSelectedRegionId(regionId);
    setEditingCell(null);
    setUpdateCandidateRegionId(undefined);
  }

  function unlinkSelectedRegion() {
    updateSelectedRegion({
      translationItemId: undefined,
      translationOverrides: undefined,
      translationOverrideHistory: undefined,
      status: "unlinked",
    });
    setEditingCell(null);
  }

  async function writeClipboardText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }

  async function readClipboardText() {
    if (!navigator.clipboard?.readText) {
      throw new Error("클립보드 읽기를 지원하지 않는 브라우저입니다.");
    }

    return navigator.clipboard.readText();
  }

  async function copyTextCellValue(value: string, label: string) {
    const text = value.trim();
    if (!text) {
      setCopyFeedback({ id: Date.now(), message: "복사할 텍스트가 없습니다." });
      return;
    }

    try {
      await writeClipboardText(text);

      setCopyFeedback({ id: Date.now(), message: `${label} 텍스트를 복사했습니다.` });
    } catch (error) {
      console.error("[clipboard] Failed to copy translation cell value.", error);
      setCopyFeedback({ id: Date.now(), message: "복사에 실패했습니다." });
    }
  }

  async function copyTranslationRow(region: TextRegion) {
    const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
    const values = [
      ...LANGUAGE_DEFS.map((language) => getCellValue(region, item, language.code).displayValue),
      region.memo,
    ];
    const text = values.map((value) => value.replace(/\r?\n/g, "\n")).join("\t");

    if (!text.trim()) {
      setCopyFeedback({ id: Date.now(), message: "복사할 Row 값이 없습니다." });
      return;
    }

    try {
      await writeClipboardText(text);
      setCopiedRowValues(values);
      setCopyFeedback({ id: Date.now(), message: "Row 전체를 복사했습니다." });
    } catch (error) {
      console.error("[clipboard] Failed to copy translation row.", error);
      setCopyFeedback({ id: Date.now(), message: "복사에 실패했습니다." });
    }
  }

  function parseTranslationRowClipboardText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const firstLine = normalizedText.split("\n")[0] ?? "";
    return firstLine.split("\t");
  }

  async function pasteTranslationRow(region: TextRegion) {
    if (!isEditing) {
      setCopyFeedback({ id: Date.now(), message: "화면 추가/편집 모드에서만 붙여넣을 수 있습니다." });
      return;
    }

    try {
      const text = copiedRowValues ? "" : await readClipboardText();
      const values = copiedRowValues ?? parseTranslationRowClipboardText(text);
      const expectedColumnCount = LANGUAGE_DEFS.length + 1;

      if (values.length < LANGUAGE_DEFS.length || values.length > expectedColumnCount) {
        setCopyFeedback({ id: Date.now(), message: "붙여넣을 Row 형식이 올바르지 않습니다." });
        return;
      }

      const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
      const nextOverrides = { ...(region.translationOverrides ?? {}) };
      const nextHistory = { ...(region.translationOverrideHistory ?? {}) };
      let changed = false;

      for (const [index, language] of LANGUAGE_DEFS.entries()) {
        const nextValue = values[index] ?? "";
        const baseValue = item?.[language.code] ?? "";
        const currentValue = getCellValue(region, item, language.code).displayValue;
        if (nextValue === currentValue) continue;

        if (nextValue === baseValue) {
          delete nextOverrides[language.code];
        } else {
          nextOverrides[language.code] = nextValue;
        }
        delete nextHistory[language.code];
        changed = true;
      }

      const nextMemo = values[LANGUAGE_DEFS.length] ?? region.memo;
      const memoChanged = nextMemo !== region.memo;
      if (!changed && !memoChanged) {
        setCopyFeedback({ id: Date.now(), message: "변경할 Row 값이 없습니다." });
        return;
      }

      updateRegion(region.id, {
        translationOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
        translationOverrideHistory: Object.keys(nextHistory).length > 0 ? nextHistory : undefined,
        memo: nextMemo,
      });
      setSelectedRegionId(region.id);
      setEditingCell(null);
      setCopyFeedback({ id: Date.now(), message: "Row 값을 붙여넣었습니다." });
    } catch (error) {
      console.error("[clipboard] Failed to paste translation row.", error);
      setCopyFeedback({ id: Date.now(), message: "붙여넣기에 실패했습니다." });
    }
  }

  function isNativeContextTarget(target: EventTarget | null) {
    return target instanceof Element && Boolean(target.closest("button, input, textarea, select, a"));
  }

  function openRowContextMenu(event: MouseEvent, region: TextRegion) {
    if (isNativeContextTarget(event.target)) return;

    event.preventDefault();
    applyImmediateRegionSelection(region.id);
    setSelectedRegionId(region.id);
    setRowContextMenu({
      regionId: region.id,
      x: Math.min(event.clientX, window.innerWidth - 180),
      y: Math.min(event.clientY, window.innerHeight - 72),
    });
  }

  function getCellValue(region: TextRegion, item: TranslationItem | undefined, languageCode: LanguageCode) {
    const hasOverride = Object.prototype.hasOwnProperty.call(region.translationOverrides ?? {}, languageCode);

    return {
      baseValue: item?.[languageCode] ?? "",
      displayValue: hasOverride ? (region.translationOverrides?.[languageCode] ?? "") : (item?.[languageCode] ?? ""),
      hasOverride,
    };
  }

  function getRegionDomSelector(regionId: string) {
    return `[data-region-id="${regionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }

  function setDomRegionSelected(regionId: string, selected: boolean) {
    document.querySelectorAll(getRegionDomSelector(regionId)).forEach((element) => {
      element.classList.toggle("selected", selected);
    });
  }

  function applyImmediateRegionSelection(regionId: string) {
    const previousRegionId = immediateSelectedRegionIdRef.current ?? selectedRegionId;
    if (previousRegionId && previousRegionId !== regionId) {
      setDomRegionSelected(previousRegionId, false);
    }
    setDomRegionSelected(regionId, true);
    immediateSelectedRegionIdRef.current = regionId;
  }

  function scrollRegionIntoView(region: TextRegion, behavior: ScrollBehavior = "smooth") {
    if (!isScreenRegion(region)) return;

    const viewport = imageViewportRef.current;
    const overlay = overlayRef.current;
    const imageTarget = editableImage;
    if (!viewport || !overlay || !imageTarget || viewport.clientHeight <= 0 || overlay.clientHeight <= 0) return;

    const viewportRect = viewport.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const regionTop = overlayRect.top + (region.y / imageTarget.imageHeight) * overlayRect.height;
    const regionHeight = (region.height / imageTarget.imageHeight) * overlayRect.height;
    const regionBottom = regionTop + regionHeight;
    const visibleTop = viewportRect.top + 8;
    const visibleBottom = viewportRect.bottom - 8;
    if (regionTop >= visibleTop && regionBottom <= visibleBottom) return;

    const targetTop = viewport.scrollTop + regionTop - viewportRect.top - (viewport.clientHeight - regionHeight) / 2;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);

    viewport.scrollTo({
      top: clamp(targetTop, 0, maxScrollTop),
      behavior,
    });
  }

  function scrollTableRowIntoView(regionId: string, behavior: ScrollBehavior = "auto") {
    const scrollContainer = translationTableWrapRef.current;
    const row = itemRefs.current[regionId];
    if (!scrollContainer || !row) return;

    const header = scrollContainer.querySelector("thead");
    const containerRect = scrollContainer.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    const targetTop = scrollContainer.scrollTop + rowRect.top - containerRect.top - headerHeight;
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

    scrollContainer.scrollTo({
      top: clamp(targetTop, 0, maxScrollTop),
      behavior,
    });
  }

  function selectRegionFromScreen(region: TextRegion) {
    applyImmediateRegionSelection(region.id);
    startTransition(() => setSelectedRegionId(region.id));
    window.requestAnimationFrame(() => scrollTableRowIntoView(region.id));
  }

  function selectRegionFromTable(region: TextRegion) {
    applyImmediateRegionSelection(region.id);
    startTransition(() => setSelectedRegionId(region.id));
    if (!isScreenRegion(region)) return;

    window.requestAnimationFrame(() => scrollRegionIntoView(region, "auto"));
  }

  function selectRegionAndOpenKeyDialog(event: React.MouseEvent<HTMLTableRowElement>, region: TextRegion) {
    selectRegionFromTable(region);
    if (!isEditing) return;

    const anchor = { x: event.clientX - 387, y: event.clientY + 12 };
    cancelPendingRowKeyDialog();
    rowKeyDialogTimerRef.current = window.setTimeout(() => {
      rowKeyDialogTimerRef.current = undefined;
      setEditingCell(null);
      openKeyDialog(region, anchor);
    }, 180);
  }

  function selectGlobalSearchMatch(match: GlobalSearchMatch) {
    setMode("view");
    setGlobalSearchOpen(false);
    setPendingGlobalFocusRegionId(match.region.id);
    setSelectedRegionId(match.region.id);
    setOpenGroups((groups) => ({ ...groups, [getScreenGroup(match.screen)]: true }));
    setSelectedScreenId(match.screen.id);
  }

  function renderHighlightedSearchValue(value: string) {
    const query = globalSearchQuery.trim();
    if (!query) return value;

    const lowerValue = value.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerValue.indexOf(lowerQuery);
    if (index < 0) return value;

    return (
      <>
        {value.slice(0, index)}
        <mark>{value.slice(index, index + query.length)}</mark>
        {value.slice(index + query.length)}
      </>
    );
  }

  function renderGlobalSearch() {
    const query = globalSearchQuery.trim();
    const showResults = globalSearchOpen && query.length > 0;

    return (
      <div className="global-search" ref={globalSearchRef}>
        <label className={`global-search-field ${globalSearchOpen ? "focused" : ""} ${query ? "typed" : ""}`}>
          <span className="global-search-icon" aria-hidden="true" />
          <input
            value={globalSearchQuery}
            onChange={(event) => {
              setGlobalSearchQuery(event.target.value);
              setGlobalSearchOpen(true);
            }}
            onFocus={() => setGlobalSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setGlobalSearchOpen(false);
              }
            }}
            placeholder="텍스트 검색"
          />
          {query ? (
            <button
              type="button"
              className="global-search-clear"
              onClick={() => {
                setGlobalSearchQuery("");
                setGlobalSearchOpen(false);
              }}
              aria-label="검색어 지우기"
            />
          ) : null}
        </label>

        {showResults ? (
          <div className="global-search-popover" role="listbox" aria-label="텍스트 검색 결과">
            <div className="global-search-summary">
              <strong>{globalSearchMatches.length.toLocaleString()}개 결과</strong>
              <span>매칭된 텍스트만 표시됩니다.</span>
            </div>
            <div className="global-search-results">
              {globalSearchMatches.length > 0 ? (
                globalSearchMatches.map((match) => (
                  <button
                    type="button"
                    key={match.id}
                    className="global-search-result"
                    onClick={() => selectGlobalSearchMatch(match)}
                  >
                    <span className="global-search-result-meta">
                      {getScreenGroup(match.screen)} · {match.screen.name} · {match.fieldLabel}
                    </span>
                    <strong>{renderHighlightedSearchValue(match.value)}</strong>
                    <em>{match.item?.key ?? "미연결 Row"}</em>
                  </button>
                ))
              ) : (
                <div className="global-search-empty">검색 결과가 없습니다.</div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function beginCellEdit(region: TextRegion, item: TranslationItem | undefined, languageCode: LanguageCode) {
    if (!isEditing) return;
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
    const currentValue = Object.prototype.hasOwnProperty.call(currentOverrides, editingCell.languageCode)
      ? (currentOverrides[editingCell.languageCode] ?? "")
      : baseValue;
    if (editingCellValue === currentValue) {
      setEditingCell(null);
      return;
    }

    const nextOverrides = { ...currentOverrides };
    const currentHistory = region?.translationOverrideHistory ?? {};
    const hasCurrentLanguageHistory = Object.prototype.hasOwnProperty.call(currentHistory, editingCell.languageCode);
    const currentLanguageHistory = hasCurrentLanguageHistory
      ? (currentHistory[editingCell.languageCode] ?? [])
      : currentValue !== baseValue
        ? [baseValue]
        : [];
    const nextLanguageHistory = [...currentLanguageHistory, currentValue];
    const nextHistory = {
      ...currentHistory,
      [editingCell.languageCode]: nextLanguageHistory,
    };

    if (editingCellValue === baseValue) {
      delete nextOverrides[editingCell.languageCode];
    } else {
      nextOverrides[editingCell.languageCode] = editingCellValue;
    }

    recordRegionHistory(activeRegions);
    updateRegion(editingCell.regionId, {
      translationOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      translationOverrideHistory: nextHistory,
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

    interactionHistoryRecordedRef.current = false;
    duplicateMoveAxisRef.current = undefined;
    setInteraction({ mode: "draw", startX: point.x, startY: point.y, beforeRegions: cloneRegions(activeRegions) });
    setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function getResizeEdges(event: React.PointerEvent<HTMLButtonElement>): ResizeEdges {
    const rect = event.currentTarget.getBoundingClientRect();
    const threshold = Math.min(8, Math.max(4, Math.min(rect.width, rect.height) / 3));

    return {
      top: event.clientY - rect.top <= threshold,
      right: rect.right - event.clientX <= threshold,
      bottom: rect.bottom - event.clientY <= threshold,
      left: event.clientX - rect.left <= threshold,
    };
  }

  function getResizeCursor(edges: ResizeEdges) {
    if ((edges.top && edges.left) || (edges.bottom && edges.right)) return "nwse-resize";
    if ((edges.top && edges.right) || (edges.bottom && edges.left)) return "nesw-resize";
    if (edges.top || edges.bottom) return "ns-resize";
    if (edges.left || edges.right) return "ew-resize";
    return "move";
  }

  function updateRegionCursor(event: React.PointerEvent<HTMLButtonElement>) {
    if (!isEditing) return;
    if (event.altKey) {
      event.currentTarget.style.cursor = "copy";
      return;
    }
    event.currentTarget.style.cursor = getResizeCursor(getResizeEdges(event));
  }

  function suppressNextRegionClick(regionId: string) {
    suppressedRegionClickRef.current = regionId;
    window.setTimeout(() => {
      if (suppressedRegionClickRef.current === regionId) {
        suppressedRegionClickRef.current = undefined;
      }
    }, 0);
  }

  function consumeSuppressedRegionClick(regionId: string) {
    if (suppressedRegionClickRef.current !== regionId) return false;
    suppressedRegionClickRef.current = undefined;
    return true;
  }

  function startRegionInteraction(event: React.PointerEvent<HTMLButtonElement>, region: TextRegion) {
    if (!isEditing) return;
    event.stopPropagation();
    const point = toPointFromReactEvent(event);
    if (!point) return;
    const initial = { x: region.x, y: region.y, width: region.width, height: region.height };
    const beforeRegions = cloneRegions(activeRegions);

    if (event.altKey) {
      duplicateMoveAxisRef.current = undefined;
      const now = new Date().toISOString();
      const duplicate: TextRegion = {
        ...region,
        id: createId("region"),
        visibleText: "",
        translationItemId: undefined,
        translationOverrides: undefined,
        translationOverrideHistory: undefined,
        status: "unlinked",
        memo: "",
        createdAt: now,
        updatedAt: now,
      };

      if (mode === "add") {
        setDraftRegions((regions) => [...regions, duplicate]);
      } else if (editDraftRegions) {
        setEditDraftRegions((regions) => [...(regions ?? []), duplicate]);
      } else {
        setAppState((state) => ({ ...state, regions: [...state.regions, duplicate] }));
      }

      recordRegionHistory(beforeRegions);
      interactionHistoryRecordedRef.current = true;
      suppressNextRegionClick(region.id);
      setSelectedRegionId(duplicate.id);
      setInteraction({
        mode: "move",
        regionId: duplicate.id,
        startX: point.x,
        startY: point.y,
        initial,
        beforeRegions,
        duplicatedRegion: duplicate,
        constrainAxis: event.shiftKey,
      });
      return;
    }

    const edges = getResizeEdges(event);
    const isResize = edges.top || edges.right || edges.bottom || edges.left;

    interactionHistoryRecordedRef.current = false;
    duplicateMoveAxisRef.current = undefined;
    setSelectedRegionId(region.id);
    if (isResize) {
      setInteraction({
        mode: "resize",
        regionId: region.id,
        startX: point.x,
        startY: point.y,
        initial,
        beforeRegions,
        edges,
      });
      return;
    }

    setInteraction({
      mode: "move",
      regionId: region.id,
      startX: point.x,
      startY: point.y,
      initial,
      beforeRegions,
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

    const letterboxHeight = getImageLetterboxHeight(currentScreen);

    return (
      <div className="image-frame" style={{ width: isEditing ? "100%" : "360px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={currentScreen.imageUrl} alt={currentScreen.name} />
        {letterboxHeight > 0 ? (
          <div className="image-letterbox" style={{ aspectRatio: `${currentScreen.imageWidth} / ${letterboxHeight}` }}>
            <span>이전 이미지 영역</span>
          </div>
        ) : null}
        <div ref={overlayRef} className="region-layer" onPointerDown={startDrawing}>
          {regionsForScreen.filter(isScreenRegion).map((region) => {
            const linked = Boolean(region.translationItemId);
            const selected = region.id === selectedRegionId;

            return (
              <button
                type="button"
                key={region.id}
                data-region-id={region.id}
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
                onPointerMove={updateRegionCursor}
                onPointerLeave={(event) => {
                  if (isEditing) event.currentTarget.style.cursor = "move";
                }}
                onPointerDown={(event) => startRegionInteraction(event, region)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (consumeSuppressedRegionClick(region.id)) return;
                  if (isEditing) {
                    openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
                    window.requestAnimationFrame(() => scrollTableRowIntoView(region.id));
                    if (!region.visibleText && ocrByRegion[region.id]?.status !== "running") {
                      void runOcrForRegion(region);
                    }
                    return;
                  }
                  selectRegionFromScreen(region);
                }}
                aria-label={region.visibleText || "텍스트 영역"}
                title={region.visibleText || "텍스트 영역"}
              />
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

    const previewRegions = mode === "add" ? draftRegions : editDraftRegions ?? regionsForScreen;
    const coordinateImage = imageDraft;
    const letterboxHeight = getImageLetterboxHeight(coordinateImage);

    return (
      <div className="image-frame add-image-frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageDraft.imageUrl} alt={screenForm.name || imageDraft.fileName} />
        {letterboxHeight > 0 ? (
          <div className="image-letterbox" style={{ aspectRatio: `${coordinateImage.imageWidth} / ${letterboxHeight}` }}>
            <span>이전 이미지 영역</span>
          </div>
        ) : null}
        <div ref={overlayRef} className="region-layer" onPointerDown={startDrawing}>
          {previewRegions.filter(isScreenRegion).map((region) => {
            const linked = Boolean(region.translationItemId);
            const selected = region.id === selectedRegionId;

            return (
              <button
                type="button"
                key={region.id}
                data-region-id={region.id}
                data-region-selection-scope="true"
                className={`region-box ${selected ? "selected" : ""} ${linked ? "linked" : "unlinked"} editable`}
                style={{
                  left: `${(region.x / coordinateImage.imageWidth) * 100}%`,
                  top: `${(region.y / coordinateImage.imageHeight) * 100}%`,
                  width: `${(region.width / coordinateImage.imageWidth) * 100}%`,
                  height: `${(region.height / coordinateImage.imageHeight) * 100}%`,
                }}
                onPointerMove={updateRegionCursor}
                onPointerLeave={(event) => {
                  event.currentTarget.style.cursor = "move";
                }}
                onPointerDown={(event) => startRegionInteraction(event, region)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (consumeSuppressedRegionClick(region.id)) return;
                  openKeyDialog(region, { x: event.clientX + 12, y: event.clientY + 12 });
                  window.requestAnimationFrame(() => scrollTableRowIntoView(region.id));
                  if (!region.visibleText && ocrByRegion[region.id]?.status !== "running") {
                    void runOcrForRegion(region);
                  }
                }}
                aria-label={region.visibleText || "텍스트 영역"}
                title={region.visibleText || "텍스트 영역"}
              />
            );
          })}
          {draftRect ? (
            <div
              className="region-draft"
              style={{
                left: `${(draftRect.x / coordinateImage.imageWidth) * 100}%`,
                top: `${(draftRect.y / coordinateImage.imageHeight) * 100}%`,
                width: `${(draftRect.width / coordinateImage.imageWidth) * 100}%`,
                height: `${(draftRect.height / coordinateImage.imageHeight) * 100}%`,
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  function renderTranslationTable() {
    const canReorderRows = isEditing;

    const renderInsertControl = (insertIndex: number, position: "before" | "after" = "before") => {
      if (!canReorderRows) return null;

      return (
        <button
          type="button"
          className={`translation-row-insert-button translation-row-insert-${position}`}
          onClick={(event) => {
            event.stopPropagation();
            insertTableOnlyRegion(insertIndex, { x: event.clientX + 12, y: event.clientY + 12 });
          }}
          aria-label={`${insertIndex + 1}번째 위치에 Row 추가`}
          title="여기에 Row 추가"
        >
          <span aria-hidden="true" />
        </button>
      );
    };

    return (
      <div className="translation-table-wrap" ref={translationTableWrapRef}>
        {filteredRegions.length > 0 ? (
          <table className="translation-matrix">
            <thead>
              <tr>
                {canReorderRows ? <th className="translation-order-head" aria-label="순서 변경" /> : null}
                {LANGUAGE_DEFS.map((language) => (
                  <th key={language.code}>{language.label}</th>
                ))}
                <th className="translation-note-head">비고</th>
              </tr>
            </thead>
            <tbody>
              {filteredRegions.map((region, index) => {
                const item = region.translationItemId ? translationsById.get(region.translationItemId) : undefined;
                const selected = region.id === selectedRegionId;
                const activeRegionIndex = activeRegionIndexById.get(region.id) ?? -1;
                const insertIndex = activeRegionIndex >= 0 ? activeRegionIndex : index;

                return (
                  <tr
                    key={region.id}
                    data-region-id={region.id}
                    data-region-selection-scope="true"
                    ref={(element) => {
                      itemRefs.current[region.id] = element;
                    }}
                    className={`translation-data-row ${selected ? "selected" : ""} ${
                      draggedRegionId === region.id ? "dragging" : ""
                    } ${dragOverRegionId === region.id ? "drop-target" : ""}`}
                    onClick={(event) => selectRegionAndOpenKeyDialog(event, region)}
                    onContextMenu={(event) => openRowContextMenu(event, region)}
                    onDragOver={(event) => {
                      if (!canReorderRows || !draggedRegionId || draggedRegionId === region.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOverRegionId(region.id);
                    }}
                    onDragLeave={() => {
                      if (dragOverRegionId === region.id) setDragOverRegionId(undefined);
                    }}
                    onDrop={(event) => {
                      if (!canReorderRows || !draggedRegionId) return;
                      event.preventDefault();
                      reorderRegion(draggedRegionId, region.id);
                      setDraggedRegionId(undefined);
                      setDragOverRegionId(undefined);
                    }}
                  >
                    {canReorderRows ? (
                      <td className="translation-order-cell">
                        {renderInsertControl(insertIndex)}
                        {index === filteredRegions.length - 1
                          ? renderInsertControl(activeRegions.length, "after")
                          : null}
                          <button
                            type="button"
                            className="translation-drag-handle"
                            draggable
                            title="드래그해서 순서 변경"
                            aria-label="드래그해서 순서 변경"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectRegionFromTable(region);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => {
                              event.stopPropagation();
                              setDraggedRegionId(region.id);
                              setDragOverRegionId(undefined);
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", region.id);
                            }}
                            onDragEnd={() => {
                              setDraggedRegionId(undefined);
                              setDragOverRegionId(undefined);
                            }}
                          />
                      </td>
                    ) : null}
                      {LANGUAGE_DEFS.map((language) => {
                        const { baseValue, displayValue, hasOverride } = getCellValue(region, item, language.code);
                        const updateCandidates = item ? (updateCandidatesByItemId.get(item.id) ?? []) : [];
                        const isCellEditing =
                          editingCell?.regionId === region.id && editingCell.languageCode === language.code;
                        const editHistory = region.translationOverrideHistory?.[language.code] ?? [];
                        const hasModifiedHistory = hasOverride && editHistory.length > 0;

                        return (
                          <td
                            key={language.code}
                            className={`${!displayValue ? "missing" : ""} ${hasOverride ? "modified" : ""} ${
                              isCellEditing ? "editing" : ""
                            }`}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              cancelPendingRowKeyDialog();
                              if (!isEditing) {
                                void copyTextCellValue(displayValue, language.label);
                                return;
                              }

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
                                {language.code === "kr" && updateCandidates.length > 0 ? (
                                  <button
                                    type="button"
                                    className="translation-update-candidate-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setUpdateCandidateRegionId(region.id);
                                    }}
                                    onDoubleClick={(event) => event.stopPropagation()}
                                  >
                                    <span aria-hidden="true" />
                                    업데이트 후보 있음
                                  </button>
                                ) : null}
                                {hasModifiedHistory ? (
                                  <span
                                    className="translation-modified-tag"
                                    aria-label={`${language.label} 이전 기록: ${editHistory.join(", ")}`}
                                    tabIndex={0}
                                  >
                                    수정됨
                                    <span className="translation-modified-tooltip" role="tooltip">
                                      <span className="translation-modified-tooltip-label">이전 기록</span>
                                      <span className="translation-modified-tooltip-list">
                                        {editHistory.map((historyValue, historyIndex) => (
                                          <span className="translation-modified-tooltip-item" key={historyIndex}>
                                            <span className="translation-modified-tooltip-index">
                                              {historyIndex + 1}
                                            </span>
                                            <span className="translation-modified-tooltip-value">
                                              {historyValue || "기존 문구 없음"}
                                            </span>
                                          </span>
                                        ))}
                                      </span>
                                    </span>
                                  </span>
                                ) : null}
                              </>
                            )}
                          </td>
                        );
                      })}
                      <td className="translation-note-cell">
                        {isEditing ? (
                          <textarea
                            className="translation-note-editor"
                            value={region.memo}
                            onChange={(event) => updateRegion(region.id, { memo: event.target.value })}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedRegionId(region.id);
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}
                            placeholder="비고 입력"
                            aria-label="비고 입력"
                          />
                        ) : (
                          <span className={region.memo ? "translation-note-value" : "translation-note-value empty"}>
                            {region.memo || "-"}
                          </span>
                        )}
                      </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : canReorderRows ? (
          <button
            type="button"
            className="translation-empty-insert-button"
            onClick={(event) => insertTableOnlyRegion(0, { x: event.clientX + 12, y: event.clientY + 12 })}
          >
            Row 추가
          </button>
        ) : null}
        {filteredRegions.length === 0 ? (
          <div className="empty-list">이 조건에 맞는 텍스트 영역이 없습니다.</div>
        ) : null}
      </div>
    );
  }

  function renderRowContextMenu() {
    if (!rowContextMenu) return null;

    const region = activeRegions.find((candidate) => candidate.id === rowContextMenu.regionId);
    if (!region) return null;

    return (
      <div
        className="row-context-menu"
        style={{ left: rowContextMenu.x, top: rowContextMenu.y }}
        role="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setRowContextMenu(null);
            void copyTranslationRow(region);
          }}
        >
          Row 복사
        </button>
        {isEditing ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRowContextMenu(null);
              void pasteTranslationRow(region);
            }}
          >
            Row 붙여넣기
          </button>
        ) : null}
      </div>
    );
  }

  function getMatchedLanguagePreview(item: TranslationItem, matchType: string) {
    if (matchType.startsWith("key ")) {
      return { label: "key", value: item.key };
    }

    const language = LANGUAGE_DEFS.find(({ label }) => matchType.startsWith(`${label} `));
    if (!language) return undefined;

    return {
      label: language.label,
      value: item[language.code],
    };
  }

  function getDisplayTranslationKey(item: TranslationItem) {
    const rowKeyMatch = item.key.match(/(?:^|_)row_(\d+)$/);
    if (item.rawData?.internalKey === item.key && rowKeyMatch) {
      return `자동 row_${rowKeyMatch[1]}`;
    }

    return item.key;
  }

  function getReadableMatchType(matchType: string) {
    return matchType === "fuzzy match" ? "유사 일치" : matchType;
  }

  function renderKeyDialog() {
    if (!keyDialogRegionId || !keyDialogAnchor) return null;

    const dialogRegion = activeRegions.find((region) => region.id === keyDialogRegionId);
    if (!dialogRegion) return null;

    const linkedItem = dialogRegion.translationItemId
      ? translationsById.get(dialogRegion.translationItemId)
      : undefined;
    const pendingItem = pendingTranslationItemId ? translationsById.get(pendingTranslationItemId) : undefined;
    const ocrState = ocrByRegion[dialogRegion.id];
    const candidateRows = searchQuery.trim()
      ? [...searchCandidates].sort((left, right) => {
          const leftIsFuzzy = left.matchType === "fuzzy match";
          const rightIsFuzzy = right.matchType === "fuzzy match";
          if (leftIsFuzzy !== rightIsFuzzy) return leftIsFuzzy ? 1 : -1;

          const leftLinkedCount = linkedTranslationUsage.get(left.item.id) ?? 0;
          const rightLinkedCount = linkedTranslationUsage.get(right.item.id) ?? 0;
          if (leftLinkedCount !== rightLinkedCount) return rightLinkedCount - leftLinkedCount;

          return right.score - left.score || left.item.key.localeCompare(right.item.key);
        })
      : [];

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
          <p>
            {ocrState?.status === "running"
              ? "OCR 인식 중..."
              : ocrState?.status === "success"
                ? `OCR 완료${ocrState.confidence === undefined ? "" : ` · 신뢰도 ${ocrState.confidence}%`}`
                : ocrState?.status === "failed"
                  ? "OCR 실패 · 수동 검색으로 연결하세요"
                  : "OCR 결과 또는 검색어로 후보를 찾습니다"}
          </p>
        </div>

        <label className="key-dialog-search">
          <span aria-hidden="true" />
          <input
            value={translationQuery}
            onChange={(event) => {
              const text = event.target.value;
              setTranslationQuery(text);
              updateRegion(dialogRegion.id, { visibleText: text });
            }}
            placeholder="OCR 결과 또는 검색어 입력"
          />
        </label>

        <div className="dialog-results">
          {candidateRows.map(({ item, matchType }) => {
            const source = sourceById.get(item.sourceId);
            const duplicate = isDuplicateCandidate(item, searchableTranslations);
            const linkedCount = linkedTranslationUsage.get(item.id) ?? 0;
            const matchedPreview = getMatchedLanguagePreview(item, matchType);
            const shouldShowMatchedPreview =
              matchedPreview && matchedPreview.value && matchedPreview.label !== "KR";
            const shouldShowEnglish = item.en && matchedPreview?.label !== "EN";
            const displayKey = getDisplayTranslationKey(item);
            const readableMatchType = getReadableMatchType(matchType);

            return (
              <button
                type="button"
                key={item.id}
                className={`key-result-row ${item.id === pendingTranslationItemId ? "selected" : ""}`}
                onClick={() => setPendingTranslationItemId(item.id)}
              >
                <div className="key-result-title">
                  <span title={item.key}>{displayKey}</span>
                  <div className="key-result-tags">
                    {linkedCount > 0 ? (
                      <small className="key-linked-badge" title={`${linkedCount}개 텍스트 영역에 연결됨`}>
                        <i aria-hidden="true" />
                        연결됨
                      </small>
                    ) : null}
                    {duplicate ? <small className="key-duplicate-badge">중복</small> : null}
                  </div>
                </div>
                <strong className="key-result-kr">
                  <span>KR: {item.kr || "없음"}</span>
                </strong>
                <div className="key-result-values">
                  {shouldShowMatchedPreview ? (
                    <span>
                      {matchedPreview.label}: {matchedPreview.value}
                    </span>
                  ) : null}
                  {shouldShowEnglish ? <span>EN: {item.en}</span> : null}
                </div>
                <em>
                  {source?.fileName ?? "알 수 없는 소스"} · {readableMatchType}
                  {linkedCount > 0 ? ` · ${linkedCount}개 영역에서 사용` : ""}
                </em>
              </button>
            );
          })}
          {candidateRows.length === 0 ? (
            <div className="empty-list">
              {searchQuery.trim() ? "검색 결과가 없습니다." : "OCR 결과를 기다리거나 직접 검색어를 입력하세요."}
            </div>
          ) : null}
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
            const groupDragItem: MenuDragItem = { type: "group", group };
            const isGroupDragging = draggedMenuItem?.type === "group" && draggedMenuItem.group === group;
            const groupDropPosition =
              menuDropTarget?.type === "group" && menuDropTarget.group === group
                ? menuDropTarget.position
                : undefined;

            return (
              <section className={`screen-group ${isGroupDragging ? "dragging" : ""}`} key={group}>
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
                      className={`screen-group-toggle ${
                        groupDropPosition ? `drop-${groupDropPosition}` : ""
                      }`}
                      draggable
                      onClick={() => setOpenGroups((groups) => ({ ...groups, [group]: !expanded }))}
                      onDragStart={(event) => {
                        setDraggedMenuItem(groupDragItem);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", `group:${group}`);
                      }}
                      onDragOver={(event) => {
                        if (draggedMenuItem?.type !== "group" || draggedMenuItem.group === group) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setMenuDropTarget({ ...groupDragItem, position: getMenuDropPosition(event) });
                      }}
                      onDragLeave={() => {
                        if (menuDropTarget?.type === "group" && menuDropTarget.group === group) {
                          setMenuDropTarget(null);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleMenuDrop({ ...groupDragItem, position: getMenuDropPosition(event) });
                      }}
                      onDragEnd={() => {
                        setDraggedMenuItem(null);
                        setMenuDropTarget(null);
                      }}
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
                      <strong>{group}</strong>
                      <em>{screens.length}</em>
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
                      const active = screen.id === selectedScreenId;
                      const screenDragItem: MenuDragItem = { type: "screen", screenId: screen.id, group };
                      const isScreenDragging =
                        draggedMenuItem?.type === "screen" && draggedMenuItem.screenId === screen.id;
                      const isScreenDropTarget =
                        menuDropTarget?.type === "screen" && menuDropTarget.screenId === screen.id;
                      const screenDropPosition = isScreenDropTarget ? menuDropTarget.position : undefined;

                      return (
                        <button
                          type="button"
                          key={screen.id}
                          className={`screen-list-item ${active ? "active" : ""} ${
                            isScreenDragging ? "dragging" : ""
                          } ${screenDropPosition ? `drop-${screenDropPosition}` : ""}`}
                          draggable
                          onDragStart={(event) => {
                            setDraggedMenuItem(screenDragItem);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", `screen:${screen.id}`);
                          }}
                          onDragOver={(event) => {
                            if (
                              draggedMenuItem?.type !== "screen" ||
                              draggedMenuItem.group !== group ||
                              draggedMenuItem.screenId === screen.id
                            ) {
                              return;
                            }

                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setMenuDropTarget({ ...screenDragItem, position: getMenuDropPosition(event) });
                          }}
                          onDragLeave={() => {
                            if (menuDropTarget?.type === "screen" && menuDropTarget.screenId === screen.id) {
                              setMenuDropTarget(null);
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            handleMenuDrop({ ...screenDragItem, position: getMenuDropPosition(event) });
                          }}
                          onDragEnd={() => {
                            setDraggedMenuItem(null);
                            setMenuDropTarget(null);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setDeleteTarget({ type: "screen", screenId: screen.id, name: screen.name });
                          }}
                          onClick={() => {
                            setSelectedScreenId(screen.id);
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

    const enabledSources = translationSources.filter((source) => source.enabled !== false);
    const disabledSources = translationSources.filter((source) => source.enabled === false);
    const renderSourceRow = (source: TranslationSource, index: number) => {
      const sourceId = getSourceId(source);
      const linkedCount = linkedSourceUsage.get(sourceId) ?? 0;
      const duplicateCount = sourceDuplicateCountById.get(sourceId) ?? 0;
      const sourceMeta = [
        `${getSourceItemCount(source).toLocaleString()}개`,
        linkedCount > 0 ? `연결 ${linkedCount.toLocaleString()}개` : "연결 없음",
        getSourceImportedAt(source).slice(0, 10),
        duplicateCount > 1 ? `동일 ID ${duplicateCount}개` : "",
      ].filter(Boolean);

      return (
        <div className={`source-row ${source.enabled === false ? "disabled" : ""}`} key={`${sourceId}:${index}`}>
          <button
            type="button"
            className="source-main"
            onClick={() => toggleTranslationSource(sourceId)}
            title={source.enabled === false ? "비활성화됨" : "활성화됨"}
          >
            <span className="source-chip">{source.fileType}</span>
            <span className="source-name">{formatSourceName(source.fileName)}</span>
            <span className="source-meta-small">
              {sourceMeta.join(" · ")}
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
    };

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
            accept={TRANSLATION_ACCEPT}
            onChange={(event) => handleTranslationFileUpload(event.target.files?.[0])}
          />

          <div className="source-list">
            {enabledSources.map(renderSourceRow)}
            {disabledSources.length > 0 ? (
              <div className="source-disabled-section">
                <button
                  type="button"
                  className="source-disabled-toggle"
                  onClick={() => setDisabledSourcesOpen((isOpen) => !isOpen)}
                  aria-expanded={disabledSourcesOpen}
                >
                  <span className="source-disabled-chevron">
                    <SelectChevronIcon />
                  </span>
                  <span>비활성화한 파일</span>
                  <em>{disabledSources.length.toLocaleString()}개</em>
                </button>
                {disabledSourcesOpen ? (
                  <div className="source-disabled-list">
                    {disabledSources.map((source, index) => renderSourceRow(source, index))}
                  </div>
                ) : null}
              </div>
            ) : null}
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

  function renderUpdateCandidateDialog() {
    if (!updateCandidateRegionId) return null;

    const region = activeRegions.find((candidate) => candidate.id === updateCandidateRegionId);
    const currentItem = region?.translationItemId ? translationsById.get(region.translationItemId) : undefined;
    const candidates = currentItem ? (updateCandidatesByItemId.get(currentItem.id) ?? []) : [];

    if (!region || !currentItem || candidates.length === 0) return null;

    return (
      <div
        className="update-candidate-modal-backdrop"
        role="presentation"
        onClick={() => setUpdateCandidateRegionId(undefined)}
      >
        <section
          className="update-candidate-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-candidate-modal-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="update-candidate-modal-head">
            <div>
              <h2 id="update-candidate-modal-title">업데이트 후보</h2>
              <p>동일 key의 최신 번역 소스가 있습니다. 교체 전까지 기존 연결은 유지됩니다.</p>
            </div>
            <button
              type="button"
              className="update-candidate-modal-close"
              onClick={() => setUpdateCandidateRegionId(undefined)}
              aria-label="업데이트 후보 닫기"
            >
              ×
            </button>
          </header>

          <div className="update-candidate-current">
            <span>현재 연결</span>
            <strong>{currentItem.key}</strong>
            <em>{sourceById.get(currentItem.sourceId)?.fileName ?? "알 수 없는 소스"}</em>
          </div>

          <div className="update-candidate-list">
            {candidates.map((candidate) => {
              const source = sourceById.get(candidate.sourceId);

              return (
                <article className="update-candidate-item" key={candidate.id}>
                  <div className="update-candidate-item-head">
                    <div>
                      <span>동일 key 최신 소스 존재</span>
                      <strong>{candidate.key}</strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => replaceRegionTranslationItem(region.id, candidate)}
                    >
                      이 항목으로 교체
                    </button>
                  </div>
                  <dl>
                    <div>
                      <dt>KR</dt>
                      <dd>{candidate.kr || "-"}</dd>
                    </div>
                    <div>
                      <dt>EN</dt>
                      <dd>{candidate.en || "-"}</dd>
                    </div>
                    <div>
                      <dt>source</dt>
                      <dd>{source?.fileName ?? "알 수 없는 소스"}</dd>
                    </div>
                    <div>
                      <dt>importedAt</dt>
                      <dd>{formatImportedAt(source ? getSourceImportedAt(source) : candidate.createdAt)}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  function renderPersistenceStatus(placement: "floating" | "header" = "floating") {
    if (persistenceStatus.phase === "ready") return null;

    if (placement === "header" && persistenceStatus.phase === "loading") {
      return (
        <div className="supabase-loading-status" role="status" aria-live="polite">
          <SupabaseLoadingLogo />
          <span>데이터 불러오는 중</span>
        </div>
      );
    }

    if (placement === "header" && persistenceStatus.phase === "saving") {
      return (
        <div className="supabase-loading-status" role="status" aria-live="polite">
          <SupabaseLoadingLogo />
          <span>데이터 저장 중</span>
        </div>
      );
    }

    const canRetrySave = isLoaded && persistenceStatus.recovery === "save";
    const shouldReload = isLoaded && persistenceStatus.recovery === "reload";

    return (
      <div
        className={`persistence-status persistence-status-${persistenceStatus.phase} persistence-status-${placement}`}
        role={persistenceStatus.phase === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        <span className="persistence-status-indicator" aria-hidden="true" />
        <span>{persistenceStatus.message}</span>
        {canRetrySave ? (
          <button
            type="button"
            onClick={() => {
              showNextSaveFeedbackRef.current = true;
              setPersistenceRetryVersion((version) => version + 1);
            }}
          >
            다시 저장
          </button>
        ) : null}
        {shouldReload ? (
          <button type="button" onClick={() => window.location.reload()}>
            최신 데이터 불러오기
          </button>
        ) : null}
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

  function renderSaveConflictDialog() {
    if (!saveConflictOpen) return null;

    return (
      <div className="confirm-modal-backdrop" role="presentation" onClick={() => setSaveConflictOpen(false)}>
        <section
          className="confirm-modal save-conflict-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-conflict-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="save-conflict-title">최신 데이터가 먼저 저장되었습니다.</h2>
          <p>
            현재 브라우저가 이전 데이터를 기준으로 열려 있어 저장을 중단했습니다. 기존 작업을 덮어쓰지 않으려면
            최신 데이터를 불러온 뒤 다시 작업해주세요.
          </p>
          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={() => setSaveConflictOpen(false)}>
              현재 화면 유지
            </button>
            <button type="button" className="confirm-primary" onClick={() => window.location.reload()}>
              최신 데이터 불러오기
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderRegionDeleteConfirmDialog() {
    if (!regionDeleteTargetId || !isEditing) return null;

    return (
      <div
        className="confirm-modal-backdrop"
        role="presentation"
        data-region-selection-scope="true"
        onClick={() => setRegionDeleteTargetId(undefined)}
      >
        <section
          className="confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="region-delete-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="region-delete-confirm-title">삭제하시겠습니까?</h2>
          <p>선택한 텍스트 영역이 삭제됩니다.</p>
          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={() => setRegionDeleteTargetId(undefined)}>
              취소
            </button>
            <button type="button" className="confirm-delete" onClick={confirmDeleteSelectedRegion}>
              삭제
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderEditorLeaveConfirmDialog() {
    if (!leaveConfirmOpen || !isEditing) return null;

    return (
      <div className="confirm-modal-backdrop" role="presentation" onClick={() => setLeaveConfirmOpen(false)}>
        <section
          className="confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="editor-leave-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="editor-leave-confirm-title">저장하지 않고 나가시겠습니까?</h2>
          <p>변경한 내용은 저장되지 않습니다.</p>
          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={() => setLeaveConfirmOpen(false)}>
              취소
            </button>
            <button type="button" className="confirm-delete" onClick={leaveEditorMode}>
              나가기
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
          accept={IMAGE_ACCEPT}
          onChange={(event) => {
            handleImageFileInput(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />

        <div className="add-mode-title">
          <button type="button" className="add-back-button" onClick={requestLeaveEditorMode} aria-label="뒤로가기">
            <BackArrowIcon />
          </button>
          <h1>{isEditMode ? "화면 수정" : "화면 추가"}</h1>
        </div>

        <section
          ref={(element) => {
            imageViewportRef.current = element;
          }}
          className={`add-screen-pane ${hasScreenImage ? "has-image" : ""}`}
        >
          {hasScreenImage ? (
            <button
              type="button"
              className="add-image-replace-button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => imageFileInputRef.current?.click()}
            >
              교체
            </button>
          ) : null}
          {imageDraft ? (
            renderAddScreenPreview()
          ) : isEditMode && currentScreen ? (
            renderScreenImage()
          ) : (
            <div className="add-upload-empty">
              <p>
                텍스트 영역을 지정할 화면을
                <br />
                업로드하거나 붙여넣어주세요.
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
              <span>그룹</span>
              <div className="add-select-shell">
                <select
                  value={screenForm.group}
                  onChange={(event) => setScreenForm((form) => ({ ...form, group: event.target.value }))}
                >
                  {groupOptions.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
                <SelectChevronIcon />
              </div>
            </label>

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
            {hasRegions ? (
              renderTranslationTable()
            ) : (
              <div className="add-empty-guide">
                <div className="add-empty-guide-content">
                  <ol className="add-empty-steps">
                    {[
                      { icon: "/figma/step-1.svg", text: "화면을 업로드하고" },
                      { icon: "/figma/step-2.svg", text: "텍스트 영역 지정 or Row 추가 후" },
                      { icon: "/figma/step-3.svg", text: "Key 연결 or 직접 입력할 수 있어요." },
                    ].map((step, index) => (
                      <li key={step.icon}>
                        <span className="add-empty-step-asset" aria-hidden="true">
                          <span className="add-empty-step-number">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={step.icon} alt="" />
                          </span>
                          {index < 2 ? <span className="add-empty-step-bar" /> : null}
                        </span>
                        <span className="add-empty-step-copy">{step.text}</span>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className="add-empty-row-button"
                    onClick={(event) =>
                      insertTableOnlyRegion(0, { x: event.clientX + 12, y: event.clientY + 12 })
                    }
                  >
                    Row 추가
                  </button>
                </div>
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
          <div className="topbar-actions">
            {renderPersistenceStatus("header")}
            {renderGlobalSearch()}
            <button type="button" className="translation-source-button" onClick={() => setSourceDialogOpen(true)}>
              번역 데이터 관리
            </button>
          </div>
        </header>
      ) : null}

      {mode !== "view" ? renderPersistenceStatus() : null}
      {copyFeedback ? (
        <div className="copy-feedback-toast" role="status" aria-live="polite">
          {copyFeedback.message}
        </div>
      ) : null}
      {renderRowContextMenu()}

      {!isLoaded ? (
        <section className="persistence-loading-view" aria-label="저장 데이터 로드 중">
          <span aria-hidden="true" />
          <strong>저장 데이터를 불러오는 중입니다.</strong>
        </section>
      ) : mode === "view" ? (
        <section className="view-workspace">
          {currentScreen ? (
            <>
              {renderViewSidebar()}

              <section className="canvas-panel">
                <div
                  ref={(element) => {
                    imageViewportRef.current = element;
                  }}
                  className="image-stage"
                >
                  {renderScreenImage()}
                </div>
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
                <span>그룹과 화면을 추가하면 표시돼요.</span>
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
                <button type="button" className="button secondary" onClick={requestLeaveEditorMode}>
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
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  onChange={(event) => {
                    handleImageFileInput(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
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
                    accept={TRANSLATION_ACCEPT}
                    onChange={(event) => {
                      void handleTranslationFileUpload(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }}
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
            <div
              ref={(element) => {
                imageViewportRef.current = element;
              }}
              className={`image-stage ${isEditing && editableImage ? "is-drawing" : ""}`}
            >
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
                  const linkedCount = linkedTranslationUsage.get(item.id) ?? 0;

                  return (
                    <button
                      type="button"
                      key={item.id}
                      className="result-row"
                      disabled={!selectedRegion}
                      onClick={() => connectSelectedRegion(item)}
                    >
                      <div className="result-row-title">
                        <strong>{item.key}</strong>
                        {linkedCount > 0 ? (
                          <small className="key-linked-badge" title={`${linkedCount}개 텍스트 영역에 연결됨`}>
                            <i aria-hidden="true" />
                            연결됨
                          </small>
                        ) : null}
                      </div>
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
      {renderUpdateCandidateDialog()}
      {renderDeleteConfirmDialog()}
      {renderSaveConflictDialog()}
      {renderRegionDeleteConfirmDialog()}
      {renderEditorLeaveConfirmDialog()}
    </main>
  );
}
