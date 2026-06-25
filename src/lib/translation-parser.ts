import * as XLSX from "xlsx";
import { LANGUAGE_DEFS, type LanguageCode, type TranslationItem, type TranslationSource } from "./types";

export type TranslationMatchType =
  | `${(typeof LANGUAGE_DEFS)[number]["label"]} 완전 일치`
  | `${(typeof LANGUAGE_DEFS)[number]["label"]} 부분 일치`
  | "key 완전 일치"
  | "fuzzy match";

export type TranslationCandidate = {
  item: TranslationItem;
  matchType: TranslationMatchType;
  score: number;
};

const KEY_HEADERS = new Set(["키", "key", "id"]);
const LANGUAGE_HEADER_PATTERNS: Record<LanguageCode, RegExp[]> = {
  kr: [/^korean$/, /^kr$/, /한국어?$/, /^한글$/],
  en: [/^english$/, /^en$/, /영어/],
  sc: [/^chinese$/, /^sc$/, /간체/, /중국어/],
  tc: [/^taiwan$/, /^tc$/, /번체/],
  es: [/^spanish$/, /^es$/, /스페인어/, /spanish/, /la\(mx\)/],
  it: [/^italian$/, /^it$/, /이탈리아어/, /italian/],
  pt: [/^portuguese$/, /^pt$/, /포르투갈어/, /portuguese/],
  de: [/^german$/, /^de$/, /독일어/, /german/],
  fr: [/^french$/, /^fr$/, /프랑스어/, /french/],
  jp: [/^japanese$/, /^jp$/, /일본어/, /japanese/],
  th: [/^thai$/, /^th$/, /태국어/, /thai/],
};

type TranslationFileType = TranslationSource["fileType"];

function normalizeHeader(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/_/g, " ").toLowerCase();
}

