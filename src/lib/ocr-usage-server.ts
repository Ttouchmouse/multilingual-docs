import { createClient } from "@supabase/supabase-js";
import { OCR_FREE_MONTHLY_LIMIT, type OcrUsageSummary } from "./ocr-usage";

const OCR_USAGE_TABLE = "ocr_usage_monthly";
const OCR_USAGE_INCREMENT_FUNCTION = "increment_ocr_usage_monthly";
const MISSING_RESOURCE_CODES = new Set(["42P01", "PGRST202", "PGRST205"]);

type OcrUsageRow = {
  month: string;
  request_count: number;
  updated_at: string;
};

function createServerSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) return null;

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getGoogleBillingMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  if (!year || !month) {
    throw new Error("OCR 사용량 기준 월을 계산할 수 없습니다.");
  }

  return `${year}-${month}`;
}

function toUsageSummary(row: Pick<OcrUsageRow, "month" | "request_count">): OcrUsageSummary {
  return {
    month: row.month,
    used: Math.max(0, Number(row.request_count) || 0),
    limit: OCR_FREE_MONTHLY_LIMIT,
  };
}

function isUsageStorageUnavailable(error: { code?: string } | null) {
  return Boolean(error?.code && MISSING_RESOURCE_CODES.has(error.code));
}

export async function loadMonthlyOcrUsage(): Promise<{
  available: boolean;
  usage?: OcrUsageSummary;
}> {
  const supabase = createServerSupabaseClient();
  if (!supabase) return { available: false };

  const month = getGoogleBillingMonth();
  const { data, error } = await supabase
    .from(OCR_USAGE_TABLE)
    .select("month, request_count")
    .eq("month", month)
    .maybeSingle<Pick<OcrUsageRow, "month" | "request_count">>();

  if (error) {
    if (isUsageStorageUnavailable(error)) {
      console.warn("[ocr-usage] Usage table is not configured.");
      return { available: false };
    }
    throw error;
  }

  return {
    available: true,
    usage: data
      ? toUsageSummary(data)
      : {
          month,
          used: 0,
          limit: OCR_FREE_MONTHLY_LIMIT,
        },
  };
}

export async function recordMonthlyOcrRequest(): Promise<{
  available: boolean;
  usage?: OcrUsageSummary;
}> {
  const supabase = createServerSupabaseClient();
  if (!supabase) return { available: false };

  const month = getGoogleBillingMonth();
  const { data, error } = await supabase
    .rpc(OCR_USAGE_INCREMENT_FUNCTION, { p_month: month })
    .single<OcrUsageRow>();

  if (error) {
    if (isUsageStorageUnavailable(error)) {
      console.warn("[ocr-usage] Usage increment function is not configured.");
      return { available: false };
    }
    throw error;
  }

  return {
    available: true,
    usage: toUsageSummary(data),
  };
}
