'use strict';

// Only this adapter calls Eagle item/comment APIs. Never write library files.
const path = require('path');
const fs = require('fs');
function responseType(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function selectionError(code, message, diagnostics) {
  const error = new Error(message); error.code = code;
  error.diagnostics = { ...diagnostics, failureCode: code };
  return error;
}
function toolError(code, message) { const error = new Error(message); error.code = code; return error; }
async function discoverTools(eagleApi, options = {}) {
  const io = options.fs || fs;
  let module, installed, paths;
  try {
    module = eagleApi && eagleApi.extraModule && eagleApi.extraModule.ffmpeg;
    if (!module || typeof module.isInstalled !== 'function' || typeof module.getPaths !== 'function')
      throw toolError('TOOLS_API_UNAVAILABLE', '当前 Eagle 没有可用的 FFmpeg 工具读取接口。');
    // Public SDK wraps its internal module in asynchronous IPC calls. Await
    // both forms, preserving the receiver; never install or write to Eagle.
    installed = await module.isInstalled.call(module);
    if (installed === false) throw toolError('TOOLS_MISSING', 'Eagle 尚未安装 FFmpeg 模块，请先在 Eagle 中准备该模块后重试。');
    if (installed !== true) throw toolError('TOOLS_RESPONSE_INVALID', 'Eagle FFmpeg 安装状态返回异常。');
    paths = await module.getPaths.call(module);
  } catch (error) {
    if (error && error.code && String(error.code).startsWith('TOOLS_')) throw error;
    throw toolError('TOOLS_API_FAILED', '读取 Eagle FFmpeg 工具失败：' + String(error && error.message || error).slice(0, 512));
  }
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) throw toolError('TOOLS_RESPONSE_INVALID', 'Eagle FFmpeg 路径返回异常。');
  const result = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    let value;
    try { value = paths[name]; }
    catch (error) { throw toolError('TOOLS_PATH_INVALID', '读取 ' + name + ' 工具路径失败：' + String(error && error.message || error).slice(0, 512)); }
    if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value))
      throw toolError('TOOLS_PATH_INVALID', name + ' 缺少有效的本地绝对路径。');
    const absolute = path.resolve(value);
    try {
      const stat = io.lstatSync(absolute);
      const canonical = io.realpathSync(absolute);
      const same = process.platform === 'win32' ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute;
      if (!stat.isFile() || stat.isSymbolicLink() || !same)
        throw new Error('不是普通文件，或路径经过链接');
    } catch (error) { throw toolError('TOOLS_FILE_INVALID', name + ' 工具文件不可用：' + String(error && error.message || error).slice(0, 512)); }
    result[name] = absolute;
  }
  return Object.freeze(result);
}
function createEagleAdapter(eagleApi, options = {}) {
  return Object.freeze({ captureSelected: settings => captureSelected(eagleApi, settings),
    discoverTools: () => discoverTools(eagleApi, options),
    readComments: (source, context) => readComments(eagleApi, source, context, options),
    saveComment: (proposal, settings) => saveComment(eagleApi, proposal, settings, options),
    verifyComment: attempt => verifyComment(eagleApi, attempt, options) });
}

