import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApiRequestAuthorized, unauthorizedJson } from "@/lib/api-auth";
import { loadMonthlyOcrUsage } from "@/lib/ocr-usage-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  try {
    return NextResponse.json(await loadMonthlyOcrUsage());
  } catch (error) {
    console.error("[ocr-usage] Failed to load monthly usage.", error);
    return NextResponse.json(
      { available: false, error: "OCR 사용량을 불러올 수 없습니다." },
      { status: 500 },
    );
  }
}
