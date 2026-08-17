export const MAX_CAPTURE_FILTER_CHARS = 512;
export const MAX_CAPTURE_PART_BYTES = 256 * 1024;
export const MAX_CAPTURE_HEADER_CHARS = 16 * 1024;

const SENSITIVE_FIELD = /pass(word)?|secret|token|authorization|auth|otp|code|pin|cvv|cvc|card|session|cookie|credential|assertion|signature|ticket|api[-_]?key|access[-_]?key/i;
const AUTH_LIKE_URL = /authenticate|confirm|verify|resend|login|signin|sign-in|password|reset|otp|sso/i;
const SECRET_HEADER = /cookie|authorization|auth-token|api[-_]?key|access[-_]?key|secret|session|csrf|xsrf/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

export function captureOptions(params = {}) {
  const urlPattern = String(params.urlPattern || "").trim();
  const allUrls = params.allUrls === true;
  if (!urlPattern && !allUrls) {
    throw new Error("Network capture requires a URL filter or explicit allUrls=true");
  }
  if (urlPattern.length > MAX_CAPTURE_FILTER_CHARS) {
    throw new Error(`Capture filter exceeds ${MAX_CAPTURE_FILTER_CHARS} characters`);
  }
  if (urlPattern.startsWith("/") && urlPattern.endsWith("/") && urlPattern.length > 2) {
    throw new Error("Regular-expression capture filters are not supported; use a URL substring");
  }
  return {
    urlPattern,
    allUrls,
    captureRequestBody: params.captureRequestBody === true,
    includeSecrets: params.includeSecrets === true
  };
}

export function matchesCaptureUrl(url, options) {
  if (options.allUrls) return true;
  return Boolean(options.urlPattern) && String(url || "").includes(options.urlPattern);
}

export function redactUrl(value, includeSecrets = false) {
  const raw = String(value || "");
  if (includeSecrets || !raw) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = redacted(parsed.username);
    if (parsed.password) parsed.password = redacted(parsed.password);
    const sanitized = new URLSearchParams();
    for (const [key, item] of parsed.searchParams) {
      sanitized.append(key, SENSITIVE_FIELD.test(key) ? redacted(item) : item);
    }
    parsed.search = sanitized.toString();
    parsed.hash = "";
    return parsed.href;
  } catch {
    return raw.replace(
      /([?&](?:password|secret|token|auth|code|pin|cookie|credential|signature)=)[^&#]*/gi,
      "$1%3Credacted%3E"
    );
  }
}

export function extractCapturedRequestBody(details, includeSecrets = false) {
  const requestBody = details?.requestBody;
  if (!requestBody) return undefined;
  if (!includeSecrets && isAuthLikeUrl(details.url)) {
    return { kind: "redacted", reason: "auth-like URL" };
  }
  if (requestBody.error) return { kind: "error", error: truncateText(requestBody.error, 1024).text };
  if (requestBody.formData) {
    return {
      kind: "formData",
      data: serializeFormData(requestBody.formData, includeSecrets)
    };
  }
  if (requestBody.raw) {
    let remaining = MAX_CAPTURE_PART_BYTES;
    return {
      kind: "raw",
      parts: requestBody.raw.map(part => {
        const result = serializeUploadPart(part, includeSecrets, remaining);
        remaining = Math.max(0, remaining - (result.capturedBytes || 0));
        delete result.capturedBytes;
        return result;
      })
    };
  }
  return { kind: "unknown" };
}

export function normalizeCapturedHeaders(headers = [], includeSecrets = false) {
  return headers.map(header => {
    const name = String(header?.name || "");
    const value = String(header?.value || "");
    if (!includeSecrets && isSecretHeader(name)) {
      return { name, value: summarizeSecretHeader(value) };
    }
    return { name, value: truncateText(value, MAX_CAPTURE_HEADER_CHARS).text };
  });
}

