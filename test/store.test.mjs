import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';

function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-store-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('a handled offset survives reopening with private file modes', () => sandbox(root => {
  const path = join(root, 'data');
  const store = openStore(path);
  store.state.offset = 42;
  store.save();
  assert.equal(openStore(path).state.offset, 42);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(path, 'state.json')).mode & 0o777, 0o600);
}));
test('state temporary-file symlinks cannot overwrite external files', () => sandbox(root => {
  const path = join(root, 'data');
  mkdirSync(path);
  const external = join(root, 'external');
  writeFileSync(external, 'unchanged');
  symlinkSync(external, join(path, 'state.tmp'));
  assert.throws(() => openStore(path).save());
  assert.equal(readFileSync(external, 'utf8'), 'unchanged');
}));
test('data and state symlinks are rejected', () => sandbox(root => {
  const external = join(root, 'external');
  mkdirSync(external);
  symlinkSync(external, join(root, 'data'));
  assert.throws(() => openStore(join(root, 'data')));
  mkdirSync(join(root, 'real'));
  const externalFile = join(root, 'external-file');
  writeFileSync(externalFile, '{}');
  symlinkSync(externalFile, join(root, 'real', 'state.json'));
  assert.throws(() => openStore(join(root, 'real')));
}));
