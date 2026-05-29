import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const fileName = "20260108_번역.html";
    const filePath = path.join(process.cwd(), fileName);
    const html = await readFile(filePath, "utf8");

    return NextResponse.json({ fileName, html });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return NextResponse.json(
      { error: `로컬 번역 HTML을 읽을 수 없습니다: ${message}` },
      { status: 500 },
    );
  }
}
