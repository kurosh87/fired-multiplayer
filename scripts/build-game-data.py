#!/usr/bin/env python3
"""Assemble the game's original data and translate its relocations to WASM."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
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
    target = ROOT / 'build/game-source' / args.version
    report = json.loads((target / 'report.json').read_text())
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())['nativeFireRedReference']
    if report['failures'] or report['sourceCommit'] != locked['commit'] or report['version'] != args.version:
        raise SystemExit('Complete the pinned C source compilation for this version first.')
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    for tool in ['arm-none-eabi-as', 'arm-none-eabi-ld', 'gmake', compiler]:
        if not shutil.which(tool):
            raise SystemExit(f'Missing game data tool: {tool}')
    log = (target / 'data-build.log').open('w')

    def run(command, **kwargs):
        return subprocess.run(command, cwd=source, check=True, stderr=log, **kwargs)

    try:
        c_assemblies = sorted((target / 'src').rglob('*.wasm.s'))
        print(f'Assembling {len(c_assemblies)} C compilation units to WASM objects...', flush=True)
        for path in c_assemblies:
            run([compiler, '--target=wasm32-unknown-unknown', '-c', str(path), '-o', str(path.with_suffix('.o'))], stdout=log)
        songs = [str(p.relative_to(source).with_suffix('.s')) for p in sorted((source / 'sound/songs').rglob('*.mid'))]
        for offset in range(0, len(songs), 100):
            run(['gmake', '-j2', 'NODEP=1', 'SETUP_PREREQS=0', 'CPP=clang', *songs[offset:offset + 100]], stdout=log)
        identifiers = []
        for line in (source / 'data/specials.inc').read_text().splitlines():
            match = re.match(r'\s*def_special\s+([A-Za-z_0-9]+)', line)
            if match:
                identifiers.append(f'.set SPECIAL_{match[1]},{len(identifiers)}')
        definitions = target / 'special_ids.inc'
        definitions.write_text('\n'.join(identifiers) + '\n')
        assembly_sources = sorted((source / 'data').glob('*.s')) + sorted((source / 'sound/songs').rglob('*.s'))
        asset_spec = importlib.util.spec_from_file_location('source_assets', ROOT / 'engine/port/source_assets.py')
        assets = importlib.util.module_from_spec(asset_spec)
        asset_spec.loader.exec_module(assets)
        assets.generate(source, [], assembly_sources, run, log)
        objects = []
        print(f'Assembling {len(assembly_sources)} original script/music data files...', flush=True)
        for number, path in enumerate(assembly_sources, 1):
            relative = path.relative_to(source)
            destination = target / 'arm-data' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            expanded = destination.with_suffix('.expanded.s')
            if relative.parts[0] == 'data':
                first = run(['tools/preproc/preproc', str(relative), 'charmap.txt'], stdout=subprocess.PIPE)
                cpp = run([compiler, '-E', '-x', 'c', '-I', 'include', '-DPORTABLE', '-DUBFIX', '-'],
                          input=first.stdout, stdout=subprocess.PIPE)
                result = run(['tools/preproc/preproc', '-ie', str(relative), 'charmap.txt'],
                             input=cpp.stdout, stdout=subprocess.PIPE)
                expanded.write_bytes(f'.include "{definitions}"\n'.encode() + result.stdout)
            else:
                expanded.write_bytes(path.read_bytes())
            output = destination.with_suffix('.arm.o')
            run(['arm-none-eabi-as', '-march=armv7-a', '--defsym', args.version.upper() + '=1',
                 '--defsym', 'REVISION=1', '--defsym', 'ENGLISH=1', '--defsym', 'MODERN=1',
                 '-I', '.', '-I', 'sound', '-o', str(output), str(expanded)], stdout=log)
            objects.append(output)
            if number % 100 == 0:
                print(f'Assembled {number}/{len(assembly_sources)} data files', flush=True)
        combined = target / 'game-data.arm.o'
        run(['arm-none-eabi-ld', '-r', '-o', str(combined), *map(str, objects)], stdout=log)
        spec = importlib.util.spec_from_file_location('elf_data', ROOT / 'engine/port/elf_data.py')
        converter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(converter)
        translated = target / 'game-data.wasm.s'
        translated.write_text(converter.convert(combined.read_bytes(), combined,
                                               converter.signatures_from_assembly(c_assemblies)))
        wasm_data = target / 'game-data.wasm.o'
        run([compiler, '--target=wasm32-unknown-unknown', '-c', str(translated), '-o', str(wasm_data)], stdout=log)
        result = {'version': args.version, 'sourceCommit': locked['commit'], 'cObjects': len(c_assemblies),
                  'armDataObjects': len(objects), 'dataObject': str(wasm_data.relative_to(ROOT)),
                  'playableArtifactProduced': False}
        (target / 'data-report.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2), flush=True)
        return 0
    finally:
        log.close()


if __name__ == '__main__':
    raise SystemExit(main())
