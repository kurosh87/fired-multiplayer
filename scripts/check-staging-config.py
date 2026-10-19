#!/usr/bin/env python3
"""Validate Compose offline with owned fixture values; never contact a daemon."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9-]{1,40}', args.tag):
        raise SystemExit('Use a fresh bounded evidence tag.')
    guard = Path.home() / '.local/bin/mini-build-guard'
    if guard.exists() and subprocess.run([str(guard), '--is-owned'], capture_output=True).returncode:
        raise SystemExit('Run this finite check through scripts/run-local.py.')
    docker = shutil.which('docker')
    if not docker:
        raise SystemExit('Docker Compose CLI is required for offline config validation; no daemon is used.')
    folder = ROOT / 'build' / f'{args.tag}-compose'
    folder.mkdir(exist_ok=False)
    artifacts = folder / 'empty-artifacts'
    artifacts.mkdir()
    runtime = folder / 'fixture-runtime.env'
    runtime.write_text('SUPABASE_URL=https://fixture.invalid\nSUPABASE_PUBLISHABLE_KEY=fixture-only\n'
                       'DATABASE_URL=postgresql://fixture:literal$dollar@fixture.invalid/db\n'
                       'PUBLIC_RELEASE=true\nGAME_WORKER_TRANSPORT=thread\n')
    runtime.chmod(0o600)
    operator = folder / 'fixture-operator.env'
    operator.write_text(f'KANTO_API_IMAGE=kanto-api-staging:fixture\nKANTO_RUNTIME_ENV_FILE={runtime}\n'
                        f'KANTO_ENGINE_DIRECTORY={artifacts}\nKANTO_WEB_ORIGIN=https://client.invalid\n')
    empty = folder / 'empty.env'
    empty.write_text('')
    # Deliberately unusable Docker endpoint. Config rendering must work without
    # starting Colima, connecting to a remote Docker host or loading a real .env.
    environment = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    environment['DOCKER_HOST'] = 'unix:///kanto-offline-validation-no-daemon.sock'
    command = [docker, 'compose', '--env-file', str(operator), '-f', str(ROOT / 'infra/compose.staging.yml'), 'config']
    result = subprocess.run([*command, '--format', 'json'], capture_output=True, text=True, env=environment, cwd=ROOT, timeout=20)
    if result.returncode:
        raise SystemExit('Offline Compose fixture validation failed: ' + result.stderr[:1000])
    model = json.loads(result.stdout)
    assert set(model['services']) == {'api'}
    (folder / 'normalized-fixture.json').write_text(json.dumps(model, indent=2) + '\n')
    api = model['services']['api']
    assert api['user'] == '1000:1000' and api['read_only'] and api['init']
    assert api['cap_drop'] == ['ALL'] and 'no-new-privileges:true' in api['security_opt']
    assert api['cpus'] == 2 and int(api['mem_limit']) == int(api['memswap_limit']) == 4294967296
    assert api['pids_limit'] == 192 and api['cgroup'] == 'private'
    assert api['pull_policy'] == 'never' and api['stop_grace_period'] == '30s'
    assert len(api['ports']) == 1 and api['ports'][0]['host_ip'] == '127.0.0.1'
    assert api['ports'][0]['target'] == 8787
    assert len(api['volumes']) == 1 and api['volumes'][0]['read_only']
    assert api['volumes'][0]['target'] == '/opt/kanto/artifacts'
    assert not api['volumes'][0].get('bind', {}).get('create_host_path', False)
    env = api['environment']
    assert env['PUBLIC_RELEASE'] == 'false' and env['GAME_WORKER_TRANSPORT'] == 'process'
    assert env['WEB_ORIGIN'] == 'https://client.invalid' and env['TRUST_PROXY_CIDRS'] == ''
    # Compose v2.35 config escapes dollar signs in its serialized output.
    # The raw loader value itself is verified later inside the Linux CI container.
    assert env['DATABASE_URL'] == 'postgresql://fixture:literal$$dollar@fixture.invalid/db'
    assert sum(int(env[name]) for name in ('ADVENTURE_WORKERS', 'BATTLE_WORKERS', 'TRADE_WORKERS', 'INSPECTION_WORKERS')) == 7
    missing = subprocess.run([docker, 'compose', '--env-file', str(empty), '-f', str(ROOT / 'infra/compose.staging.yml'),
                              'config', '--quiet'], capture_output=True, text=True, env=environment, cwd=ROOT, timeout=20)
    assert missing.returncode != 0, 'Required staging operator inputs were not enforced.'
    ci = subprocess.run([docker, 'compose', '--env-file', str(operator), '-f', str(ROOT / 'infra/compose.staging.yml'),
                         '-f', str(ROOT / 'infra/compose.ci.yml'), 'config', '--format', 'json'], capture_output=True,
                        text=True, env={**environment, 'KANTO_TEST_DIRECTORY': str(ROOT / 'tests')}, cwd=ROOT, timeout=20)
    assert ci.returncode == 0, ci.stderr[:1000]
    ci_model = json.loads(ci.stdout)
    ci_api = ci_model['services']['api']
    assert len(ci_api['volumes']) == 2 and all(volume['read_only'] for volume in ci_api['volumes'])
    assert {volume['target'] for volume in ci_api['volumes']} == {'/opt/kanto/artifacts', '/opt/kanto/tests'}
    assert ci_api['read_only'] and ci_api['user'] == api['user'] and ci_api['cap_drop'] == api['cap_drop']
    assert ci_api['mem_limit'] == api['mem_limit'] and ci_api['cpus'] == api['cpus']
    (folder / 'normalized-ci-fixture.json').write_text(json.dumps(ci_model, indent=2) + '\n')
    source = ROOT / 'infra/compose.staging.yml'
    report = {'composeSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'composeVersion': subprocess.check_output([docker, 'compose', 'version', '--short'], text=True, env=environment).strip(),
              'offlineConfigValidated': True, 'invalidDaemonEndpointUsed': True,
              'requiredOperatorInputsChecked': True, 'rawDollarConfigEscapingChecked': True,
              'ciOverlayValidated': True,
              'runtimeEnvValueQualified': False,
              'publicReleaseOverrideRefused': True, 'containerResourcesConfigured': True,
              'artifactsReadOnlyConfigured': True, 'loopbackOnlyPortConfigured': True,
              'realCredentialsRead': False, 'imageBuilt': False, 'containerStarted': False,
              'kernelEnforcementQualified': False, 'capacity1000Qualified': False}
    (folder / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'evidence': str(folder / 'report.json'), **report}))


if __name__ == '__main__':
    main()
