'use client';

import { clsx, type ClassValue } from 'clsx';
import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { twMerge } from 'tailwind-merge';

function cn(...parts: ClassValue[]) {
  return twMerge(clsx(...parts));
}

type SheetContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
};

const SheetContext = createContext<SheetContextValue | null>(null);

function useSheet() {
  const ctx = useContext(SheetContext);
  if (!ctx) throw new Error('Sheet components must be used inside <Sheet>');
  return ctx;
}

export function Sheet({
  children,
  defaultOpen,
  open: openProp,
  onOpenChange,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const open = openProp !== undefined ? openProp : internalOpen;
  const titleId = useId();
  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  return (
    <SheetContext.Provider value={{ open, setOpen, titleId }}>
      {children}
    </SheetContext.Provider>
  );
}

export function SheetTrigger({ className, children, ...props }: ComponentProps<'button'>) {
  const ctx = useSheet();
  return (
    <button
      type="button"
      onClick={() => ctx.setOpen(true)}
      className={cn('inline-flex items-center justify-center', className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function SheetContent({ className, children, ...props }: ComponentProps<'div'>) {
  const ctx = useSheet();
  useEffect(() => {
    if (!ctx.open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') ctx.setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [ctx.open, ctx.setOpen]);
  if (!ctx.open) return null;
  return (
    <div className="fixed inset-0 z-50" {...props}>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => ctx.setOpen(false)}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={ctx.titleId}
        className={cn(
          'fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-line/50 bg-surface p-6 shadow-xl',
          'flex flex-col',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SheetHeader({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('mb-4 flex items-start justify-between', className)} {...props}>
      {children}
    </div>
  );
}

export function SheetTitle({ className, children, ...props }: ComponentProps<'h2'>) {
  const ctx = useSheet();
  return (
    <h2 id={ctx.titleId} className={cn('text-lg font-semibold text-ink', className)} {...props}>
      {children}
    </h2>
  );
}

export function SheetClose({ className, children, ...props }: ComponentProps<'button'>) {
  const ctx = useSheet();
  return (
    <button
      type="button"
      onClick={() => ctx.setOpen(false)}
      aria-label="Close"
      className={cn('rounded-md p-1 text-muted transition-colors hover:bg-ink/5 hover:text-ink', className)}
      {...props}
    >
      {children ?? <X className="h-5 w-5" />}
    </button>
  );
}
