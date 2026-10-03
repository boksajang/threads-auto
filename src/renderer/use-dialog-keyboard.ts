import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = 'button,input:not([type="hidden"]),select,textarea,a[href],summary,[tabindex]';
const initialFieldSelector = 'input[autofocus]:not([disabled]),textarea[autofocus]:not([disabled]),select[autofocus]:not([disabled]),.modal-body input:not([disabled]),.modal-body textarea:not([disabled]),.modal-body select:not([disabled])';

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(element =>
    element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert]') &&
    ![element, ...ancestors(element, dialog)].some(node => {
      const style = getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden';
    }));
}

function ancestors(element: HTMLElement, dialog: HTMLElement): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (let parent = element.parentElement; parent && parent !== dialog; parent = parent.parentElement) nodes.push(parent);
  return nodes;
}

export function useDialogKeyboard(ref: RefObject<HTMLElement | null>, onClose: () => void, open = true): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      const dialog = ref.current;
      if (!dialog || dialog.contains(document.activeElement)) return;
      const focusable = focusableElements(dialog);
      (focusable.find(element => element.matches(initialFieldSelector)) ?? focusable[0])?.focus();
    }, 0);
    const handle = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog) return;
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs.length && dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { window.clearTimeout(focusTimer); document.removeEventListener('keydown', handle); if (previous?.isConnected) previous.focus(); };
  }, [ref, open]);
}
