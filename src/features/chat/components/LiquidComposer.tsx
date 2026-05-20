import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/global/lib/utils";
import { Send } from "lucide-react";

interface GlassEffectProps {
  children: ReactNode;
  className?: string;
}

export function GlassComposer({
  children,
  className = "",
}: GlassEffectProps) {
  return (
    <div
      className={cn(
        "chat-composer__box chat-composer__frame relative overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

type GlassSendButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function GlassSendButton({
  className,
  children,
  ...props
}: GlassSendButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "chat-composer__send chat-composer__send--quiet relative overflow-hidden",
        "h-8 w-8",
        className,
      )}
      {...props}
    >
      <span className="relative z-10 flex items-center justify-center">
        {children ?? <Send size={14} />}
      </span>
    </button>
  );
}
