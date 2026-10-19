#!/usr/bin/env python3
"""Render the private multi-API profile offline. Never contact a Docker daemon."""
import argparse
import hashlib
import ipaddress
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
        raise SystemExit('Run this check through scripts/run-local.py.')
    docker = shutil.which('docker')
    if not docker:
        raise SystemExit('Install the Docker Compose CLI; no daemon or VM is needed for this check.')
    folder = ROOT / 'build' / f'{args.tag}-gateway-compose'
    folder.mkdir(exist_ok=False)
    artifacts = folder / 'empty-artifacts'
    artifacts.mkdir()
    runtime = folder / 'fixture-api.env'
    runtime.write_text('SUPABASE_URL=https://fixture.invalid\nSUPABASE_PUBLISHABLE_KEY=fixture-only\n'
                       'DATABASE_URL=postgresql://fixture:literal$dollar@fixture.invalid/db\n'
                       'PUBLIC_RELEASE=true\nGAME_WORKER_TRANSPORT=thread\nTRUST_PROXY_CIDRS=0.0.0.0/0\n')
    gateway_runtime = folder / 'fixture-gateway.env'
    gateway_runtime.write_text('SUPABASE_URL=https://fixture.invalid\nSUPABASE_PUBLISHABLE_KEY=fixture-only\n'
                               'DATABASE_URL=must-not-reach-gateway\nWORKER_NODES_JSON=forged\nPUBLIC_RELEASE=true\n')
    for path in (runtime, gateway_runtime):
        path.chmod(0o600)
    values = {'KANTO_API_IMAGE': 'kanto-api-staging:fixture', 'KANTO_RUNTIME_ENV_FILE': str(runtime),
              'KANTO_GATEWAY_RUNTIME_ENV_FILE': str(gateway_runtime), 'KANTO_ENGINE_DIRECTORY': str(artifacts),
              'KANTO_WEB_ORIGIN': 'https://client.invalid'}
    operator = folder / 'fixture-operator.env'
    operator.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    environment = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    environment['DOCKER_HOST'] = 'unix:///kanto-offline-validation-no-daemon.sock'
    source = ROOT / 'infra/compose.gateway.staging.yml'

    def render(path):
        return subprocess.run([docker, 'compose', '--env-file', str(path), '-f', str(source), 'config', '--format', 'json'],
                              cwd=ROOT, env=environment, text=True, capture_output=True, timeout=20)

    result = render(operator)
    if result.returncode:
        raise SystemExit('Offline routing profile validation failed: ' + result.stderr[:1000])
    model = json.loads(result.stdout)
    services = model['services']
    assert set(services) == {'api-alpha', 'api-bravo', 'gateway'}
    for name, service in services.items():
        assert service['user'] == '1000:1000' and service['read_only'] and service['init']
        assert service['cap_drop'] == ['ALL'] and 'no-new-privileges:true' in service['security_opt']
        assert service['cgroup'] == 'private' and service['pull_policy'] == 'never'
        assert int(service['mem_limit']) == int(service['memswap_limit'])
        assert service['stop_grace_period'] == '30s' and service['environment']['PUBLIC_RELEASE'] == 'false'
        assert service['tmpfs'] == ['/tmp:rw,noexec,nosuid,size=16777216,mode=1777']
        assert not service.get('privileged') and not service.get('build')
        assert service['logging']['driver'] == 'local'
        if name != 'gateway':
            assert service['command'] == ['node', '--experimental-strip-types', 'apps/server/src/main.ts']
            assert service['cpus'] == 2 and int(service['mem_limit']) == 4294967296 and service['pids_limit'] == 192
            assert not service.get('ports') and set(service['networks']) == {'workers'}
            assert service['environment']['GAME_WORKER_TRANSPORT'] == 'process'
            assert service['environment']['TRUST_PROXY_CIDRS'] == '172.30.44.2/32'
            assert service['environment']['DATABASE_URL'] == 'postgresql://fixture:literal$$dollar@fixture.invalid/db'
            assert len(service['volumes']) == 1 and service['volumes'][0]['read_only']
            assert service['volumes'][0]['target'] == '/opt/kanto/artifacts'
            assert not service['volumes'][0].get('bind', {}).get('create_host_path', False)
    gateway = services['gateway']
    assert gateway['command'] == ['node', '--experimental-strip-types', 'apps/server/src/gateway-main.ts']
    assert gateway['cpus'] == 1 and int(gateway['mem_limit']) == 536870912 and gateway['pids_limit'] == 64
    assert gateway['environment']['DATABASE_URL'] == '' and gateway['environment']['TRUST_PROXY_CIDRS'] == ''
    assert not gateway.get('volumes') and set(gateway['networks']) == {'workers', 'ingress'}
    assert gateway['networks']['workers']['ipv4_address'] == '172.30.44.2'
    subnet = ipaddress.ip_network(model['networks']['workers']['ipam']['config'][0]['subnet'])
    assert subnet.is_private and ipaddress.ip_address('172.30.44.2') in subnet
    assert not model['networks']['workers'].get('internal', False), 'APIs need outbound Auth/DB connectivity.'
    assert json.loads(gateway['environment']['WORKER_NODES_JSON']) == [
        {'id': 'alpha', 'origin': 'http://api-alpha:8787'}, {'id': 'bravo', 'origin': 'http://api-bravo:8787'}]
    assert len(gateway['ports']) == 1 and gateway['ports'][0]['host_ip'] == '127.0.0.1'
    assert gateway['ports'][0]['target'] == 8788 and gateway['ports'][0]['published'] == '8788'
    assert set(gateway['depends_on']) == {'api-alpha', 'api-bravo'}
    assert all(item['condition'] == 'service_healthy' for item in gateway['depends_on'].values())
    (folder / 'normalized-fixture.json').write_text(json.dumps(model, indent=2) + '\n')
    missing = []
    for key in values:
        path = folder / f'missing-{key.lower()}.env'
        path.write_text(''.join(f'{name}={value}\n' for name, value in values.items() if name != key))
        assert render(path).returncode != 0, f'Missing required input {key} was accepted.'
        missing.append(key)
    # An operator-selected unused subnet must carry the exact proxy trust with
    # it; never trust every API or every address on the bridge.
    custom = folder / 'custom-network.env'
    custom.write_text(operator.read_text() + 'KANTO_WORKER_SUBNET=172.30.45.0/28\nKANTO_GATEWAY_PRIVATE_IP=172.30.45.2\n')
    custom_result = render(custom)
    assert custom_result.returncode == 0, custom_result.stderr[:1000]
    custom_model = json.loads(custom_result.stdout)
    assert custom_model['services']['gateway']['networks']['workers']['ipv4_address'] == '172.30.45.2'
    for name in ('api-alpha', 'api-bravo'):
        assert custom_model['services'][name]['environment']['TRUST_PROXY_CIDRS'] == '172.30.45.2/32'
    report = {'composeSourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'composeVersion': subprocess.check_output([docker, 'compose', 'version', '--short'], text=True, env=environment).strip(),
              'offlineConfigValidated': True, 'invalidDaemonEndpointUsed': True, 'missingInputsRejected': missing,
              'customSubnetAndExactProxyTrustChecked': True, 'gatewayOnlyLoopbackPublished': True,
              'gatewayDatabaseCredentialOverrideEmpty': True, 'fixedTopologyAndReleaseGateChecked': True,
              'combinedConfiguredMemoryBytes': sum(int(service['mem_limit']) for service in services.values()),
              'combinedConfiguredCpuUnits': sum(service['cpus'] for service in services.values()),
              'runtimeEnvDollarValueQualified': False, 'realCredentialsRead': False, 'imageBuilt': False,
              'containersStarted': False, 'kernelEnforcementQualified': False, 'capacity1000Qualified': False}
    (folder / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'evidence': str(folder / 'report.json'), **report}))


if __name__ == '__main__':
    main()
