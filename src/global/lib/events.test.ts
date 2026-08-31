import { describe, expect, it, vi } from "vitest";
import {
  CODEX_AUTH_CHANGED_EVENT,
  subscribeToCodexAuthRefreshSignals,
} from "./events";

describe("Codex auth refresh signals", () => {
  it("refreshes for same-tab auth changes, tab focus, and becoming visible", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let visibilityState: DocumentVisibilityState = "hidden";
    const refresh = vi.fn();
    const unsubscribe = subscribeToCodexAuthRefreshSignals(refresh, {
      windowTarget,
      documentTarget,
      getVisibilityState: () => visibilityState,
    });

    windowTarget.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(refresh).toHaveBeenCalledTimes(3);

    unsubscribe();
    windowTarget.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
