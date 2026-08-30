export type DataRegion = "international" | "japan";

export const DATA_REGION_LABELS: Record<DataRegion, string> = {
  international: "International",
  japan: "Japan",
};

export function isDataRegion(value: unknown): value is DataRegion {
  return value === "international" || value === "japan";
}
