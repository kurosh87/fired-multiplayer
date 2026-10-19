#!/usr/bin/env python3
"""Fetch the exact source revision under the local machine's build policy."""
import hashlib
import argparse
import io
import json
import posixpath
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
GUARD = Path.home() / '.local/bin/mini-build-guard'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', choices=['firered', 'nativeFireRedReference', 'emeraldReference',
                                              'agbccReference', 'mgbaReference'], default='firered')
    args = parser.parse_args()
    if GUARD.exists() and subprocess.run([str(GUARD), '--is-owned'], capture_output=True).returncode:
        return subprocess.run([str(GUARD), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]).returncode
    locked = json.loads((ROOT / 'engine/upstream.lock.json').read_text())[args.reference]
    directory, budget = {
        'firered': ('pokefirered', 64 * 1024 * 1024),
        'nativeFireRedReference': ('pokefirered-native', 128 * 1024 * 1024),
        'emeraldReference': ('pokeemerald-wasm', 128 * 1024 * 1024),
        'agbccReference': ('agbcc', 64 * 1024 * 1024),
        'mgbaReference': ('mgba', 128 * 1024 * 1024),
    }[args.reference]
    target = ROOT / 'vendor' / directory
    marker = target / '.kanto-source.json'
    if marker.exists():
        if json.loads(marker.read_text())['commit'] != locked['commit']:
            raise SystemExit('Existing source belongs to a different revision. Preserve it and choose a separate source path.')
        print('Pinned source is already present.')
        return 0
    if target.exists() and any(target.iterdir()):
        raise SystemExit('Refusing to overwrite an existing source directory.')
    url = f"https://codeload.github.com/{locked['repository']}/tar.gz/{locked['commit']}"
    request = urllib.request.Request(url, headers={'User-Agent': 'kanto-online-source-bootstrap'})
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = response.read(budget + 1)
    if len(archive) > budget:
        raise SystemExit('Source archive exceeds its expected size budget.')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        members = source.getmembers()
        by_name = {member.name: member for member in members}
        materialized = {}
        if sum(member.size for member in members) > budget:
            raise SystemExit('Expanded source exceeds its expected size budget.')
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or member.islnk():
                raise SystemExit('Unsafe path in source archive.')
            if member.issym():
                # Materialize an internal regular file instead of creating a
                # filesystem symlink. No absolute, escaping or chained links.
                link = PurePosixPath(member.linkname)
                resolved = PurePosixPath(posixpath.normpath(str(path.parent / link)))
                linked = by_name.get(str(resolved))
                if link.is_absolute() or not resolved.parts or resolved.parts[0] != path.parts[0] \
                        or linked is None or not linked.isfile():
                    raise SystemExit('Unsafe source archive link: ' + member.name)
                materialized[member.name] = linked
            elif not member.isfile() and not member.isdir():
                raise SystemExit('Unsupported archive member.')
        target.mkdir(parents=True, exist_ok=True)
        for member in members:
            relative = PurePosixPath(*PurePosixPath(member.name).parts[1:])
            if not relative.parts:
                continue
            output = target.joinpath(*relative.parts)
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                original = materialized.get(member.name, member)
                with source.extractfile(original) as data:
                    output.write_bytes(data.read())
                output.chmod(original.mode & 0o755)
    marker.write_text(json.dumps({**locked, 'archiveSha256': hashlib.sha256(archive).hexdigest()}, indent=2) + '\n')
    print(f"Fetched {locked['repository']} at {locked['commit']} into {target}")
    instructions = list(target.rglob('AGENTS.md'))
    if instructions:
        print('Read upstream instructions before editing: ' + ', '.join(str(path) for path in instructions))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
