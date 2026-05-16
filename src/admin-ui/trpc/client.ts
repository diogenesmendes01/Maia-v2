/**
 * P8.5 — tRPC React-Query client. Imported by all 'use client' pages.
 */
import { createTRPCReact } from '@trpc/react-query';
import { QueryClient } from '@tanstack/react-query';
import type { AppRouter } from './routers/_app.js';

export const trpc = createTRPCReact<AppRouter>();

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function getBaseUrl(): string {
  if (typeof window !== 'undefined') return ''; // same-origin
  return process.env.NEXTAUTH_URL ?? 'http://localhost:4000';
}
