import React from "react";

interface ModalProps {
  children: React.ReactNode;
  onClose?: () => void;
}

export function Modal({ children, onClose }: ModalProps) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-surface)] card p-6 w-full max-w-xl lg:max-w-2xl max-h-[90vh] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

// Confirmation Modal - replaces browser confirm()
interface ConfirmModalProps {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "danger",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-surface)] card p-6 w-full max-w-sm">
        {title && <h3 className="font-medium mb-2">{title}</h3>}
        <p className="text-sm text-[var(--color-text)] mb-4">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] btn px-4 py-2 transition"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 text-sm text-white px-4 py-2 btn transition ${
              confirmVariant === "danger"
                ? "bg-red-500 hover:bg-red-600"
                : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

// Alert Modal - replaces browser alert()
interface AlertModalProps {
  title?: string;
  message: string;
  buttonText?: string;
  variant?: "error" | "success" | "info";
  onClose: () => void;
}

export function AlertModal({
  title,
  message,
  buttonText = "OK",
  variant = "info",
  onClose,
}: AlertModalProps) {
  const iconColors = {
    error: "bg-red-500/20 text-red-400",
    success: "bg-green-500/20 text-green-400",
    info: "bg-blue-500/20 text-blue-400",
  };

  const icons = {
    error: "✕",
    success: "✓",
    info: "ℹ",
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--color-surface)] card p-6 w-full max-w-sm text-center">
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${iconColors[variant]}`}
        >
          <span className="text-xl">{icons[variant]}</span>
        </div>
        {title && <h3 className="font-medium mb-2">{title}</h3>}
        <p className="text-sm text-[var(--color-text)] mb-4">{message}</p>
        <button
          onClick={onClose}
          className="w-full text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] px-4 py-2 btn transition"
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
}

// Hook for using confirmation dialogs
import { useState, useCallback } from "react";

interface UseConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: "danger" | "primary";
}

export function useConfirm() {
  const [state, setState] = useState<{
    message: string;
    options: UseConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const confirm = useCallback((message: string, options: UseConfirmOptions = {}) => {
    return new Promise<boolean>((resolve) => {
      setState({ message, options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    state?.resolve(true);
    setState(null);
  }, [state]);

  const handleCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  const ConfirmDialog = state ? (
    <ConfirmModal
      title={state.options.title}
      message={state.message}
      confirmText={state.options.confirmText}
      cancelText={state.options.cancelText}
      confirmVariant={state.options.confirmVariant}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, ConfirmDialog };
}

// Hook for using alert dialogs
interface UseAlertOptions {
  title?: string;
  buttonText?: string;
  variant?: "error" | "success" | "info";
}

export function useAlert() {
  const [state, setState] = useState<{
    message: string;
    options: UseAlertOptions;
    resolve: () => void;
  } | null>(null);

  const alert = useCallback((message: string, options: UseAlertOptions = {}) => {
    return new Promise<void>((resolve) => {
      setState({ message, options, resolve });
    });
  }, []);

  const handleClose = useCallback(() => {
    state?.resolve();
    setState(null);
  }, [state]);

  const AlertDialog = state ? (
    <AlertModal
      title={state.options.title}
      message={state.message}
      buttonText={state.options.buttonText}
      variant={state.options.variant}
      onClose={handleClose}
    />
  ) : null;

  return { alert, AlertDialog };
}
