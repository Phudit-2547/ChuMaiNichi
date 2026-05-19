import { MonitorCog, Moon, Settings as Gear, Sun, X } from "lucide-react";
import type { ReactNode } from "react";
import useSettingsStore, { type ThemeMode } from "../stores/settings-store";
import useAuthStore from "@/features/auth/stores/auth-store";
import { APP_CONFIG } from "@/global/lib/config";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/global/components/ui/dialog";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsModal({
  open,
  onOpenChange,
}: SettingsModalProps) {
  const {
    themeMode,
    autoOpenChat,
    showToolCalls,
    setThemeMode,
    setAutoOpenChat,
    setShowToolCalls,
  } = useSettingsStore();

  const handleSignOut = () => {
    if (!confirm("Sign out of the dashboard?")) return;
    useAuthStore.getState().clearPassword();
    window.location.reload();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="modal glass-modal gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <div className="modal-head">
          <Gear size={16} style={{ color: "var(--color-accent-hover)" }} />
          <DialogTitle asChild>
            <h2>Settings</h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure assistant display and dashboard session preferences.
          </DialogDescription>
          <DialogClose asChild>
            <button
              type="button"
              className="modal-close glass-control glass-control--clear"
              title="Close"
              aria-label="Close settings"
            >
              <X size={14} />
            </button>
          </DialogClose>
        </div>

        <div className="modal-body">
          <section className="modal-section">
            <h3>Appearance</h3>
            <Row label="Theme" sub="Auto follows system">
              <ThemeSegmentedControl
                value={themeMode}
                onChange={setThemeMode}
              />
            </Row>
          </section>

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
      </DialogContent>
    </Dialog>
  );
}

const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  icon: ReactNode;
}> = [
  { value: "auto", label: "Auto", icon: <MonitorCog size={13} /> },
  { value: "light", label: "Light", icon: <Sun size={13} /> },
  { value: "dark", label: "Dark", icon: <Moon size={13} /> },
];

function ThemeSegmentedControl({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (v: ThemeMode) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="segmented__option glass-control glass-control--clear"
          data-active={value === option.value ? "true" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
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
  children: ReactNode;
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
      className={`toggle glass-control glass-control--clear ${pressed ? "glass-control--active" : ""}`}
      aria-pressed={pressed}
      aria-label={label}
      onClick={() => onChange(!pressed)}
    />
  );
}
