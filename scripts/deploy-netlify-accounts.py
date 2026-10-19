#!/usr/bin/env python3
"""Deploy a tested Kanto bundle through the documented Netlify CLI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import shutil

ROOT = Path(__file__).resolve().parent.parent
STAGE = Path.home() / '.local/share/kanto-netlify-accounts-v1'
SITE = '4fcf6389-9abb-4239-8134-d99fa08b85d8'
GUARD = Path.home() / '.local/bin/mini-build-guard'
if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
    raise SystemExit('Run this finite release job through scripts/run-local.py.')
assert json.loads((STAGE / '.netlify/state.json').read_text())['siteId'] == SITE
assert not json.loads((STAGE / 'bundle-manifest.json').read_text()).get('battlePreview'), 'A private battle bundle must use the preview-only qualification workflow; do not publish it through the account release pipeline.'
reports = sorted((ROOT / 'build').glob('netlify-accounts-check-*/report.json'), reverse=True)
report_path = reports[0]
report = json.loads(report_path.read_text())
assert report.get('databaseMajor') == 18, 'Native release qualification must cover the observed hosted PostgreSQL 18 major.'
assert not report.get('draftGameSchema'), 'A draft SQL rehearsal is not a deployable migration.'
assert any('concurrent save conflict' in item for item in report['checks'])
assert len(report['browser']) == 2 and all(item['passwordRecoveryWhileSignedIn'] for item in report['browser'])
for path, expected in report['sourceSha256'].items():
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, f'Source changed since native checks: {path}'
stamp = str(int(time.time()))
output = ROOT / 'build' / ('netlify-accounts-release-' + stamp)
output.mkdir(mode=0o700)
evidence = {'siteId': SITE, 'localValidation': str(report_path.relative_to(ROOT)), 'phases': [], 'externalEmailsSent': 0}
performance_path = report_path.parent / 'performance-report.json'
assert performance_path.exists(), 'Missing real-worker performance comparison.'
assert report.get('battleUiValidation'), 'Run the full original-C battle regression in this native qualification.'
battle_path = ROOT / report['battleUiValidation']
assert battle_path.resolve().is_relative_to(ROOT / 'build')
battle = json.loads(battle_path.read_text())
assert battle['forfeitConfirmationBlocksBattleInputs'] and battle['canonicalAdventuresUnchanged']
assert battle['realBetterAuthAccounts'] and battle['independentDatabaseTransactions']
main_report_path = report_path.parent / 'main-browser-report.json'
main_report = json.loads(main_report_path.read_text())
assert main_report['actualMainAccountsAndBattle'] and main_report['exactAdventureReturnAndCartridgePreserved']
request_http_path = Path(os.environ.get('KANTO_REQUEST_HTTP_PROOF', report.get('requestHttpValidation') or ''))
if not request_http_path.is_absolute():
    request_http_path = ROOT / request_http_path
assert request_http_path.is_file() and request_http_path.resolve().is_relative_to(ROOT / 'build'), 'Provide the matching full HTTP battle proof.'
request_http = json.loads(request_http_path.read_text())
assert (ROOT / 'infra/netlify-request-battles.sql').read_bytes() == (ROOT / 'netlify/database/migrations/20261017140706_request-driven-battles/migration.sql').read_bytes()
assert (ROOT / 'infra/netlify-battle-controls.sql').read_bytes() == (ROOT / 'netlify/database/migrations/20261017152100_battle-control-connections/migration.sql').read_bytes()
assert (ROOT / 'infra/netlify-game-runtime-role.sql').read_bytes() == (ROOT / 'netlify/database/migrations/20261017160200_game-runtime-role-switch/migration.sql').read_bytes()
game_role_path = report_path.parent / 'game-role-switch-report.json'
game_role = json.loads(game_role_path.read_text())
assert all(game_role[key] for key in ['actualNonSuperuserLogin', 'reproducedAdminWithoutSet', 'versionedMigrationApplied',
    'explicitGameRoleSwitch', 'gamePrivilegesNotInherited', 'authAndSoloFlashDenied', 'transactionLocalRoleRestored', 'accountRoleStillIsolated'])
assert all(request_http[key] for key in ['actualHttp', 'actualBetterAuth', 'realOriginalC', 'fullRecordedMatch',
    'peerCannotStallWithMissingInputs', 'oneFrameTapReferenceParity', 'databaseStatementTimeoutRollback', 'canonicalCartridgesUnchanged',
    'explicitTabOwnership', 'oldTabCannotReclaimOnRetry', 'tabReplacementFencesSpeculativeWork', 'fairWriterHandoff',
    'busyRetryPresenceWithoutClockCredit', 'abandonedPriorityExpires', 'expiredPresenceCannotBeRevived'])
request_browser = request_http.get('browserValidation')
assert request_browser and all(request_browser[key] for key in ['actualSameOriginHttp', 'actualSdkCreatedAccounts', 'actualOriginalC',
    'restrictedPostgres', 'desktopAndMobile', 'shortKeyboardAndTouchTaps', 'forfeitConfirmationBlocksControls', 'exactLostReplyRetry',
    'busyRetryRetainsBufferedTap', 'reloadPreservesSequence', 'replacedTabStopsWithoutReclaiming', 'atomicForfeitAndLobbyReturn', 'noBrowserErrors', 'noUnexpectedServerFailures', 'noViewportOverflow']), 'Qualify the actual HTTP browser viewer and contention/recovery behavior before release.'
for path, expected in request_http['sourceSha256'].items():
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, f'HTTP battle source changed: {path}'
evidence.update({'performanceValidation': str(performance_path.relative_to(ROOT)),
                 'localBattleValidation': str(battle_path.relative_to(ROOT)), 'localMainBrowserValidation': str(main_report_path.relative_to(ROOT)),
                 'localRequestBattleValidation': str(request_http_path.relative_to(ROOT))})

def run(label, command, cwd=ROOT, env=None):
    print(label, flush=True)
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=360)
    for suffix, value in [('stdout', result.stdout), ('stderr', result.stderr)]:
        path = output / (label + '.' + suffix + '.log')
        path.write_text(value)
        path.chmod(0o600)
    evidence['phases'].append({'name': label, 'exitCode': result.returncode})
    (output / 'progress.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if result.returncode:
        print(result.stdout[-6000:], flush=True)
        print(result.stderr[-6000:], flush=True)
        raise SystemExit(f'{label} failed; logs retained in {output}. Stop before the next deployment.')
    return result.stdout

def deploy(label, production=False):
    command = ['netlify', 'deploy', '--site', SITE, '--context', 'production' if production else 'deploy-preview',
               '--message', 'Kanto private HTTP battle control and restricted runtime foundations', '--json']
    command += ['--prod'] if production else ['--alias', 'kanto-account-check']
    data = json.loads(run(label, command, STAGE))
    assert data['site_id'] == SITE
    evidence[label] = data
    return 'https://' + data['deploy_id'] + '--kanto-online-preview.netlify.app'

draft = deploy('preview-deploy')
run('preview-http', ['node', '--experimental-strip-types', 'scripts/check-netlify-cloud-http.ts', draft, 'accounts-preview-' + stamp])
status = json.loads(run('preview-migrations', ['netlify', 'database', 'status', '--branch', 'kanto-account-check', '--json'], STAGE))
assert status['enabled'] and status['applied'] and not status['pending'] and not status['outOfOrder']
evidence['previewMigrations'] = {key: status[key] for key in ['target', 'applied', 'pending', 'outOfOrder']}
preview_runtime = json.loads(run('preview-game-runtime', ['node', '--experimental-strip-types', 'scripts/check-netlify-game-runtime.ts',
    'kanto-account-check', str(output / 'preview-game-runtime.json')]))
assert preview_runtime['passed'] and preview_runtime['restrictedRoleChecksPassed']
evidence['previewGameRuntime'] = preview_runtime
environment = dict(os.environ, KANTO_NETLIFY_ACCOUNTS='1', KANTO_PREVIEW_CANDIDATE='battle-text-audio-16',
                   KANTO_PREVIEW_URL=draft, KANTO_UI_EVIDENCE_TAG='accounts-release-' + stamp)
run('preview-browser', ['node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.hosted-preview.config.ts'], env=environment)
production = deploy('production-deploy', True)
production_status = json.loads(run('production-migrations', ['netlify', 'database', 'status', '--branch', 'production', '--json'], STAGE))
assert production_status['target'] == 'production' and production_status['enabled']
assert not production_status['pending'] and not production_status['outOfOrder']
assert {item['name'] for item in production_status['applied']} == {item['name'] for item in status['applied']}
evidence['productionMigrations'] = {key: production_status[key] for key in ['target', 'applied', 'pending', 'outOfOrder']}
production_runtime = json.loads(run('production-game-runtime', ['node', '--experimental-strip-types', 'scripts/check-netlify-game-runtime.ts',
    'production', str(output / 'production-game-runtime.json')], env=dict(os.environ, KANTO_MANAGED_GAME_ROLE=preview_runtime['managedRuntimeRole'])))
assert production_runtime['passed'] and production_runtime['productionReadonlyCatalogCheck']
evidence['productionGameRuntime'] = production_runtime
public = 'https://kanto-online-preview.netlify.app'
run('production-http', ['node', '--experimental-strip-types', 'scripts/check-netlify-cloud-http.ts', public, 'accounts-production-' + stamp])
evidence.update({'finishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'publicURL': public,
                 'productionImmutableURL': production, 'previewBrowserPassed': True,
                 'scope': 'Temporary accounts and solo flash saves; global multiplayer and 1000-player capacity remain unfinished.'})
sources = set(report['sourceSha256']) | {
    'AGENTS.md', 'scripts/check-netlify-game-runtime.ts', 'scripts/check-request-battle-local.py',
    'scripts/deploy-netlify-accounts.py', 'scripts/stage-netlify-preview.ts', 'scripts/build-preview.ts',
    'scripts/check-netlify-cloud-http.ts', 'scripts/check-database.py', 'tests/hosted-preview.spec.ts',
    'infra/NETLIFY-ACCOUNTS.md', 'infra/netlify-preview-permissions.sql', 'tsconfig.json', 'packages/protocol/index.ts',
    'PLATFORM-DIRECTION.md', 'tests/platform-direction.test.ts', 'tests/battle-ui-qualification.ts',
    'infra/BETTER-AUTH-MULTIPLAYER.md', 'scripts/check-web-local.ts', 'tests/adventure-cards.spec.ts', 'tests/account-session-cache.test.ts'}
sources.update({'infra/REQUEST-BATTLE-API.md','infra/NETLIFY-GAME-EXECUTION.md','tests/request-battle-clock.test.ts'})
for directory in ['apps/web/src', 'packages/games', 'packages/community']:
    for path in (ROOT / directory).rglob('*'):
        if path.is_file() and path.suffix in ['.ts', '.tsx', '.css']:
            sources.add(str(path.relative_to(ROOT)))
identities = {}
for relative in sorted(sources):
    target = output / 'source' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / relative, target)
    identities[relative] = hashlib.sha256(target.read_bytes()).hexdigest()
evidence['sourceSha256'] = identities
(output / 'bundle-manifest.json').write_bytes((STAGE / 'bundle-manifest.json').read_bytes())
for path in [performance_path, battle_path, main_report_path, request_http_path, game_role_path]:
    shutil.copy2(path, output / path.name)
(output / 'report.json').write_text(json.dumps(evidence, indent=2) + '\n')
paths = [STAGE, output, ROOT / 'build/hgss-research-20261017', battle_path, request_http_path, ROOT / 'build/qualification-postgres'] + list((ROOT / 'build').glob('netlify-request-battles-v*')) + list((ROOT / 'build').glob('netlify-multiplayer-accounts-v*')) + list((ROOT / 'build').glob('web-better-auth-v*')) + list((ROOT / 'build').glob('netlify-adventures-v*')) + list((ROOT / 'build').glob('netlify-accounts-v*')) + list((ROOT / 'build').glob('netlify-accounts-check-*')) + list((ROOT / 'build').glob('postgres-netlify-*'))
retained = []
for path in paths:
    files = list(path.rglob('*')) if path.is_dir() else [path]
    retained.append({'path': str(path), 'logicalBytes': sum(item.stat().st_size for item in files if item.is_file()),
                     'fileCount': sum(item.is_file() for item in files)})
inventory_path = ROOT / 'build/retention-inventory.json'
inventory = json.loads(inventory_path.read_text())
inventory['netlifyAccounts'] = {'report': str((output / 'report.json').relative_to(ROOT)), 'retained': retained,
    'indispensable': ['release and failed-check evidence', 'source hashes and archive', 'versioned migrations'],
    'regenerableRetained': ['static build bundles', 'Netlify CLI build dependencies', 'native fixture clusters'],
    'ownedTestPostmasterFilesAbsent': all(not (path / 'data/postmaster.pid').exists() for path in list((ROOT / 'build').glob('postgres-netlify-*'))+list((ROOT / 'build/qualification-postgres').glob('*'))),
    'providerCredentialsCopiedToSource': False, 'filesRemoved': 0, 'removalApproved': False}
inventory_path.write_text(json.dumps(inventory, indent=2) + '\n')
print(json.dumps({'output': str(output), 'publicURL': public, 'previewBrowserPassed': True, 'productionHttpPassed': True}), flush=True)
