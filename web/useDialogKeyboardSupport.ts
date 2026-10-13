import { useEffect, useRef } from "react";

type ElementRef<T extends HTMLElement> = { current: T | null };

/** Keeps modal focus behavior consistent across the career and network workspaces. */
export function useDialogKeyboardSupport(
  open: boolean,
  dialogRef: ElementRef<HTMLElement>,
  onClose: () => void,
  returnFocusRef?: ElementRef<HTMLElement>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const container = dialogRef.current;
    if (!container) return;
    const previousFocus = returnFocusRef?.current?.isConnected
      ? returnFocusRef.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const firstFocus = container.querySelector<HTMLElement>("[data-dialog-initial-focus]") || focusable()[0] || container;
    firstFocus.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
      if (returnFocusRef) returnFocusRef.current = null;
    };
  }, [open, dialogRef, returnFocusRef]);
}
