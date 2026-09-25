// Deliberately independent of Maia globalSetup: never opens DB/Redis.
export default {
  test: {
    include: ['tests/harness/fixtures/*.test.mjs'],
    retry: 0,
    maxWorkers: 1,
    fileParallelism: false,
  },
};
