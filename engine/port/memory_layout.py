"""Read the exact wasm-ld linear-memory partition; reject unknown layouts."""
import re


def read_layout(text, static_base=1048576):
    sections = {}
    for line in text.splitlines():
        # The Out column has one separator after Size. In/Symbol columns
        # are indented further; local .L* symbols are not output sections.
        match = re.fullmatch(r'\s*([a-fA-F0-9]+)\s+([a-fA-F0-9]+)\s+([a-fA-F0-9]+) (\.[\w.]+)\s*', line)
        if not match:
            continue
        start, _, size, name = match.groups()
        if name in sections:
            raise ValueError(f'Duplicate linear-memory section: {name}')
        sections[name] = (int(start, 16), int(size, 16))
    if set(sections) != {'.rodata', '.data', '.bss'}:
        raise ValueError(f'Unsupported linear-memory partition: {sorted(sections)}')
    readonly, initialized, zeroed = (sections[name] for name in ['.rodata', '.data', '.bss'])
    if readonly[0] != static_base or readonly[1] < 1 or initialized[1] < 1 or zeroed[1] < 1 \
            or readonly[0] + readonly[1] > initialized[0] \
            or initialized[0] + initialized[1] > zeroed[0] \
            or initialized[0] % 16 or zeroed[0] + zeroed[1] > 256 * 1024 * 1024:
        raise ValueError('The read-only and mutable memory regions overlap or have an invalid boundary.')
    return {'staticBase': static_base, 'readonlyBytes': readonly[1],
            'mutableBase': initialized[0], 'mutableEnd': zeroed[0] + zeroed[1],
            'mutableBytes': zeroed[0] + zeroed[1] - initialized[0]}