function commentError(code, message) { const error = new Error(message); error.code = code; return error; }
function commentDeadline(work, options) {
  const ms = options.commentTimeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(commentError('COMMENT_TIMEOUT', 'Eagle标注响应超时。')), ms);
    Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function libraryPath(api) {
  const value = api && api.library && api.library.path;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw commentError('COMMENT_LIBRARY_UNAVAILABLE', '无法确认当前素材库，标注操作已停止。');
  return path.resolve(value);
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function guardLibrary(api, expected) {
  const current = libraryPath(api);
  if (expected && !samePath(current, expected)) throw commentError('COMMENT_LIBRARY_CHANGED', '素材库已变化，不能向原提案保存标注。');
  return current;
}
function cloneComments(value) {
  if (!Array.isArray(value)) throw commentError('COMMENTS_INVALID', 'Eagle标注返回异常，未将它当作空列表。');
  const ids = new Set();
  return Object.freeze(value.map(item => {
    const id = item && item.id, time = item && item.duration, text = item && item.annotation;
    if (typeof id !== 'string' || !id || ids.has(id) || !Number.isFinite(time) || time < 0 || typeof text !== 'string')
      throw commentError('COMMENTS_INVALID', 'Eagle标注缺少可靠的ID、时间或文字，已停止添加。');
    ids.add(id); return Object.freeze({ id, time, text });
  }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)));
}
async function commentItem(api, source, expectedLibrary, options) {
  const selected = validateSnapshot(source), context = guardLibrary(api, expectedLibrary);
  if (!api.item || typeof api.item.getById !== 'function') throw commentError('COMMENTS_API_UNAVAILABLE', '当前Eagle没有标注读取接口。');
  const item = await commentDeadline(api.item.getById(selected.id), options);
  guardLibrary(api, context);
  const actual = validateSnapshot(item);
  if (actual.id !== selected.id || !samePath(actual.filePath, selected.filePath))
    throw commentError('COMMENT_IDENTITY_CHANGED', '素材身份或路径已变化，标注操作已停止。');
  return { item, libraryPath: context };
}
async function readComments(api, source, context = {}, options = {}) {
  const result = await commentItem(api, source, context.libraryPath, options);
  return Object.freeze({ libraryPath: result.libraryPath, items: cloneComments(result.item.comments) });
}
function matchAttempt(attempt, data) {
  const candidates = data.items.filter(item => !attempt.beforeIds.includes(item.id) &&
    (!attempt.returnedId || item.id === attempt.returnedId) && item.text === attempt.text && Math.abs(item.time - attempt.time) <= .001);
  return candidates.length === 1 ? { status: 'saved', commentId: candidates[0].id, items: data.items, attempt,
    message: '已保存。' } : { status: 'unknown', attempt,
    message: '保存结果尚未确认。文字已保留，请先核对，勿重复添加；关闭会丢失本次输入。' };
}
async function verifyComment(api, attempt, options = {}) {
  try { return matchAttempt(attempt, await readComments(api, attempt.source, { libraryPath: attempt.libraryPath }, options)); }
  catch (error) { return { status: 'unknown', attempt, message: '无法核对保存结果：' + error.message }; }
}
async function saveComment(api, proposal, settings = {}, options = {}) {
  let attempt = null;
  try {
    if (!proposal || typeof proposal.text !== 'string' || !proposal.text.trim() || !Number.isFinite(proposal.time) || proposal.time < 0)
      throw commentError('COMMENT_PROPOSAL_INVALID', '请填写标注文字，并确认固定的画面时间。');
    const result = await commentItem(api, proposal.source, proposal.libraryPath, options), before = cloneComments(result.item.comments);
    if (typeof result.item.addComment !== 'function') throw commentError('COMMENT_WRITE_UNAVAILABLE', '当前Eagle没有时间点标注添加接口。');
    guardLibrary(api, proposal.libraryPath);
    if (settings.isCurrent && !settings.isCurrent()) throw commentError('COMMENT_SUPERSEDED', '原提案已失效，未发送标注。');
    attempt = Object.freeze({ source: Object.freeze({ ...proposal.source }), libraryPath: result.libraryPath,
      time: proposal.time, text: proposal.text, frameId: proposal.frameId, beforeIds: Object.freeze(before.map(item => item.id)), returnedId: null });
    // The callback records dispatch intent before the mutating call. No await
    // may appear between the final guards and that call.
    if (settings.onIssued) settings.onIssued(attempt);
    // Observers can synchronously switch/close during that notification.
    try {
      guardLibrary(api, proposal.libraryPath);
      if (settings.isCurrent && !settings.isCurrent()) throw commentError('COMMENT_SUPERSEDED', '原提案已失效，未发送标注。');
    } catch (error) { attempt = null; throw error; }
    let returned;
    try { returned = await commentDeadline(result.item.addComment({ duration: attempt.time, annotation: attempt.text }), options); }
    catch (_) { /* A rejected IPC response can follow a committed write. Read back. */ }
    if (returned && typeof returned.id === 'string' && returned.id)
      attempt = Object.freeze({ ...attempt, returnedId: returned.id });
    // Fetch a NEW Item, not the instance the SDK just mutated internally.
    return await verifyComment(api, attempt, options);
  } catch (error) {
    return { status: attempt ? 'unknown' : 'failed', attempt, message: error.message || '标注操作失败，文字已保留。' };
  }
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
  if (ext !== 'mp4' || path.extname(filePath).toLowerCase() !== '.mp4') throw selectionError('SELECTION_NOT_MP4', '当前选择只支持 MP4 视频。', diagnostics);
  return Object.freeze({ id, itemId: id, name: typeof name === 'string' && name.trim() ? name : path.basename(filePath), filePath: path.resolve(filePath), ext: 'mp4' });
}
function captureSelected(eagleApi, options = {}) {
  const diagnostics = { schema: 'eva-selection-diagnostic-v1', method: 'eagle.item.getSelected',
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
module.exports = { createEagleAdapter, captureSelected, validateSnapshot, discoverTools };
