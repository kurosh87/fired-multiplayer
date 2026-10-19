#!/usr/bin/env python3
"""Compare saved C record layouts with the pinned matching ARM compiler."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    parser_args = argparse.ArgumentParser()
    parser_args.add_argument('--output', default='build/record-abi')
    args = parser_args.parse_args()
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    original, native = ROOT / 'vendor/pokefirered', ROOT / 'vendor/pokefirered-native'
    lock = json.loads((ROOT / 'engine/upstream.lock.json').read_text())
    for source, kind in [(original, 'firered'), (native, 'nativeFireRedReference'), (ROOT / 'vendor/agbcc', 'agbccReference')]:
        if json.loads((source / '.kanto-source.json').read_text())['commit'] != lock[kind]['commit']:
            raise SystemExit('Saved-layout qualification requires the pinned ' + kind + ' source.')
    target = (ROOT / args.output).resolve()
    if not target.is_relative_to(ROOT / 'build'):
        raise SystemExit('Record-layout outputs must stay inside the project build directory.')
    target.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('prepare_records', ROOT / 'engine/port/prepare_records.py')
    records = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(records)
    spec = importlib.util.spec_from_file_location('prepare_main', ROOT / 'engine/port/prepare_main.py')
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    entries = []
    header = (original / 'include/global.h').read_text()
    for name in ['SaveBlock1', 'SaveBlock2', 'QuestLogScene', 'QuestLogObjectEvent',
                 'Mail', 'DayCareMail', 'FameCheckerSaveData', 'Pokemon', 'BoxPokemon', 'PokemonStorage']:
        entries.append((f'sizeof({name})', f'sizeof(struct {name})'))
    # Check every direct non-bitfield member in both save blocks and the recap.
    for name in ['SaveBlock1', 'SaveBlock2', 'QuestLogScene']:
        start = header.index('{', header.index('struct ' + name + '\n'))
        body = header[start + 1:parser.closing_brace(header, start)]
        body = re.sub(r'/\*.*?\*/|//[^\n]*', '', body, flags=re.S)
        for declaration in body.split(';'):
            if ':' in declaration or not declaration.strip():
                continue
            match = re.search(r'(\w+)\s*(?:\[[^\]]*\]\s*)*$', declaration.strip())
            if not match:
                raise ValueError('Review saved member declaration: ' + declaration)
            member = match[1]
            entries.append((name + '.' + member, f'(u32)&((struct {name} *)0)->{member}'))
    for member in ['currentBox', 'boxes', 'boxNames', 'boxWallpapers']:
        entries.append(('PokemonStorage.' + member, f'(u32)&((struct PokemonStorage *)0)->{member}'))
    source = '#include "global.h"\n#include "pokemon_storage_system.h"\nconst u32 kanto_layout[] = {\n' + ',\n'.join(value for _, value in entries) + '\n};\n'
    fixture = target / 'layout.c'
    fixture.write_text(source)
    flags = ['-DFIRERED=1', '-DREVISION=1', '-DENGLISH=1']
    arm_i = subprocess.run([shutil.which('cpp-15') or 'cpp', '-iquote', 'include',
                           '-I', 'tools/agbcc/include', '-I', 'tools/agbcc', '-nostdinc', '-undef',
                           '-std=gnu89', *flags, '-DMODERN=0', str(fixture)], cwd=original,
                          capture_output=True, text=True, check=True).stdout
    arm_s = target / 'layout.arm.s'
    subprocess.run([str(original / 'tools/agbcc/bin/agbcc'), '-mthumb-interwork', '-O2',
                    '-o', str(arm_s), '-'], input=arm_i, text=True, check=True, capture_output=True)
    arm_o = target / 'layout.arm.o'
    subprocess.run(['arm-none-eabi-as', '-mcpu=arm7tdmi', '-o', str(arm_o), str(arm_s)], check=True)
    arm_bin = target / 'layout.arm.bin'
    subprocess.run(['arm-none-eabi-objcopy', '-O', 'binary', '--only-section=.rodata', str(arm_o), str(arm_bin)], check=True)
    cc = '/opt/homebrew/opt/llvm/bin/clang'
    wasm_flags = ['--target=wasm32-unknown-unknown', '-std=gnu11', '-ffreestanding', '-fno-builtin',
                  '-Wno-everything', '-I', str(ROOT / 'engine/port/libc'), '-iquote', str(native / 'include'),
                  *flags, '-DMODERN=1', '-DPORTABLE=1']
    wasm_i = subprocess.run([cc, *wasm_flags, '-E', str(fixture)], capture_output=True, text=True, check=True).stdout
    expanded = target / 'layout.wasm.c'
    expanded.write_text(records.prepare(wasm_i))
    wasm_o, wasm = target / 'layout.wasm.o', target / 'layout.wasm'
    subprocess.run([cc, *wasm_flags, '-c', str(expanded), '-o', str(wasm_o)], check=True)
    subprocess.run(['wasm-ld', '--no-entry', '--export-all', str(wasm_o), '-o', str(wasm)], check=True)
    result = subprocess.run(['node', '--input-type=module', '-e',
        "import{readFileSync}from'node:fs';const e=(await WebAssembly.instantiate(readFileSync(process.argv[1]),{})).instance.exports;"
        "process.stdout.write(Buffer.from(e.memory.buffer,e.kanto_layout.value,Number(process.argv[2])*4));",
        str(wasm), str(len(entries))], capture_output=True, check=True).stdout
    arm_bytes = arm_bin.read_bytes()
    if len(arm_bytes) != len(entries) * 4:
        raise ValueError('Unexpected ARM fixture section size.')
    arm_values = struct.unpack('<' + 'I' * len(entries), arm_bytes)
    wasm_values = struct.unpack('<' + 'I' * len(entries), result)
    mismatches = [(name, a, b) for (name, _), a, b in zip(entries, arm_values, wasm_values) if a != b]
    report = {'matching': not mismatches, 'compiler': 'pinned matching agbcc Thumb',
              'compilerCommit': lock['agbccReference']['commit'],
              'originalSourceCommit': lock['firered']['commit'],
              'nativeSourceCommit': lock['nativeFireRedReference']['commit'],
              'minimumRecordAlignmentBits': 32, 'packedRecordsExempt': True,
              'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
              'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'members': {name: {'arm': a, 'wasm': b} for (name, _), a, b in zip(entries, arm_values, wasm_values)},
              'mismatches': mismatches}
    (target / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    if mismatches:
        raise SystemExit('Saved record layout mismatches: ' + repr(mismatches))
    print(f'{len(entries)} original saved-record sizes/member offsets match the pinned ARM compiler.')


if __name__ == '__main__':
    main()
