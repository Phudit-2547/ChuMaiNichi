import { MessageCircle, RotateCw, Settings } from "lucide-react";
import useShellStore from "../stores/shell-store";

interface HeaderProps {
  onRefresh: () => void;
  onOpenSettings: () => void;
  refreshing?: boolean;
}

export default function Header({
  onRefresh,
  onOpenSettings,
  refreshing = false,
}: HeaderProps) {
  const { chatOpen, toggleChat } = useShellStore();

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
        title={refreshing ? "Please wait ~2 min" : "Refresh scores"}
        aria-label={refreshing ? "Please wait ~2 min" : "Refresh scores"}
      >
        <RotateCw size={16} className={refreshing ? "icon-spin" : ""} />
        <span className="text-btn__label">
          {refreshing ? "Please wait ~2 min" : "Refresh scores"}
        </span>
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
        className="icon-btn"
        title={chatOpen ? "Close chat" : "Open chat"}
        aria-pressed={chatOpen}
        onClick={toggleChat}
      >
        <MessageCircle size={18} />
      </button>
    </header>
  );
}
