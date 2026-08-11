'use client';

import { clsx, type ClassValue } from 'clsx';
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { twMerge } from 'tailwind-merge';

function cn(...parts: ClassValue[]) {
  return twMerge(clsx(...parts));
}

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used inside <Tabs>');
  return ctx;
}

export function Tabs({
  children,
  defaultValue,
  value: valueProp,
  onValueChange,
  className,
}: {
  children: ReactNode;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? '');
  const value = valueProp !== undefined ? valueProp : internalValue;
  const setValue = (next: string) => {
    setInternalValue(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex border-b border-line', className)} {...props} />;
}

export function Tab({
  value,
  className,
  children,
  ...props
}: ComponentProps<'button'> & { value: string }) {
  const ctx = useTabs();
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.setValue(value)}
      className={cn(
        '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-muted hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabPanel({
  value,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { value: string }) {
  const ctx = useTabs();
  if (ctx.value !== value) return null;
  return (
    <div role="tabpanel" className={cn('py-4', className)} {...props}>
      {children}
    </div>
  );
}
