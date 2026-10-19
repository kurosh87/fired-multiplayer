#!/usr/bin/env python3
"""Create a deterministic server-only Docker context, without dependencies/data."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parent.parent
FIXED = ('package.json', 'package-lock.json', 'apps/server/package.json',
         'apps/web/package.json', 'infra/api.Dockerfile', 'infra/inspect-linux-runtime.ts')


def regular(root: Path, relative: str) -> Path:
    path = root / relative
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f'Refusing a symlink in runtime source: {relative}')
    if not path.is_file():
        raise ValueError(f'Missing regular runtime source: {relative}')
    return path


def sources(root: Path) -> dict[str, bytes]:
    names = set(FIXED)
    for folder in ('apps/server/src', 'packages'):
        directory = root / folder
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError(f'Missing regular runtime directory: {folder}')
        names.update(path.relative_to(root).as_posix() for path in directory.rglob('*.ts'))
    result = {}
    for name in sorted(names):
        if any(part.startswith('.') or part in ('node_modules', 'build', 'vendor', 'test-output')
               for part in Path(name).parts):
            continue
        result[name] = regular(root, name).read_bytes()
    return result


def package(root: Path, output: Path) -> dict:
    manifest = output.with_suffix(output.suffix + '.manifest.json')
    if output.exists() or output.is_symlink() or manifest.exists() or manifest.is_symlink():
        raise ValueError('Preserve existing context/evidence; choose a fresh output path.')
    files = sources(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream, tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            entry.mtime = 0
            entry.uid = entry.gid = 0
            archive.addfile(entry, io.BytesIO(data))
    report = {'archive': output.name, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
              'bytes': output.stat().st_size,
              'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
              'dependenciesIncluded': False, 'gameArtifactsIncluded': False,
              'credentialsIncluded': False, 'imageBuilt': False}
    with manifest.open('x') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    guard = Path.home() / '.local/bin/mini-build-guard'
    if guard.exists() and subprocess.run([str(guard), '--is-owned'], capture_output=True).returncode:
        raise SystemExit('Run this finite packaging job through scripts/run-local.py.')
    if args.output.is_symlink():
        raise SystemExit('Preserve an existing output symlink; choose a fresh output path.')
    output = args.output.resolve()
    build = ROOT / 'build'
    if not output.is_relative_to(build) or output.suffix != '.tar':
        raise SystemExit('Keep the .tar context in the project build directory.')
    report = package(ROOT, output)
    print(json.dumps({'context': str(output), 'sha256': report['sha256'],
                      'files': len(report['files']), 'bytes': report['bytes'], 'imageBuilt': False}))


if __name__ == '__main__':
    main()
