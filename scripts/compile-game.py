#!/usr/bin/env python3
"""Build original assets and compile portable FireRed/LeafGreen C to WASM objects.

This is the source compilation stage. It emits no playable artifact or manifest
until the platform, assembled data and ABI have been linked and qualified.
"""
import argparse
import hashlib
import importlib.util
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
    source = ROOT / 'vendor/pokefirered-native'
    marker = source / '.kanto-source.json'
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())['nativeFireRedReference']
    if not marker.exists() or json.loads(marker.read_text())['commit'] != locked['commit']:
        raise SystemExit('Fetch the pinned nativeFireRedReference first.')
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    for tool in ['gmake', compiler]:
        if not shutil.which(tool):
            raise SystemExit(f'Missing source compilation tool: {tool}')
    target = ROOT / 'build/game-source' / args.version
    target.mkdir(parents=True, exist_ok=True)
    log = (target / 'build.log').open('w')

    def run(command, **kwargs):
        return subprocess.run(command, cwd=source, check=True, stderr=log, **kwargs)

    try:
        print('Building source asset tools and generated map data...', flush=True)
        run(['gmake', '-f', 'make_tools.mk', '-j2', 'tools'], stdout=log)
        run(['gmake', '-j2', 'generated', 'CPP=clang'], stdout=log)
        excluded = {'src/stub.c', 'src/platform/sdl2.c', 'src/platform/win32.c',
                    'src/platform/nostd.c', 'src/platform/dualscreen_bridge.c',
                    'src/platform/voxel_stub.c', 'src/platform/gba_fast_draw.c'}
        c_sources = [p for p in sorted((source / 'src').rglob('*.c'))
                     if not p.name.endswith('.inc.c') and str(p.relative_to(source)) not in excluded
                     and 'voxel' not in p.relative_to(source).parts]
        asm_sources = sorted((source / 'data').glob('*.s')) + sorted((source / 'sound/songs').rglob('*.s'))
        asset_spec = importlib.util.spec_from_file_location('source_assets', ROOT / 'engine/port/source_assets.py')
        assets = importlib.util.module_from_spec(asset_spec)
        asset_spec.loader.exec_module(assets)
        assets.generate(source, c_sources, asm_sources, run, log)
        flags = ['--target=wasm32-unknown-unknown', '-std=gnu11', '-ffreestanding', '-fno-builtin',
                 '-fno-strict-aliasing', '-DNONMATCHING', '-DPORTABLE', '-DRENDERER_EASY_DRAW',
                 '-D' + args.version.upper() + '=1', '-DREVISION=1', '-DENGLISH=1', '-DMODERN=1',
                 '-DUBFIX=1', '-DNDEBUG=1', '-I', str(ROOT / 'engine/port/libc'), '-iquote', 'include']
        flags += ['-DKANTO_WASM=1', '-I', str(ROOT / 'engine/port')]
        warnings = ['-Wno-implicit-function-declaration', '-Wno-int-conversion',
                    '-Wno-incompatible-function-pointer-types', '-Wno-unknown-attributes',
                    '-Wno-deprecated-non-prototype']
        failures = []
        spec = importlib.util.spec_from_file_location('prepare_portable', ROOT / 'engine/port/prepare_portable.py')
        preparation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(preparation)
        spec = importlib.util.spec_from_file_location('prepare_records', ROOT / 'engine/port/prepare_records.py')
        records = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(records)
        spec = importlib.util.spec_from_file_location('prepare_battle_text', ROOT / 'engine/port/prepare_battle_text.py')
        battle_text = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(battle_text)
        for number, path in enumerate(c_sources, 1):
            relative = path.relative_to(source)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            intermediate = destination.with_suffix('.i')
            expanded = destination.with_suffix('.expanded.c')
            assembly = destination.with_suffix('.wasm.s')
            try:
                input_path = relative
                quoted = []
                if str(relative) in locked['portInputs']:
                    original = path.read_bytes()
                    if hashlib.sha256(original).hexdigest() != locked['portInputs'][str(relative)]:
                        raise ValueError(f'{relative} differs from the reviewed source.')
                    prepared = target / 'prepared' / relative
                    prepared.parent.mkdir(parents=True, exist_ok=True)
                    prepared.write_text(preparation.prepare(original.decode(), str(relative)))
                    input_path = prepared
                    quoted = ['-iquote', str(path.parent)]
                with intermediate.open('wb') as output:
                    run([compiler, *quoted, *flags, '-E', str(input_path)], stdout=output)
                with expanded.open('wb') as output:
                    run(['tools/preproc/preproc', str(intermediate), 'charmap.txt'], stdout=output)
                expanded.write_text(battle_text.prepare(records.prepare(expanded.read_text())))
                run([compiler, *flags, *warnings, '-O1', '-S', str(expanded), '-o', str(assembly)], stdout=log)
            except subprocess.CalledProcessError:
                failures.append(str(relative))
                print(f'Compile failed: {relative} (see {target / "build.log"})', flush=True)
            if number % 25 == 0:
                print(f'Compiled {number}/{len(c_sources)} source units; failures={len(failures)}', flush=True)
        report = {'version': args.version, 'sourceCommit': locked['commit'],
                  'sourceCount': len(c_sources), 'compiled': len(c_sources) - len(failures),
                  'failures': failures, 'playableArtifactProduced': False}
        (target / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2), flush=True)
        return 1 if failures else 0
    finally:
        log.close()


if __name__ == '__main__':
    raise SystemExit(main())
