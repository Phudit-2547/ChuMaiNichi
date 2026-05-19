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
    <div ref={wrapperRef} className="year-dropdown" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="year-dropdown__trigger"
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

      {open && (
        <div className="year-dropdown__menu">
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
                className={`year-dropdown__item ${year === value ? "year-dropdown__item--selected" : ""} ${
                  focused === i ? "year-dropdown__item--focused" : ""
                }`}
                onMouseEnter={() => setFocused(i)}
                onMouseLeave={() => setFocused(-1)}
                onClick={() => {
                  onChange(year);
                  setOpen(false);
                  setFocused(-1);
                }}
              >
                <span>{year}</span>
                {year === value && (
                  <Check size={12} className="text-accent-hover" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
