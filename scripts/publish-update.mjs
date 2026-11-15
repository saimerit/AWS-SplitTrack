import { execFileSync } from 'node:child_process';

const [message, ...notes] = process.argv.slice(2);
if (!message) {
  console.error('Usage: node scripts/publish-update.mjs "User-facing message" "Optional note"');
  process.exit(1);
}
const changelog = [message, ...notes].join('\n- ');
execFileSync('npx', ['eas-cli@latest', 'update', '--channel', 'production', '--message', changelog], {
  cwd: new URL('../frontend/', import.meta.url),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
