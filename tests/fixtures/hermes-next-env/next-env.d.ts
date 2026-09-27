// Declared compatibility fixture: Next augments NodeJS.ProcessEnv this way.
// This is not a replacement for the admin-ui's real dependency/typecheck lane.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: 'development' | 'production' | 'test';
  }
}
