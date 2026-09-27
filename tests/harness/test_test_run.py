import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/harness/test_run.py'


class TestRunTests(unittest.TestCase):
    def test_original_exit_command_and_full_log_with_unknown_counts(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'evidence'
            command = [sys.executable, '-c',
                       'import sys; print("out"); print("err", file=sys.stderr); sys.exit(7)']
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence),
                                     '--', *command], capture_output=True, text=True)
            self.assertEqual(result.returncode, 7)
            summary = json.loads((evidence / 'summary.json').read_text())
            self.assertEqual(summary['command'], command)
            self.assertEqual(summary['exit_code'], 7)
            self.assertEqual(summary['counts'], 'unknown')
            self.assertEqual(summary['failures'], 'unknown')
            log = (evidence / 'full.log').read_text()
            self.assertIn('out\n', log)
            self.assertIn('err\n', log)

    def test_vitest_json_counts_include_skips_and_failure_details(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'evidence'
            report = {'numTotalTests': 3, 'numPassedTests': 1, 'numFailedTests': 1,
                      'numPendingTests': 1, 'numTodoTests': 0,
                      'testResults': [{'name': 'fixture.spec.ts', 'assertionResults': [
                          {'fullName': 'passes', 'status': 'passed', 'failureMessages': []},
                          {'fullName': 'fails', 'status': 'failed', 'failureMessages': ['expected 1 to be 2']},
                          {'fullName': 'skips', 'status': 'pending', 'failureMessages': []}]}]}
            source = ('import json,sys; from pathlib import Path; '
                      'Path(sys.argv[-1].split("=",1)[1]).write_text(' + repr(json.dumps(report)) + '); sys.exit(1)')
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence),
                                     '--parser', 'vitest-json', '--', sys.executable, '-c', source],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            summary = json.loads((evidence / 'summary.json').read_text())
            self.assertEqual(summary['counts'], {'executed': 2, 'passed': 1, 'failed': 1,
                                                'skipped': 1, 'todo': 0, 'total': 3})
            self.assertEqual(summary['failures'][0]['name'], 'fails')
            self.assertEqual(summary['failures'][0]['messages'], ['expected 1 to be 2'])
            self.assertEqual(summary['coverage'], 'partial')

    def test_malformed_or_missing_report_never_invents_counts_or_masks_exit(self):
        for source, expected in [('pass', 0),
                                 ('import sys; from pathlib import Path; Path(sys.argv[-1].split("=",1)[1]).write_text("{}"); sys.exit(9)', 9)]:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temp:
                evidence = Path(temp) / 'evidence'
                result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence),
                                         '--parser', 'vitest-json', '--', sys.executable, '-c', source],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, expected)
                summary = json.loads((evidence / 'summary.json').read_text())
                self.assertEqual(summary['counts'], 'unknown')
                self.assertEqual(summary['failures'], 'unknown')
                self.assertIsNotNone(summary['parse_error'])

    def test_signal_preserves_raw_status_and_shell_convention(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'evidence'
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence), '--',
                                     sys.executable, '-c', 'import os,signal; os.kill(os.getpid(),signal.SIGTERM)'],
                                    capture_output=True, text=True)
            summary = json.loads((evidence / 'summary.json').read_text())
            self.assertEqual(result.returncode, 143)
            self.assertEqual(summary['exit_code'], -15)
            self.assertEqual(summary['signal'], 15)

    def test_launch_error_is_distinct_from_test_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'evidence'
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence),
                                     '--', '/no/such/command'], capture_output=True, text=True)
            summary = json.loads((evidence / 'summary.json').read_text())
            self.assertEqual(result.returncode, 127)
            self.assertEqual(summary['launch_error'], 'FileNotFoundError')
            self.assertEqual(summary['counts'], 'unknown')

    def test_full_log_is_not_truncated(self):
        with tempfile.TemporaryDirectory() as temp:
            evidence = Path(temp) / 'evidence'
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', str(evidence), '--',
                                     sys.executable, '-c', 'print("x" * 1048576)'], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual((evidence / 'full.log').stat().st_size, 1048577)

    def test_existing_evidence_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'summary.json'
            target.write_text('original')
            result = subprocess.run([sys.executable, str(SCRIPT), '--out', temp, '--',
                                     sys.executable, '-c', 'pass'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_text(), 'original')


if __name__ == '__main__':
    unittest.main()
