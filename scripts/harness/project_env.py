#!/usr/bin/env python3
"""Run recipe commands with explicit card endpoints and an allowlisted test env."""
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


def test_environment():
    source = os.environ
    database = source['DATABASE_URL']
    pg = urlsplit(database)
    redis = urlsplit(source['REDIS_URL'])
    card = source['HARNESS_CARD_DATABASE']
    if not re.fullmatch(r'card_[a-z0-9_]{1,48}', card):
        raise ValueError('card database')
    if (database != source['TEST_DB_URL'] or pg.scheme not in ('postgres', 'postgresql')
            or pg.hostname not in ('127.0.0.1', '::1')
            or pg.hostname != source['HARNESS_PG_HOST']
            or pg.port != int(source['HARNESS_PG_PORT'])
            or unquote(pg.username or '') != source['HARNESS_PG_USER']
            or pg.path != '/' + card or pg.query or pg.fragment or not pg.password):
        raise ValueError('postgres endpoint')
    redis_db = int(source['HARNESS_REDIS_DB'])
    if (redis.scheme != 'redis' or redis.hostname not in ('127.0.0.1', '::1')
            or redis.port != int(source['HARNESS_REDIS_PORT'])
            or redis_db < 1 or redis.path != '/' + str(redis_db) or redis.query or redis.fragment):
        raise ValueError('redis endpoint')
    env = {key: source[key] for key in ['PATH', 'HOME', 'TMPDIR']}
    env.update({'NODE_ENV': 'test', 'DOTENV_CONFIG_PATH': '/dev/null',
                'TEST_WORKTREE_SCOPE': 'off', 'DATABASE_URL': database,
                'TEST_DB_URL': database, 'REDIS_URL': source['REDIS_URL'],
                'POSTGRES_USER': unquote(pg.username),
                'POSTGRES_PASSWORD': unquote(pg.password), 'POSTGRES_DB': card,
                'PGHOST': pg.hostname, 'PGPORT': str(pg.port),
                'PGUSER': unquote(pg.username), 'PGPASSWORD': unquote(pg.password),
                'PGDATABASE': card, 'PGCONNECT_TIMEOUT': '3'})
    return env


def main():
    command = sys.argv[1:]
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        print('FALHA receita: comando ausente', file=sys.stderr)
        return 2
    try:
        env = test_environment()
    except (KeyError, ValueError):
        print('FALHA receita: configurar endpoints exclusivos de teste e card', file=sys.stderr)
        return 2
    try:
        code = subprocess.run(command, env=env).returncode
    except OSError:
        print('FALHA receita: comando indisponivel', file=sys.stderr)
        return 127
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    raise SystemExit(main())
