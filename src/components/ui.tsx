import { clsx } from 'clsx';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export function cn(...parts: Parameters<typeof clsx>) {
  return twMerge(clsx(...parts));
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-white hover:bg-indigo-700',
  secondary: 'border border-line bg-white text-ink hover:bg-slate-50',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
  ghost: 'text-muted hover:bg-slate-100 hover:text-ink',
} as const;

export function Button({
  className,
  variant = 'primary',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <button className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} {...props} />;
}

export function LinkButton({
  className,
  variant = 'primary',
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <Link className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)} {...props} />;
}

const FIELD =
  'w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(FIELD, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD, 'min-h-32 resize-y', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(FIELD, className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-white p-4 shadow-sm', className)}
      {...props}
    />
  );
}

const BADGE_TONES = {
  neutral: 'bg-slate-100 text-slate-700',
  accent: 'bg-accent-soft text-accent',
  good: 'bg-emerald-50 text-emerald-700',
  bad: 'bg-red-50 text-red-700',
  warn: 'bg-amber-50 text-amber-800',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: keyof typeof BADGE_TONES }) {
  return (
    <span
      className={cn(
        // `wrap-anywhere`, not `break-words`: a badge holds user text — a
        // keyword, a track name — and one unbroken 58-character token widened
        // the card past a 390px viewport, giving the whole page a horizontal
        // scrollbar. `overflow-wrap: break-word` does not fix that, because it
        // leaves the min-content width of the word intact and the card sizes to
        // it anyway. Measured at 439px against a 390px client either way;
        // `anywhere` is what brought it back to 390.
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium wrap-anywhere',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white p-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}

export function Notice({
  tone = 'warn',
  children,
}: {
  tone?: 'warn' | 'bad' | 'good' | 'accent';
  children: ReactNode;
}) {
  const tones = {
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    bad: 'border-red-200 bg-red-50 text-red-900',
    good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    accent: 'border-indigo-200 bg-accent-soft text-indigo-900',
  } as const;
  return (
    <div className={cn('rounded-md border px-4 py-3 text-sm', tones[tone])}>{children}</div>
  );
}

export function ScoreDots({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted">no grades</span>;
  return (
    <span className="inline-flex items-center gap-1" title={`${score.toFixed(2)} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={cn(
            'h-2 w-2 rounded-full',
            n <= Math.round(score) ? 'bg-accent' : 'bg-slate-200',
          )}
        />
      ))}
      <span className="ml-1 text-xs tabular-nums text-muted">{score.toFixed(1)}</span>
    </span>
  );
}