function normalizeSearchText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function compactSearchText(value: string) {
  return normalizeSearchText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function levenshteinDistance(a: string, b: string) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function similarity(a: string, b: string) {
  const left = compactSearchText(a);
  const right = compactSearchText(b);
  const length = Math.max(left.length, right.length);
  if (length === 0) return 0;
  return 1 - levenshteinDistance(left, right) / length;
}

function textFromCell(cell: Element) {
  return (cell.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

function getFileType(fileName: string): TranslationFileType {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "xlsx") return "xlsx";
  if (extension === "csv") return "csv";
  return "html";
}

function createRandomToken() {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return Math.random().toString(36).slice(2, 8);
}

function createSourceId(fileName: string, importedAt: string) {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  const normalized = baseName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_가-힣]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const timestamp = importedAt.replace(/[-:.]/g, "").replace("T", "_").slice(0, 16);
  const uniqueSuffix = `${timestamp}_${createRandomToken()}`;

  return `${normalized || "src"}_${uniqueSuffix}`;
}

function createSource(fileName: string, fileType = getFileType(fileName)): TranslationSource {
  const now = new Date().toISOString();
  const sourceId = createSourceId(fileName, now);

  return {
    sourceId,
    id: sourceId,
    fileName,
    fileType,
    importedAt: now,
    uploadedAt: now,
    parsedAt: now,
    itemCount: 0,
    totalCount: 0,
    enabled: true,
    status: "parsed",
  };
}

function resolveLanguageIndexes(headers: string[]) {
  const languageIndexes = new Map<LanguageCode, number>();

  for (const language of LANGUAGE_DEFS) {
    const patterns = LANGUAGE_HEADER_PATTERNS[language.code];
    const index = headers.findIndex((header) => {
      const normalized = normalizeHeader(header);
      return normalized === normalizeHeader(language.sourceHeader) || patterns.some((pattern) => pattern.test(normalized));
    });
    if (index >= 0) languageIndexes.set(language.code, index);
  }

  return languageIndexes;
}

function findHeaderRowIndex(rows: string[][]) {
  let bestIndex = -1;
  let bestScore = 0;

  rows.slice(0, 50).forEach((row, index) => {
    const languageCount = resolveLanguageIndexes(row).size;
    const hasNumberColumn = row.some((cell) => ["번호", "no", "number"].includes(normalizeHeader(cell)));
    const hasFrameColumn = row.some((cell) => ["프레임", "frame"].includes(normalizeHeader(cell)));
    const score = languageCount * 10 + (hasNumberColumn ? 1 : 0) + (hasFrameColumn ? 1 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= 10 ? bestIndex : -1;
}

function parseRowsWithDetectedHeader(source: TranslationSource, rows: string[][], rowNumberOffset = 0) {
  const headerIndex = findHeaderRowIndex(rows);
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map((cell) => String(cell ?? "").trim());
  const bodyRows = rows
    .slice(headerIndex + 1)
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some(Boolean));

  return buildItemsFromRows(source, headers, bodyRows, { generateMissingKeys: true, rowNumberOffset });
}

function buildItemsFromRows(
  source: TranslationSource,
  headers: string[],
  rows: string[][],
  options?: { generateMissingKeys?: boolean; rowNumberOffset?: number },
): TranslationItem[] {
  const keyIndex = headers.findIndex((header) => KEY_HEADERS.has(normalizeHeader(header)));
  if (keyIndex < 0 && !options?.generateMissingKeys) return [];

  const languageIndexes = resolveLanguageIndexes(headers);
  if (languageIndexes.size === 0) return [];

  const now = source.importedAt;
  const items: TranslationItem[] = [];
  const seenIds = new Map<string, number>();
  const rowNumberOffset = options?.rowNumberOffset ?? 0;

  for (const [rowIndex, row] of rows.entries()) {
    const generatedKey = `${source.sourceId}_row_${String(rowNumberOffset + rowIndex + 1).padStart(3, "0")}`;
    const key = keyIndex >= 0 ? (row[keyIndex] ?? "").trim() || generatedKey : generatedKey;
    if (!key) continue;

    const rawData: Record<string, string> = {};
    headers.forEach((header, index) => {
      rawData[header || `column_${index}`] = row[index] ?? "";
    });
    if (keyIndex < 0 || !(row[keyIndex] ?? "").trim()) {
      rawData.internalKey = key;
    }

    const baseId = `${source.sourceId}:${key}`;
    const duplicateCount = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, duplicateCount + 1);

    const item: TranslationItem = {
      id: duplicateCount === 0 ? baseId : `${baseId}:${duplicateCount + 1}`,
      sourceId: source.sourceId,
      key,
      kr: "",
      en: "",
      sc: "",
      tc: "",
      es: "",
      it: "",
      pt: "",
      de: "",
      fr: "",
      jp: "",
      th: "",
      rawData,
      createdAt: now,
      updatedAt: now,
    };

    for (const [language, index] of languageIndexes) {
      item[language] = row[index] ?? "";
    }

    items.push(item);
  }

  return items;
}

export function parseTranslationHtml(
  html: string,
  fileName: string,
): { source: TranslationSource; items: TranslationItem[] } {
  const source = createSource(fileName, "html");
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  const tables = Array.from(document.querySelectorAll("table"));
  const items: TranslationItem[] = [];

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) continue;

    const headers = Array.from(rows[0].querySelectorAll("th,td")).map((cell) => textFromCell(cell));
    const bodyRows = rows.slice(1).map((row) => Array.from(row.querySelectorAll("td,th")).map(textFromCell));
    items.push(...buildItemsFromRows(source, headers, bodyRows));
  }

  source.itemCount = items.length;
  source.totalCount = items.length;
  return { source, items };
}

function parseCsvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseTranslationCsv(csv: string, fileName: string) {
  const source = createSource(fileName, "csv");
  const items = parseRowsWithDetectedHeader(source, parseCsvRows(csv));

  source.itemCount = items.length;
  source.totalCount = items.length;
  return { source, items };
}

