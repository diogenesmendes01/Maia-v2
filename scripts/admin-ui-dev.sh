#!/usr/bin/env bash
# P8.5 — start admin-ui dev environment (Fastify :3000 + Next.js :4000).
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "P8.5 — Admin UI development environment"
echo "  Fastify backend: http://localhost:3000"
echo "  Next.js admin-ui: http://localhost:4000"
echo ""

# Ensure admin-ui deps installed (idempotent)
if [ ! -d "src/admin-ui/node_modules" ]; then
  echo "Installing admin-ui dependencies..."
  (cd src/admin-ui && npm install)
fi

# Start both processes
npm run dev &
FASTIFY_PID=$!

(cd src/admin-ui && npm run dev) &
NEXTJS_PID=$!

cleanup() {
  echo ""
  echo "Stopping admin-ui dev processes..."
  kill "$FASTIFY_PID" "$NEXTJS_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait
