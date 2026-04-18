import { APP_CONFIG } from "../../../../global/lib/config";
import HeatmapSkeletonBlock from "./HeatmapSkeletonBlock";

export default function HeatmapSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-label="Loading">
      {APP_CONFIG.games.map((g) => (
        <HeatmapSkeletonBlock key={g} />
      ))}
    </div>
  );
}
