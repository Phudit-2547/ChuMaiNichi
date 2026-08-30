import { MessageCircle, RotateCw, Settings } from "lucide-react";
import useShellStore from "../stores/shell-store";

interface HeaderProps {
  onRefresh: () => void;
  onOpenSettings: () => void;
  refreshing?: boolean;
  refreshStatus?: string;
  refreshAvailable?: boolean;
}

export default function Header({
  onRefresh,
  onOpenSettings,
  refreshing = false,
  refreshStatus = "",
  refreshAvailable = true,
}: HeaderProps) {
  const { chatOpen, toggleChat } = useShellStore();

  const refreshState =
    refreshStatus === "queued" ||
    refreshStatus === "in_progress" ||
    refreshStatus === "syncing" ||
    refreshStatus === "completed" ||
    refreshStatus === "failed"
      ? refreshStatus
      : refreshing
        ? "working"
        : "idle";

  const refreshCopy =
    refreshStatus === "queued"
      ? {
          label: "Queued",
          title: "Refresh queued. Waiting for the scrape to start.",
        }
      : refreshStatus === "in_progress"
        ? {
            label: "Running",
            title: "Refresh running. New score data is being collected.",
          }
        : refreshStatus === "syncing"
          ? {
              label: "Syncing",
              title: "Refresh finished. Updating the dashboard data.",
            }
          : refreshStatus === "completed"
            ? {
                label: "Done",
                title: "Refresh complete. Scores are up to date.",
              }
            : refreshStatus === "failed"
              ? {
                  label: "Retry",
                  title: "Refresh failed. Try again.",
                }
              : refreshing
                ? {
                    label: "Working",
                    title: "Refresh in progress. Please wait.",
                  }
                : {
                    label: "Refresh",
                    title: "Refresh scores",
                  };
  const assistantTitle = chatOpen
    ? "Close Assistant (Ctrl/Cmd+K)"
    : "Open Assistant (Ctrl/Cmd+K)";

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <svg
          className="app-header__logo"
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient
              id="app-header-logo-gradient"
              x1="12"
              y1="12"
              x2="88"
              y2="88"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor="var(--color-maimai)" />
              <stop offset="52%" stopColor="var(--color-accent-hover)" />
              <stop offset="100%" stopColor="var(--color-chunithm)" />
            </linearGradient>
          </defs>
          <path
            id="app-header-logo-circle"
            className="app-header__logo-text-path"
            d="M 50, 50 m -43, 0 a 43,43 0 1,1 86,0 a 43,43 0 1,1 -86,0"
          />
          <path
            className="app-header__logo-orbit app-header__logo-orbit--back"
            d="M 50, 50 m -38, 0 a 38,38 0 1,1 76,0 a 38,38 0 1,1 -76,0"
          />
          <path
            className="app-header__logo-orbit"
            d="M 50, 50 m -38, 0 a 38,38 0 1,1 76,0 a 38,38 0 1,1 -76,0"
          />
          <g className="app-header__logo-sparks">
            <circle
              className="app-header__logo-spark app-header__logo-spark--maimai"
              cx="73"
              cy="30"
              r="5.5"
            />
            <circle
              className="app-header__logo-spark app-header__logo-spark--chunithm"
              cx="27"
              cy="70"
              r="4.5"
            />
          </g>
          <text className="app-header__logo-text">
            <textPath href="#app-header-logo-circle" startOffset="0%">
              CHUMAINICHI / MAIMAI / CHUNITHM /
            </textPath>
          </text>
        </svg>
        ChuMaiNichi
      </div>
      <div className="app-header__spacer" />
      <div className="app-header__actions" data-header-actions="score-controls">
        {refreshAvailable && (
          <button
            type="button"
            className={`app-header__action app-header__action--primary app-header__action--refresh text-btn text-btn--refresh glass-control glass-control--primary ${refreshing ? "glass-control--active" : ""}`}
            onClick={onRefresh}
            disabled={refreshing}
            title={refreshCopy.title}
            aria-label={refreshCopy.title}
            aria-busy={refreshing}
            data-header-action="refresh"
            data-priority="primary"
            data-state={refreshState}
          >
            <RotateCw size={16} className={refreshing ? "icon-spin" : ""} />
            <span className="text-btn__label text-btn__label--primary" aria-live="polite">
              {refreshCopy.label}
            </span>
          </button>
        )}
        <button
          type="button"
          className="app-header__action app-header__action--quiet app-header__action--settings icon-btn glass-control glass-control--clear"
          title="Settings"
          aria-label="Open settings"
          onClick={onOpenSettings}
          data-header-action="settings"
          data-priority="tertiary"
          data-state="idle"
        >
          <Settings size={18} />
        </button>
        <button
          id="chat-toggle-button"
          type="button"
          className={`app-header__action app-header__action--stateful app-header__action--assistant icon-btn icon-btn--chat glass-control glass-control--clear ${chatOpen ? "glass-control--active" : ""}`}
          title={assistantTitle}
          aria-label={chatOpen ? "Close Assistant" : "Open Assistant"}
          aria-pressed={chatOpen}
          aria-keyshortcuts="Control+K Meta+K"
          onClick={toggleChat}
          data-header-action="assistant"
          data-priority="secondary"
          data-state={chatOpen ? "open" : "closed"}
        >
          <MessageCircle size={18} />
          {!chatOpen && (
            <span className="icon-btn__shortcut icon-btn__shortcut--desktop" aria-hidden="true">
              Ctrl/⌘ K
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
