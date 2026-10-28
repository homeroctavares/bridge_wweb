import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { applyMediaIdBackport } = require('../scripts/patch-wwebjs-media-id.cjs');
const installedFile = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
const installedSource = fs.readFileSync(installedFile, 'utf8');
const patchBlock = /\r?\n        \/\/ MediaData is a model whose private __x_id field collides with Msg's\r?\n        \/\/ internal id field when its enumerable properties are spread above,\r?\n        \/\/ breaking getValidatedSender\(\) during Msg initialization\.\r?\n        if \(message\.__x_id\) \{\r?\n            delete message\.__x_id;\r?\n        \}/;
const unpatchedSource = installedSource.replace(patchBlock, '');

function withTree(run, source = unpatchedSource, version = '1.34.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-media-id-patch-'));
  const file = path.join(root, 'src/util/Injected/Utils.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(file, source);
  try { return run(root, file); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('remove a colisão __x_id sem alterar as opções documentais ou a citação', () => {
  withTree((root, file) => {
    const result = applyMediaIdBackport(root);
    assert.equal(result.skipped, false);
    const patched = fs.readFileSync(file, 'utf8');
    assert.equal(patched.replace(patchBlock, ''), unpatchedSource);
    assert.ok(patched.indexOf('...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),') < patched.indexOf('delete message.__x_id;'));
    assert.ok(patched.indexOf('delete message.__x_id;') < patched.indexOf("// Bot's won't reply"));

    // Fixture local do mesmo shape usado pelo envio de documento citado; não acessa WhatsApp.
    const mediaOptions = {
      __x_id: 'media-private-id',
      mediaHandle: 'fixture-media-handle',
      toJSON() { return { mimetype: 'application/pdf', filename: 'fixture.pdf' }; },
    };
    const options = {
      sendMediaAsDocument: true,
      quotedMessageId: 'quoted-fixture-id',
    };
    const newMsgKey = { _serialized: 'outgoing-fixture-id' };
    const message = {
      ...options,
      id: newMsgKey,
      ...mediaOptions,
      ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
    };
    if (message.__x_id) delete message.__x_id;
    assert.equal(message.__x_id, undefined);
    assert.equal(message.id, newMsgKey);
    assert.equal(message.sendMediaAsDocument, true);
    assert.equal(message.quotedMessageId, 'quoted-fixture-id');
    assert.equal(message.mimetype, 'application/pdf');
    assert.equal(message.filename, 'fixture.pdf');
  });
});

test('segunda aplicação é idempotente e preserva CRLF', () => {
  withTree((root, file) => {
    const crlfSource = unpatchedSource.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(file, crlfSource);
    assert.equal(applyMediaIdBackport(root).skipped, false);
    const before = fs.readFileSync(file);
    assert.equal(applyMediaIdBackport(root).skipped, true);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.match(before.toString(), /delete message\.__x_id;\r\n/);
  });
});

test('bloqueia versão desconhecida antes de modificar o arquivo', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaIdBackport(root), /unsupported version/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource, '9.9.9');
});

test('bloqueia shape divergente antes de modificar o arquivo', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaIdBackport(root), /unsupported shape/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource.replace('            ...mediaOptions,', '            ...changedMediaOptions,'));
});

test('falha fechado se detectar patch parcial', () => {
  const partial = `${unpatchedSource}\n        if (message.__x_id) {\n`;
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaIdBackport(root), /partially present/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, partial);
});
