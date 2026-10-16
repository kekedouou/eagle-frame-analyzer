'use strict';
// Storage layout only: JPEG bytes and source PTS remain unchanged. No I/O.
const FILE = 'frames.pack', BATCH_BYTES = 1024 ** 2;
function validate(info, limit) {
  const pack = info.framePack;
  if (pack === undefined) {
    if (info.frames.some(f => f.offset !== undefined)) throw Error('未声明图片包却包含帧偏移。');
    return null;
  }
  if (!pack || Object.keys(pack).sort().join(',') !== 'bytes,file,schema,sha256' || pack.schema !== 1 || pack.file !== FILE || !Number.isSafeInteger(pack.bytes) || pack.bytes <= 0 || pack.bytes > limit || !/^[0-9a-f]{64}$/.test(pack.sha256))
    throw Error('图片包版本、长度或内容指纹无效。');
  let offset = 0; const names = new Set([FILE, 'owner.json', 'manifest.json', 'writer.lock', 'transaction.log']);
  if (info.audio) names.add(info.audio.file);
  for (const frame of info.frames) {
    if (typeof frame.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(frame.file) || names.has(frame.file) ||
        !Number.isSafeInteger(frame.bytes) || frame.bytes <= 0 || !/^[0-9a-f]{64}$/.test(frame.sha256) || frame.offset !== offset || !Number.isSafeInteger(offset + frame.bytes))
      throw Error('图片包帧目录重复、越界或不连续。');
    names.add(frame.file); offset += frame.bytes;
  }
  if (offset !== pack.bytes) throw Error('图片包长度与全部帧目录不符。');
  return pack;
}
module.exports = { FILE, BATCH_BYTES, validate };
