import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('api_context', Path(__file__).resolve().parent.parent / 'scripts/package-api-context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


class ApiContextTest(unittest.TestCase):
    def fixture(self, root):
        for name in context.FIXED:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{}' if name.endswith('.json') else '// fixture')
        for name in ('apps/server/src/main.ts', 'packages/engine/runtime.ts'):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('export const fixture = true;')

    def test_archive_is_deterministic_and_excludes_non_runtime_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            excluded = ('.env', 'apps/web/src/main.tsx', 'packages/.env', 'packages/nested/secret.env',
                         'packages/engine/save.sav', 'packages/engine/game.wasm', 'vendor/game.gba',
                         'node_modules/fixture/index.ts', 'packages/engine/node_modules/private.ts',
                         'tests/auth-fixture.ts', 'build/checkpoint.bin')
            for name in excluded:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('excluded fixture bytes')
            first = context.package(root, root / 'first.tar')
            second = context.package(root, root / 'second.tar')
            self.assertEqual(first['sha256'], second['sha256'])
            with tarfile.open(root / 'first.tar') as archive:
                self.assertEqual(set(archive.getnames()), set(context.FIXED) | {'apps/server/src/main.ts', 'packages/engine/runtime.ts'})
                self.assertTrue(set(excluded).isdisjoint(archive.getnames()))
                self.assertTrue(all(member.isfile() and member.mode == 0o644 for member in archive))
            self.assertFalse(first['credentialsIncluded'])

    def test_symlinked_source_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            outside = root / 'outside.txt'
            outside.write_text('private fixture')
            source = root / 'packages/engine/runtime.ts'
            source.unlink()
            source.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                context.package(root, root / 'context.tar')
            self.assertFalse((root / 'context.tar').exists())

    def test_symlinked_runtime_directory_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            target = root / 'apps/server/src'
            target.rename(root / 'private-source')
            target.symlink_to(root / 'private-source', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'regular runtime directory'):
                context.sources(root)

    def test_existing_output_and_manifest_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            output = root / 'context.tar'
            context.package(root, output)
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'Preserve'):
                context.package(root, output)
            self.assertEqual(output.read_bytes(), before)
            self.assertTrue(json.loads((root / 'context.tar.manifest.json').read_text())['sha256'])

    def test_cli_preserves_a_broken_output_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            build = root / 'build'
            build.mkdir()
            output = build / 'existing.tar'
            target = build / 'new-target.tar'
            output.symlink_to(target)
            with patch.object(context, 'ROOT', root), patch('sys.argv', ['package-api-context.py', '--output', str(output)]):
                with self.assertRaisesRegex(SystemExit, 'symlink'):
                    context.main()
            self.assertTrue(output.is_symlink())
            self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
