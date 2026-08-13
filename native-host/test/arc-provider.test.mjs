import assert from "node:assert/strict";
import test from "node:test";
import { arcProviderInfo, focusArcSpace, listArcSpaces } from "../src/arc-provider.mjs";

test("Arc provider advertises its Spaces capabilities when Arc is installed", async () => {
  const info = await arcProviderInfo({
    platform: "darwin",
    accessFn: async candidate => {
      if (candidate !== "/Applications/Arc.app") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  });
  assert.equal(info.id, "arc");
  assert.equal(info.available, true);
  assert.equal(info.applicationPath, "/Applications/Arc.app");
  assert.deepEqual(info.capabilities, ["spaces.list", "space.focus"]);
});

test("Arc provider parses read-only Space listings", async () => {
  const result = await listArcSpaces({
    platform: "darwin",
    runJxa: async (_script, args) => {
      assert.deepEqual(args, []);
      return JSON.stringify({
        running: true,
        windows: [{ id: 1, activeSpaceId: "space-1", spaces: [{ id: "space-1", title: "Work", tabs: [] }] }]
      });
    }
  });
  assert.equal(result.windows[0].spaces[0].title, "Work");
});

test("Arc provider passes an explicit Space id to focus", async () => {
  const result = await focusArcSpace("space-2", {
    platform: "darwin",
    runJxa: async (_script, args) => {
      assert.deepEqual(args, ["space-2"]);
      return JSON.stringify({ focused: true, spaceId: args[0], title: "Personal" });
    }
  });
  assert.deepEqual(result, { focused: true, spaceId: "space-2", title: "Personal" });
});
