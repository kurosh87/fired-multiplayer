"""Redirect the pinned game's hardware macros to wasm32 linear-memory storage.

Only the reviewed macro definitions are changed. The rest of the original
headers (register offsets, types, flags and addresses derived from the bases)
remain intact. This is storage, not a DMA, interrupt or timer implementation.
"""
import re


DEFINES = {
    'SOUND_INFO_PTR': ('(*(struct SoundInfo **)0x3007FF0)',
                       '(gKantoHardware.sound_info)'),
    'INTR_CHECK': ('(*(u16 *)0x3007FF8)', '(gKantoHardware.intr_check)'),
    'INTR_VECTOR': ('(*(void **)0x3007FFC)', '(gKantoHardware.intr_vector)'),
    'PLTT': ('0x5000000', '((uintptr_t)gKantoHardware.palette)'),
    'VRAM': ('0x6000000', '((uintptr_t)gKantoHardware.vram)'),
    'OAM': ('0x7000000', '((uintptr_t)gKantoHardware.oam)'),
}
REGISTERS = {
    'REG_BASE': ('0x4000000', '((uintptr_t)gKantoHardware.registers)'),
}


def normalize(text: str) -> str:
    return re.sub(r'\s+', '', text)


def prepare(source: str, kind: str) -> str:
    if kind not in ['defines', 'registers']:
        raise ValueError('Expected defines or registers header.')
    if 'kanto_hardware.h' in source:
        raise ValueError('Source has already been prepared.')
    replacements = DEFINES if kind == 'defines' else REGISTERS
    for name, (expected, mapped) in replacements.items():
        pattern = re.compile(r'^(#define[ \t]+' + re.escape(name)
                             + r'[ \t]+)([^\n]*)(\n|$)', re.MULTILINE)
        matches = list(pattern.finditer(source))
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one definition of {name}.')
        definition = matches[0].group(2).split('//', 1)[0].strip()
        if normalize(definition) != normalize(expected):
            raise ValueError(f'{name} changed upstream; review its memory semantics.')
        source = pattern.sub(lambda m: m.group(1) + mapped + m.group(3), source)
    return ('#ifndef KANTO_WASM\n'
            '#error This generated header is for the WASM port only.\n'
            '#endif\n#include "kanto_hardware.h"\n' + source)
