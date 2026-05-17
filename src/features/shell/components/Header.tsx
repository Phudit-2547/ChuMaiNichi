import { MessageCircle, RotateCw, Settings } from "lucide-react";
import useShellStore from "../stores/shell-store";

interface HeaderProps {
  onRefresh: () => void;
  onOpenSettings: () => void;
  refreshing?: boolean;
  refreshStatus?: string;
}

export default function Header({
  onRefresh,
  onOpenSettings,
  refreshing = false,
  refreshStatus = "",
}: HeaderProps) {
  const { chatOpen, toggleChat } = useShellStore();

  const statusLabel =
    refreshStatus === "queued"
      ? "Queued…"
      : refreshStatus === "in_progress"
        ? "Scraping…"
        : refreshStatus === "syncing"
          ? "Updating…"
          : refreshStatus === "completed"
            ? "Done!"
            : refreshStatus === "failed"
              ? "Failed"
              : refreshing
                ? "Please wait…"
                : "Refresh scores";

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" />
        ChuMaiNichi
        <span className="app-header__sub">/ dashboard</span>
      </div>
      <div className="app-header__spacer" />
      <button
        type="button"
        className="text-btn text-btn--refresh"
        onClick={onRefresh}
        disabled={refreshing}
        title={statusLabel}
        aria-label={statusLabel}
      >
        <RotateCw size={16} className={refreshing ? "icon-spin" : ""} />
        <span className="text-btn__label">{statusLabel}</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Settings"
        onClick={onOpenSettings}
      >
        <Settings size={18} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--chat"
        title="Toggle chat (Ctrl/Cmd+K)"
        aria-label={chatOpen ? "Close chat" : "Open chat"}
        aria-pressed={chatOpen}
        aria-keyshortcuts="Control+K Meta+K"
        onClick={toggleChat}
      >
        <MessageCircle size={18} />
        {!chatOpen && (
          <span className="icon-btn__shortcut" aria-hidden="true">
            Ctrl/⌘ K
          </span>
        )}
      </button>
    </header>
  );
}
