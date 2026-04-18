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
        className="icon-btn"
        title="Refresh scrape"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <RotateCw size={18} className={refreshing ? "icon-spin" : ""} />
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
        {!chatOpen && <span className="icon-btn__dot" />}
      </button>
    </header>
  );
}
