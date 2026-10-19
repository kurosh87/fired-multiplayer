#!/usr/bin/env python3
"""Prepare reviewed source transformations; this does not produce a game binary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'engine/port/{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_files(source, locked):
    """Validate every input before returning any generated files."""
    main = load('prepare_main')
    hardware = load('prepare_hardware')
    dma = load('prepare_dma')
    transforms = {
        'src/main.c': main.prepare,
        'include/gba/defines.h': lambda text: hardware.prepare(text, 'defines'),
        'include/gba/io_reg.h': lambda text: hardware.prepare(text, 'registers'),
        'include/gba/macro.h': dma.prepare,
    }
    output = {}
    for name, transform in transforms.items():
        data = (source / name).read_bytes()
        expected = locked['portInputs'][name]
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'{name} does not match the reviewed pinned source.')
        output[name] = transform(data.decode('utf-8'))
    return output


def main():
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve())]).returncode
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())['firered']
    source = ROOT / 'vendor/pokefirered'
    marker = source / '.kanto-source.json'
    if not marker.exists():
        raise SystemExit('Fetch the pinned source with engine:fetch first.')
    if json.loads(marker.read_text())['commit'] != locked['commit']:
        raise SystemExit('Source revision differs from the lock.')
    output = prepare_files(source, locked)
    target = ROOT / 'engine/generated'
    for name, text in output.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    print(json.dumps({'prepared': list(output), 'directory': str(target),
                      'gameBuildReady': False, 'remaining': [
                          'Game RAM layout and raw-address conversion',
                          'Scanline DMA scheduling and direct register-write audit',
                          'Interrupt, timer and BIOS implementations',
                          'Portable flash driver, script and asset conversion',
                          'Rendering, audio and canonical state serialization',
                          'Linking and gameplay qualification for both versions',
                      ]}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
