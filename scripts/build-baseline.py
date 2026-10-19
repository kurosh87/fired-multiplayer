#!/usr/bin/env python3
"""Build an unchanged revision-1 GBA ROM and verify its upstream checksum.

This ROM is an independent correctness reference, never the browser engine.
Source, toolchain, logs and outputs are retained in project-owned directories.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', choices=['firered', 'leafgreen'], default='firered')
    args = parser.parse_args()
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    lock = json.loads((ROOT / 'engine/upstream.lock.json').read_text())
    source, compiler = ROOT / 'vendor/pokefirered', ROOT / 'vendor/agbcc'
    for path, kind in [(source, 'firered'), (compiler, 'agbccReference')]:
        if not (path / '.kanto-source.json').exists() \
                or json.loads((path / '.kanto-source.json').read_text())['commit'] != lock[kind]['commit']:
            raise SystemExit('Fetch the pinned ' + kind + ' source first.')
    target = ROOT / 'build/baseline'
    target.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    if not environment.get('CC') and shutil.which('gcc-15'):
        environment.update(CC='gcc-15', CXX='g++-15')
    binaries = ['agbcc', 'old_agbcc', 'agbcc_arm', 'libgcc.a', 'libc.a']
    if not all((compiler / name).exists() for name in binaries):
        print('Building the pinned matching ARM compiler (one worker)...', flush=True)
        with (target / 'compiler.log').open('w') as log:
            subprocess.run(['bash', './build.sh'], cwd=compiler, env=environment,
                           stdout=log, stderr=log, check=True)
    with (target / 'install.log').open('w') as log:
        subprocess.run(['bash', './install.sh', str(source)], cwd=compiler,
                       stdout=log, stderr=log, check=True)
    cpp = os.environ.get('KANTO_BASELINE_CPP') or shutil.which('cpp-15') or shutil.which('cpp')
    print(f'Building unchanged {args.version} revision 1...', flush=True)
    with (target / f'{args.version}.log').open('w') as log:
        subprocess.run(['gmake', '-j2', 'GAME_VERSION=' + args.version.upper(), 'GAME_REVISION=1',
                        'MODERN=0', 'COMPARE=1', 'CPP=' + cpp], cwd=source,
                       stdout=log, stderr=log, check=True)
    name = 'poke' + args.version + '_rev1.gba'
    output = source / name
    expected = (source / (args.version + '_rev1.sha1')).read_text().split()[0]
    digest = hashlib.sha1(output.read_bytes()).hexdigest()
    if digest != expected:
        raise SystemExit('Unchanged GBA baseline does not match the upstream checksum.')
    result = {'version': args.version, 'revision': 1, 'sourceCommit': lock['firered']['commit'],
              'compilerCommit': lock['agbccReference']['commit'], 'rom': str(output.relative_to(ROOT)),
              'sha1': digest, 'bytes': output.stat().st_size, 'matchesOriginal': True,
              'browserEngineQualified': False}
    (target / f'{args.version}.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Original baseline failed ({Path(error.cmd[0]).name}, exit {error.returncode}); see build/baseline logs.') from None
