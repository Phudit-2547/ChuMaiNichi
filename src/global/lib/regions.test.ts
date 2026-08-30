import { describe, expect, it } from "vitest";
import { isDataRegion } from "./regions";

describe("isDataRegion", () => {
  it.each(["international", "japan"])("accepts %s", (region) => {
    expect(isDataRegion(region)).toBe(true);
  });

  it.each([undefined, null, "unknown", "jp", 1])("rejects %s", (value) => {
    expect(isDataRegion(value)).toBe(false);
  });
});
