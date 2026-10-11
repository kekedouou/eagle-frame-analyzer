'use strict';

// T0 read-only adapter: capture one click's Eagle selection, never watch the
// library or retain a mutable Eagle Item. No Eagle mutation API is used here.
const path = require('path');
function responseType(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function selectionError(code, message, diagnostics) {
  const error = new Error(message); error.code = code;
  error.diagnostics = { ...diagnostics, failureCode: code };
  return error;
}
function validateSnapshot(value) {
  const diagnostics = { stage: 'snapshot-validation', itemType: responseType(value) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw selectionError('SELECTION_ITEM_TYPE', '选中 API 的单个素材不是有效 Item。', diagnostics);
  let id, filePath, name, declaredExt;
  try {
    // Official Item instances expose prototype getters, not necessarily own fields.
    // Read each field once, then retain only plain immutable values.
    id = value.id; filePath = value.filePath; name = value.name; declaredExt = value.ext;
  } catch (error) {
    throw selectionError('SELECTION_ITEM_ACCESS_ERROR', '读取选中 Item 属性失败：' + String(error && error.message || error).slice(0, 512), diagnostics);
  }
  diagnostics.fieldTypes = { id: typeof id, filePath: typeof filePath, name: typeof name, ext: typeof declaredExt };
  if (typeof id !== 'string' || !id.trim()) throw selectionError('SELECTION_ID_INVALID', '选中视频缺少 Eagle 素材 ID。', diagnostics);
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath) || filePath.includes('\0')) throw selectionError('SELECTION_PATH_INVALID', '选中视频缺少有效的本地绝对路径。', diagnostics);
  const ext = declaredExt == null ? 'mp4' : String(declaredExt).replace(/^\./, '').toLowerCase();
  if (ext !== 'mp4' || path.extname(filePath).toLowerCase() !== '.mp4') throw selectionError('SELECTION_NOT_MP4', 'T0 当前选择只支持 MP4 视频。', diagnostics);
  return Object.freeze({ id, itemId: id, name: typeof name === 'string' && name.trim() ? name : path.basename(filePath), filePath: path.resolve(filePath), ext: 'mp4' });
}
function captureSelected(eagleApi, options = {}) {
  const diagnostics = { schema: 'eva-t0-selection-diagnostic-v1', method: 'eagle.item.getSelected',
    contract: 'Promise<Item[]>', attempts: 0, stage: 'api-check', response: null };
  const publish = () => {
    if (typeof options.onDiagnostic !== 'function') return;
    try { options.onDiagnostic(Object.freeze({ ...diagnostics,
      response: diagnostics.response ? Object.freeze({ ...diagnostics.response }) : null })); }
    catch (_) { diagnostics.observerError = true; }
  };
  const rejected = (code, message, detail) => {
    Object.assign(diagnostics, detail || {}, { failureCode: code }); publish();
    return selectionError(code, message, diagnostics);
  };
  let itemApi, method, response;
  try {
    itemApi = eagleApi && eagleApi.item; method = itemApi && itemApi.getSelected;
  } catch (error) { return Promise.reject(rejected('SELECTION_API_UNAVAILABLE', '读取 Eagle 选中 API 失败：' + String(error && error.message || error).slice(0, 512))); }
  if (typeof method !== 'function') return Promise.reject(rejected('SELECTION_API_UNAVAILABLE', '当前环境没有 Eagle 选中素材读取 API。'));
  // Invoke immediately, before the caller's serial load/cancel/dispose queue.
  // Preserve the official receiver and use exactly this one API, without fallback.
  diagnostics.stage = 'api-call'; diagnostics.attempts = 1;
  try { response = method.call(itemApi); }
  catch (error) { return Promise.reject(rejected('SELECTION_API_SYNC_ERROR', 'Eagle 选中 API 调用失败：' + String(error && error.message || error).slice(0, 512))); }
  return Promise.resolve(response).then(items => {
    diagnostics.stage = 'response';
    diagnostics.response = { type: responseType(items), count: Array.isArray(items) ? items.length : null }; publish();
    if (!Array.isArray(items)) throw rejected('SELECTION_RESPONSE_TYPE', 'Eagle 选中 API 返回类型异常（' + diagnostics.response.type + '）；没有将它当作未选择。');
    if (items.length === 0) throw rejected('SELECTION_EMPTY', 'Eagle 选中 API 返回 0 个素材。请在主素材列表中单选 MP4 后重新读取。');
    if (items.length !== 1) throw rejected('SELECTION_MULTIPLE', '当前选中了多个素材，请只选中一个 MP4 视频。');
    diagnostics.stage = 'snapshot-validation';
    let snapshot;
    try { snapshot = validateSnapshot(items[0]); }
    catch (error) {
      if (error && error.code) {
        const detail = error.diagnostics || {};
        throw rejected(error.code, error.message, { itemType: detail.itemType, fieldTypes: detail.fieldTypes });
      }
      throw rejected('SELECTION_ITEM_ACCESS_ERROR', '读取选中 Item 失败：' + String(error && error.message || error).slice(0, 512));
    }
    diagnostics.stage = 'captured'; publish(); return snapshot;
  }, error => { throw rejected('SELECTION_API_ASYNC_ERROR', 'Eagle 选中 API 异步失败：' + String(error && error.message || error).slice(0, 512), { stage: 'api-await' }); });
}
module.exports = { captureSelected, validateSnapshot };
