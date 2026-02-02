import React from "react";

interface ModalProps {
  children: React.ReactNode;
  onClose?: () => void;
}

export function Modal({ children, onClose }: ModalProps) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#111] rounded p-6 w-full max-w-xl lg:max-w-2xl border border-[#1a1a1a] max-h-[90vh] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
