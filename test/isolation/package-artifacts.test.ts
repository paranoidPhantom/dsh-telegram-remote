import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { projectRoot } from "../project-root.js";

// Exercise the same archive-policy functions as the standalone pack verifier.
// Real archive/import/child checks run via scripts/verify-package.mjs after build.
test("package verifier rejects unsafe archives and literal secrets without regex false positives", () => {
  const verifier = new URL("scripts/verify-package.mjs", projectRoot).href;
  const source = `
    import assert from 'node:assert/strict';
    import { validateArchivePaths, assertSafeText } from ${JSON.stringify(verifier)};
    assert.equal(validateArchivePaths(['package/index.js', 'package/dist/index.d.ts']).size, 2);
    for (const name of [
      '../outside', 'package/../outside', '/package/index.js',
      'package/dist/../../outside', 'package/dist/./index.js',
      'package/src/index.ts', 'package/test/fixture.js',
      'package/node_modules/dependency/index.js', 'package/.cache/data.js',
      'package/.env', 'package/.env.production', 'package/.credentials.yaml',
      'package/debug.log', 'package/archive.tgz', 'package/bot/index.js',
      'package/dist/.env', 'package/dist/credentials.js',
    ]) assert.throws(() => validateArchivePaths([name]), undefined, name);
    assert.throws(() => validateArchivePaths(['package/index.js', 'package/index.js']));
    const token = '123456789:' + 'A'.repeat(35);
    assert.throws(() => assertSafeText(token, 'fixture'));
    for (const path of ['/Users/person/private', '/home/person/private', String.raw\`C:\\Users\\person\\private\`]) {
      assert.throws(() => assertSafeText(path, 'fixture'));
    }
    assertSafeText(String.raw\`/\\d{6,12}:[A-Za-z0-9_-]{30,50}/\`, 'regex documentation');
    assertSafeText('telegram-console/bot and https://api.telegram.org/bot', 'identifiers');
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
