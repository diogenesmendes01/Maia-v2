#!/bin/sh
#
# docker-entrypoint.sh — self-migrate gate para single-container deploys (issue #565).
#
# Coolify e orquestradores similares rodam UMA imagem com UM conjunto de env vars.
# Não há como separar o migration job do runtime: ambos nascem no mesmo container.
# Esta solução ENCADEIA o migration gate antes do app: se a migration falha, o
# app NÃO inicia.
#
# **Fail-closed por default**: AUTO_MIGRATE_ON_BOOT default=true (gateFlag).
# SÓ 'false' ou '0' (case-insensitive, trimmed) desligam.
#
# Compose multi-serviço (compose.prod.yml) seta AUTO_MIGRATE_ON_BOOT=false no
# serviço app porque o job `migrate` separado já aplica. Deploy single-container
# (Coolify, Dockerfile direto) deixa o default true, e a imagem self-migrates.
#
# Signal handling: o `exec` no final faz o node process substituir este shell e
# virar PID 1 real (via tini ENTRYPOINT). SIGTERM/SIGINT propagam corretamente
# para graceful shutdown (SHUTDOWN_GRACE_MS).
#
# Ver docs/runbooks/deploy-prod.md §7 e src/migrations/release-gate.ts.
set -e

AUTO_MIGRATE="${AUTO_MIGRATE_ON_BOOT:-true}"

# Normaliza para lowercase e trim (mesmo padrão do gateFlag TypeScript)
AUTO_MIGRATE_NORM=$(echo "$AUTO_MIGRATE" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ "$AUTO_MIGRATE_NORM" = "false" ] || [ "$AUTO_MIGRATE_NORM" = "0" ]; then
  echo "docker-entrypoint: AUTO_MIGRATE_ON_BOOT desligado — pulando migration gate"
else
  echo "docker-entrypoint: AUTO_MIGRATE_ON_BOOT ligado — rodando migration gate"
  npm run release:migrate || {
    EXIT_CODE=$?
    echo "docker-entrypoint: migration gate falhou com código $EXIT_CODE — app NÃO iniciará"
    exit $EXIT_CODE
  }
  echo "docker-entrypoint: migration gate passou — iniciando app"
fi

# exec: substitui o shell pelo node process. O tini (ENTRYPOINT) vira pai direto
# do node, e SIGTERM/SIGINT propagam corretamente.
exec node dist/index.js
