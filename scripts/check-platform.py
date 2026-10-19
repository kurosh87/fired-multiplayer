#!/usr/bin/env python3
"""Compile and execute the C platform contract tests under the machine lease."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def main():
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve())]).returncode
    target = ROOT / 'build/port-tests'
    target.mkdir(parents=True, exist_ok=True)
    common = ['cc', '-std=c11', '-fno-strict-aliasing', '-Wall', '-Wextra', '-Werror']
    cases = {
        'hardware': ['engine/port/kanto_hardware.c', 'tests/kanto_hardware_test.c'],
        'entropy': ['engine/port/kanto_entropy.c', 'tests/kanto_entropy_test.c'],
        'dma': ['engine/port/kanto_hardware.c', 'engine/port/kanto_dma.c', 'tests/kanto_dma_test.c'],
        'libc': ['engine/port/kanto_libc.c', 'tests/kanto_libc_test.c'],
    }
    for name, sources in cases.items():
        binary = target / name
        subprocess.run([*common, '-fno-builtin', *sources, '-o', str(binary)], cwd=ROOT, check=True)
        subprocess.run([str(binary)], cwd=ROOT, check=True)
        print(f'{name}: C behavior checks passed', flush=True)
    subprocess.run(['clang', '--target=wasm32-unknown-unknown', '-DKANTO_WASM',
                    '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsyntax-only',
                    'engine/port/kanto_hardware.c', 'engine/port/kanto_dma.c',
                    'engine/port/kanto_entropy.c'], cwd=ROOT, check=True)
    print('wasm32: platform syntax/layout checks passed (game not compiled)', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
