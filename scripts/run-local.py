#!/usr/bin/env python3
"""Run a finite job with the local resource guard when present.

--allow-low-disk is an explicit operator override for the startup reserve.
--min-free-gib additionally changes this invocation's emergency floor when the
operator has authorized continuing despite storage issues. The shared lease,
memory/swap checks and per-job growth budget remain in force. No global policy
or retained files are changed.
"""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import signal
import sys


def main(args):
    low_disk = args[:1] == ['--allow-low-disk']
    if low_disk:
        args = args[1:]
    minimum = None
    if args[:1] == ['--min-free-gib']:
        try:
            minimum = float(args[1])
        except (IndexError, ValueError):
            raise SystemExit('--min-free-gib requires a value between 1 and 20.') from None
        if not low_disk or not 1 <= minimum <= 20:
            raise SystemExit('--min-free-gib requires --allow-low-disk and a value between 1 and 20.')
        args = args[2:]
    offset = 2 if args[:1] == ['--wait-for-slot'] else 0
    if len(args) < offset + 2 or args[offset] != '--':
        raise SystemExit('Usage: run-local.py [--allow-low-disk [--min-free-gib N]] [--wait-for-slot SECONDS] -- COMMAND [ARGS]')
    path = Path.home() / '.local/bin/mini-build-guard'
    if not path.exists():
        os.execvp(args[offset + 1], args[offset + 1:])
    if not low_disk:
        os.execv(str(path), [str(path), *args])
    sys.path.insert(0, str(path.parent))
    loader = importlib.machinery.SourceFileLoader('kanto_session_guard', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    guard = importlib.util.module_from_spec(spec)
    loader.exec_module(guard)
    if minimum is not None:
        guard.STOP_FREE = int(minimum * 1024 ** 3)
    guard.START_FREE = guard.STOP_FREE
    print(f'Using user-authorized task-local disk reserve: {guard.STOP_FREE / 1024 ** 3:g} GiB. Shared lease and memory/growth checks remain active.', flush=True)
    # Importing the guard does not run its __main__ signal setup. Preserve its
    # normal SIGTERM -> KeyboardInterrupt -> owned-child cleanup path here too.
    signal.signal(signal.SIGTERM, guard.interrupted)
    try:
        return guard.main(args)
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
