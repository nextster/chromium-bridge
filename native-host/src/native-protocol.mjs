import os from "node:os";
import { once } from "node:events";

export const MAX_HOST_TO_BROWSER_BYTES = 1024 * 1024;
export const MAX_BROWSER_TO_HOST_BYTES = 64 * 1024 * 1024;

const littleEndian = os.endianness() === "LE";

export function encodeNativeMessage(value, maxBytes = MAX_HOST_TO_BROWSER_BYTES) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > maxBytes) {
    throw new Error(`Native message is ${payload.length} bytes; limit is ${maxBytes}`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  if (littleEndian) frame.writeUInt32LE(payload.length, 0);
  else frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export async function writeNativeMessage(stream, value, maxBytes = MAX_HOST_TO_BROWSER_BYTES) {
  const frame = encodeNativeMessage(value, maxBytes);
  if (!stream.write(frame)) await once(stream, "drain");
}

export async function* readNativeMessages(stream, maxBytes = MAX_BROWSER_TO_HOST_BYTES) {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    while (buffered.length >= 4) {
      const length = littleEndian ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
      if (length > maxBytes) throw new Error(`Native message length ${length} exceeds limit ${maxBytes}`);
      if (buffered.length < 4 + length) break;
      const payload = buffered.subarray(4, 4 + length).toString("utf8");
      buffered = buffered.subarray(4 + length);
      yield JSON.parse(payload);
    }
  }
  if (buffered.length) throw new Error("Native messaging stream ended with an incomplete frame");
}
