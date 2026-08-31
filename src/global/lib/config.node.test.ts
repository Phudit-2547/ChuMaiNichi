import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("APP_CONFIG native Node loading", () => {
  it("imports config without a missing JSON import attribute", () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), "src/global/lib/config.ts"),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_IMPORT_ATTRIBUTE_MISSING");
    expect(result.status).toBe(0);
  });
});
