"use client";

import { type FormEvent, type ReactNode, useEffect, useState } from "react";

const ACCESS_SESSION_KEY = "tg-access-code-version";
const ACCESS_LOCAL_KEY = "tg-access-code-version";

type AccessStatus =
  | { phase: "checking" }
  | { phase: "unlocked" }
  | { phase: "locked"; version: string; error?: string };

type AccessStatusResponse = {
  enabled?: boolean;
  version?: string;
  ok?: boolean;
  authorized?: boolean;
};

export function AppAccessGate({ children }: { children: ReactNode }) {
  const [accessStatus, setAccessStatus] = useState<AccessStatus>({ phase: "checking" });
  const [accessCode, setAccessCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadAccessStatus() {
      try {
        const response = await fetch("/api/access/verify", { cache: "no-store" });
        if (!response.ok) throw new Error("접근 설정을 확인할 수 없습니다.");

        const payload = (await response.json()) as AccessStatusResponse;
        if (!payload.enabled) {
          if (!cancelled) setAccessStatus({ phase: "unlocked" });
          return;
        }

        const version = payload.version ?? "";
        const storedPersistentVersion = window.localStorage.getItem(ACCESS_LOCAL_KEY);
        const storedVersion = window.sessionStorage.getItem(ACCESS_SESSION_KEY);
        if (payload.authorized && (storedPersistentVersion === version || storedVersion === version)) {
          window.localStorage.setItem(ACCESS_LOCAL_KEY, version);
          window.sessionStorage.setItem(ACCESS_SESSION_KEY, version);
          if (!cancelled) setAccessStatus({ phase: "unlocked" });
          return;
        }

        if (!cancelled) setAccessStatus({ phase: "locked", version });
      } catch (error) {
        const message = error instanceof Error ? error.message : "접근 설정을 확인할 수 없습니다.";
        if (!cancelled) setAccessStatus({ phase: "locked", version: "", error: message });
      }
    }

    void loadAccessStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  async function submitAccessCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accessStatus.phase !== "locked" || submitting) return;

    setSubmitting(true);
    setAccessStatus((status) => (status.phase === "locked" ? { ...status, error: undefined } : status));

    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: accessCode }),
      });
      const payload = (await response.json()) as AccessStatusResponse;
      if (!response.ok || !payload.ok || !payload.version) {
        throw new Error("보안 키를 확인해주세요.");
      }

      window.sessionStorage.setItem(ACCESS_SESSION_KEY, payload.version);
      window.localStorage.setItem(ACCESS_LOCAL_KEY, payload.version);
      setAccessStatus({ phase: "unlocked" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "보안 키를 확인해주세요.";
      setAccessStatus((status) => (status.phase === "locked" ? { ...status, error: message } : status));
    } finally {
      setSubmitting(false);
    }
  }

  if (accessStatus.phase === "unlocked") {
    return <>{children}</>;
  }

  const locked = accessStatus.phase === "locked";
  const errorMessage = locked ? accessStatus.error : undefined;

  return (
    <main className="access-gate-shell" aria-label="앱 접근 코드 입력">
      <form className="access-gate-dialog" onSubmit={submitAccessCode}>
        <h1>TG 다국어 위키</h1>
        <input
          type="text"
          value={accessCode}
          placeholder={accessStatus.phase === "checking" ? "확인 중입니다" : "보안 키 입력(영문+숫자 8자리)"}
          aria-label="보안 키"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={8}
          disabled={!locked || submitting}
          onChange={(event) => {
            const value = event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
            setAccessCode(value);
            if (errorMessage) {
              setAccessStatus((status) => (status.phase === "locked" ? { ...status, error: undefined } : status));
            }
          }}
        />
        <button type="submit" disabled={!locked || submitting || accessCode.length < 1}>
          {submitting ? "확인 중" : "입력"}
        </button>
        {errorMessage ? <p role="alert">{errorMessage}</p> : null}
      </form>
    </main>
  );
}
