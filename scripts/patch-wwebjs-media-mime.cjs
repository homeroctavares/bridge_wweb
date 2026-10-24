'use strict';
/**
 * Backport equivalente ao fix upstream #201914 para whatsapp-web.js 1.34.7.
 * #201908: sem mimetype, DownloadManager pode rejeitar imagens não cacheadas
 * como application/octet-stream e propagar a exceção minificada "t".
 * Não altera LocalAuth, IDs, Chromium, downloads externos ou políticas de mídia.
 */
const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_TARGET = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

function applyMediaMimeBackport(target = DEFAULT_TARGET) {
  const packageFile = path.join(target, 'package.json');
  const file = path.join(target, 'src', 'structures', 'Message.js');
  for (const input of [target, packageFile, path.join(target, 'src'), path.join(target, 'src', 'structures'), file]) {
    if (fs.lstatSync(input).isSymbolicLink()) throw new Error('symlink input not allowed');
  }
  const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
  if (version !== '1.34.7') throw new Error('unsupported version: review the upstream media fix before changing the pin');
  const source = fs.readFileSync(file, 'utf8');
  const calls = [...source.matchAll(/\.downloadAndMaybeDecrypt\(\{([\s\S]*?)\}\);/g)];
  if (calls.length !== 1) throw new Error('unsupported shape: expected exactly one direct DownloadManager call');
  const [call] = calls;
  const body = call[1];
  for (const field of ['directPath', 'encFilehash', 'filehash', 'mediaKey', 'mediaKeyTimestamp', 'type']) {
    if (!new RegExp(`^[ \\t]*${field}: msg\\.${field},\\r?$`, 'm').test(body)) {
      throw new Error('unsupported shape: direct DownloadManager fields changed');
    }
  }
  if (!/^[ \t]*signal: new AbortController\(\)\.signal,\r?$/m.test(body)
      || !/^[ \t]*downloadQpl: mockQpl,\r?$/m.test(body)) {
    throw new Error('unsupported shape: download controls changed');
  }
  const mimeFields = [...body.matchAll(/^[ \t]*mimetype:[^\r\n]*/gm)];
  if (mimeFields.length) {
    if (mimeFields.length !== 1 || !/^[ \t]*mimetype: msg\.mimetype,\r?$/m.test(body)) {
      throw new Error('unsupported shape: ambiguous or incorrect mimetype field');
    }
    return { skipped: true };
  }
  const updatedCall = call[0].replace(/^([ \t]*)type: msg\.type,(\r?\n)/m,
    (line, indent, newline) => `${line}${indent}mimetype: msg.mimetype,${newline}`);
  if (updatedCall === call[0]) throw new Error('unsupported shape: no safe insertion point');
  const updated = source.slice(0, call.index) + updatedCall + source.slice(call.index + call[0].length);
  // Escrever somente depois de todos os guards; rename atômico evita patch parcial.
  const temp = `${file}.media-mime-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, updated, { flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { skipped: false };
}

if (require.main === module) {
  try {
    const result = applyMediaMimeBackport();
    console.log(`patch-wwebjs-media-mime: ${result.skipped ? 'skipped (already applied)' : 'applied'}`);
  } catch (error) {
    console.error(`patch-wwebjs-media-mime: ${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { applyMediaMimeBackport };
