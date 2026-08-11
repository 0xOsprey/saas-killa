import { execFileSync } from 'node:child_process';
import { clearMailbox } from './mailbox';

/**
 * Reset to the seeded fixture before the suite. The pipeline test asserts on
 * counts and on an empty schedule grid, so it needs a known starting state
 * rather than whatever the last manual poke around left behind.
 */
export default function globalSetup() {
  clearMailbox();
  execFileSync('pnpm', ['db:reset'], { stdio: 'inherit' });
}