export function parseTranslationXlsx(buffer: ArrayBuffer, fileName: string) {
  const source = createSource(fileName, "xlsx");
  const workbook = XLSX.read(buffer, { type: "array" });
  const items: TranslationItem[] = [];
  let rowNumberOffset = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });
    if (rows.length < 2) continue;

    const normalizedRows = rows.map((row) => row.map((cell) => String(cell ?? "").trim()));
    const parsedItems = parseRowsWithDetectedHeader(source, normalizedRows, rowNumberOffset);
    items.push(...parsedItems);
    rowNumberOffset += normalizedRows.length;
  }

  source.itemCount = items.length;
  source.totalCount = items.length;
  return { source, items };
}

export function searchTranslationItems(items: TranslationItem[], query: string, limit = 40) {
  const needle = normalizeSearchText(query);
  if (!needle) return items.slice(0, limit);

  const matches: TranslationItem[] = [];
  for (const item of items) {
    const haystack = [item.key, ...LANGUAGE_DEFS.map((language) => item[language.code])].join("\n").toLowerCase();

    if (haystack.includes(needle)) {
      matches.push(item);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

export function searchTranslationCandidates(items: TranslationItem[], query: string, limit = 40): TranslationCandidate[] {
  const needle = normalizeSearchText(query);
  if (!needle) {
    return items.slice(0, limit).map((item) => ({ item, matchType: "KR 부분 일치", score: 0 }));
  }

  const candidateById = new Map<string, TranslationCandidate>();
  const addCandidate = (item: TranslationItem, matchType: TranslationMatchType, score: number) => {
    const previous = candidateById.get(item.id);
    if (!previous || score > previous.score) {
      candidateById.set(item.id, { item, matchType, score });
    }
  };

  for (const item of items) {
    const key = normalizeSearchText(item.key);
    const values = LANGUAGE_DEFS.map((language) => ({
      label: language.label,
      value: normalizeSearchText(item[language.code]),
    }));
    const kr = values.find(({ label }) => label === "KR")?.value ?? "";
    const en = values.find(({ label }) => label === "EN")?.value ?? "";
    const otherLanguages = values.filter(({ label }) => label !== "KR" && label !== "EN");

    if (kr && kr === needle) {
      addCandidate(item, "KR 완전 일치", 600);
      continue;
    }

    if (en && en === needle) {
      addCandidate(item, "EN 완전 일치", 500);
      continue;
    }

    if (key && key === needle) {
      addCandidate(item, "key 완전 일치", 400);
      continue;
    }

    const exactOtherLanguage = otherLanguages.find(({ value }) => value && value === needle);
    if (exactOtherLanguage) {
      addCandidate(item, `${exactOtherLanguage.label} 완전 일치`, 350);
      continue;
    }

    if (kr && kr.includes(needle)) {
      addCandidate(item, "KR 부분 일치", 300 + Math.min(needle.length / Math.max(kr.length, 1), 1));
      continue;
    }

    if (en && en.includes(needle)) {
      addCandidate(item, "EN 부분 일치", 200 + Math.min(needle.length / Math.max(en.length, 1), 1));
      continue;
    }

    const partialOtherLanguage = otherLanguages.find(({ value }) => value && value.includes(needle));
    if (partialOtherLanguage) {
      addCandidate(
        item,
        `${partialOtherLanguage.label} 부분 일치`,
        150 + Math.min(needle.length / Math.max(partialOtherLanguage.value.length, 1), 1),
      );
      continue;
    }

    const fuzzyScore = Math.max(similarity(needle, key), ...values.map(({ value }) => similarity(needle, value)));
    if (fuzzyScore >= 0.62) {
      addCandidate(item, "fuzzy match", 100 + fuzzyScore);
    }
  }

  return Array.from(candidateById.values())
    .sort((a, b) => b.score - a.score || a.item.key.localeCompare(b.item.key))
    .slice(0, limit);
}
