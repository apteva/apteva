import React, { useState, useRef, useEffect } from "react";

interface SelectOption {
  value: string;
  label: string;
  recommended?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}

export function Select({ value, options, onChange, placeholder = "Select...", compact }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(o => o.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded ${compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2"} text-left flex items-center justify-between focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)] hover:border-[var(--color-border-light)] transition`}
      >
        <span className={selectedOption ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
          {selectedOption ? (
            <>
              {selectedOption.label}
              {selectedOption.recommended && (
                <span className="text-[var(--color-accent)] text-xs ml-2">(Recommended)</span>
              )}
            </>
          ) : placeholder}
        </span>
        <ChevronIcon isOpen={isOpen} />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full min-w-max mt-1 bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded shadow-lg max-h-60 overflow-y-auto scrollbar-hide">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`w-full ${compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2"} text-left flex items-center justify-between hover:bg-[var(--color-surface-raised)] transition ${
                option.value === value ? "bg-[var(--color-surface-raised)] text-[var(--color-accent)]" : "text-[var(--color-text)]"
              }`}
            >
              <span>
                {option.label}
                {option.recommended && (
                  <span className="text-[var(--color-accent)] text-xs ml-2">(Recommended)</span>
                )}
              </span>
              {option.value === value && (
                <svg className="w-4 h-4 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
