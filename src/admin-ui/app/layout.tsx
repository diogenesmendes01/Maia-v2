import './../styles/globals.css';
import * as React from 'react';
import Link from 'next/link';
import { auth } from '../lib/auth.js';
import { Providers } from './providers.js';

export const metadata = {
  title: 'Maia Admin',
  description: 'Governance & approval control plane (P8.5)',
};

// Every route in the admin-ui depends on the NextAuth session (the layout
// calls `auth()`, every page reads `useSession()`). Static prerendering would
// either bake in an empty session or throw `useContext is null`. Force-dynamic
// on the root layout makes Next render at request time, which is the only
// correct behavior for a session-gated app.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          {session ? (
            <>
              <nav className="bg-gray-900 text-white p-4 flex justify-between items-center">
                <div className="flex gap-4 flex-wrap text-sm">
                  <Link href="/dashboard" className="hover:underline font-medium">
                    Dashboard
                  </Link>
                  <Link href="/inbox" className="hover:underline">
                    Inbox
                  </Link>
                  <Link href="/versions" className="hover:underline">
                    Versions
                  </Link>
                  <Link href="/drift" className="hover:underline">
                    Drift
                  </Link>
                  <Link href="/traces" className="hover:underline">
                    Traces
                  </Link>
                  <Link href="/identities" className="hover:underline">
                    Identities
                  </Link>
                  <Link href="/capabilities" className="hover:underline">
                    Capabilities
                  </Link>
                  <Link href="/procedures" className="hover:underline">
                    Procedures
                  </Link>
                  <Link href="/knowledge" className="hover:underline">
                    Knowledge
                  </Link>
                  <span className="opacity-50">|</span>
                  <Link href="/setup/tenants" className="hover:underline">
                    Tenants
                  </Link>
                  <Link href="/setup/agents" className="hover:underline">
                    Agents
                  </Link>
                  <Link href="/setup/channels" className="hover:underline">
                    Channels
                  </Link>
                  <Link href="/setup/llm-settings" className="hover:underline">
                    LLM Settings
                  </Link>
                </div>
                <div className="flex gap-4 items-center text-sm">
                  <span className="opacity-80">
                    {session.user?.email}
                    <span className="ml-2 px-2 py-0.5 bg-gray-700 rounded text-xs">
                      {session.user?.role}
                    </span>
                  </span>
                  <Link href="/api/auth/signout" className="underline hover:no-underline">
                    Logout
                  </Link>
                </div>
              </nav>
              <main className="p-6 max-w-7xl mx-auto">{children}</main>
            </>
          ) : (
            <main className="p-6">{children}</main>
          )}
        </Providers>
      </body>
    </html>
  );
}
