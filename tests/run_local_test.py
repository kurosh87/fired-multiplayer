"""Exercise the task-local guard wrapper's real SIGTERM/child-cleanup path.

The fixture guard starts one tiny sleeping child. It does not acquire or alter
the machine guard, environment markers, user HOME or resource policy.
"""
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class LocalRunnerTests(unittest.TestCase):
    def test_imported_guard_receives_sigterm_and_cleans_up_its_child(self):
        with tempfile.TemporaryDirectory(prefix='kanto-runner-signal-') as directory:
            fixture = Path(directory)
            guard = fixture / '.local/bin/mini-build-guard'
            guard.parent.mkdir(parents=True)
            guard.write_text('''import os, signal, subprocess, sys
GIB = 1024**3
STOP_FREE = 20 * GIB
START_FREE = 30 * GIB
def interrupted(signum, frame):
    raise KeyboardInterrupt
def main(args):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
    try:
        print('owned-child:' + str(child.pid), flush=True)
        child.wait()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=5)
    return 0
''')
            bootstrap = '''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('local_runner', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixture = pathlib.Path(sys.argv[2])
module.Path.home = classmethod(lambda cls: fixture)
raise SystemExit(module.main(['--allow-low-disk', '--min-free-gib', '2', '--', 'unused-fixture-command']))
'''
            process = subprocess.Popen([sys.executable, '-B', '-c', bootstrap, str(ROOT / 'scripts/run-local.py'), str(fixture)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            child_pid = None
            try:
                # Read one byte at a time to avoid buffered readline/select races.
                with selectors.DefaultSelector() as ready:
                    ready.register(process.stdout, selectors.EVENT_READ)
                    data = b''
                    while b'owned-child:' not in data or not data.endswith(b'\n'):
                        self.assertTrue(ready.select(timeout=5), 'Fixture child did not start.')
                        byte = os.read(process.stdout.fileno(), 1)
                        self.assertTrue(byte, 'Fixture guard exited before starting its child.')
                        data += byte
                    child_pid = int(data.decode().split('owned-child:')[1].strip())
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 130, (stdout, stderr))
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                child_pid = None
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
                if child_pid is not None:
                    try:
                        os.killpg(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
