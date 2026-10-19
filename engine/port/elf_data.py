"""Translate ARM ELF data objects into relocatable wasm32 assembly.

GNU as expands the original game macros, scripts and incbin assets first. This
tool preserves those bytes and relocations instead of reimplementing script
commands in Python. ARM instructions and unsupported relocations are errors.
"""
import argparse
from bisect import bisect_right
import hashlib
import json
from pathlib import Path
import re
import struct


class ElfError(ValueError):
    pass


def bounded(data, offset, size):
    if offset < 0 or size < 0 or offset + size > len(data):
        raise ElfError('ELF region lies outside the input file.')
    return data[offset:offset + size]


def string(data, offset):
    if offset >= len(data) or offset < 0:
        raise ElfError('Invalid ELF string offset.')
    end = data.find(b'\0', offset)
    if end < 0:
        raise ElfError('Unterminated ELF string.')
    return data[offset:end].decode('ascii')


def symbol_identifier(name):
    if not re.fullmatch(r'[A-Za-z_.$][A-Za-z_0-9.$]*', name):
        raise ElfError(f'Unsupported symbol name: {name!r}')
    return name


def signatures_from_assembly(paths):
    result = {}
    for path in paths:
        text = path.read_text()
        public = set(re.findall(r'^\s*\.(?:globl|global|weak)\s+([A-Za-z_.$][A-Za-z_0-9.$]*)', text, re.MULTILINE))
        for name, signature in re.findall(r'^\s*\.functype\s+(\S+)\s+(\([^\n]*\)\s*->\s*\([^\n]*\))\s*$', text, re.MULTILINE):
            if name not in public:
                continue
            signature = re.sub(r'\s+', '', signature)
            if name in result and result[name] != signature:
                raise ElfError(f'Conflicting C function signatures for {name}.')
            result[name] = signature
    return result


