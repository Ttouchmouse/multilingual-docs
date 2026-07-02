import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApiRequestAuthorized, unauthorizedJson } from "@/lib/api-auth";
import {
  loadServerSupabaseSnapshot,
  saveServerSupabaseSnapshot,
} from "@/lib/supabase-server-storage";
import type { AppState, TranslationItem } from "@/lib/types";

export const dynamic = "force-dynamic";

type SaveSnapshotBody = {
  appState?: AppState;
  translations?: TranslationItem[];
  expectedUpdatedAt?: string;
};

export async function GET(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  try {
    const snapshot = await loadServerSupabaseSnapshot();

    if (!snapshot.configured) {
      return NextResponse.json(
        { configured: false, error: "Supabase 환경변수가 설정되지 않았습니다." },
        { status: 503 },
      );
    }

    if (!snapshot.found) {
      return NextResponse.json({ configured: true, found: false });
    }

    return NextResponse.json({
      configured: true,
      found: true,
      appState: snapshot.appState,
      translations: snapshot.translations,
      updatedAt: snapshot.updatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase 원본을 불러오지 못했습니다.";
    console.error("[persistence] Server snapshot load failed.", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  try {
    const body = (await request.json()) as SaveSnapshotBody;
    if (!body.appState || !Array.isArray(body.translations)) {
      return NextResponse.json({ error: "저장할 스냅샷 데이터가 올바르지 않습니다." }, { status: 400 });
    }

    const result = await saveServerSupabaseSnapshot(
      body.appState,
      body.translations,
      body.expectedUpdatedAt,
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase 저장에 실패했습니다.";
    console.error("[persistence] Server snapshot save failed.", error);
    if (error instanceof Error && error.name === "SupabaseSnapshotConflictError") {
      return NextResponse.json({ error: message, code: "SNAPSHOT_CONFLICT" }, { status: 409 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
