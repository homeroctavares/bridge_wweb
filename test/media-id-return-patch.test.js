import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { applyMediaIdReturnBackport } = require('../scripts/patch-wwebjs-media-id-return.cjs');
const installedFile = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
const installedSource = fs.readFileSync(installedFile, 'utf8');
const returnPatch = /\r?\n        const sentMsg = await msgPromise;[\s\S]*?\r?\n        return storedMsg;/;
const originalReturnBlock = `
        await msgPromise;

        if (options.waitUntilMsgSent) await sendMsgResultPromise;

        return window
            .require('WAWebCollections')
            .Msg.get(newMsgKey._serialized || newMsgKey.$1);`;
const unpatchedSource = installedSource.replace(returnPatch, originalReturnBlock);

function withTree(run, source = unpatchedSource, version = '1.34.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-media-id-return-'));
  const file = path.join(root, 'src/util/Injected/Utils.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(file, source);
  try { return run(root, file); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function extractReturnBlock(source) {
  const start = source.indexOf('        const [msgPromise, sendMsgResultPromise] = window');
  const end = source.indexOf('\n    };', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

async function runReturnBlock(source, { sentMessage, storedMessages = [], waitUntilMsgSent = false } = {}) {
  const block = extractReturnBlock(source);
  const messages = [...storedMessages];
  let collectionLookups = 0;
  const window = {
    require(name) {
      if (name === 'WAWebSendMsgChatAction') {
        return {
          addAndSendMsgToChat() {
            return [Promise.resolve(sentMessage), Promise.resolve()];
          },
        };
      }
      if (name === 'WAWebCollections') {
        return {
          Msg: {
            get() {
              collectionLookups += 1;
              return messages.shift();
            },
          },
        };
      }
      throw new Error(`unexpected module: ${name}`);
    },
  };
  const context = { window, chat: {}, message: {}, options: { waitUntilMsgSent }, newMsgKey: { _serialized: 'fixture-key' }, setTimeout };
  const result = await vm.runInNewContext(`(async () => {\n${block}\n})()`, context);
  return { result, collectionLookups };
}

test('prioriza msgPromise quando o modelo possui ID e mantém Msg.get como fallback', () => {
  withTree((root, file) => {
    const result = applyMediaIdReturnBackport(root);
    assert.equal(result.skipped, false);
    const patched = fs.readFileSync(file, 'utf8');
    assert.match(patched, /const sentMsg = await msgPromise;/);
    assert.match(patched, /if \(sentMsg\?\.id\?\._serialized \|\| sentMsg\?\.id\?\.\$1\)/);
    assert.match(patched, /return sentMsg;/);
    assert.match(patched, /let storedMsg = window[\s\S]*Msg\.get\(newMsgKey\._serialized \|\| newMsgKey\.\$1\)/);
    assert.match(patched, /for \(let attempt = 0; attempt < 10 && !storedMsg; attempt \+= 1\)/);
    assert.ok(patched.indexOf('const sentMsg = await msgPromise;') < patched.indexOf('return sentMsg;'));
    assert.ok(patched.indexOf('return sentMsg;') < patched.indexOf('let storedMsg'));
  });
});

test('executa retorno direto com _serialized, $1, fallback atrasado e sem falso sucesso', async () => {
  const patched = fs.readFileSync(installedFile, 'utf8');
  const serialized = { id: { _serialized: 'serialized-id' } };
  const dollarOne = { id: { $1: 'dollar-one-id' } };
  const directSerialized = await runReturnBlock(patched, { sentMessage: serialized });
  assert.equal(directSerialized.result, serialized);
  assert.equal(directSerialized.collectionLookups, 0);
  const directDollarOne = await runReturnBlock(patched, { sentMessage: dollarOne, waitUntilMsgSent: true });
  assert.equal(directDollarOne.result, dollarOne);
  assert.equal(directDollarOne.collectionLookups, 0);
  const delayed = { id: { _serialized: 'delayed-id' } };
  const fallback = await runReturnBlock(patched, { sentMessage: {}, storedMessages: [undefined, undefined, delayed] });
  assert.equal(fallback.result, delayed);
  assert.equal(fallback.collectionLookups, 3);
  const noId = await runReturnBlock(patched, { sentMessage: {}, storedMessages: [] });
  assert.equal(noId.result, undefined);
  assert.equal(noId.collectionLookups, 11);
});

test('segunda aplicação é idempotente e preserva CRLF', () => {
  withTree((root, file) => {
    fs.writeFileSync(file, unpatchedSource.replace(/\r?\n/g, '\r\n'));
    assert.equal(applyMediaIdReturnBackport(root).skipped, false);
    const before = fs.readFileSync(file);
    assert.equal(applyMediaIdReturnBackport(root).skipped, true);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.match(before.toString(), /const sentMsg = await msgPromise;\r\n/);
  });
});

test('bloqueia versão desconhecida antes de modificar o arquivo', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaIdReturnBackport(root), /unsupported version/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource, '9.9.9');
});

test('bloqueia shape divergente antes de modificar o arquivo', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaIdReturnBackport(root), /unsupported shape/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource.replace('            .addAndSendMsgToChat(chat, message);', '            .changedSendCall(chat, message);'));
});

test('falha fechado para cada forma de aplicação parcial', () => {
  const partials = [
    `${unpatchedSource}\n        const sentMsg = await msgPromise;\n`,
    unpatchedSource.replace('            .addAndSendMsgToChat(chat, message);', '            .addAndSendMsgToChat(chat, message);\n        const sentMsg = await msgPromise;\n        if (sentMsg?.id?._serialized || sentMsg?.id?.$1) {\n            return sentMsg;\n        }'),
    unpatchedSource.replace('            .addAndSendMsgToChat(chat, message);', '            .addAndSendMsgToChat(chat, message);\n        const sentMsg = await msgPromise;\n        return sentMsg;'),
  ];
  for (const partial of partials) {
    withTree((root, file) => {
      const before = fs.readFileSync(file);
      assert.throws(() => applyMediaIdReturnBackport(root), /partially present/);
      assert.deepEqual(fs.readFileSync(file), before);
    }, partial);
  }
});
