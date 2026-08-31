export const CODEX_AUTH_CHANGED_EVENT = "chumainichi:codex-auth-changed";

type RefreshEventTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

export type CodexAuthRefreshSignalSources = {
  windowTarget: RefreshEventTarget;
  documentTarget: RefreshEventTarget;
  getVisibilityState: () => DocumentVisibilityState;
};

export function subscribeToCodexAuthRefreshSignals(
  refresh: () => void,
  sources: CodexAuthRefreshSignalSources = {
    windowTarget: window,
    documentTarget: document,
    getVisibilityState: () => document.visibilityState,
  },
): () => void {
  const handleRefresh: EventListener = () => refresh();
  const handleVisibilityChange: EventListener = () => {
    if (sources.getVisibilityState() === "visible") refresh();
  };

  sources.windowTarget.addEventListener(
    CODEX_AUTH_CHANGED_EVENT,
    handleRefresh,
  );
  sources.windowTarget.addEventListener("focus", handleRefresh);
  sources.documentTarget.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
  );

  return () => {
    sources.windowTarget.removeEventListener(
      CODEX_AUTH_CHANGED_EVENT,
      handleRefresh,
    );
    sources.windowTarget.removeEventListener("focus", handleRefresh);
    sources.documentTarget.removeEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );
  };
}
