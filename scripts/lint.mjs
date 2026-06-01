import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const files = globSync('**/*.{ts,tsx,js,mjs,css,md,json,yml,yaml}', {
  exclude: ['node_modules/**', 'dist/**', 'coverage/**', '.agents/**', 'package-lock.json']
});
const failures = [];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (/\r\n/.test(content)) {
    failures.push(`${file}: uses CRLF line endings`);
  }
  content.split('\n').forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      failures.push(`${file}:${index + 1}: trailing whitespace`);
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Lint passed for ${files.length} files.`);
