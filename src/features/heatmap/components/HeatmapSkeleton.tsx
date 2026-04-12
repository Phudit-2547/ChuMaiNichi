export default function HeatmapSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <div className="w-20 h-[1.1rem] bg-surface rounded animate-skeleton-pulse" />
        <div className="w-full max-w-235 h-30 bg-surface rounded animate-skeleton-pulse" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="w-20 h-[1.1rem] bg-surface rounded animate-skeleton-pulse" />
        <div className="w-full max-w-235 h-30 bg-surface rounded animate-skeleton-pulse" />
      </div>
    </div>
  );
}
