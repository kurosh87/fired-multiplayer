"""Give the original battle dialogue its own storage on modern compilers.

The pinned game explicitly documents Brock's >300-byte defeat text overflowing
gDisplayedStringBattle into text scratch buffers and an unused sFlickerArray.
Clang removes that unused array, exposing live battle flags to the overwrite.
Reserve 1024 bytes for the display text instead: the original expansion scratch
buffer gStringVar4 is 1000 bytes, and the battle wrapper adds control bytes.
Apply to definitions AND header declarations after preprocessing. No text,
battle logic, prize formula, vendor source or cartridge format changes.
"""
import re

MARKER = 'KANTO_BATTLE_TEXT_PREPARED'
CAPACITY = 1024
DECLARATION = re.compile(r'(?m)^([ \t]*(?:extern[ \t]+)?u8[ \t]+gDisplayedStringBattle[ \t]*\[[ \t]*)(\d+)([ \t]*\])')


def prepare(source):
    if MARKER in source:
        raise ValueError('Battle text storage has already been prepared.')
    matches = list(DECLARATION.finditer(source))
    if not matches:
        return source
    if any(match[2] != '300' for match in matches):
        raise ValueError('The original battle display buffer declaration changed upstream.')
    source = DECLARATION.sub(lambda match: match[1] + str(CAPACITY) + match[3], source)
    return '#define ' + MARKER + ' 1\n' + source
