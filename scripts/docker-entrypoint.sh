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
# Signal handling: trap captura SIGTERM/SIGINT durante a migration e os repassa
# ao processo do migrator. O migrator NÃO tem handler próprio de SIGTERM — ele
# morre imediatamente, podendo deixar o ledger dirty em migrations no-transaction.
# Após a migration, o exec substitui o shell pelo node, e o tini (ENTRYPOINT)
# propaga sinais diretamente ao node para graceful shutdown (SHUTDOWN_GRACE_MS).
# Ver runbook §7 sobre SIGTERM no meio da migration (advisory lock, dirty, rerun).
#
# Ver docs/runbooks/deploy-prod.md §7 e src/migrations/release-gate.ts.
set -e

MIGRATOR_PID=""

# Trap para repassar SIGTERM/SIGINT ao migrator durante a migration.
# Após o exec, o trap deixa de existir e o tini manda sinais direto ao node.
cleanup() {
  local sig=$1
  if [ -n "$MIGRATOR_PID" ]; then
    echo "docker-entrypoint: sinal $sig recebido, repassando ao migrator PID $MIGRATOR_PID"
    kill -TERM "$MIGRATOR_PID" 2>/dev/null || true
    wait "$MIGRATOR_PID" 2>/dev/null || true
  fi
  # Exit codes: SIGINT=130 (128+2), SIGTERM=143 (128+15)
  if [ "$sig" = "INT" ]; then
    exit 130
  else
    exit 143
  fi
}

trap 'cleanup INT' INT
trap 'cleanup TERM' TERM

AUTO_MIGRATE="${AUTO_MIGRATE_ON_BOOT:-true}"

# Normaliza para lowercase e trim (mesmo padrão do gateFlag TypeScript)
AUTO_MIGRATE_NORM=$(echo "$AUTO_MIGRATE" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ "$AUTO_MIGRATE_NORM" = "false" ] || [ "$AUTO_MIGRATE_NORM" = "0" ]; then
  echo "docker-entrypoint: AUTO_MIGRATE_ON_BOOT desligado — pulando migration gate"
else
  echo "docker-entrypoint: AUTO_MIGRATE_ON_BOOT ligado — rodando migration gate"
  
  # Roda o migrator em background para capturar o PID e permitir trap
  npm run release:migrate &
  MIGRATOR_PID=$!
  
  # Aguarda o migrator. Se receber sinal, o trap acima dispara.
  wait "$MIGRATOR_PID" || {
    EXIT_CODE=$?
    MIGRATOR_PID=""  # já terminou, trap não deve matá-lo
    echo "docker-entrypoint: migration gate falhou com código $EXIT_CODE — app NÃO iniciará"
    exit $EXIT_CODE
  }
  
  MIGRATOR_PID=""  # migrator terminou com sucesso
  echo "docker-entrypoint: migration gate passou — iniciando app"
fi

# exec: substitui o shell pelo node process. O trap deixa de existir aqui.
# O tini (ENTRYPOINT) vira pai direto do node e propaga SIGTERM/SIGINT para
# graceful shutdown.
exec node dist/index.js
