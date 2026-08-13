import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { encodeNativeMessage, readNativeMessages } from "../src/native-protocol.mjs";

test("native protocol reads fragmented and adjacent messages", async () => {
  const stream = new PassThrough();
  const first = encodeNativeMessage({ type: "hello", value: "тест" });
  const second = encodeNativeMessage({ type: "event", value: 2 });
  const received = collect(readNativeMessages(stream));

  stream.write(first.subarray(0, 2));
  stream.write(Buffer.concat([first.subarray(2), second.subarray(0, 5)]));
  stream.end(second.subarray(5));

  assert.deepEqual(await received, [
    { type: "hello", value: "тест" },
    { type: "event", value: 2 }
  ]);
});

test("native protocol rejects messages above the configured limit", async () => {
  assert.throws(() => encodeNativeMessage({ body: "too large" }, 4), /limit is 4/);
});

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}
