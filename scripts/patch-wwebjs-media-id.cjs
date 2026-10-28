'use strict';

/**
 * Backport do fix upstream whatsapp-web.js#201923 para 1.34.7.
 *
 * WhatsApp Web passou a expor MediaData.__x_id como propriedade enumerável.
 * Ao espalhar mediaOptions no objeto outbound, esse campo pode sobrescrever
 * o id legítimo da Msg e impedir que Client.sendMessage devolva a mensagem.
 * O patch remove somente esse campo privado depois da composição do objeto.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TARGET = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const SUPPORTED_VERSION = '1.34.7';
const FILE_RELATIVE = path.join('src', 'util', 'Injected', 'Utils.js');
const BOT_COMMENT = "// Bot's won't reply if canonicalUrl is set (linking)";
const PATCH_COMMENT = "        // MediaData is a model whose private __x_id field collides with Msg's";
const PATCH_START = '        if (message.__x_id) {';
const PATCH_MARKER = '            delete message.__x_id;';

function ensureNotSymlink(input) {
  if (fs.lstatSync(input).isSymbolicLink()) throw new Error(`symlink input not allowed: ${input}`);
}

function applyMediaIdBackport(target = DEFAULT_TARGET) {
  const packageFile = path.join(target, 'package.json');
  const sourceRoot = path.join(target, 'src');
  const injectedRoot = path.join(sourceRoot, 'util', 'Injected');
  const file = path.join(target, FILE_RELATIVE);
  for (const input of [target, packageFile, sourceRoot, path.join(sourceRoot, 'util'), injectedRoot, file]) {
    ensureNotSymlink(input);
  }

  const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`unsupported version: expected whatsapp-web.js ${SUPPORTED_VERSION}, got ${version}`);
  }

  const source = fs.readFileSync(file, 'utf8');
  const hasPatchComment = source.includes(PATCH_COMMENT);
  const hasPatchStart = source.includes(PATCH_START);
  const hasPatchMarker = source.includes(PATCH_MARKER);
  if (hasPatchComment || hasPatchStart || hasPatchMarker) {
    if (hasPatchComment && hasPatchStart && hasPatchMarker) return { skipped: true };
    throw new Error('unsupported shape: media ID patch is partially present');
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const messageStart = source.indexOf(`        const message = {${newline}`);
  const botCommentIndex = source.indexOf(`${newline}        ${BOT_COMMENT}`, messageStart);
  const messageEnd = source.indexOf(`${newline}        };`, messageStart);
  if (messageStart < 0 || messageEnd < 0 || botCommentIndex < 0 || messageEnd > botCommentIndex) {
    throw new Error('unsupported shape: outbound message composition changed');
  }

  const messageBlock = source.slice(messageStart, messageEnd);
  if (!messageBlock.includes(`${newline}            ...mediaOptions,`) ||
      !messageBlock.includes(`${newline}            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),`)) {
    throw new Error('unsupported shape: media options composition changed');
  }

  const patch = [
    '',
    '        // MediaData is a model whose private __x_id field collides with Msg\'s',
    '        // internal id field when its enumerable properties are spread above,',
    '        // breaking getValidatedSender() during Msg initialization.',
    '        if (message.__x_id) {',
    '            delete message.__x_id;',
    '        }',
  ].join(newline);
  const updated = source.slice(0, botCommentIndex) + patch + source.slice(botCommentIndex);
  if (updated === source || !updated.includes(PATCH_MARKER)) {
    throw new Error('unsupported shape: no safe patch insertion point');
  }

  // Escrever somente depois de todos os guards; rename atômico evita patch parcial.
  const temp = `${file}.media-id-${process.pid}.tmp`;
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
    const result = applyMediaIdBackport();
    console.log(`patch-wwebjs-media-id: ${result.skipped ? 'skipped (already applied)' : 'applied'}`);
  } catch (error) {
    console.error(`patch-wwebjs-media-id: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { applyMediaIdBackport };
