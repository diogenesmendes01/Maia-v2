#!/usr/bin/env python3
"""Fast, read-only sandbox diagnostics. No project imports or dotenv loading."""
import os
from pathlib import Path
import pwd
import subprocess

TIMEOUT = 1.5


class Failure(Exception):
    pass


def required(name):
    value = os.environ.get(name)
    if not value:
        raise Failure('configuracao ausente: ' + name)
    return value


def probe(argv, env=None):
    try:
        result = subprocess.run(argv, env=env, capture_output=True, text=True,
                                timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        raise Failure('timeout') from None
    except FileNotFoundError:
        raise Failure('executavel ausente') from None
    if result.returncode:
        raise Failure('probe recusado')
    return result.stdout.strip()


def uid():
    if os.getuid() == 0 or pwd.getpwuid(os.getuid()).pw_name != 'hermes-sandbox':
        raise Failure('requer usuario hermes-sandbox nao root')


def node():
    # Reuse the repository's canonical version guard, not a second range.
    probe(['node', str(Path(__file__).resolve().parents[1] / 'check-node.mjs')])


def worktree():
    repo = Path(required('HARNESS_REPO')).resolve(strict=True)
    common = Path(probe(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])).resolve(strict=True)
    specific = Path(probe(['git', 'rev-parse', '--absolute-git-dir'])).resolve(strict=True)
    if common != (repo / '.git').resolve(strict=True) or common == specific:
        raise Failure('requer worktree ligada ao clone configurado')
    if probe(['git', 'rev-parse', '--is-inside-work-tree']) != 'true':
        raise Failure('fora de worktree')


def github():
    # Authenticated GET, not public repo access; never print token or response.
    probe(['gh', 'api', '--hostname', 'github.com', 'user', '--silent'])


def postgres():
    # Explicit test-only endpoint; no fallback to host PG/service settings.
    host = required('HARNESS_PG_HOST')
    port = required('HARNESS_PG_PORT')
    if host not in ('127.0.0.1', '::1') or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise Failure('endpoint teste localhost invalido')
    env = {'PATH': os.environ.get('PATH', ''), 'PGHOST': host, 'PGPORT': port,
           'PGUSER': required('HARNESS_PG_USER'),
           'PGDATABASE': required('HARNESS_PG_DATABASE'),
           'PGCONNECT_TIMEOUT': '1',
           'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=1000'}
    # Credential file provisioned separately. Never include secrets in argv.
    if os.environ.get('PGPASSFILE'):
        env['PGPASSFILE'] = os.environ['PGPASSFILE']
    result = probe(['psql', '-X', '-w', '-A', '-t', '-c',
                    'SELECT rolcreatedb AND NOT rolsuper AND NOT rolcreaterole '
                    'FROM pg_roles WHERE rolname = current_user'], env)
    if result != 't':
        raise Failure('papel requer CREATEDB NOSUPERUSER NOCREATEROLE')


def disk():
    # Check actual mounts of repo/dependencies/DB, not only / or cwd.
    paths = required('HARNESS_DISK_PATHS').split(os.pathsep)
    for path in paths:
        if not path or not Path(path).is_absolute():
            raise Failure('caminho de armazenamento invalido')
        stat = os.statvfs(Path(path).resolve(strict=True))
        if stat.f_blocks <= 0 or stat.f_bavail / stat.f_blocks <= 0.20:
            raise Failure('armazenamento >=80% ou indisponivel')


def main():
    failed = False
    for name, check in [('uid', uid), ('node', node), ('worktree', worktree),
                        ('github', github), ('postgres', postgres), ('disk', disk)]:
        try:
            check()
        except Exception as error:
            failed = True
            reason = str(error) if isinstance(error, Failure) else 'erro inesperado: ' + type(error).__name__
            print(f'FALHA {name}: {reason}')
        else:
            print(f'OK {name}')
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
