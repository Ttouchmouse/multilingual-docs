import { createHash, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE_NAME = "tg_access_session";

export function normalizeAccessCode(value: string) {
  return value.trim().toUpperCase();
}

export function getConfiguredAccessCode() {
  const code = process.env.APP_ACCESS_CODE;
  return code ? normalizeAccessCode(code) : "";
}

export function getAccessVersion(code: string) {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

export function getAccessSessionToken(code: string) {
  return createHash("sha256").update(`tg-access:${code}:${getAccessVersion(code)}`).digest("hex");
}

export function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function codesMatch(input: string, configuredCode: string) {
  return safeCompare(normalizeAccessCode(input), configuredCode);
}

export function accessCookieMatches(cookieValue: string | undefined, configuredCode: string) {
  if (!configuredCode || !cookieValue) return !configuredCode;
  return safeCompare(cookieValue, getAccessSessionToken(configuredCode));
}
