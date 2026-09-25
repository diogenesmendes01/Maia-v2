import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/harness/project_env.py'


class ProjectEnvironmentTests(unittest.TestCase):
    def environment(self):
        return {'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'],
                'TMPDIR': os.environ.get('TMPDIR', '/nonexistent'),
                'HARNESS_PG_HOST': '127.0.0.1', 'HARNESS_PG_PORT': '65432',
                'HARNESS_PG_USER': 'sandbox', 'HARNESS_CARD_DATABASE': 'card_fixture',
                'DATABASE_URL': 'postgres://sandbox:fixtureonly@127.0.0.1:65432/card_fixture',
                'TEST_DB_URL': 'postgres://sandbox:fixtureonly@127.0.0.1:65432/card_fixture',
                'HARNESS_REDIS_PORT': '65431', 'HARNESS_REDIS_DB': '3',
                'REDIS_URL': 'redis://127.0.0.1:65431/3',
                'MAIA_ENV': 'production', 'ANTHROPIC_API_KEY': 'SHOULD_NOT_INHERIT',
                'DOTENV_CONFIG_OVERRIDE': 'true', 'NODE_OPTIONS': '--invalid-flag'}

    def test_scrubs_inherited_production_and_pins_test_destinations(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--', sys.executable,
                                 '-c', 'import os,json; print(json.dumps(dict(os.environ)))'],
                                env=self.environment(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        env = json.loads(result.stdout)
        self.assertEqual(env['NODE_ENV'], 'test')
        self.assertEqual(env['DOTENV_CONFIG_PATH'], '/dev/null')
        self.assertEqual(env['TEST_WORKTREE_SCOPE'], 'off')
        self.assertEqual(env['DATABASE_URL'], env['TEST_DB_URL'])
        for forbidden in ['MAIA_ENV', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'DOTENV_CONFIG_OVERRIDE']:
            self.assertNotIn(forbidden, env)

    def test_rejects_wrong_or_missing_endpoints_before_command(self):
        for key, value in [('DATABASE_URL', 'postgres://prod.example/production'),
                           ('TEST_DB_URL', ''), ('HARNESS_PG_PORT', ''),
                           ('REDIS_URL', 'redis://127.0.0.1:6379/0')]:
            with self.subTest(key=key):
                env = self.environment()
                env[key] = value
                result = subprocess.run([sys.executable, str(SCRIPT), '--', sys.executable,
                                         '-c', 'print("EXECUTED")'], env=env,
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('EXECUTED', result.stdout)
                self.assertNotIn('fixtureonly', result.stderr)


if __name__ == '__main__':
    unittest.main()
