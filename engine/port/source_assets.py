"""Use the original asset recipes, including generated assembly include trees."""
from pathlib import Path
import subprocess


def generate(source, c_sources, asm_sources, run, log):
    # These are explicit dependencies of map_events.o/maps.o in the upstream
    # Makefile. Missing include files are not reported by scaninc itself.
    maps = [str(path.with_name('events.inc').relative_to(source))
            for path in sorted((source / 'data/maps').glob('*/map.json'))]
    for offset in range(0, len(maps), 100):
        run(['gmake', '-j2', 'NODEP=1', 'SETUP_PREREQS=0', 'CPP=clang', *maps[offset:offset + 100]], stdout=log)
    generated = 0
    previous = None
    for iteration in range(4):
        missing = set()
        for path in c_sources + asm_sources:
            includes = ['-I', 'include']
            if path.suffix == '.s':
                includes += ['-I', '', '-I', 'sound']
            result = run(['tools/scaninc/scaninc', *includes, str(path.relative_to(source))],
                         stdout=subprocess.PIPE, text=True)
            for name in result.stdout.split():
                candidate = Path(name)
                if candidate.is_absolute() or '..' in candidate.parts or name.startswith('-'):
                    raise ValueError(f'Unexpected dependency path: {name}')
                if not (source / name).exists():
                    missing.add(name)
        if not missing:
            return generated
        if missing == previous:
            raise ValueError('Original asset recipes made no progress on missing dependencies.')
        previous = missing
        assets = sorted(missing)
        print(f'Generating {len(assets)} missing source assets (pass {iteration + 1})...', flush=True)
        for offset in range(0, len(assets), 100):
            run(['gmake', '-j2', 'NODEP=1', 'SETUP_PREREQS=0', 'CPP=clang', *assets[offset:offset + 100]], stdout=log)
        generated += len(assets)
    raise ValueError('Asset dependency expansion exceeded its expected depth.')
