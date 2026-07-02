import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function normalizeAccessCode(value: string) {
  return value.trim().toUpperCase();
}

function getConfiguredAccessCode() {
  const code = process.env.APP_ACCESS_CODE;
  return code ? normalizeAccessCode(code) : "";
}

function getAccessVersion(code: string) {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

function codesMatch(input: string, configuredCode: string) {
  const normalizedInput = normalizeAccessCode(input);
  const inputBuffer = Buffer.from(normalizedInput);
  const configuredBuffer = Buffer.from(configuredCode);
  if (inputBuffer.length !== configuredBuffer.length) return false;
  return timingSafeEqual(inputBuffer, configuredBuffer);
}

export async function GET() {
  const configuredCode = getConfiguredAccessCode();
  if (!configuredCode) {
    return NextResponse.json({ enabled: false });
  }

  return NextResponse.json({
    enabled: true,
    version: getAccessVersion(configuredCode),
  });
}

export async function POST(request: Request) {
  const configuredCode = getConfiguredAccessCode();
  if (!configuredCode) {
    return NextResponse.json({ enabled: false, ok: true });
  }

  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const ok = typeof body.code === "string" && codesMatch(body.code, configuredCode);

  return NextResponse.json(
    {
      enabled: true,
      ok,
      version: ok ? getAccessVersion(configuredCode) : undefined,
    },
    { status: ok ? 200 : 401 },
  );
}
