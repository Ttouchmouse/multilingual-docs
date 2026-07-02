import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE_NAME,
  accessCookieMatches,
  codesMatch,
  getAccessSessionToken,
  getAccessVersion,
  getConfiguredAccessCode,
} from "@/lib/access-session";

export const dynamic = "force-dynamic";

const ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function GET() {
  const configuredCode = getConfiguredAccessCode();
  if (!configuredCode) {
    return NextResponse.json({ enabled: false });
  }

  const cookieStore = await cookies();

  return NextResponse.json({
    enabled: true,
    version: getAccessVersion(configuredCode),
    authorized: accessCookieMatches(cookieStore.get(ACCESS_COOKIE_NAME)?.value, configuredCode),
  });
}

export async function POST(request: Request) {
  const configuredCode = getConfiguredAccessCode();
  if (!configuredCode) {
    return NextResponse.json({ enabled: false, ok: true });
  }

  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const ok = typeof body.code === "string" && codesMatch(body.code, configuredCode);

  const response = NextResponse.json(
    {
      enabled: true,
      ok,
      version: ok ? getAccessVersion(configuredCode) : undefined,
    },
    { status: ok ? 200 : 401 },
  );

  if (ok) {
    response.cookies.set(ACCESS_COOKIE_NAME, getAccessSessionToken(configuredCode), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
    });
  }

  return response;
}
