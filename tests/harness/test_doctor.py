"""Subprocess acceptance: external executables are controlled boundary fixtures."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import time


def load_doctor():
    spec = importlib.util.spec_from_file_location('doctor', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/harness/doctor.py'


class DoctorTests(unittest.TestCase):
    def test_simultaneous_github_postgres_failure_continues_to_disk(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], env={
            'PATH': '/nonexistent', 'HOME': '/nonexistent',
        }, capture_output=True, text=True)
        lines = result.stdout.splitlines()
        self.assertEqual([line.split()[1].rstrip(':') for line in lines],
                         ['uid', 'node', 'worktree', 'github', 'postgres', 'disk'])
        self.assertTrue(lines[3].startswith('FALHA github:'))
        self.assertTrue(lines[4].startswith('FALHA postgres:'))
        self.assertTrue(lines[5].startswith('FALHA disk:'))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')

    def boundary_run(self, script):
        with tempfile.TemporaryDirectory() as temp:
            for name in ('gh', 'psql'):
                target = Path(temp) / name
                target.write_text('#!' + sys.executable + '\n' + script)
                target.chmod(0o700)
            env = {'PATH': temp, 'HARNESS_PG_HOST': '127.0.0.1',
                   'HARNESS_PG_PORT': '65432', 'HARNESS_PG_USER': 'sandbox',
                   'HARNESS_PG_DATABASE': 'postgres', 'HARNESS_DISK_PATHS': temp}
            started = time.monotonic()
            result = subprocess.run([sys.executable, str(SCRIPT)], env=env,
                                    capture_output=True, text=True, timeout=8)
            return result, time.monotonic() - started

    def test_two_real_probe_failures_are_sanitized_and_disk_runs(self):
        result, _ = self.boundary_run('import sys\nprint("SECRET_FROM_PROBE", file=sys.stderr)\nsys.exit(3)\n')
        self.assertIn('FALHA github: probe recusado\n', result.stdout)
        self.assertIn('FALHA postgres: probe recusado\n', result.stdout)
        self.assertTrue(result.stdout.endswith('OK disk\n'))
        self.assertNotIn('SECRET', result.stdout + result.stderr)
        self.assertEqual(result.returncode, 1)

    def test_real_process_timeouts_are_bounded_and_continue(self):
        result, duration = self.boundary_run('import time\ntime.sleep(10)\n')
        self.assertIn('FALHA github: timeout\n', result.stdout)
        self.assertIn('FALHA postgres: timeout\n', result.stdout)
        self.assertTrue(result.stdout.endswith('OK disk\n'))
        self.assertLess(duration, 5)
        self.assertEqual(result.returncode, 1)

    def test_unexpected_exception_is_sanitized_and_all_checks_continue(self):
        doctor = load_doctor()
        output = io.StringIO()
        with patch.object(doctor, 'uid', side_effect=RuntimeError('SECRET')), \
             patch.object(doctor, 'node'), patch.object(doctor, 'worktree'), \
             patch.object(doctor, 'github'), patch.object(doctor, 'postgres'), \
             patch.object(doctor, 'disk'), redirect_stdout(output):
            self.assertEqual(doctor.main(), 1)
        self.assertEqual(output.getvalue().splitlines(), [
            'FALHA uid: erro inesperado: RuntimeError', 'OK node', 'OK worktree',
            'OK github', 'OK postgres', 'OK disk'])

    def test_aggregate_exit_zero_only_when_every_check_passes(self):
        doctor = load_doctor()
        with patch.object(doctor, 'uid'), patch.object(doctor, 'node'), \
             patch.object(doctor, 'worktree'), patch.object(doctor, 'github'), \
             patch.object(doctor, 'postgres'), patch.object(doctor, 'disk'), redirect_stdout(io.StringIO()):
            self.assertEqual(doctor.main(), 0)

    def test_postgres_role_failure_still_reaches_disk(self):
        result, _ = self.boundary_run('from pathlib import Path\nimport sys\nprint("f" if Path(sys.argv[0]).name == "psql" else "")\n')
        self.assertIn('OK github\n', result.stdout)
        self.assertIn('FALHA postgres: papel requer CREATEDB NOSUPERUSER NOCREATEROLE\n', result.stdout)
        self.assertTrue(result.stdout.endswith('OK disk\n'))
        self.assertEqual(result.returncode, 1)

    def test_disk_threshold_checks_each_configured_storage(self):
        doctor = load_doctor()
        from types import SimpleNamespace
        with patch.dict(os.environ, {'HARNESS_DISK_PATHS': '/:/usr'}), \
             patch.object(doctor.os, 'statvfs', side_effect=[
                 SimpleNamespace(f_blocks=100, f_bavail=80),
                 SimpleNamespace(f_blocks=100, f_bavail=20)]) as stat:
            with self.assertRaises(doctor.Failure):
                doctor.disk()
            self.assertEqual(stat.call_count, 2)

    def test_uid_rejects_root(self):
        doctor = load_doctor()
        with patch.object(doctor.os, 'getuid', return_value=0):
            with self.assertRaises(doctor.Failure):
                doctor.uid()

    def test_worktree_accepts_external_linked_tree_but_not_main_checkout(self):
        doctor = load_doctor()
        with tempfile.TemporaryDirectory() as temp:
            repo, tree = Path(temp) / 'repo', Path(temp) / 'outside'
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Fixture', '-c',
                            'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], check=True)
            subprocess.run(['git', '-C', str(repo), 'worktree', 'add', '-q', '--detach', str(tree)], check=True)
            previous = Path.cwd()
            try:
                with patch.dict(os.environ, {'HARNESS_REPO': str(repo)}):
                    os.chdir(tree)
                    doctor.worktree()
                    os.chdir(repo)
                    with self.assertRaises(doctor.Failure):
                        doctor.worktree()
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
