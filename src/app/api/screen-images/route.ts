import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApiRequestAuthorized, unauthorizedJson } from "@/lib/api-auth";
import { createServerScreenImageUpload, uploadServerScreenImage } from "@/lib/supabase-server-storage";

export const dynamic = "force-dynamic";

type UploadImageBody = {
  screenId?: string;
  dataUrl?: string;
  fileName?: string;
  contentType?: string;
  uploadMode?: "signed";
};

export async function POST(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  try {
    const body = (await request.json()) as UploadImageBody;
    if (!body.screenId) {
      return NextResponse.json({ error: "업로드할 화면 이미지 데이터가 올바르지 않습니다." }, { status: 400 });
    }

    if (body.uploadMode === "signed") {
      const result = await createServerScreenImageUpload(body.screenId, body.fileName, body.contentType);
      return NextResponse.json({ result });
    }

    if (!body.dataUrl) {
      return NextResponse.json({ error: "업로드할 화면 이미지 데이터가 올바르지 않습니다." }, { status: 400 });
    }

    const result = await uploadServerScreenImage(body.screenId, body.dataUrl);
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "화면 이미지 업로드에 실패했습니다.";
    console.error("[persistence] Server image upload failed.", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
