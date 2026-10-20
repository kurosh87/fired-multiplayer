#!/usr/bin/env python3
"""Build-backed private battle preview; no production publish or data writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STAGE = Path.home() / '.local/share/kanto-netlify-accounts-v1'
GUARD = Path.home() / '.local/bin/mini-build-guard'
assert subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode == 0
proof = Path(os.environ['KANTO_NETLIFY_BATTLE_PROOF']).resolve()
assert proof.is_relative_to(ROOT / 'build')
native = json.loads(proof.read_text())
assert native['databaseMajor'] == 18 and native['battleUiValidation'] and native['requestHttpValidation']
http = json.loads(Path(native['requestHttpValidation']).read_text())
assert http['fullRecordedMatch'] and http['browserValidation']['noUnexpectedServerFailures']
for path, expected in native['sourceSha256'].items():
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected, path
output = ROOT / 'build' / ('netlify-battle-preview-' + str(int(time.time())))
output.mkdir(mode=0o700)
public = 'https://kanto-online-preview.netlify.app'
before = hashlib.sha256(urllib.request.urlopen(public, timeout=30).read()).hexdigest()
report = {'nativeQualification': str(proof.relative_to(ROOT)), 'productionPublished': False, 'phases': []}

def run(label, command, cwd=ROOT, env=None):
    print(label, flush=True)
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=600)
    for suffix, value in [('stdout', result.stdout), ('stderr', result.stderr)]:
        path = output / (label + '.' + suffix + '.log')
        path.write_text(value)
        path.chmod(0o600)
    report['phases'].append({'name': label, 'exitCode': result.returncode})
    (output / 'progress.json').write_text(json.dumps(report, indent=2) + '\n')
    if result.returncode:
        print(result.stdout[-4000:], flush=True)
        print(result.stderr[-4000:], flush=True)
        raise SystemExit(f'{label} failed. Stop; exact logs retained in {output}.')
    return result.stdout

run('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit'])
run('test-page', ['node', '--experimental-strip-types', 'scripts/build-battle-test.ts'])
run('stage', ['node', '--experimental-strip-types', 'scripts/stage-netlify-preview.ts', '--retain-previous', '--battle-preview'], env=dict(os.environ, KANTO_PREVIEW_OUTPUT='build/netlify-request-battles-v1'))
retained = STAGE / 'retained'
if retained.exists():
    outside = Path.home() / '.local/share' / ('kanto-netlify-accounts-v1-retained-' + str(int(time.time())))
    retained.rename(outside)
    print('retained previous bundle outside the stage: ' + str(outside), flush=True)
deploy = json.loads(run('preview-deploy', ['/opt/homebrew/bin/netlify', 'deploy', '--site', '4fcf6389-9abb-4239-8134-d99fa08b85d8',
    '--context', 'deploy-preview', '--alias', 'kanto-battle-check', '--message', 'Private original-C battle Function qualification', '--json'], STAGE))
assert deploy['site_id'] == '4fcf6389-9abb-4239-8134-d99fa08b85d8'
origin = 'https://' + deploy['deploy_id'] + '--kanto-online-preview.netlify.app'
report['deploy'] = deploy
hosted = json.loads(run('hosted-battles', ['node', '--experimental-strip-types', 'scripts/check-netlify-battles-hosted.ts', origin, str(output / 'hosted-report.json')]))
assert hosted['passed']
after = hashlib.sha256(urllib.request.urlopen(public, timeout=30).read()).hexdigest()
assert before == after
report.update({'passed': True, 'publicHtmlSha256': after, 'publicBytesUnchanged': True, 'finishedAt': time.time()})
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'output': str(output), 'passed': True, 'productionPublished': False}), flush=True)
