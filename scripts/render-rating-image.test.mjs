import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnosticText, findNewestInput, generateImage } from "./render-rating-image.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rating-image-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeInput(directory, name, profile, complete = true) {
  const data = { profile, best: [], current: [] };
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(data));
  if (complete) {
    await fs.writeFile(path.join(directory, `full-${name}.json`), JSON.stringify({ ...data, allRecords: [] }));
  }
}

test("selects the correct game's latest export from a shared output directory", async (t) => {
  const directory = await fixture(t);
  await writeInput(directory, "mai-old", { star: 1 });
  await fs.utimes(path.join(directory, "mai-old.json"), 1, 1);
  await writeInput(directory, "mai-new", { star: 2 });
  await writeInput(directory, "chuni", { overpowerValue: 100 });
  await fs.writeFile(path.join(directory, "state.json"), JSON.stringify({ cookies: [] }));
  await fs.writeFile(path.join(directory, "broken.json"), "{");
  await fs.writeFile(path.join(directory, "malformed.json"), JSON.stringify({ profile: 1, best: [], current: [] }));

  assert.equal(path.basename((await findNewestInput(directory, "maimai")).inputPath), "mai-new.json");
  assert.equal(path.basename((await findNewestInput(directory, "chunithm")).inputPath), "chuni.json");
});

test("cannot recover a failed scrape without matching complete JSON", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(findNewestInput(directory, "maimai"), /No maimai image-generation JSON/);
  await writeInput(directory, "mai", { star: 1 }, false);
  await assert.rejects(findNewestInput(directory, "maimai"), /ENOENT/);
  await fs.writeFile(path.join(directory, "full-mai.json"), "{}");
  await assert.rejects(findNewestInput(directory, "maimai"), /Incomplete full export/);
});

test("diagnostics retain failing asset paths but omit URL credentials and payloads", () => {
  const message = "Failed https://user:password@example.com/_app/chunk.js?token=secret#private data:image/png;base64,private-payload";
  assert.equal(diagnosticText(message), "Failed https://example.com/_app/chunk.js [data URL omitted]");
});

test("upstream HTTP failure is logged and rejected without generating a substitute image", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  t.mock.method(console, "log", () => {});
  const handlers = new Map();
  const response = {
    status: () => 525,
    ok: () => false,
    url: () => "https://example.com/?token=secret",
  };
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    on: (event, callback) => handlers.set(event, callback),
    goto: async () => {
      handlers.get("response")(response);
      return response;
    },
  };
  await assert.rejects(generateImage(page, {
    inputPath: "/unused.json", serviceUrl: "https://example.com", version: "XVRSX", data: {},
  }), /Renderer returned HTTP 525/);
  assert.deepEqual(errors, ["[renderer HTTP 525] https://example.com/"]);
});

test("a missing download remains a failure after the extended wait", async (t) => {
  t.mock.method(console, "log", () => {});
  const timeout = new Error("download timed out after 120000ms");
  const control = { selectOption() {}, setInputFiles() {}, waitFor() {}, click() {} };
  const page = {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {},
    goto: async () => ({ ok: () => true }),
    locator: () => control, getByLabel: () => control,
    getByText: () => control, getByRole: () => control,
    waitForEvent: async (event, options) => {
      assert.equal(event, "download");
      assert.equal(options.timeout, 120_000);
      throw timeout;
    },
  };
  await assert.rejects(generateImage(page, {
    inputPath: "/unused.json", serviceUrl: "https://example.com", version: "XVRSX", data: {},
  }), (error) => error === timeout);
});
