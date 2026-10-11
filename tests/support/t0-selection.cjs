'use strict';

// T0 read-only adapter: capture one click's Eagle selection, never watch the
// library or retain a mutable Eagle Item. No Eagle mutation API is used here.
const path = require('path');
function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要本次选中视频的快照。');
  const id = value.id, filePath = value.filePath, name = value.name, declaredExt = value.ext;
  if (typeof id !== 'string' || !id.trim()) throw new Error('选中视频缺少 Eagle 素材 ID。');
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('选中视频缺少有效的本地绝对路径。');
  const ext = declaredExt == null ? 'mp4' : String(declaredExt).replace(/^\./, '').toLowerCase();
  if (ext !== 'mp4' || path.extname(filePath).toLowerCase() !== '.mp4') throw new Error('T0 当前选择只支持 MP4 视频。');
  return Object.freeze({ id, itemId: id, name: typeof name === 'string' && name.trim() ? name : path.basename(filePath), filePath: path.resolve(filePath), ext: 'mp4' });
}
function captureSelected(eagleApi) {
  try {
    if (!eagleApi || !eagleApi.item || typeof eagleApi.item.getSelected !== 'function') throw new Error('当前环境没有 Eagle 选中素材读取 API。');
    // Invoke immediately, before the caller's serial load/cancel/dispose queue.
    const response = eagleApi.item.getSelected();
    return Promise.resolve(response).then(items => {
      if (!Array.isArray(items) || items.length === 0) throw new Error('请先在 Eagle 中选中一个 MP4 视频。');
      if (items.length !== 1) throw new Error('当前选中了多个素材，请只选中一个 MP4 视频。');
      return validateSnapshot(items[0]);
    });
  } catch (error) { return Promise.reject(error); }
}
module.exports = { captureSelected, validateSnapshot };
