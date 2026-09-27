import { expect, test } from 'vitest';

test('executes a passing case', () => expect(2).toBe(2));
test('controlled failure for wrapper evidence', () => {
  expect(process.env.HARNESS_FIXTURE_FAIL).not.toBe('1');
});
test.skip('explicit skip is not coverage', () => {});
test.todo('explicit todo is not execution');
