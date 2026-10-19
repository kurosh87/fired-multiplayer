#!/usr/bin/env python3
"""Run database contracts against an isolated, project-owned Postgres cluster."""
import json
import fcntl
import os
import re
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    if sys.argv[1:] not in ([], ['--mixed'], ['--restart'], ['--gateway'], ['--migrations'], ['--netlify-preview']):
        raise SystemExit('Usage: check-database.py [--mixed|--restart|--gateway|--migrations|--netlify-preview]')
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    prefix = Path(os.environ.get('KANTO_POSTGRES_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
    initdb = str(prefix / 'initdb') if (prefix / 'initdb').exists() else shutil.which('initdb')
    pg_ctl = str(prefix / 'pg_ctl') if (prefix / 'pg_ctl').exists() else shutil.which('pg_ctl')
    if not initdb or not pg_ctl:
        raise SystemExit('Postgres 17 tools are required; set KANTO_POSTGRES_BIN to their directory.')
    version = subprocess.check_output([pg_ctl, '--version'], text=True)
    match = re.search(r'\b(17|18)\.\d+', version)
    if not match or match[1] != '17' and sys.argv[1:] != ['--netlify-preview']:
        raise SystemExit('Legacy checks require Postgres 17; the Netlify lane also supports the hosted Postgres 18 major.')
    major = int(match[1])
    # Netlify's initial provisioning migration owns a cluster-wide runtime role.
    # Rehearse each fresh Netlify database on its own cluster, preserving prior
    # applied migrations and retained test databases without modifying them.
    # Legacy postgres-netlify-* directories were retired by an external
    # cleanup during an active run. Give retained qualification databases an
    # explicit namespace and ownership marker, under the same resource guard.
    project_lock = (ROOT / 'build/.native-qualification.lock').open('a+')
    fcntl.flock(project_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    target = ROOT / ('build/qualification-postgres/' + str(time.time_ns()) if sys.argv[1:] == ['--netlify-preview'] else 'build/postgres-test')
    data = target / 'data'
    sockets = target / ('s' if sys.argv[1:] == ['--netlify-preview'] else 'socket')
    if len(os.fsencode(str(sockets / '.s.PGSQL.5432'))) > 103:
        raise SystemExit('The native socket path exceeds the macOS limit; use a shorter checkout path.')
    marker = target / '.kanto-test-cluster.json'
    if target.is_symlink() or data.is_symlink() or sockets.is_symlink():
        raise SystemExit('Refusing a symlinked test cluster directory.')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    lease = Path.home() / '.local/share/mini-storage/active-build.json'
    guard_owner = json.loads(lease.read_text()).get('owner_pid') if lease.exists() else None
    owner_receipt = {'active': True, 'nativePid': os.getpid(), 'nativeBirth': subprocess.check_output(
        ['/bin/ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True).strip(), 'guardOwnerPid': guard_owner,
        'startedAt': time.time(), 'major': major, 'retainedEvidence': True}
    owner_path = target / '.kanto-native-owner.json'
    owner_path.write_text(json.dumps(owner_receipt, indent=2) + '\n')
    sockets.mkdir(exist_ok=True, mode=0o700)
    if data.exists() and not marker.exists():
        raise SystemExit('Existing cluster has no Kanto test marker; it has been preserved.')
    if marker.exists():
        if json.loads(marker.read_text()) != {'purpose': 'kanto-disposable-contract-tests', 'major': major}:
            raise SystemExit('Existing cluster marker is incompatible; it has been preserved.')
    else:
        subprocess.run([initdb, '-D', str(data), '-U', 'kanto_test', '--auth-local=trust',
                        '--auth-host=reject', '--encoding=UTF8', '--no-locale'], check=True,
                       stdout=subprocess.DEVNULL)
        marker.write_text(json.dumps({'purpose': 'kanto-disposable-contract-tests', 'major': major}) + '\n')
    if subprocess.run([pg_ctl, '-D', str(data), 'status'], capture_output=True).returncode == 0:
        raise SystemExit('The project test cluster is already running; no existing server was changed.')
    options = shlex.join(['-k', str(sockets), '-c', 'listen_addresses=', '-c', 'max_connections=16',
                          '-c', 'shared_buffers=16MB', '-c', 'unix_socket_permissions=0700'])
    if sys.argv[1:] == ['--netlify-preview']:
        # These are small finite fixtures. Recycle WAL more frequently while
        # retaining normal durable commits. max_wal_size is a soft target;
        # the shared guard still enforces the actual free-space floor.
        options += ' ' + shlex.join(['-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB',
                                      '-c', 'checkpoint_timeout=1min'])
    started = False
    try:
        subprocess.run([pg_ctl, '-D', str(data), '-l', str(target / 'server.log'),
                        '-o', options, '-w', '-t', '20', 'start'], check=True)
        started = True
        if sys.argv[1:] == ['--netlify-preview']:
            psql = str(prefix / 'psql') if (prefix / 'psql').exists() else shutil.which('psql')
            if not psql:
                raise SystemExit('psql is required to verify fixture durability settings.')
            settings = json.loads(subprocess.check_output([psql, '-XAt', '-h', str(sockets), '-U', 'kanto_test', '-d', 'postgres', '-c',
                "select json_build_object('fsync',current_setting('fsync'),'synchronous_commit',current_setting('synchronous_commit'),"
                "'full_page_writes',current_setting('full_page_writes'),'max_wal_size',current_setting('max_wal_size'),"
                "'min_wal_size',current_setting('min_wal_size'),'checkpoint_timeout',current_setting('checkpoint_timeout'))"], text=True))
            assert all(settings[key] == 'on' for key in ['fsync', 'synchronous_commit', 'full_page_writes']), 'Native fixture must preserve durable commit behavior.'
            (target / 'runtime-settings.json').write_text(json.dumps(settings, indent=2) + '\n')
        environment = dict(os.environ, DATABASE_TEST_URL='postgresql://kanto_test@localhost/postgres?'
                           + urlencode({'host': str(sockets)}))
        command = (['node', '--experimental-strip-types', 'scripts/benchmark-mixed.ts'] if sys.argv[1:] == ['--mixed']
                   else ['node', '--experimental-strip-types', 'scripts/check-api-restart.ts'] if sys.argv[1:] == ['--restart']
                   else ['node', '--experimental-strip-types', 'scripts/check-gateway-game.ts'] if sys.argv[1:] == ['--gateway']
                   else ['node', '--experimental-strip-types', 'scripts/check-database-migrations.ts'] if sys.argv[1:] == ['--migrations']
                   else ['node', '--experimental-strip-types', 'scripts/check-netlify-preview.ts'] if sys.argv[1:] == ['--netlify-preview']
                   else ['node', '--experimental-strip-types', '--test', 'tests/postgres.integration.test.ts'])
        result = subprocess.run(command, cwd=ROOT, env=environment)
        return result.returncode
    finally:
        try:
            if started:
                subprocess.run([pg_ctl, '-D', str(data), '-m', 'fast', '-w', '-t', '20', 'stop'], check=True)
        finally:
            if target.exists():
                owner_receipt.update({'active': False, 'endedAt': time.time(), 'postmasterFileAbsent': not (data / 'postmaster.pid').exists()})
                owner_path.write_text(json.dumps(owner_receipt, indent=2) + '\n')
            fcntl.flock(project_lock, fcntl.LOCK_UN)
            project_lock.close()


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
