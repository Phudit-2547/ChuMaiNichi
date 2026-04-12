import HeatmapSkeletonBlock from "./HeatmapSkeletonBlock";

export default function HeatmapSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-label="Loading">
      <HeatmapSkeletonBlock />
      <HeatmapSkeletonBlock />
    </div>
  );
}
