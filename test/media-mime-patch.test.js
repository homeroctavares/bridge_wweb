import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { applyMediaMimeBackport } = require('../scripts/patch-wwebjs-media-mime.cjs');
const Message = require('whatsapp-web.js/src/structures/Message.js');
const installedSource = fs.readFileSync(require.resolve('whatsapp-web.js/src/structures/Message.js'), 'utf8');
const unpatchedSource = installedSource.replace(/\r?\n[ \t]*mimetype: msg\.mimetype,(?=\r?\n[ \t]*signal:)/g, '');

function withTree(run, source = unpatchedSource, version = '1.34.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-media-mime-patch-'));
  const file = path.join(root, 'src/structures/Message.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(file, source);
  try { return run(root, file); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('aplica somente o MIME ao DownloadManager e preserva o restante da biblioteca', () => {
  withTree((root, file) => {
    assert.equal(applyMediaMimeBackport(root).skipped, false);
    const patched = fs.readFileSync(file, 'utf8');
    assert.match(patched, /type: msg\.type,\s+mimetype: msg\.mimetype,\s+signal:/);
    assert.equal(patched.replace(/\r?\n[ \t]*mimetype: msg\.mimetype,(?=\r?\n[ \t]*signal:)/g, ''), unpatchedSource);
  });
});

test('segunda aplicação é idempotente e aceita CRLF', () => {
  withTree((root, file) => {
    applyMediaMimeBackport(root);
    const before = fs.readFileSync(file);
    assert.equal(applyMediaMimeBackport(root).skipped, true);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource.replace(/\r?\n/g, '\r\n'));
});

test('bloqueia versão desconhecida antes de modificar o arquivo', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaMimeBackport(root), /unsupported version/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource, '9.9.9');
});

test('bloqueia shape divergente antes de escrever', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaMimeBackport(root), /unsupported shape/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource.replace('type: msg.type,', 'type: changed.type,'));
});

test('não aceita duas chamadas ambíguas ao DownloadManager', () => {
  withTree((root, file) => {
    const before = fs.readFileSync(file);
    assert.throws(() => applyMediaMimeBackport(root), /unsupported shape/);
    assert.deepEqual(fs.readFileSync(file), before);
  }, unpatchedSource + '\nconst duplicate = x.downloadAndMaybeDecrypt({type: msg.type});\n');
});

for (const mime of ['image/jpeg', 'image/png', 'audio/ogg', 'video/mp4']) {
  test(`callback real de downloadMedia repassa ${mime} sem tráfego externo`, async () => {
    const msg = {
      mediaData: { mediaStage: 'RESOLVED' },
      directPath: 'fixture-only', encFilehash: 'fixture-only', filehash: 'fixture-only',
      mediaKey: 'fixture-only', mediaKeyTimestamp: 1,
      type: mime.split('/')[0], mimetype: mime, filename: 'fixture.bin', size: 3,
    };
    let calls = 0;
    const window = {
      require(name) {
        if (name === 'WAWebCollections') return { Msg: { get: () => msg } };
        assert.equal(name, 'WAWebDownloadManager');
        return { downloadManager: { async downloadAndMaybeDecrypt(options) {
          calls += 1;
          // Reproduz a condição do upstream que rejeita MIME ausente.
          if (options.mimetype !== mime) throw new Error('t');
          assert.equal(options.type, msg.type);
          assert.ok(options.downloadQpl);
          return new Uint8Array([1, 2, 3]).buffer;
        } } };
      },
      WWebJS: { async arrayBufferToBase64Async(data) { return Buffer.from(data).toString('base64'); } },
    };
    const media = await Message.prototype.downloadMedia.call({
      hasMedia: true,
      id: { _serialized: 'isolated-fixture' },
      client: { pupPage: { async evaluate(fn, id) {
        return vm.runInNewContext(`(${fn.toString()})(msgId)`, { window, AbortController, msgId: id });
      } } },
    });
    assert.equal(calls, 1);
    assert.equal(media.mimetype, mime);
    assert.equal(media.data, 'AQID');
  });
}
