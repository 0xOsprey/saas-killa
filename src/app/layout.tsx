import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { Inter, Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import { AppShell } from '@/components/AppShell';
import { currentUser } from '@/lib/auth';
import { getEvent } from '@/lib/queries';
import { cn } from '@/components/ui';
import './globals.css';

const bodyFont = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const displayFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-display-face',
  display: 'swap',
});

const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-code',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Saas Killa',
  description: 'Call for papers, grading, scheduling and the public agenda for one conference.',
};

// Every page reads the database and most read the session cookie, so nothing
// here is statically prerenderable.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [user, event, cookieStore] = await Promise.all([
    currentUser().catch(() => null),
    getEvent().catch(() => null),
    cookies(),
  ]);

  const theme = cookieStore.get('theme')?.value === 'light' ? 'light' : 'ai-engineer';

  return (
    <html
      lang="en"
      className={cn(
        bodyFont.variable,
        displayFont.variable,
        monoFont.variable,
        theme === 'ai-engineer' && 'theme-ai-engineer',
      )}
      data-theme={theme}
    >
      <body className="min-h-[100dvh] antialiased">
        <AppShell user={user} eventName={event?.name ?? null} theme={theme}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
