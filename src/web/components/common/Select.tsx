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
}

export function Select({ value, options, onChange, placeholder = "Select..." }: SelectProps) {
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
        className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 text-left flex items-center justify-between focus:outline-none focus:border-[#f97316] text-[#e0e0e0] hover:border-[#333] transition"
      >
        <span className={selectedOption ? "text-[#e0e0e0]" : "text-[#666]"}>
          {selectedOption ? (
            <>
              {selectedOption.label}
              {selectedOption.recommended && (
                <span className="text-[#f97316] text-xs ml-2">(Recommended)</span>
              )}
            </>
          ) : placeholder}
        </span>
        <ChevronIcon isOpen={isOpen} />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-[#111] border border-[#222] rounded shadow-lg max-h-60 overflow-auto">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2 text-left flex items-center justify-between hover:bg-[#1a1a1a] transition ${
                option.value === value ? "bg-[#1a1a1a] text-[#f97316]" : "text-[#e0e0e0]"
              }`}
            >
              <span>
                {option.label}
                {option.recommended && (
                  <span className="text-[#f97316] text-xs ml-2">(Recommended)</span>
                )}
              </span>
              {option.value === value && (
                <svg className="w-4 h-4 text-[#f97316]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      className={`w-4 h-4 text-[#666] transition-transform ${isOpen ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
