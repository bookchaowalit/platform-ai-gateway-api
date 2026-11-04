import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The image copies api/ modules one by one; a module the service imports but the Dockerfile
// leaves out passes every test here and only fails the Railway build (2026-11-04).
test('the Dockerfile copies every api/ module the service bundle imports', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const dir = file.slice(0, file.lastIndexOf('/'));
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
      const parts = `${dir}/${spec}.ts`.split('/');
      const out: string[] = [];
      for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
      visit(out.join('/'));
    }
  };
  visit('api/ai-gateway-service/main.ts');
  for (const file of seen) assert.ok(dockerfile.includes(file), `${file} is not copied in the Dockerfile`);
});