export function redactDebuggerValue(value, includeSecrets = false, key = "", sensitiveContext = false) {
  const inSensitiveContext = sensitiveContext || /cookie|authorization|credential|password|secret|token/i.test(key);
  if (value == null || typeof value !== "object") {
    if (!includeSecrets && inSensitiveContext) return redacted(value);
    if (!includeSecrets && /postData/i.test(key)) return redactBodyText(value);
    if (/url$/i.test(key)) return redactUrl(value, includeSecrets);
    return typeof value === "string" ? truncateText(value, MAX_CAPTURE_PART_BYTES).text : value;
  }
  if (!includeSecrets && /postDataEntries/i.test(key)) {
    return { redactedEntries: Array.isArray(value) ? value.length : 1 };
  }
  if (Array.isArray(value)) {
    return value.map(item => redactDebuggerValue(item, includeSecrets, key, inSensitiveContext));
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    redactDebuggerValue(child, includeSecrets, childKey, inSensitiveContext)
  ]));
}

export function redactBodyText(value) {
  const text = String(value ?? "");
  try {
    return truncateText(JSON.stringify(redactObject(JSON.parse(text))), MAX_CAPTURE_PART_BYTES).text;
  } catch {}

  if (text.includes("=")) {
    try {
      const params = new URLSearchParams(text);
      const sanitized = new URLSearchParams();
      let fields = 0;
      for (const [key, item] of params) {
        fields += 1;
        sanitized.append(key, SENSITIVE_FIELD.test(key) ? redacted(item) : item);
      }
      if (fields) return truncateText(sanitized.toString(), MAX_CAPTURE_PART_BYTES).text;
    } catch {}
  }
  return redacted(text);
}

export function isSecretHeader(name) {
  return SECRET_HEADER.test(String(name));
}

export function isAuthLikeUrl(url) {
  return AUTH_LIKE_URL.test(String(url));
}

function serializeFormData(formData, includeSecrets) {
  return Object.fromEntries(Object.entries(formData).map(([key, rawValues]) => {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    return [key, values.map(rawValue => {
      const value = String(rawValue ?? "");
      if (!includeSecrets && SENSITIVE_FIELD.test(key)) return redacted(value);
      return truncateText(value, MAX_CAPTURE_PART_BYTES).text;
    })];
  }));
}

function serializeUploadPart(part, includeSecrets, remainingBytes) {
  if (part?.file) {
    const file = String(part.file);
    return includeSecrets
      ? { file: truncateText(file, 4096).text, capturedBytes: 0 }
      : { fileName: file.split(/[\\/]/).pop() || "", capturedBytes: 0 };
  }
  if (!part?.bytes) return { empty: true, capturedBytes: 0 };
  const bytes = new Uint8Array(part.bytes);
  if (remainingBytes <= 0) return { truncatedBytes: bytes.byteLength, capturedBytes: 0 };
  const captured = bytes.subarray(0, Math.min(bytes.byteLength, remainingBytes));
  const truncatedBytes = bytes.byteLength - captured.byteLength;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(captured);
  } catch {
    return includeSecrets
      ? {
          base64: bytesToBase64(captured),
          ...(truncatedBytes ? { truncatedBytes } : {}),
          capturedBytes: captured.byteLength
        }
      : { redactedBinaryBytes: bytes.byteLength, capturedBytes: 0 };
  }
  return {
    text: includeSecrets ? text : redactBodyText(text),
    ...(truncatedBytes ? { truncatedBytes } : {}),
    capturedBytes: captured.byteLength
  };
}

function redactObject(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return redacted(value);
  if (Array.isArray(value)) return value.map(item => redactObject(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactObject(child, childKey)]));
  }
  return value;
}

function summarizeSecretHeader(value = "") {
  const text = String(value);
  if (!text) return "<redacted:0>";
  return text.split(/;\s*/).filter(Boolean).map(part => {
    const equals = part.indexOf("=");
    if (equals < 0) return redacted(part);
    return `${part.slice(0, equals)}=${redacted(part.slice(equals + 1))}`;
  }).join("; ");
}

function truncateText(value, maximumBytes) {
  const text = String(value ?? "");
  const bytes = textEncoder.encode(text);
  if (bytes.byteLength <= maximumBytes) return { text, truncatedBytes: 0 };
  const truncatedBytes = bytes.byteLength - maximumBytes;
  return {
    text: `${textDecoder.decode(bytes.subarray(0, maximumBytes))}<truncated:${truncatedBytes}>`,
    truncatedBytes
  };
}

function redacted(value) {
  return `<redacted:${String(value ?? "").length}>`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
