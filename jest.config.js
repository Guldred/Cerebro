/** Unit tests for the pure, safety-critical logic (no DB required).
 *  The DB-backed integration check is `npm run eval`, gated in CI. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
