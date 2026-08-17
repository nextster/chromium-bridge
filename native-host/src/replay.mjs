const OMITTED_REQUEST_HEADERS = /^(content-length|host|connection|accept-encoding)$/i;
const REDACTED = /<redacted(?::\d+)?>/i;

export function renderCurl(events) {
  const requests = collectRequests(events);
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail", ""];
  let index = 0;

  for (const request of requests.values()) {
    if (!request.url || !request.method) continue;
    index += 1;
    const variables = new Set();
    const args = [sh(request.url), `-X ${sh(request.method)}`];
    const headers = Array.isArray(request.headers) ? request.headers : [];
    const contentType = headerValue(headers, "content-type");
    const formBody = request.body?.kind === "formData";

    for (const header of headers) {
      const name = String(header?.name || "");
      const value = String(header?.value || "");
      if (!name || OMITTED_REQUEST_HEADERS.test(name)) continue;
      if (formBody && /^content-type$/i.test(name)) continue;

      if (REDACTED.test(value)) {
        const variable = headerVariable(name);
        variables.add(variable);
        args.push(`-H ${withEnvironmentValue(`${name}: `, variable)}`);
      } else {
        args.push(`-H ${sh(`${name}: ${value}`)}`);
      }
    }

    addBodyArgs(args, variables, request.body, contentType, index);
    args.push("--compressed");

    lines.push(`# request ${index}: ${singleLine(request.method)} ${singleLine(request.url)}`);
    for (const variable of variables) lines.push(`: "\${${variable}:=}"`);
    lines.push("curl \\");
    args.forEach((arg, argIndex) => {
      const suffix = argIndex === args.length - 1 ? "" : " \\";
      lines.push(`  ${arg}${suffix}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

export function collectRequests(events) {
  const requests = new Map();
  for (const event of events || []) {
    const payload = event?.payload || {};
    if (!payload.requestId) continue;
    const key = String(payload.requestId);
    const request = requests.get(key) || {};
    if (event.type === "request.before") {
      Object.assign(request, {
        method: payload.method,
        url: payload.url,
        body: payload.requestBody
      });
    } else if (event.type === "request.headers") {
      Object.assign(request, {
        method: payload.method,
        url: payload.url,
        headers: payload.requestHeaders
      });
    }
    requests.set(key, request);
  }
  return requests;
}

function addBodyArgs(args, variables, body, contentType, requestIndex) {
  if (!body) return;
  if (body.kind === "formData") {
    const multipart = /^multipart\/form-data\b/i.test(contentType);
    const option = multipart ? "--form-string" : "--data-urlencode";
    for (const [key, rawValues] of Object.entries(body.data || {})) {
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      values.forEach((rawValue, valueIndex) => {
        const value = String(rawValue ?? "");
        if (REDACTED.test(value)) {
          const variable = `SIDECAR_FORM_${requestIndex}_${slug(key)}_${valueIndex + 1}`;
          variables.add(variable);
          args.push(`${option} ${withEnvironmentValue(`${key}=`, variable)}`);
        } else {
          args.push(`${option} ${sh(`${key}=${value}`)}`);
        }
      });
    }
    return;
  }

  if (body.kind === "redacted") {
    const variable = `SIDECAR_BODY_${requestIndex}`;
    variables.add(variable);
    args.push(`--data-binary ${dq(`\${${variable}}`)}`);
    return;
  }

  if (body.kind !== "raw") return;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const textOnly = parts.every(part => typeof part?.text === "string");
  const text = textOnly ? parts.map(part => part.text).join("") : "";
  if (!textOnly || REDACTED.test(text)) {
    const variable = `SIDECAR_BODY_${requestIndex}`;
    variables.add(variable);
    args.push(`--data-binary ${dq(`\${${variable}}`)}`);
  } else if (text) {
    args.push(`--data-binary ${sh(text)}`);
  }
}

function headerValue(headers, wantedName) {
  return String(headers.find(header => String(header?.name || "").toLowerCase() === wantedName)?.value || "");
}

function headerVariable(name) {
  return /^cookie$/i.test(name) ? "SIDECAR_COOKIE" : `SIDECAR_HEADER_${slug(name)}`;
}

function withEnvironmentValue(prefix, variable) {
  return `${sh(prefix)}"\${${variable}}"`;
}

function slug(value) {
  const result = String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return result || "VALUE";
}

function singleLine(value) {
  return String(value).replace(/[\r\n]+/g, " ");
}

function dq(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
