#!/usr/bin/env python3
"""Link an experimental core for boot/replay checks; do not enable public play."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', choices=['firered', 'leafgreen'], default='firered')
    parser.add_argument('--battle-experiment', action='store_true', help='Link reviewed battle overrides without replacing the adventure candidate.')
    parser.add_argument('--memory-mib', type=int, choices=[16,32,64], default=64)
    parser.add_argument('--memory-experiment', action='store_true',
                        help='Keep an adventure memory-size candidate in memory-N without replacing the current candidate.')
    parser.add_argument('--audio-experiment', action='store_true', help='Keep the experimental audio ABI/rate build in audio-N, preserving prior candidates.')
    parser.add_argument('--battle-text-experiment', action='store_true', help='Repair battle text storage in a separate battle-text-audio-N candidate using retained source objects.')
    args = parser.parse_args()
    if sum([args.memory_experiment, args.battle_experiment, args.audio_experiment]) > 1:
        parser.error('Memory experiments use unchanged adventure objects, not battle overrides.')
    if args.battle_text_experiment and not args.audio_experiment:
        parser.error('The isolated battle-text experiment requires --audio-experiment.')
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    source = ROOT / 'vendor/pokefirered-native'
    base = ROOT / 'build/game-source' / args.version
    target = (base / f'battle-text-audio-{args.memory_mib}' if args.battle_text_experiment else base / f'audio-{args.memory_mib}' if args.audio_experiment else base / f'memory-{args.memory_mib}' if args.memory_experiment
              else base / 'battle' if args.battle_experiment else base)
    if args.battle_text_experiment and target.exists():
        raise SystemExit('Preserve the retained battle-text candidate; output already exists.')
    target.mkdir(parents=True, exist_ok=True)
    report = json.loads((base / 'data-report.json').read_text())
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())['nativeFireRedReference']
    if report['sourceCommit'] != locked['commit'] or report['version'] != args.version:
        raise SystemExit('Build the pinned game data for this variant first.')
    compiler = os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
                if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    flags = ['--target=wasm32-unknown-unknown', '-std=gnu11', '-ffreestanding', '-fno-builtin',
             '-fno-strict-aliasing', '-O1', '-DKANTO_WASM=1', '-DPORTABLE',
             '-D' + args.version.upper() + '=1', '-DREVISION=1', '-DENGLISH=1', '-DMODERN=1',
             '-DUBFIX=1', '-DNDEBUG=1', '-I', str(ROOT / 'engine/port/libc'),
             '-I', str(ROOT / 'engine/port'), '-iquote', str(source / 'include')]
    own_sources = ['kanto_bridge.c', 'kanto_hardware.c', 'kanto_dma.c', 'kanto_libc.c', 'kanto_entropy.c',
                   'native_platform.c', 'kanto_scheduler.c', 'kanto_stack.s', 'kanto_reset.s', 'kanto_exchange.c', 'kanto_lobby.c']
    if args.audio_experiment: flags += ['-DKANTO_AUDIO_EXPERIMENT=1']
    if args.battle_experiment: own_sources.append('kanto_battle.c')
    own_objects = []
    log_path = target / 'candidate-build.log'
    with log_path.open('w') as log:
        spec = importlib.util.spec_from_file_location('prepare_records', ROOT / 'engine/port/prepare_records.py')
        records = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(records)
        spec = importlib.util.spec_from_file_location('prepare_battle_text', ROOT / 'engine/port/prepare_battle_text.py')
        battle_text = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(battle_text)
        def compile_own(name, extra_flags=()):
            output = target / 'platform' / Path(name).with_suffix('.o')
            output.parent.mkdir(parents=True, exist_ok=True)
            input_path = ROOT / 'engine/port' / name
            if input_path.suffix == '.c':
                expanded = output.with_suffix('.expanded.c')
                result = subprocess.run([compiler, *flags, *extra_flags, '-E', str(input_path)],
                                        stdout=subprocess.PIPE, stderr=log, check=True, text=True)
                expanded.write_text(battle_text.prepare(records.prepare(result.stdout)))
                input_path = expanded
            subprocess.run([compiler, *flags, *extra_flags, '-c', str(input_path), '-o', str(output)],
                           stdout=log, stderr=log, check=True)
            return output
        for name in own_sources:
            output = compile_own(name)
            own_objects.append(output)
        objects = [p for p in sorted((base / 'src').rglob('*.wasm.o'))
                   if p != base / 'src/platform/dma.wasm.o']
        if args.battle_text_experiment:
            original_main = (source / 'src/battle_main.c').read_bytes()
            if hashlib.sha256(original_main).hexdigest() != locked['battleInputs']['src/battle_main.c']:
                raise ValueError('The pinned original battle buffer source drifted.')
            repaired = {}
            for original in list(objects):
                expanded_source = original.with_name(original.name.replace('.wasm.o', '.expanded.c'))
                text = expanded_source.read_text()
                if not battle_text.DECLARATION.search(text): continue
                relative = expanded_source.relative_to(base)
                expanded = target / relative
                expanded.parent.mkdir(parents=True, exist_ok=True)
                expanded.write_text(battle_text.prepare(text))
                override = expanded.with_suffix('.o')
                subprocess.run([compiler, *flags, '-Wno-everything', '-c', str(expanded), '-o', str(override)], stdout=log, stderr=log, check=True)
                objects[objects.index(original)] = override
                repaired[str(relative)] = hashlib.sha256(expanded_source.read_bytes()).hexdigest()
            if not {'src/battle_main.expanded.c', 'src/battle_message.expanded.c'} <= repaired.keys():
                raise ValueError('Both battle text definition and expansion must be rebuilt.')
            (target / 'battle-text-inputs.json').write_text(json.dumps({'capacity': battle_text.CAPACITY,
                'adaptationSha256': hashlib.sha256((ROOT / 'engine/port/prepare_battle_text.py').read_bytes()).hexdigest(),
                'pinnedBattleMainSha256': hashlib.sha256(original_main).hexdigest(), 'retainedExpandedSourceHashes': repaired}, indent=2) + '\n')
        if args.audio_experiment:
            # Only the synth rate changes. Recompile these original C units
            # with the reviewed pre-include; the vendor tree stays untouched.
            for relative in ['src/m4a.c', 'src/platform/sound_mixer.c']:
                original = base / Path(relative).with_suffix('.wasm.o')
                if original not in objects: raise ValueError('Compile the original audio source objects first.')
                expanded = target / Path(relative).with_suffix('.expanded.c')
                expanded.parent.mkdir(parents=True, exist_ok=True)
                preprocessed = subprocess.run([compiler, *flags, '-include', str(ROOT / 'engine/port/kanto_audio_rate.h'),
                                               '-E', str(source / relative)], stdout=subprocess.PIPE, stderr=log, check=True, text=True).stdout
                expanded.write_text(battle_text.prepare(records.prepare(preprocessed)))
                override = expanded.with_suffix('.o')
                subprocess.run([compiler, *flags, '-Wno-everything', '-c', str(expanded), '-o', str(override)], stdout=log, stderr=log, check=True)
                objects[objects.index(original)] = override
        if args.battle_experiment:
            for relative in locked['battleInputs']:
                original = base / Path(relative).with_suffix('.wasm.o')
                override = target / Path(relative).with_suffix('.wasm.o')
                if original not in objects or not override.exists(): raise ValueError('Compile all reviewed battle overrides first.')
                objects[objects.index(original)] = override
        objects += [base / 'game-data.wasm.o', *own_objects]
        wasm = target / 'candidate.wasm'
        raw = target / 'candidate.raw.wasm'
        allowed = target / 'asyncify-symbols.txt'
        allowed.write_text('\n'.join(['KantoStartUnwind', 'KantoStopUnwind', 'KantoStartRewind',
                                     'KantoStopRewind']) + '\n')
        map_path = target / 'candidate.map'
        def link():
            subprocess.run(['wasm-ld', '--no-entry', '--export-all', '--fatal-warnings', '--error-limit=0',
                            '--stack-first', '-z', 'stack-size=1048576', '--initial-memory=' + str(args.memory_mib * 1024 ** 2),
                            '--max-memory=' + str(args.memory_mib * 1024 ** 2), '-Map=' + str(map_path),
                            '--allow-undefined-file=' + str(allowed),
                            '-o', str(raw), *map(str, objects)], stdout=log, stderr=log, check=True)
        spec = importlib.util.spec_from_file_location('kanto_memory_layout', ROOT / 'engine/port/memory_layout.py')
        layout_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(layout_module)
        link()
        layout = layout_module.read_layout(map_path.read_text())
        # Embed the discovered boundary as an instruction constant, then prove
        # that recompilation did not move either data region. No asset ranges
        # are inferred from names or assumed from another build/variant.
        compile_own('native_platform.c', ['-DKANTO_MUTABLE_BASE=' + str(layout['mutableBase'])])
        link()
        if layout_module.read_layout(map_path.read_text()) != layout:
            raise SystemExit('Embedding the mutable-state boundary changed the linked data layout.')
        # The original ARM ABI permits callback casts (e.g. void specials in
        # the script engine's u16-return table). Normalize indirect-call types
        # before Asyncify so its generated thunks can also suspend correctly.
        coroutine = target / 'candidate.coroutine.wasm'
        subprocess.run(['wasm-opt', str(raw), '--fpcast-emu', '--asyncify',
                        '--pass-arg=asyncify-removelist@KantoRunGameStack',
                        '--all-features', '-g', '-o', str(coroutine)],
                       stdout=log, stderr=log, check=True)
        spec = importlib.util.spec_from_file_location('kanto_reset_memory', ROOT / 'engine/port/reset_memory.py')
        reset = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = reset
        spec.loader.exec_module(reset)
        wasm.write_bytes(reset.prepare(coroutine.read_bytes()))
        subprocess.run(['node', '--input-type=module', '-e',
                        "import{readFileSync}from'node:fs';const b=readFileSync(process.argv[1]);"
                        "if(!WebAssembly.validate(b))process.exit(1);"
                        "const e=(await WebAssembly.instantiate(b,{})).instance.exports;"
                        "if(e.__data_end.value!==Number(process.argv[2])"
                        "||e.kanto_immutable_ptr()+e.kanto_immutable_size()!==Number(process.argv[3]))process.exit(2);",
                        str(wasm), str(layout['mutableEnd']), str(layout['mutableBase'])],
                       stdout=log, stderr=log, check=True)
    digest = hashlib.sha256(wasm.read_bytes()).hexdigest()
    manifest = {'id': f'{args.version}-rev1-{locked["commit"][:10]}-{digest[:12]}',
                'version': args.version, 'revision': 1, 'abi': 1, 'wasmSha256': digest,
                'upstreamCommit': locked['commit'], 'status': 'experimental',
                'capabilities': {'adventure': False, 'battle': False, 'trade': False, 'audio': False}}
    (target / 'candidate.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (target / 'memory-layout.json').write_text(json.dumps({'artifactId': manifest['id'], **layout}, indent=2) + '\n')
    print(json.dumps({'candidate': str(wasm.relative_to(ROOT)), 'bytes': wasm.stat().st_size,
                      'status': 'experimental', 'adventureEnabled': False,
                      'publicReleaseQualified': False}, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Candidate build failed ({Path(error.cmd[0]).name}, exit {error.returncode}); see candidate-build.log.') from None
    except ValueError as error:
        raise SystemExit(f'Candidate layout rejected: {error}') from None
