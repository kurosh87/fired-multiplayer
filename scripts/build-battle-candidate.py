#!/usr/bin/env python3
"""Compile only reviewed link-battle boundaries against the existing game data.

The prior adventure/trade candidate and evidence stay in place. This bounded
experiment shares its exact original C/data objects and dependency installation.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent.parent
GUARD=Path.home()/'.local/bin/mini-build-guard'


def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'engine/port'/f'{name}.py')
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--version',choices=['firered','leafgreen'],default='firered')
    parser.add_argument('--memory-mib',type=int,choices=[16,32,64],default=16)
    args=parser.parse_args()
    if GUARD.exists() and subprocess.run([str(GUARD),'--is-owned'],capture_output=True).returncode:
        return subprocess.run([str(GUARD),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]]).returncode
    source=ROOT/'vendor/pokefirered-native'
    base=ROOT/'build/game-source'/args.version
    locked=json.loads((ROOT/'engine/upstream.lock.json').read_text())['nativeFireRedReference']
    marker=json.loads((source/'.kanto-source.json').read_text())
    data=json.loads((base/'data-report.json').read_text())
    if marker['commit']!=locked['commit'] or data['sourceCommit']!=locked['commit'] or data['version']!=args.version:
        raise SystemExit('Build the pinned original source/data for this variant first.')
    target=base/'battle';target.mkdir(exist_ok=True)
    compiler=os.environ.get('KANTO_WASM_CC') or ('/opt/homebrew/opt/llvm/bin/clang'
        if Path('/opt/homebrew/opt/llvm/bin/clang').exists() else 'clang')
    flags=['--target=wasm32-unknown-unknown','-std=gnu11','-ffreestanding','-fno-builtin','-fno-strict-aliasing',
           '-DNONMATCHING','-DPORTABLE','-DRENDERER_EASY_DRAW','-D'+args.version.upper()+'=1','-DREVISION=1',
           '-DENGLISH=1','-DMODERN=1','-DUBFIX=1','-DNDEBUG=1','-DKANTO_WASM=1',
           '-I',str(ROOT/'engine/port/libc'),'-I',str(ROOT/'engine/port'),'-iquote','include']
    warnings=['-Wno-implicit-function-declaration','-Wno-int-conversion','-Wno-incompatible-function-pointer-types',
              '-Wno-unknown-attributes','-Wno-deprecated-non-prototype']
    battle,records,battle_text=module('prepare_battle'),module('prepare_records'),module('prepare_battle_text')
    with (target/'compile.log').open('w') as log:
        for relative,expected in locked['battleInputs'].items():
            original=(source/relative).read_bytes()
            if hashlib.sha256(original).hexdigest()!=expected:raise SystemExit(f'Original battle source drifted: {relative}')
            path=target/relative;path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(battle.prepare(original.decode(),relative))
            intermediate=path.with_suffix('.i');expanded=path.with_suffix('.expanded.c');assembly=path.with_suffix('.wasm.s')
            with intermediate.open('wb') as output:
                subprocess.run([compiler,*flags,'-iquote',str((source/relative).parent),'-E',str(path)],
                               cwd=source,stdout=output,stderr=log,check=True)
            with expanded.open('wb') as output:
                subprocess.run(['tools/preproc/preproc',str(intermediate),'charmap.txt'],cwd=source,stdout=output,stderr=log,check=True)
            expanded.write_text(battle_text.prepare(records.prepare(expanded.read_text())))
            subprocess.run([compiler,*flags,*warnings,'-O1','-S',str(expanded),'-o',str(assembly)],cwd=source,stdout=log,stderr=log,check=True)
            subprocess.run([compiler,'--target=wasm32-unknown-unknown','-c',str(assembly),'-o',str(path.with_suffix('.wasm.o'))],
                           cwd=source,stdout=log,stderr=log,check=True)
    return subprocess.run([sys.executable,'-B',str(ROOT/'scripts/link-candidate.py'),'--version',args.version,'--battle-experiment',
                           '--memory-mib',str(args.memory_mib)],cwd=ROOT).returncode


if __name__=='__main__':
    try:raise SystemExit(main())
    except subprocess.CalledProcessError as error:raise SystemExit(f'Battle compilation failed: {error}. Inspect the retained battle/compile.log.') from None
