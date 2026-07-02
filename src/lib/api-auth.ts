import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ACCESS_COOKIE_NAME, accessCookieMatches, getConfiguredAccessCode } from "./access-session";

export function isApiRequestAuthorized(request: NextRequest) {
  const configuredCode = getConfiguredAccessCode();
  if (!configuredCode) return true;

  return accessCookieMatches(request.cookies.get(ACCESS_COOKIE_NAME)?.value, configuredCode);
}

export function unauthorizedJson() {
  return NextResponse.json(
    {
      error: "접근 세션이 만료되었습니다. 보안 키를 다시 입력해주세요.",
    },
    { status: 401 },
  );
}