def convert(data, input_path, signatures=None):
    signatures = signatures or {}
    if len(data) < 52:
        raise ElfError('Truncated ELF header.')
    header = struct.unpack_from('<16sHHIIIIIHHHHHH', data)
    ident, kind, machine, version = header[:4]
    if ident[:7] != b'\x7fELF\x01\x01\x01' or kind != 1 or machine != 40 or version != 1:
        raise ElfError('Expected an ELF32 little-endian ARM relocatable object.')
    section_offset, entry_size, count, names_index = header[6], header[11], header[12], header[13]
    if header[8] != 52 or entry_size != 40 or not count or names_index >= count:
        raise ElfError('Unsupported ELF section table.')
    bounded(data, section_offset, count * entry_size)
    sections = [struct.unpack_from('<IIIIIIIIII', data, section_offset + i * entry_size) for i in range(count)]
    names_section = sections[names_index]
    names = bounded(data, names_section[4], names_section[5])
    section_names = [string(names, section[0]) for section in sections]
    allocated = [i for i, section in enumerate(sections) if section[2] & 2 and section[5]]
    for i in allocated:
        if sections[i][2] & 4:
            raise ElfError(f'ARM machine code is not data: {section_names[i]}.')
        if sections[i][1] not in (1, 8):
            raise ElfError(f'Unsupported allocated section: {section_names[i]}.')
        if sections[i][1] != 8:
            bounded(data, sections[i][4], sections[i][5])
    symbols = []
    symbol_table_index = None
    for i, section in enumerate(sections):
        if section[1] != 2:
            continue
        if symbol_table_index is not None or section[9] != 16 or section[5] % 16 or section[6] >= count:
            raise ElfError('Unsupported ELF symbol table.')
        symbol_table_index = i
        strings_section = sections[section[6]]
        strings = bounded(data, strings_section[4], strings_section[5])
        raw = bounded(data, section[4], section[5])
        for offset in range(0, len(raw), 16):
            name, value, size, info, other, index = struct.unpack_from('<IIIBBH', raw, offset)
            symbols.append((string(strings, name), value, size, info >> 4, info & 15, index))
    if symbol_table_index is None:
        raise ElfError('Missing ELF symbol table.')
    namespace = '__kanto_arm_' + hashlib.sha256(data).hexdigest()[:16]
    roots = {i: f'{namespace}_section_{i}' for i in allocated}

    def identifier(index):
        if index >= len(symbols):
            raise ElfError('Invalid relocation symbol index.')
        name, value, size, binding, kind, section = symbols[index]
        if kind == 3:
            if section not in roots:
                raise ElfError('Reference to an unsupported section.')
            return roots[section]
        if binding in (1, 2) or section == 0:
            return symbol_identifier(name)
        return f'{namespace}_symbol_{index}'

    relocations = {i: {} for i in allocated}
    function_declarations = {}
    for section in sections:
        if section[1] not in (4, 9) or section[7] not in relocations:
            continue
        if section[1] != 9 or section[6] != symbol_table_index or section[9] != 8 or section[5] % 8:
            raise ElfError('Only ARM SHT_REL data relocations are supported.')
        raw = bounded(data, section[4], section[5])
        target = sections[section[7]]
        for offset in range(0, len(raw), 8):
            location, info = struct.unpack_from('<II', raw, offset)
            symbol, relocation = info >> 8, info & 255
            if relocation != 2:
                raise ElfError(f'Unsupported ARM data relocation {relocation}.')
            if location in relocations[section[7]] or location + 4 > target[5] or target[1] == 8:
                raise ElfError('Invalid or overlapping data relocation.')
            if symbol >= len(symbols):
                raise ElfError('Invalid relocation symbol index.')
            name, value, size, binding, kind, symbol_section = symbols[symbol]
            addend = struct.unpack_from('<i', data, target[4] + location)[0]
            if symbol == 0 or symbol_section == 0xfff1:
                expression = str((value + addend) & 0xffffffff)
            elif symbol_section == 0 and name in signatures:
                if addend:
                    raise ElfError(f'Function-pointer arithmetic needs review: {name}.')
                signature = signatures[name]
                if not re.fullmatch(r'\((?:(?:i32|i64|f32|f64)(?:,(?:i32|i64|f32|f64))*)?\)->\((?:i32|i64|f32|f64)?\)', re.sub(r'\s+', '', signature)):
                    raise ElfError(f'Unsupported function signature for {name}.')
                function_declarations[name] = signature
                expression = identifier(symbol)
            else:
                if symbol_section not in roots and symbol_section != 0:
                    raise ElfError(f'Unsupported relocation target: {name}.')
                expression = identifier(symbol)
                if kind == 3:
                    addend += value
                if addend:
                    expression += f'{addend:+d}'
            relocations[section[7]][location] = expression

    output = ['# Generated from ARM data; no executable ARM code is translated.']
    for name, signature in sorted(function_declarations.items()):
        output.append(f'.functype {name} {signature}')
    input_name = json.dumps(str(Path(input_path).resolve()))
    for index in allocated:
        section = sections[index]
        alignment = section[8] or 1
        if alignment & (alignment - 1):
            raise ElfError('Section alignment is not a power of two.')
        # Preserve mutability/NOBITS rather than grouping every allocated
        # section with ROM assets. The sound driver has live track state in
        # ARM .bss; putting it in .rodata would omit it from mutable hashes.
        kind = '.bss' if section[1] == 8 else '.data' if section[2] & 1 else '.rodata'
        output += [f'.section {kind}.{namespace}_{index},"",@', f'.p2align {alignment.bit_length() - 1}',
                   f'.type {roots[index]},@object', roots[index] + ':', f'.size {roots[index]},{section[5]}']
        labels = {}
        for number, symbol in enumerate(symbols):
            name, value, size, binding, kind, symbol_section = symbol
            if symbol_section != index or kind in (3, 4):
                continue
            if kind not in (0, 1) or value > section[5] or size > section[5] - value:
                raise ElfError(f'Invalid data symbol: {name}.')
            labels.setdefault(value, []).append((identifier(number), size, binding))
        events = sorted(set(labels) | set(relocations[index]) | {0, section[5]})
        label_points = sorted(labels)
        cursor = 0
        while True:
            for name, size, binding in labels.get(cursor, []):
                if binding == 1:
                    output.append(f'.globl {name}')
                elif binding == 2:
                    output.append(f'.weak {name}')
                next_index = bisect_right(label_points, cursor)
                next_label = label_points[next_index] if next_index < len(label_points) else section[5]
                output += [f'.type {name},@object', name + ':', f'.size {name},{size or next_label - cursor}']
            if cursor == section[5]:
                break
            if cursor in relocations[index]:
                if events[bisect_right(events, cursor)] < cursor + 4:
                    raise ElfError('A label or relocation splits a pointer field.')
                output.append(f'.int32 {relocations[index][cursor]}')
                cursor += 4
            else:
                end = events[bisect_right(events, cursor)]
                output.append(f'.zero {end - cursor}' if section[1] == 8 else
                              f'.incbin {input_name},{section[4] + cursor},{end - cursor}')
                cursor = end
    return '\n'.join(output) + '\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--c-assembly', nargs='*', type=Path, default=[])
    args = parser.parse_args()
    result = convert(args.input.read_bytes(), args.input, signatures_from_assembly(args.c_assembly))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(result)


if __name__ == '__main__':
    main()
