import { clsx } from 'clsx';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export function cn(...parts: Parameters<typeof clsx>) {
  return twMerge(clsx(...parts));
}

function initials(name: string | null | undefined, email?: string | null): string {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]!.charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
    return (first + last).toUpperCase() || first.toUpperCase() || '?';
  }
  const safeEmail = email ?? '';
  const [local] = safeEmail.split('@');
  const source = local ?? safeEmail;
  return source.slice(0, 2).toUpperCase() || source.charAt(0).toUpperCase() || '?';
}

const AVATAR_SIZES = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-11 w-11 text-sm',
} as const;

export function Avatar({
  src,
  name,
  email,
  size = 'md',
  className,
}: {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
}) {
  const label = name?.trim() || email || 'Avatar';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/10 font-medium uppercase text-ink',
        AVATAR_SIZES[size],
        className,
      )}
      aria-label={label}
      title={label}
      role="img"
    >
      {src ? (
        <img
          src={src}
          alt={label}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{initials(name, email)}</span>
      )}
    </span>
  );
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-background border border-accent hover:bg-accent/90 active:scale-[0.98]',
  secondary: 'border border-line bg-surface text-ink hover:bg-subtle hover:border-ink/20 active:scale-[0.98]',
  danger: 'border border-status-bad-border/20 bg-status-bad-bg/10 text-status-bad-text hover:bg-status-bad-bg/15 active:scale-[0.98]',
  ghost: 'text-muted hover:bg-ink/5 hover:text-ink',
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
  'w-full rounded-md border border-line/50 bg-surface px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted focus:border-ink/40 focus:outline-none focus:ring-2 focus:ring-ink/10';

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
      <span className="block text-sm font-medium leading-5 text-ink">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function FieldAction({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col space-y-1.5', className)}>
      <span
        className={cn(
          'block text-sm font-medium leading-5',
          label ? 'text-ink' : 'invisible',
        )}
        aria-hidden={label ? undefined : 'true'}
      >
        {label || '\u00A0'}
      </span>
      {children}
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-line/50 bg-surface p-4', className)}
      {...props}
    />
  );
}

const BADGE_TONES = {
  neutral: 'bg-ink/5 text-muted',
  accent: 'border border-accent/20 bg-accent/10 text-accent',
  good: 'border border-status-good-border/20 bg-status-good-bg/10 text-status-good-text',
  bad: 'border border-status-bad-border/20 bg-status-bad-bg/10 text-status-bad-text',
  warn: 'border border-status-warn-border/20 bg-status-warn-bg/10 text-status-warn-text',
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

/**
 * Tailwind reads class names as literal strings out of the source, so a
 * computed `line-clamp-${n}` compiles to a rule that does not exist. The map is
 * what makes the `lines` prop real.
 */
const CLAMP_LINES = {
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
} as const;

/**
 * Long text, folded to a few lines behind Show more.
 *
 * The whole string is in the DOM once and CSS decides how much of it you see.
 * The obvious alternative, a short server-truncated copy swapped for the full
 * one, puts the opening sentence on the wire twice on every card of a forty
 * session agenda, and buys back a description almost nobody expands.
 *
 * `details`/`summary` with `group-open:`, which is the disclosure idiom already
 * used by the collapsible panels on `/organizer/speakers`. It costs no client
 * JavaScript on pages a venue full of people open at once, and it keeps a
 * collapsed card the same height whatever the author wrote. Everything sits
 * inside the `summary`, so the element discloses nothing and exists only to
 * carry the open state.
 *
 * Text shorter than `foldAfter` renders as a plain paragraph. A Show more that
 * reveals nothing teaches people the control is decorative.
 */
export function ShowMoreText({
  text,
  lines = 2,
  foldAfter = 180,
  className,
  testId,
}: {
  text: string;
  lines?: keyof typeof CLAMP_LINES;
  foldAfter?: number;
  className?: string;
  testId?: string;
}) {
  const body = cn('block whitespace-pre-wrap', className);

  if (text.length <= foldAfter) {
    return <p className={body}>{text}</p>;
  }

  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <span className={cn(body, CLAMP_LINES[lines], 'group-open:line-clamp-none')}>{text}</span>
        <span className="mt-0.5 block text-xs font-medium text-ink" data-testid={testId}>
          <span className="group-open:hidden">Show more</span>
          <span className="hidden group-open:inline">Show less</span>
        </span>
      </summary>
    </details>
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
        {description ? <p className="mt-1 text-sm font-medium text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center text-sm text-muted">
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
    warn: 'border-status-warn-border/20 bg-status-warn-bg/10 text-status-warn-text',
    bad: 'border-status-bad-border/20 bg-status-bad-bg/10 text-status-bad-text',
    good: 'border-status-good-border/20 bg-status-good-bg/10 text-status-good-text',
    accent: 'border-accent/20 bg-accent/5 text-accent',
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
            n <= Math.round(score) ? 'bg-ink' : 'bg-ink/10',
          )}
        />
      ))}
      <span className="ml-1 text-xs tabular-nums text-muted">{score.toFixed(1)}</span>
    </span>
  );
}

export function Dropdown({ className, ...props }: ComponentProps<'details'>) {
  return <details className={cn('relative inline-block', className)} {...props} />;
}

export function DropdownTrigger({ className, ...props }: ComponentProps<'summary'>) {
  return <summary className={cn('cursor-pointer list-none', className)} {...props} />;
}

export function DropdownMenu({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'absolute right-0 z-50 mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg',
        className,
      )}
      {...props}
    />
  );
}

type DropdownItemProps = {
  href?: string;
} & Omit<ComponentProps<'button'>, 'href'>;

export function DropdownItem({
  href,
  className,
  children,
  disabled,
  type: _type,
  ref,
  ...props
}: DropdownItemProps) {
  const classes = cn(
    'block w-full px-4 py-2 text-left text-sm text-ink transition-colors hover:bg-ink/5',
    className,
  );
  if (href) {
    return (
      <li>
        <Link
          href={href}
          className={classes}
          {...(props as unknown as Omit<
            ComponentProps<typeof Link>,
            'href' | 'className' | 'children' | 'ref' | 'disabled' | 'type'
          >)}
        >
          {children}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <button
        ref={ref}
        type={_type ?? 'button'}
        disabled={disabled}
        className={classes}
        {...props}
      >
        {children}
      </button>
    </li>
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <table className={cn('w-full text-left text-sm', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-line bg-surface text-xs uppercase tracking-wider text-muted', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line bg-surface', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('hover:bg-subtle', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('px-4 py-3 font-medium', className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3', className)} {...props} />;
}

export { Tabs, TabList, Tab, TabPanel } from './Tabs';
export { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetClose } from './Sheet';
