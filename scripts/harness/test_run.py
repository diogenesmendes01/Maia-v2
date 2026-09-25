#!/usr/bin/env python3
"""Capture a test command without hiding its exit status or guessing counts."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def vitest_counts(path):
    """Only accept a complete, internally consistent Vitest JSON report."""
    report = json.loads(path.read_text())
    keys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']
    total, passed, failed, skipped, todo = [report[key] for key in keys]
    if any(type(n) is not int or n < 0 for n in [total, passed, failed, skipped, todo]):
        raise ValueError('invalid counters')
    if passed + failed + skipped + todo != total:
        raise ValueError('inconsistent counters')
    assertions = [case for suite in report['testResults'] for case in suite['assertionResults']]
    if len(assertions) != total:
        raise ValueError('incomplete assertions')
    statuses = [case['status'] for case in assertions]
    if (statuses.count('passed'), statuses.count('failed'),
            statuses.count('pending') + statuses.count('skipped'), statuses.count('todo')) != (passed, failed, skipped, todo):
        raise ValueError('inconsistent assertions')
    failures = [{'file': suite['name'], 'name': case['fullName'],
                 'messages': case['failureMessages']}
                for suite in report['testResults'] for case in suite['assertionResults']
                if case['status'] == 'failed']
    # Suite/import errors may exist without failed assertions.
    failures.extend({'file': suite['name'], 'name': '(suite)', 'messages': [suite['message']]}
                    for suite in report['testResults'] if suite.get('message'))
    return ({'executed': passed + failed, 'passed': passed, 'failed': failed,
             'skipped': skipped, 'todo': todo, 'total': total}, failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--parser', choices=['unknown', 'vitest-json'], default='unknown')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('command required after --')
    # Never overwrite evidence from a prior run. No shell interpolation.
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    requested_command = command.copy()
    report_path = args.out.resolve() / 'vitest.json'
    if args.parser == 'vitest-json':
        command += ['--reporter=default', '--reporter=json', '--outputFile=' + str(report_path)]
    started = time.monotonic()
    launch_error = None
    with (args.out / 'full.log').open('wb') as log:
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
            code = result.returncode
        except OSError as error:
            launch_error = type(error).__name__
            code = 127
    counts, failures, parse_error = 'unknown', 'unknown', None
    if args.parser == 'vitest-json':
        try:
            counts, failures = vitest_counts(report_path)
        except (OSError, ValueError, KeyError, TypeError) as error:
            parse_error = type(error).__name__
    coverage = 'unknown' if counts == 'unknown' else (
        'partial' if counts['skipped'] or counts['todo'] or not counts['executed'] else 'complete')
    summary = {'command': command, 'requested_command': requested_command, 'exit_code': code,
               'signal': -code if code < 0 else None,
               'duration_seconds': round(time.monotonic() - started, 3),
               'counts': counts, 'failures': failures, 'parser': args.parser,
               'parse_error': parse_error, 'coverage': coverage,
               'launch_error': launch_error,
               'full_log': str((args.out / 'full.log').resolve())}
    (args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    raise SystemExit(main())
