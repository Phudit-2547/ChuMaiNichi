export default function AuthLoading() {
  return (
    <div
      className="flex items-center justify-center min-h-screen"
      aria-label="Checking authentication"
    >
      <span className="text-xl text-muted-foreground animate-skeleton-pulse">
        ChuMaiNichi
      </span>
    </div>
  );
}
