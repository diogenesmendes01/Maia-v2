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
  IconShield,
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
  shield: IconShield,
} as const;

function isActive(pathname: string, href: string, activePrefix?: string): boolean {
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  if (activePrefix && pathname.startsWith(activePrefix)) return true;
  return false;
}

/** Local stroke icons for the mobile topbar (same style as ../ui/icons.js). */
function IconMenu({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function IconX({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function BrandLink() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-5 py-5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
        M
      </span>
      <span className="text-sm font-semibold tracking-tight text-white">
        Maia Console
      </span>
    </Link>
  );
}

/** Sidebar/drawer column: brand, nav sections and the user footer block. */
function SidebarContent({
  pathname,
  role,
  tenantId,
  email,
  pendingTotal,
}: {
  pathname: string;
  role: string;
  tenantId: string;
  email: string | null | undefined;
  pendingTotal: number;
}) {
  return (
    <>
      <BrandLink />

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
              {email ?? '—'}
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
    </>
  );
}

/**
 * App shell. `lg` and up: fixed dark sidebar + scrollable content column.
 * Below `lg`: sticky topbar com menu hambúrguer + drawer deslizante.
 * The pending-approvals badge keeps the daily loop visible from anywhere.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role ?? '';
  const tenantId = session?.user?.tenant_id ?? '';

  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Close the drawer on route change so navigation feels native on mobile.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Close on Escape while the drawer is open.
  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

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
      {/* Desktop sidebar (lg and up) — unchanged behavior. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-ink text-zinc-300 lg:flex">
        <SidebarContent
          pathname={pathname}
          role={role}
          tenantId={tenantId}
          email={session?.user?.email}
          pendingTotal={pendingTotal}
        />
      </aside>

      {/* Mobile drawer + backdrop (below lg). */}
      {drawerOpen && (
        <div className="lg:hidden">
          <div
            className="fixed inset-0 z-40 bg-black/50"
            aria-hidden
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Menu de navegação"
            className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col bg-ink text-zinc-300 shadow-overlay"
          >
            <button
              type="button"
              aria-label="Fechar menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-2 top-5 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-ink-soft hover:text-zinc-200"
            >
              <IconX size={16} />
            </button>
            <SidebarContent
              pathname={pathname}
              role={role}
              tenantId={tenantId}
              email={session?.user?.email}
              pendingTotal={pendingTotal}
            />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1 lg:ml-60">
        {/* Mobile topbar (below lg). */}
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-ink-line bg-ink px-3 py-2.5 text-zinc-300 lg:hidden">
          <button
            type="button"
            aria-label="Abrir menu"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-2 text-zinc-300 transition-colors hover:bg-ink-soft hover:text-white"
          >
            <IconMenu size={18} />
          </button>
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">
              M
            </span>
            <span className="truncate text-sm font-semibold tracking-tight text-white">
              Maia Console
            </span>
          </Link>
          <span className="grow" />
          {pendingTotal > 0 && (
            <Link
              href="/inbox"
              aria-label={`${pendingTotal} aprovações pendentes`}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/90 px-2.5 py-1 text-2xs font-semibold text-amber-950"
            >
              <IconInbox size={13} />
              {pendingTotal}
            </Link>
          )}
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
