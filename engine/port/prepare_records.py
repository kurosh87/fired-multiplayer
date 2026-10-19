"""Preserve agbcc Thumb's 32-bit minimum record size/alignment in clang.

The matching compiler defines STRUCTURE_SIZE_BOUNDARY=32 (gcc/thumb.h).
Its stor-layout.c exempts explicitly packed records. Apply after preprocessing
so nested/header/local records all use the same ABI without editing vendors.
"""
import re

MARKER = 'KANTO_RECORD_ABI_PREPARED'
TOKEN = re.compile(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[A-Za-z_]\w*|[^\s]', re.S)


def prepare(source):
    if MARKER in source:
        raise ValueError('Record ABI has already been prepared.')
    tokens = [m for m in TOKEN.finditer(source) if not m.group().startswith(('/*', '//'))]
    stack, pairs = [], {}
    for i, token in enumerate(tokens):
        if token.group() in ('{', '('):
            stack.append(i)
        elif token.group() in ('}', ')'):
            if not stack:
                raise ValueError('Unbalanced preprocessed C.')
            opening = stack.pop()
            if (tokens[opening].group(), token.group()) not in (('{', '}'), ('(', ')')):
                raise ValueError('Mismatched preprocessed C delimiters.')
            pairs[opening] = i
    if stack:
        raise ValueError('Unbalanced preprocessed C.')

    def attributes(i):
        start = i
        while i < len(tokens) and tokens[i].group() in ('__attribute__', '__attribute'):
            i += 1
            if tokens[i].group() != '(':
                raise ValueError('Unexpected record attribute.')
            i = pairs[i] + 1
        return i, ' '.join(t.group() for t in tokens[start:i])

    edits = []
    for i, token in enumerate(tokens):
        if token.group() not in ('struct', 'union'):
            continue
        j, prefix = attributes(i + 1)
        if re.fullmatch(r'[A-Za-z_]\w*', tokens[j].group()):
            j += 1
        j, more = attributes(j)
        if tokens[j].group() != '{':
            continue  # A reference, not a definition.
        end = pairs[j]
        _, suffix = attributes(end + 1)
        if re.search(r'\b(__packed__|packed)\b', prefix + more + suffix):
            continue
        edits.append(tokens[end].end())
    for position in reversed(sorted(edits)):
        source = source[:position] + ' __attribute__((aligned(4)))' + source[position:]
    return '#define ' + MARKER + ' 1\n' + source
