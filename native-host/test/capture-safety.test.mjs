import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CAPTURE_PART_BYTES,
  captureOptions,
  extractCapturedRequestBody,
  normalizeCapturedHeaders,
  redactDebuggerValue,
  redactUrl
} from "../../extension/capture-safety.js";

test("capture requires an explicit bounded substring or all-URL opt-in", () => {
  assert.throws(() => captureOptions({}), /requires a URL filter/);
  assert.throws(() => captureOptions({ urlPattern: "/(a+)+$/" }), /Regular-expression/);
  assert.deepEqual(captureOptions({ allUrls: true }), {
    urlPattern: "",
    allUrls: true,
    captureRequestBody: false,
    includeSecrets: false
  });
});

test("capture redacts URL credentials and sensitive query parameters", () => {
  const value = redactUrl("https://alice:password@example.test/path?amount=42&access_token=secret#private");
  assert.doesNotMatch(value, /alice|password|secret|private/);
  assert.match(value, /amount=42/);
  assert.match(value, /access_token=%3Credacted%3A6%3E/);
});

test("capture redacts secret headers and debugger cookie structures", () => {
  assert.deepEqual(normalizeCapturedHeaders([
    { name: "Authorization", value: "Bearer top-secret" },
    { name: "X-Api-Key", value: "api-secret" },
    { name: "Accept", value: "application/json" }
  ]), [
    { name: "Authorization", value: "<redacted:17>" },
    { name: "X-Api-Key", value: "<redacted:10>" },
    { name: "Accept", value: "application/json" }
  ]);

  const value = redactDebuggerValue({
    request: { url: "https://example.test/?token=hidden" },
    associatedCookies: [{ cookie: { name: "session", value: "cookie-secret" } }]
  });
  assert.doesNotMatch(JSON.stringify(value), /hidden|cookie-secret/);
});

test("capture redacts unknown raw text and bounds raw bodies", () => {
  const unknown = extractCapturedRequestBody({
    url: "https://example.test/submit",
    requestBody: { raw: [{ bytes: bytes("opaque private payload") }] }
  });
  assert.match(unknown.parts[0].text, /^<redacted:/);
  assert.doesNotMatch(unknown.parts[0].text, /private/);

  const large = extractCapturedRequestBody({
    url: "https://example.test/submit",
    requestBody: { raw: [{ bytes: bytes("x".repeat(MAX_CAPTURE_PART_BYTES + 200)) }] }
  }, true);
  assert.equal(large.parts[0].text.length, MAX_CAPTURE_PART_BYTES);
  assert.equal(large.parts[0].truncatedBytes, 200);
});

test("capture omits local upload paths unless raw capture is explicit", () => {
  const redacted = extractCapturedRequestBody({
    url: "https://example.test/upload",
    requestBody: { raw: [{ file: "/home/example/Private/report.pdf" }] }
  });
  assert.deepEqual(redacted.parts[0], { fileName: "report.pdf" });
});

function bytes(value) {
  return new TextEncoder().encode(value).buffer;
}
