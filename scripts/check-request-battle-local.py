#!/usr/bin/env python3
"""Qualify the HTTP viewer and legacy battle path in one guarded finite job."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'
if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
    raise SystemExit('Run this finite job through scripts/run-local.py.')
tag = os.environ.get('KANTO_REQUEST_CHECK_TAG', 'http-viewer-v1')
if not tag or len(tag) > 32 or any(char not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for char in tag):
    raise SystemExit('Choose a short, fresh evidence tag.')
output = ROOT / 'build' / tag
output.mkdir(mode=0o700, exist_ok=False)
sources = set(json.loads((ROOT / 'build/request-battle-viewer-v1/report.json').read_text())['sourceSha256'])
sources.update({'AGENTS.md', 'scripts/check-request-battle-local.py', 'scripts/deploy-netlify-accounts.py'})
sources.update({'scripts/check-netlify-game-role.ts', 'infra/netlify-game-runtime-role.sql',
                'netlify/database/migrations/20261017160200_game-runtime-role-switch/migration.sql'})
sources.update({'apps/server/src/netlify-battles.ts', 'netlify/functions/battles.mts', 'packages/engine/registry.ts',
                'packages/battles/private-artifacts.ts', 'packages/battles/console-pool.ts', 'packages/battles/console-worker.ts',
                'packages/engine/private-worker-transport.ts', 'scripts/build-netlify-battle-runtime.ts',
                'scripts/check-netlify-battles-local.ts', 'scripts/stage-netlify-preview.ts', 'tests/netlify-battle-boundary.test.ts'})
sources.update(str(path.relative_to(ROOT)) for path in (ROOT / 'netlify/database/migrations').glob('*/migration.sql'))
identities = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sorted(sources)}
report = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'phases': [],
          'sourceSha256': identities, 'scope': 'Native local qualification; no hosted multiplayer admission or deploy.'}
environment = dict(os.environ, KANTO_PREVIEW_OUTPUT='build/netlify-request-battles-v1', KANTO_CHECK_REQUEST_BATTLES='1',
                   KANTO_REQUEST_BATTLE_FULL=os.environ.get('KANTO_REQUEST_BATTLE_FULL', '1'), KANTO_CHECK_REQUEST_BATTLE_BROWSER='1',
                   KANTO_CHECK_BETTER_AUTH_BATTLE=os.environ.get('KANTO_CHECK_BETTER_AUTH_BATTLE', '1'),
                   KANTO_CHECK_MAIN_ACCOUNTS=os.environ.get('KANTO_CHECK_MAIN_ACCOUNTS', '1'), KANTO_CHECK_NETLIFY_BATTLES='1', KANTO_BATTLE_UI_EVIDENCE_TAG=tag)
report['qualificationScope'] = {name: environment[name] == '1' for name in [
    'KANTO_REQUEST_BATTLE_FULL', 'KANTO_CHECK_REQUEST_BATTLE_BROWSER', 'KANTO_CHECK_BETTER_AUTH_BATTLE', 'KANTO_CHECK_MAIN_ACCOUNTS', 'KANTO_CHECK_NETLIFY_BATTLES']}
phases = [('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], 180),
          ('clock-protocol-playback', ['node', '--experimental-strip-types', '--test',
                                      'tests/request-battle-clock.test.ts', 'tests/request-battle-playback.test.ts', 'tests/netlify-battle-boundary.test.ts'], 180),
          ('native-http-browser-battle', ['python3', '-B', 'scripts/check-database.py', '--netlify-preview'], 1200)]
for name, command, timeout in phases:
    print('Starting ' + name, flush=True)
    started = time.monotonic()
    with (output / (name + '.log')).open('w') as log:
        try:
            with subprocess.Popen(command, cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT) as process:
                try:
                    status = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    # Let the native launcher's finally stop its owned PG
                    # cluster; subprocess.run(timeout=...) would kill it first.
                    process.send_signal(signal.SIGINT)
                    try:
                        process.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    status = 124
        except subprocess.TimeoutExpired:
            status = 124
    report['phases'].append({'name': name, 'exitCode': status, 'elapsedSeconds': round(time.monotonic() - started, 3)})
    (output / 'progress.json').write_text(json.dumps(report, indent=2) + '\n')
    if status:
        report['passed'] = False
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print((output / (name + '.log')).read_text()[-7000:], flush=True)
        raise SystemExit(status)
    print('Passed ' + name, flush=True)
assert all(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected for path, expected in identities.items()), 'Source changed during qualification.'
report.update({'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'passed': True})
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'output': str(output), 'passed': True}), flush=True)
