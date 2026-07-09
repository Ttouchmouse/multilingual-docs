export const LANGUAGE_DEFS = [
  { code: "kr", label: "KR", sourceHeader: "Korean", name: "한국어" },
  { code: "en", label: "EN", sourceHeader: "English", name: "영어" },
  { code: "sc", label: "SC", sourceHeader: "Chinese", name: "중국어 간체" },
  { code: "tc", label: "TC", sourceHeader: "Taiwan", name: "중국어 번체" },
  { code: "es", label: "ESP", sourceHeader: "Spanish", name: "스페인어" },
  { code: "it", label: "IT", sourceHeader: "Italian", name: "이탈리아어" },
  { code: "pt", label: "POR", sourceHeader: "Portuguese", name: "포르투갈어" },
  { code: "de", label: "DE", sourceHeader: "German", name: "독일어" },
  { code: "fr", label: "FR", sourceHeader: "French", name: "프랑스어" },
  { code: "jp", label: "JA", sourceHeader: "Japanese", name: "일본어" },
  { code: "th", label: "TH", sourceHeader: "Thai", name: "태국어" },
] as const;

export type LanguageCode = (typeof LANGUAGE_DEFS)[number]["code"];

export type TranslationItem = {
  id: string;
  sourceId: string;
  key: string;
  rawData?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
} & Record<LanguageCode, string>;

export type TranslationSource = {
  sourceId: string;
  fileName: string;
  fileType: "html" | "xlsx" | "csv";
  importedAt: string;
  itemCount: number;
  enabled: boolean;
  id?: string;
  uploadedAt?: string;
  parsedAt?: string;
  totalCount?: number;
  status: "uploaded" | "parsing" | "parsed" | "failed";
  errorMessage?: string;
};

export type TextRegionStatus =
  | "unlinked"
  | "linked"
  | "needs_check"
  | "missing_translation"
  | "needs_revision";

export type Screen = {
  id: string;
  name: string;
  group: string;
  platform: "mobile_web" | "pc_web" | "app" | "common";
  baseLanguage: LanguageCode;
  figmaUrl: string;
  imageUrl: string;
  imageStoragePath?: string;
  imageWidth: number;
  imageHeight: number;
  imageContentWidth?: number;
  imageContentHeight?: number;
  memo: string;
  createdAt: string;
  updatedAt: string;
};

export type TextRegion = {
  id: string;
  screenId: string;
  visibleText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  translationItemId?: string;
  translationOverrides?: Partial<Record<LanguageCode, string>>;
  translationOverrideHistory?: Partial<Record<LanguageCode, string[]>>;
  status: TextRegionStatus;
  memo: string;
  createdAt: string;
  updatedAt: string;
};

export type AppState = {
  source?: TranslationSource;
  sources?: TranslationSource[];
  groups?: string[];
  screens: Screen[];
  regions: TextRegion[];
  activeScreenId?: string;
};

export const STATUS_LABELS: Record<TextRegionStatus, string> = {
  unlinked: "미연결",
  linked: "연결 완료",
  needs_check: "확인 필요",
  missing_translation: "번역 누락",
  needs_revision: "수정 필요",
};

export const SCREEN_GROUPS = [
  "payment",
  "subscription",
  "adult_verification",
  "cookie",
  "login",
  "signup",
  "viewer",
  "event",
  "mypage",
  "account",
  "common",
  "etc",
];
