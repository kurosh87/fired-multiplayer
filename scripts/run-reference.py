#!/usr/bin/env python3
"""Run recorded buttons on the checksum-matching GBA baseline with mGBA."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', choices=['firered', 'leafgreen'], default='firered')
    parser.add_argument('--replay', default='tests/replays/new-game.json')
    parser.add_argument('--save', help='Read a canonical 128 KiB flash file into temporary emulator memory.')
    parser.add_argument('--output', help='Project-relative directory for this reference scenario.')
    parser.add_argument('--dump-storage', action='store_true', help='Read the complete original PokemonStorage RAM block after replay.')
    args = parser.parse_args()
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())
    source = ROOT / 'vendor/mgba'
    if json.loads((source / '.kanto-source.json').read_text())['commit'] != locked['mgbaReference']['commit']:
        raise SystemExit('Fetch the pinned mGBA reference first.')
    baseline = json.loads((ROOT / 'build/baseline' / f'{args.version}.json').read_text())
    rom = ROOT / baseline['rom']
    if baseline['sourceCommit'] != locked['firered']['commit'] \
            or hashlib.sha1(rom.read_bytes()).hexdigest() != baseline['sha1'] or not baseline['matchesOriginal']:
        raise SystemExit('Build and verify the unchanged original GBA baseline first.')
    build = ROOT / 'build/mgba'
    target = ROOT / args.output if args.output else ROOT / 'build/reference' / args.version
    if not target.resolve().is_relative_to(ROOT / 'build'):
        raise SystemExit('Reference outputs must stay inside the project build directory.')
    target.mkdir(parents=True, exist_ok=True)
    with (target / 'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', str(source), '-B', str(build), '-DLIBMGBA_ONLY=ON',
                        '-DM_CORE_GB=OFF', '-DM_CORE_GBA=ON', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
                        '-DCMAKE_BUILD_TYPE=Release'], stdout=log, stderr=log, check=True)
        subprocess.run(['cmake', '--build', str(build), '--parallel', '2'], stdout=log, stderr=log, check=True)
        binary = build / 'kanto-reference'
        libraries = ['-lm', '-lpthread'] + (['-framework', 'Foundation'] if sys.platform == 'darwin' else [])
        subprocess.run(['cc', '-std=c11', '-O2', '-DM_CORE_GBA', '-DBUILD_STATIC',
                        '-I', str(source / 'include'), '-I', str(build / 'include'),
                        str(ROOT / 'engine/reference/headless.c'), str(build / 'libmgba.a'),
                        *libraries, '-o', str(binary)], stdout=log, stderr=log, check=True)
    replay = json.loads((ROOT / args.replay).read_text())
    total = sum(run['frames'] for run in replay['runs'])
    captures = set([900, 1201, 3385, total])
    frame = 0
    lines = []
    for run in replay['runs']:
        remaining = run['frames']
        if run['buttons'] < 0 or run['buttons'] > 1023 or remaining < 1 or remaining > 60:
            raise ValueError('Invalid replay input.')
        while remaining:
            count = min([remaining] + [point - frame for point in captures if frame < point <= frame + remaining])
            frame += count
            lines.append(f'{run["buttons"]} {count} {int(frame in captures)}')
            remaining -= count
    inputs = target / 'inputs.txt'
    inputs.write_text('\n'.join(lines) + '\n')
    table = subprocess.run(['arm-none-eabi-nm', '-n', str(rom.with_suffix('.elf'))],
                           capture_output=True, text=True, check=True).stdout
    symbols, addresses = {}, {}
    for line in table.splitlines():
        parts = line.split()
        if len(parts) == 3:
            addresses[parts[2]] = int(parts[0], 16)
            if parts[1].lower() == 't': symbols[int(parts[0], 16)] = parts[2]
    print(f'Running {total} original GBA frames with mGBA {locked["mgbaReference"]["version"]}...', flush=True)
    restored = []
    save_sha256 = None
    if args.save:
        save_path = (ROOT / args.save).resolve()
        save_bytes = save_path.read_bytes()
        if len(save_bytes) != 128 * 1024:
            raise ValueError('A reference flash file must contain exactly 128 KiB.')
        save_sha256 = hashlib.sha256(save_bytes).hexdigest()
        restored = [str(save_path)]
    with (target / 'run.log').open('w') as log:
        storage_args = ['--storage-address', str(addresses['gPokemonStoragePtr'])] if args.dump_storage else []
        subprocess.run([str(binary), str(rom), str(inputs), str(target),
                        str(addresses['gMain']), str(addresses['gSaveBlock1Ptr']),
                        str(addresses['gPlayerParty']), str(addresses['gPlayerPartyCount']),
                        str(addresses['gSaveFileStatus']), str(addresses['gQuestLogState']),
                        str(addresses['gSaveBlock2Ptr']), *restored, *storage_args],
                       stdout=log, stderr=log, check=True)
    points = []
    startup = None
    for line in (target / 'run.log').read_text().splitlines():
        if line.startswith('{'):
            point = json.loads(line)
            if 'startupHardwareFrames' in point:
                startup = point
                continue
            point['callback'] = symbols.get(point['callbackAddress'] & ~1, 'unknown')
            points.append(point)
    report = {'version': args.version, 'romSha1': baseline['sha1'],
              'referenceCommit': locked['mgbaReference']['commit'], 'restoredFlashSha256': save_sha256,
              'frames': total, 'startup': startup, 'points': points,
              'storageReadback': args.dump_storage,
              'sourceHashes': {'runner': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                               'harness': hashlib.sha256((ROOT / 'engine/reference/headless.c').read_bytes()).hexdigest()},
              'browserEngineQualified': False}
    (target / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'GBA reference failed ({Path(error.cmd[0]).name}, exit {error.returncode}); see build/reference logs.') from None
