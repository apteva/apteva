import React from "react";
import { CloseIcon } from "../common/Icons";

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="bg-red-500/10 border-b border-red-500/30 px-6 py-3 text-red-400 text-sm flex items-center justify-between">
      <span>{message}</span>
      <button onClick={onDismiss} className="hover:text-red-300">
        <CloseIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
