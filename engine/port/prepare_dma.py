"""Route the original DMA helper macros through the checked portable controller."""
import re

ORIGINAL = {
    'DmaSet': ('DmaSet(dmaNum, src, dest, control)', '''{
        vu32 *dmaRegs = (vu32 *)REG_ADDR_DMA##dmaNum;
        dmaRegs[0] = (vu32)(src);
        dmaRegs[1] = (vu32)(dest);
        dmaRegs[2] = (vu32)(control);
        dmaRegs[2];
    }'''),
    'DmaStop': ('DmaStop(dmaNum)', '''{
        vu16 *dmaRegs = (vu16 *)REG_ADDR_DMA##dmaNum;
        dmaRegs[5] &= ~(DMA_START_MASK | DMA_DREQ_ON | DMA_REPEAT);
        dmaRegs[5] &= ~DMA_ENABLE;
        dmaRegs[5];
    }'''),
}
MAPPED = {
    'DmaSet': ('do { KantoDmaSet((dmaNum), (const void *)(src), '
               '(void *)(dest), (uint32_t)(control)); } while (0)'),
    'DmaStop': 'do { KantoDmaStop((dmaNum)); } while (0)',
}


def normalize(text):
    return re.sub(r'\s+', '', text.replace('\\\n', ''))


def prepare(source):
    if 'kanto_dma.h' in source:
        raise ValueError('Source has already been prepared.')
    lines = source.splitlines(keepends=True)
    found = set()
    output = []
    i = 0
    while i < len(lines):
        match = re.match(r'#define\s+(DmaSet|DmaStop)\(', lines[i])
        if not match:
            output.append(lines[i])
            i += 1
            continue
        name = match[1]
        if name in found:
            raise ValueError(f'Duplicate {name} definition.')
        found.add(name)
        block = lines[i]
        while lines[i].rstrip().endswith('\\'):
            i += 1
            if i == len(lines):
                raise ValueError(f'Unterminated {name} definition.')
            block += lines[i]
        signature, body = ORIGINAL[name]
        if normalize(block) != normalize('#define ' + signature + body):
            raise ValueError(f'{name} changed upstream; review its transfer semantics.')
        output.append('#define ' + signature + ' ' + MAPPED[name] + '\n')
        i += 1
    if found != set(ORIGINAL):
        raise ValueError('Expected both original DMA helper macros.')
    return ('#ifndef KANTO_WASM\n'
            '#error This generated header is for the WASM port only.\n'
            '#endif\n#include "kanto_dma.h"\n' + ''.join(output))
