#!/usr/bin/env python3
"""Inventory real GBA dependencies. This tool never substitutes emulator output."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'vendor/pokefirered'

def audit():
    if not (SOURCE / 'src/main.c').exists():
        return {'ready': False, 'sourcePresent': False, 'reason': 'Run the guarded source bootstrap once build resources are available.'}
    c_files = sorted((SOURCE / 'src').rglob('*.c'))
    assembly = sorted(str(path.relative_to(SOURCE)) for folder in ['asm','data','sound'] for path in (SOURCE / folder).rglob('*.s'))
    findings = []
    for path in c_files:
        text = path.read_text(errors='replace')
        for kind, pattern in [('inlineArmAssembly', r'\b(?:asm|__asm__)\s*\('), ('directHardwareAccess', r'\bREG_[A-Z0-9_]+'), ('incbinAssets', r'\bINCBIN_[A-Z0-9_]+')]:
            count = len(re.findall(pattern, text))
            if count:
                findings.append({'path': str(path.relative_to(SOURCE)), 'kind': kind, 'count': count})
    artifacts = [ROOT / f'engine/artifacts/{version}.wasm' for version in ['firered','leafgreen']]
    return {'ready': all(path.exists() for path in artifacts), 'sourcePresent': True, 'cSourceCount': len(c_files),
        'assemblyDataCount': len(assembly), 'assemblyData': assembly, 'dependencies': findings,
        'requiredWork': ['Frame-stepped main loop', 'Deterministic GBA platform/BIOS implementations',
          'Assembly/script/asset conversion', 'Graphics and audio adapters', 'Canonical state serialization',
          'Kanto ABI bridge', 'Browser/server replay parity and reference compatibility']}

if __name__ == '__main__':
    result = audit()
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ready'] else 1)
