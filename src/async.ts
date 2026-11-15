import {
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

export const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_COMPLETION_TIMEOUT_MS = 180_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
export const COMPLETION_TIMEOUT_ERROR = "Cursor completion timed out.";

export function abortAfter(
  ms: number,
  message: string,
  parent?: AbortSignal,
): { signal: AbortSignal; clear: () => void; refresh: () => void } {
  const deadline = new AbortController();
  const fire = () => deadline.abort(new Error(message));
  const signal = parent
    ? AbortSignal.any([parent, deadline.signal])
    : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, ms);
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal,
    clear,
    /** Restart the countdown, turning the deadline into an idle limit. No-op once cleared or aborted. */
    refresh: () => {
      if (timer === undefined) return;
      if (signal.aborted) return clear();
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
    },
  };
}

export function validateTimeout(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) {
    throw new Error(
      `Timeouts must be integers between 1 and ${MAX_TIMEOUT_MS} ms.`,
    );
  }
}

/** Stop waiting without leaving a late rejection unobserved. */
export function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

const FAILURE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EMBEDDED_FAILURE_CODE = /^\[([A-Za-z][A-Za-z0-9_]{0,63})\]\s*([\s\S]*)$/;

/** Text for Pi's `Error: ${message}` line. The result must not start with `Error:`. */
export function formatFailure(
  value: unknown,
  fallback = "Cursor request failed.",
): string {
  const record =
    value !== null && typeof value === "object"
      ? (value as { message?: unknown; code?: unknown })
      : undefined;
  let code =
    typeof record?.code === "string" && FAILURE_CODE.test(record.code)
      ? record.code
      : undefined;
  let message =
    value instanceof Error
      ? value.message
      : typeof record?.message === "string"
        ? record.message
        : value == null
          ? ""
          : String(value);
  message = message.trim();
  while (message.startsWith("Error:")) message = message.slice(6).trim();
  const embedded = EMBEDDED_FAILURE_CODE.exec(message);
  if (embedded?.[1] && (code === undefined || code === embedded[1])) {
    code = embedded[1];
    message = (embedded[2] ?? "").trim();
  }
  if (message === "" || message.toLowerCase() === "error") {
    message =
      code === "resource_exhausted"
        ? "Cursor rate limit or usage limit was reached."
        : fallback;
  }
  const prefix = code ? `[${code}] ` : "";
  return message.startsWith(prefix) ? message : `${prefix}${message}`;
}

/** Pi matches `network error`, so this suffix makes a transport failure retryable. */
const RETRYABLE_TRANSPORT_NOTE = " (Cursor network error; retryable)";

/** Case-sensitive substrings, matching the SDK transport signature list. */
const TRANSPORT_SIGNATURES = [
  "NGHTTP2",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "socket hang up",
  "Premature close",
  "UND_ERR_SOCKET",
  "ERR_STREAM",
  "protocol error",
  "http/2 stream",
  "ERR_HTTP2_SESSION_ERROR",
  "Session closed with error code",
  "connection aborted",
  "PING timed out",
  "HTTP/2 session not established",
  "HTTP/2 peer not answering",
] as const;

/** Word-boundary match, matching the SDK DNS/network code set. */
const NETWORK_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ESERVFAIL",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ECONNABORTED",
] as const;

const NETWORK_CODE_SET = new Set<string>(NETWORK_CODES);
const NETWORK_CODE_PATTERN = new RegExp(`\\b(?:${NETWORK_CODES.join("|")})\\b`);

const BLOCKED_CODES = new Set([
  "resource_exhausted",
  "unauthenticated",
  "permission_denied",
  "unauthorized",
]);

const BLOCKED_TEXT = [
  "SDK cleanup failed",
  "SDK cleanup timed out",
  "not confirmed",
  "Timeouts must be",
  "Unsupported Cursor SDK request control",
  "image input and image tool results are not supported",
  "onPayload must return",
] as const;

function resolveFailureCode(
  message: string,
  code?: string,
): string | undefined {
  const embedded = EMBEDDED_FAILURE_CODE.exec(message.trim());
  return embedded?.[1] ?? code;
}

function hasTransportSignature(text: string): boolean {
  return (
    TRANSPORT_SIGNATURES.some((signature) => text.includes(signature)) ||
    NETWORK_CODE_PATTERN.test(text)
  );
}

/** True when the SDK would treat this as a transient transport failure. */
export function isTransientCursorTransportFailure(
  message: string,
  code?: string,
): boolean {
  const resolved = resolveFailureCode(message, code);
  if (resolved === "connection_stalled") return true;
  if (hasTransportSignature(message)) return true;
  if (resolved === undefined) return false;
  return (
    NETWORK_CODE_SET.has(resolved) ||
    TRANSPORT_SIGNATURES.some((signature) => resolved.includes(signature))
  );
}

function mustNotMark(message: string, code: string | undefined): boolean {
  if (code !== undefined && BLOCKED_CODES.has(code.toLowerCase())) return true;
  if (BLOCKED_TEXT.some((text) => message.includes(text))) return true;
  if (/rate limit|usage limit/i.test(message)) return true;
  return /\bunauthori[sz]ed\b|\bunauthenticated\b|permission denied|not logged in|sign in required|\bauthentication\b|\bauth token\b|invalid api key|bad api key/i.test(
    message,
  );
}

function piAlreadyRetries(message: string): boolean {
  return isRetryableAssistantError({
    stopReason: "error",
    errorMessage: message,
  } as AssistantMessage);
}

/**
 * Append a one-line marker Pi's retry regex matches. Limits, auth, validation,
 * cleanup, and text Pi already retries are returned unchanged.
 */
export function markRetryableTransportFailure(
  message: string,
  code?: string,
): string {
  if (message.includes(RETRYABLE_TRANSPORT_NOTE)) return message;
  const resolved = resolveFailureCode(message, code);
  if (mustNotMark(message, resolved)) return message;
  if (piAlreadyRetries(message)) return message;
  if (!isTransientCursorTransportFailure(message, code)) return message;
  return `${message}${RETRYABLE_TRANSPORT_NOTE}`;
}
