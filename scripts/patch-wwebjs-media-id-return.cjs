'use strict';

/**
 * Backport do workaround upstream observado no whatsapp-web.js#201857.
 *
 * Em alguns builds de WhatsApp Web, addAndSendMsgToChat resolve msgPromise
 * com o modelo recém-criado, mas a consulta posterior Msg.get(...) ainda não
 * encontra a mensagem. O patch usa o modelo resolvido quando ele possui ID
 * serializável e mantém a consulta da coleção como fallback limitado.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TARGET = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const SUPPORTED_VERSION = '1.34.7';
const FILE_RELATIVE = path.join('src', 'util', 'Injected', 'Utils.js');
const PATCH_START = '        const sentMsg = await msgPromise;';
const PATCH_MARKERS = [
  PATCH_START,
  '        if (sentMsg?.id?._serialized || sentMsg?.id?.$1) {',
  '            return sentMsg;',
  '        let storedMsg = window',
  '        return storedMsg;',
];

function ensureNotSymlink(input) {
  if (fs.lstatSync(input).isSymbolicLink()) throw new Error(`symlink input not allowed: ${input}`);
}

function hasCompletePatch(source, newline) {
  const required = [
    '        const sentMsg = await msgPromise;',
    '        if (options.waitUntilMsgSent) await sendMsgResultPromise;',
    '        if (sentMsg?.id?._serialized || sentMsg?.id?.$1) {',
    '            return sentMsg;',
    '        }',
    `        let storedMsg = window${newline}            .require('WAWebCollections').Msg.get(newMsgKey._serialized || newMsgKey.$1);`,
    '        if (!storedMsg) {',
    '            for (let attempt = 0; attempt < 10 && !storedMsg; attempt += 1) {',
    '                await new Promise((resolve) => setTimeout(resolve, 50));',
    `                storedMsg = window${newline}                    .require('WAWebCollections').Msg.get(newMsgKey._serialized || newMsgKey.$1);`,
    '            }',
    '        }',
    '        return storedMsg;',
  ];
  return required.every((fragment) => source.includes(fragment));
}

function applyMediaIdReturnBackport(target = DEFAULT_TARGET) {
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
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const complete = hasCompletePatch(source, newline);
  const partial = PATCH_MARKERS.some((marker) => source.includes(marker));
  if (complete) return { skipped: true };
  if (partial) throw new Error('unsupported shape: media ID return patch is partially present');

  const sendMarker = '        const [msgPromise, sendMsgResultPromise] = window';
  const awaitCall = `        await msgPromise;`;
  const waitCall = `        if (options.waitUntilMsgSent) await sendMsgResultPromise;`;
  const returnCall = `        return window${newline}            .require('WAWebCollections')${newline}            .Msg.get(newMsgKey._serialized || newMsgKey.$1);`;
  const sendIndex = source.indexOf(sendMarker);
  const awaitIndex = source.indexOf(awaitCall, sendIndex);
  const waitIndex = source.indexOf(waitCall, awaitIndex);
  const returnIndex = source.indexOf(returnCall, waitIndex);
  const sendBlock = sendIndex >= 0 ? source.slice(sendIndex, awaitIndex) : '';
  if (sendIndex < 0 || !sendBlock.includes('addAndSendMsgToChat(chat, message)') || awaitIndex < 0 || waitIndex < 0 || returnIndex < 0 || !(sendIndex < awaitIndex && awaitIndex < waitIndex && waitIndex < returnIndex)) {
    throw new Error('unsupported shape: sendMessage promise return changed');
  }

  const replacement = [
    '        const sentMsg = await msgPromise;',
    '        if (options.waitUntilMsgSent) await sendMsgResultPromise;',
    '        if (sentMsg?.id?._serialized || sentMsg?.id?.$1) {',
    '            return sentMsg;',
    '        }',
    '        let storedMsg = window',
    "            .require('WAWebCollections').Msg.get(newMsgKey._serialized || newMsgKey.$1);",
    '        if (!storedMsg) {',
    '            for (let attempt = 0; attempt < 10 && !storedMsg; attempt += 1) {',
    '                await new Promise((resolve) => setTimeout(resolve, 50));',
    '                storedMsg = window',
    "                    .require('WAWebCollections').Msg.get(newMsgKey._serialized || newMsgKey.$1);",
    '            }',
    '        }',
    '        return storedMsg;',
  ].join(newline);

  const updated = source.slice(0, awaitIndex) + replacement + source.slice(returnIndex + returnCall.length);
  if (updated === source || !hasCompletePatch(updated, newline)) {
    throw new Error('unsupported shape: no safe return patch insertion point');
  }

  const temp = `${file}.media-id-return-${process.pid}.tmp`;
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
    const result = applyMediaIdReturnBackport();
    console.log(`patch-wwebjs-media-id-return: ${result.skipped ? 'skipped (already applied)' : 'applied'}`);
  } catch (error) {
    console.error(`patch-wwebjs-media-id-return: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { applyMediaIdReturnBackport };
