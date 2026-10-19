"""Prepare a frame-stepped main.c without editing the pinned upstream source.

This is one part of the port, not a complete game build. The required platform,
assembly/data conversions, graphics, sound and serialization must still link.
"""
import argparse
from pathlib import Path
import re

def closing_brace(source: str, opening: int) -> int:
    depth = 0
    state = 'code'
    i = opening
    while i < len(source):
        char = source[i]
        pair = source[i:i + 2]
        if state == 'line':
            if char == '\n': state = 'code'
        elif state == 'block':
            if pair == '*/': state = 'code'; i += 1
        elif state in ['"', "'"]:
            if char == '\\': i += 1
            elif char == state: state = 'code'
        elif pair == '//': state = 'line'; i += 1
        elif pair == '/*': state = 'block'; i += 1
        elif char in ['"', "'"]: state = char
        elif char == '{': depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0: return i
        i += 1
    raise ValueError('Unbalanced source braces.')

def prepare(source: str) -> str:
    if 'KantoGameFrame' in source:
        raise ValueError('Source has already been prepared.')
    function = re.search(r'void\s+AgbMain\s*\(\s*(?:void\s*)?\)\s*\{', source)
    if not function: raise ValueError('Expected the pinned AgbMain definition.')
    opening = source.index('{', function.start())
    ending = closing_brace(source, opening)
    loop = re.search(r'for\s*\(\s*;\s*;\s*\)\s*\{', source[opening:ending])
    if not loop: raise ValueError('Expected the original perpetual game loop.')
    loop_start = opening + loop.start()
    loop_opening = source.index('{', loop_start)
    loop_ending = closing_brace(source, loop_opening)
    if source[loop_ending + 1:ending].strip(): raise ValueError('Unexpected code after the game loop; review upstream before preparing.')
    initialization = source[opening + 1:loop_start]
    # Keep the original non-modern ResetRam path for the WASM BIOS shim; never
    # send inline ARM startup instructions to the WASM compiler.
    if '#if MODERN' not in initialization: raise ValueError('Expected the pinned modern startup block.')
    initialization = initialization.replace('#if MODERN', '#if MODERN && !defined(KANTO_WASM)', 1)
    frame = source[loop_opening + 1:loop_ending]
    if frame.count('WaitForVBlank();') != 1: raise ValueError('Expected exactly one VBlank boundary in the game loop.')
    frame = frame.replace('WaitForVBlank();', 'VBlankIntr();\n        KantoPlatformFrameEnd();')
    result = source[:opening + 1] + initialization + '\n}\n\nvoid KantoGameFrame(void)\n{\n    KantoPlatformFrameBegin();\n' + frame + '\n}' + source[ending + 1:]
    # The virtual platform invokes compiled interrupt callbacks. It must never
    # install or execute the original ARM interrupt trampoline.
    trampoline = re.compile(r'(\s*DmaCopy32\(3, intr_main, IntrMain_Buffer, sizeof\(IntrMain_Buffer\)\);\s*INTR_VECTOR = IntrMain_Buffer;)')
    result, replacements = trampoline.subn(r'\n#ifndef KANTO_WASM\n\1\n#endif\n', result)
    if replacements != 1: raise ValueError('Interrupt trampoline layout changed; review upstream before preparing.')
    return '#ifndef KANTO_WASM\n#error This generated source is for the WASM port only.\n#endif\n#include "kanto_platform.h"\n' + result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = prepare(args.source.read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result)
