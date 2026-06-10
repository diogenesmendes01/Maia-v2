'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { trpc } from '../../trpc/client.js';
import { NAV_SECTIONS } from './nav.js';
import { cn } from '../ui/cn.js';
import {
  IconHome,
  IconBot,
  IconInbox,
  IconGitBranch,
  IconAlertTriangle,
  IconSearch,
  IconBrain,
  IconLayers,
  IconZap,
  IconWrench,
  IconActivity,
  IconMessage,
  IconUsers,
  IconSettings,
  IconSparkles,
  IconLogout,
} from '../ui/icons.js';

const ICONS = {
  home: IconHome,
  bot: IconBot,
  inbox: IconInbox,
  gitBranch: IconGitBranch,
  alertTriangle: IconAlertTriangle,
  search: IconSearch,
  brain: IconBrain,
  layers: IconLayers,
  zap: IconZap,
  wrench: IconWrench,
  activity: IconActivity,
  message: IconMessage,
  users: IconUsers,
  settings: IconSettings,
  sparkles: IconSparkles,
} as const;

function isActive(pathname: string, href: string, activePrefix?: string): boolean {
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  if (activePrefix && pathname.startsWith(activePrefix)) return true;
  return false;
}

/**
 * App shell: fixed dark sidebar + scrollable content column.
 * The pending-approvals badge keeps the daily loop visible from anywhere.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';

  const countersQuery = trpc.inbox.counters.useQuery(
    { tenantId },
    { enabled: tenantId !== '', refetchInterval: 60_000 },
  );
  const pendingTotal = React.useMemo(() => {
    // inbox.counters returns the per-type pending map directly.
    const byType = countersQuery.data ?? {};
    return Object.values(byType).reduce<number>(
      (sum, n) => sum + (typeof n === 'number' ? n : 0),
      0,
    );
  }, [countersQuery.data]);

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-ink text-zinc-300">
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 px-5 py-5"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            M
          </span>
          <span className="text-sm font-semibold tracking-tight text-white">
            Maia Console
          </span>
        </Link>

        <nav className="scroll-thin grow space-y-5 overflow-y-auto px-3 pb-4">
          {NAV_SECTIONS.map((section, si) => {
            const items = section.items.filter(
              (i) => !i.founderOnly || role === 'founder',
            );
            if (items.length === 0) return null;
            return (
              <div key={si}>
                {section.label && (
                  <p className="mb-1 px-2 text-2xs font-semibold uppercase tracking-wider text-zinc-500">
                    {section.label}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = ICONS[item.icon];
                    const active = isActive(pathname, item.href, item.activePrefix);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                            active
                              ? 'bg-ink-soft font-medium text-white'
                              : 'text-zinc-400 hover:bg-ink-soft/60 hover:text-zinc-100',
                          )}
                        >
                          <Icon size={16} className={active ? 'text-brand-400' : ''} />
                          <span className="grow">{item.label}</span>
                          {item.href === '/inbox' && pendingTotal > 0 && (
                            <span className="rounded-full bg-amber-500/90 px-1.5 py-0.5 text-2xs font-semibold text-amber-950">
                              {pendingTotal}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-ink-line px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-zinc-200">
                {session?.user?.email ?? '—'}
              </p>
              <p className="text-2xs text-zinc-500">
                {role || 'sem papel'} · {tenantId || 'sem tenant'}
              </p>
            </div>
            <Link
              href="/api/auth/signout"
              title="Sair"
              className="shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-ink-soft hover:text-zinc-200"
            >
              <IconLogout size={15} />
            </Link>
          </div>
        </div>
      </aside>

      <div className="ml-60 min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
