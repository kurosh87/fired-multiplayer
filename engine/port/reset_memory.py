"""Preserve the linked WASM initializer for deterministic warm RAM resets.

Active data segments become passive segments initialized by a new start
function. A deliberately trapped assembly placeholder becomes a RAM reset
function using memory.fill/memory.init. No function/table indices, asset bytes,
relocations or simulation rules change. Reject unsupported layouts explicitly.
"""
from dataclasses import dataclass


class ResetError(ValueError):
    pass


@dataclass
class Reader:
    data: bytes
    offset: int = 0

    def take(self, size):
        if size < 0 or self.offset + size > len(self.data):
            raise ResetError('Truncated WASM section.')
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def byte(self):
        return self.take(1)[0]

    def integer(self, signed=False):
        value = shift = 0
        for _ in range(5):
            byte = self.byte()
            value |= (byte & 127) << shift
            shift += 7
            if byte < 128:
                if signed and byte & 64:
                    value -= 1 << shift
                if (signed and not (-(1 << 31) <= value < (1 << 31))) \
                        or (not signed and not (0 <= value < (1 << 32))):
                    raise ResetError('WASM integer exceeds 32 bits.')
                return value
        raise ResetError('Overlong WASM integer.')

    def string(self):
        return self.take(self.integer()).decode('utf-8')

    def finish(self):
        if self.offset != len(self.data):
            raise ResetError('Unexpected bytes in WASM section.')


def unsigned(value):
    result = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def signed(value):
    result = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        done = (value == 0 and not byte & 64) or (value == -1 and byte & 64)
        result.append(byte | (0 if done else 128))
        if done:
            return bytes(result)


def vector(items):
    return unsigned(len(items)) + b''.join(items)


def section(kind, payload):
    return bytes([kind]) + unsigned(len(payload)) + payload


def prepare(data, static_base=1048576):
    reader = Reader(data)
    if reader.take(8) != b'\0asm\x01\0\0\0':
        raise ResetError('Expected a WebAssembly version-1 module.')
    sections = []
    known = {}
    while reader.offset < len(data):
        kind = reader.byte()
        if kind > 12:
            raise ResetError('Unsupported WASM section in the reset module.')
        payload = reader.take(reader.integer())
        if kind and kind in known:
            raise ResetError('Duplicate WASM section.')
        known[kind] = payload
        sections.append((kind, payload))
    if 8 in known:
        raise ResetError('The source module already has a start function.')
    if 2 in known:
        imports = Reader(known[2])
        if imports.integer() != 0:
            raise ResetError('Reset preparation requires a fully linked module with no imports.')
        imports.finish()
    exports = {}
    entries = Reader(known[7])
    for _ in range(entries.integer()):
        name = entries.string()
        exports[name] = (entries.byte(), entries.integer())
    entries.finish()
    if exports.get('KantoRestoreInitialMemory', (None,))[0] != 0 \
            or exports.get('__data_end', (None,))[0] != 3:
        raise ResetError('Missing the reset placeholder or linked data boundary.')
    target_function = exports['KantoRestoreInitialMemory'][1]
    target_global = exports['__data_end'][1]
    globals_ = Reader(known[6])
    data_end = None
    for index in range(globals_.integer()):
        kind, mutable, opcode = globals_.byte(), globals_.byte(), globals_.byte()
        if kind != 0x7f or opcode != 0x41:
            raise ResetError('Expected constant-initialized i32 linker/control globals.')
        value = globals_.integer(signed=True)
        if globals_.byte() != 0x0b:
            raise ResetError('Unexpected linker global initializer.')
        if index == target_global:
            if mutable:
                raise ResetError('The linked data boundary must be constant.')
            data_end = value
    globals_.finish()
    memory = Reader(known[5])
    if memory.integer() != 1:
        raise ResetError('Expected one unshared wasm32 memory.')
    flags = memory.integer()
    if flags not in (0, 1):
        raise ResetError('Expected one unshared wasm32 memory.')
    initial_bytes = memory.integer() * 65536
    if flags == 1 and memory.integer() * 65536 < initial_bytes:
        raise ResetError('Invalid maximum memory size.')
    memory.finish()
    if data_end is None or not static_base < data_end <= initial_bytes:
        raise ResetError('Invalid static-memory reset region.')
    functions = Reader(known[3])
    types = [functions.integer() for _ in range(functions.integer())]
    functions.finish()
    code = Reader(known[10])
    bodies = [code.take(code.integer()) for _ in range(code.integer())]
    code.finish()
    if len(types) != len(bodies) or target_function >= len(types) \
            or bodies[target_function] != b'\0\0\x0b':
        raise ResetError('The reviewed assembly reset placeholder changed.')
    segments = Reader(known[11])
    passive, initialize = [], bytearray(b'\0')  # zero local declarations
    count = segments.integer()
    for index in range(count):
        flags = segments.integer()
        if flags not in (0, 2) or (flags == 2 and segments.integer() != 0):
            raise ResetError('Expected active data in memory zero; do not prepare a module twice.')
        if segments.byte() != 0x41:
            raise ResetError('Expected a constant data-segment offset.')
        offset = segments.integer(signed=True)
        if segments.byte() != 0x0b:
            raise ResetError('Unexpected data-segment offset expression.')
        payload = segments.take(segments.integer())
        if offset < static_base or offset + len(payload) > data_end:
            raise ResetError('Data segment extends outside the static-memory reset region.')
        passive.append(b'\x01' + unsigned(len(payload)) + payload)
        initialize.extend(b'\x41' + signed(offset) + b'\x41\0\x41' + signed(len(payload))
                          + b'\xfc\x08' + unsigned(index) + b'\0')
    segments.finish()
    initialize.append(0x0b)
    # Clear BSS as well as initialized data; never touch the active ABI stack.
    clear = b'\x41' + signed(static_base) + b'\x41\0\x41' + signed(data_end - static_base) + b'\xfc\x0b\0'
    bodies[target_function] = b'\0' + clear + initialize[1:]
    start_index = len(types)
    types.append(types[target_function])
    bodies.append(bytes(initialize))
    known[3] = vector([unsigned(value) for value in types])
    known[10] = vector([unsigned(len(body)) + body for body in bodies])
    known[11] = vector(passive)
    output = bytearray(data[:8])
    start_written = False
    for kind, payload in sections:
        if kind == 12:
            continue  # Emit the new DataCount immediately before Code.
        if kind > 8 and not start_written:
            output.extend(section(8, unsigned(start_index)))
            start_written = True
        if kind == 10:
            output.extend(section(12, unsigned(count)))
        output.extend(section(kind, known[kind] if kind else payload))
    return bytes(output)
