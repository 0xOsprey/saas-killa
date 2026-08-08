import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sessionboard',
  description: 'Call for papers, grading, scheduling and the public agenda for one conference.',
};

// Every page reads the database and most read the session cookie, so nothing
// here is statically prerenderable.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
          Running on Sessionboard.
        </footer>
      </body>
    </html>
  );
}
