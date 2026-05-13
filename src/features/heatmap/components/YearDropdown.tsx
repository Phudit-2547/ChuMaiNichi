import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";

interface YearDropdownProps {
  value: number;
  years: number[];
  onChange: (year: number) => void;
}

export function YearDropdown({ value, years, onChange }: YearDropdownProps) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFocused(-1);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setFocused(-1);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setFocused(years.indexOf(value));
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => (f < years.length - 1 ? f + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => (f > 0 ? f - 1 : years.length - 1));
    } else if (e.key === "Enter" && focused >= 0) {
      e.preventDefault();
      onChange(years[focused]);
      setOpen(false);
      setFocused(-1);
    }
  };

  return (
    <div
      ref={wrapperRef}
      className="relative inline-flex items-center"
      onKeyDown={handleKeyDown}
    >
      {/* Trigger button */}
      <button
        type="button"
        className="inline-flex items-center gap-2 bg-elevated border border-border-subtle rounded-xl shadow-card
                   px-4 py-2.5 text-base font-bold text-foreground cursor-pointer
                   transition-all duration-150 hover:bg-surface hover:border-border
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value}
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Options panel */}
      {open && (
        <div
          className="absolute top-full left-0 mt-2 z-50 min-w-full bg-elevated border border-border-subtle
                     rounded-xl shadow-elevated overflow-hidden"
        >
          <ul
            ref={listRef}
            role="listbox"
            className="py-1 max-h-64 overflow-y-auto"
            aria-label="Select year"
          >
            {years.map((year, i) => (
              <li
                key={year}
                role="option"
                aria-selected={year === value}
                className={`
                  flex items-center justify-between px-4 py-2 cursor-pointer text-sm select-none
                  transition-colors duration-100
                  ${year === value
                    ? "bg-accent-soft text-accent-hover font-semibold"
                    : "text-foreground hover:bg-surface"
                  }
                  ${focused === i ? "bg-surface" : ""}
                `}
                onMouseEnter={() => setFocused(i)}
                onMouseLeave={() => setFocused(-1)}
                onClick={() => {
                  onChange(year);
                  setOpen(false);
                  setFocused(-1);
                }}
              >
                <span>{year}</span>
                {year === value && <Check size={12} className="text-accent-hover" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
