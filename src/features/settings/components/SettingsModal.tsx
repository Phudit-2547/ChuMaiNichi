import { useEffect } from "react";
import { Settings as Gear, X } from "lucide-react";
import useSettingsStore from "../stores/settings-store";
import useAuthStore from "@/features/auth/stores/auth-store";
import { APP_CONFIG } from "@/global/lib/config";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsModal({
  open,
  onOpenChange,
}: SettingsModalProps) {
  const {
    autoOpenChat,
    showToolCalls,
    setAutoOpenChat,
    setShowToolCalls,
  } = useSettingsStore();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const handleSignOut = () => {
    if (!confirm("Sign out of the dashboard?")) return;
    useAuthStore.getState().clearPassword();
    window.location.reload();
  };

  return (
    <div className="modal-backdrop" onClick={() => onOpenChange(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <Gear size={16} style={{ color: "var(--color-accent-hover)" }} />
          <h2>Settings</h2>
          <button
            type="button"
            className="modal-close"
            onClick={() => onOpenChange(false)}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          <section className="modal-section">
            <h3>Assistant</h3>
            <Row
              label="Auto-open on load"
              sub="Show the chat panel every visit"
            >
              <Toggle
                pressed={autoOpenChat}
                onChange={setAutoOpenChat}
                label="Auto-open chat"
              />
            </Row>
            <Row
              label="Stream tool calls"
              sub="Show SQL + suggestion cards inline"
            >
              <Toggle
                pressed={showToolCalls}
                onChange={setShowToolCalls}
                label="Stream tool calls"
              />
            </Row>
          </section>

          <section className="modal-section">
            <h3>Data</h3>
            <Row label="Currency per play" sub="From config.json · deploy-time">
              <span className="row-value">฿{APP_CONFIG.currency_per_play}</span>
            </Row>
            <Row label="Games" sub="From config.json">
              <div className="row-badges">
                {APP_CONFIG.games.map((g) => (
                  <span key={g} className="game-badge" data-game={g}>
                    {g}
                  </span>
                ))}
              </div>
            </Row>
          </section>
        </div>

        <div className="modal-footer">
          <span>stored in localStorage</span>
          <button type="button" className="link-btn" onClick={handleSignOut}>
            sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="row">
      <div>
        <div>{label}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  pressed,
  onChange,
  label,
}: {
  pressed: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={pressed}
      aria-label={label}
      onClick={() => onChange(!pressed)}
    />
  );
}
