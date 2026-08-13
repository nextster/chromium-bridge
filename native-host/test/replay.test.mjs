import assert from "node:assert/strict";
import test from "node:test";
import { renderCurl } from "../src/replay.mjs";

test("curl replay reconstructs urlencoded form data", () => {
  const script = renderCurl(requestEvents({
    contentType: "application/x-www-form-urlencoded",
    body: { kind: "formData", data: { name: ["Artem Test"], month: ["2026-05"] } }
  }));

  assert.match(script, /--data-urlencode 'name=Artem Test'/);
  assert.match(script, /--data-urlencode 'month=2026-05'/);
  assert.doesNotMatch(script, /Content-Type: application\/x-www-form-urlencoded/);
  assert.doesNotMatch(script, /\{"name"/);
});

test("curl replay uses environment variables for redacted values", () => {
  const script = renderCurl(requestEvents({
    contentType: "application/x-www-form-urlencoded",
    cookie: "ASP.NET_SessionId=<redacted:24>",
    body: { kind: "formData", data: { token: ["<redacted:12>"] } }
  }));

  assert.match(script, /: "\$\{ARC_COOKIE:=\}"/);
  assert.match(script, /Cookie: \$\{ARC_COOKIE\}/);
  assert.match(script, /: "\$\{ARC_FORM_1_TOKEN_1:=\}"/);
  assert.match(script, /token=\$\{ARC_FORM_1_TOKEN_1\}/);
});

test("curl replay lets curl generate multipart boundaries", () => {
  const script = renderCurl(requestEvents({
    contentType: "multipart/form-data; boundary=browser-boundary",
    body: { kind: "formData", data: { title: ["May declaration"] } }
  }));

  assert.match(script, /--form-string 'title=May declaration'/);
  assert.doesNotMatch(script, /browser-boundary/);
});

test("curl replay preserves raw text bodies", () => {
  const script = renderCurl(requestEvents({
    contentType: "application/json",
    body: { kind: "raw", parts: [{ text: "{\"amount\":42}" }] }
  }));

  assert.match(script, /Content-Type: application\/json/);
  assert.match(script, /--data-binary '\{"amount":42\}'/);
});

function requestEvents({ contentType, cookie, body }) {
  const headers = [{ name: "Content-Type", value: contentType }];
  if (cookie) headers.push({ name: "Cookie", value: cookie });
  return [
    {
      type: "request.before",
      payload: { requestId: "1", method: "POST", url: "https://example.test/submit", requestBody: body }
    },
    {
      type: "request.headers",
      payload: { requestId: "1", method: "POST", url: "https://example.test/submit", requestHeaders: headers }
    }
  ];
}
