/* 实验 A：不用第三方依赖。文件上半部可在 Node 中检查；下半部须在 Eagle 内运行。 */
(() => {
  'use strict';
  const ROOT = 'D:\\documents\\Codex\\2026-10-09\\files-pasted-by-the-user-0\\outputs\\eagle-window-poc-a';
  function oneMP4(items) {
    if (!Array.isArray(items) || items.length !== 1) throw new Error('请只选中一个专用测试 MP4。');
    const item = items[0];
    if (!item || String(item.ext).toLowerCase() !== 'mp4' || !item.id || !item.filePath)
      throw new Error('选择结果不是具有 ID 和文件路径的 MP4。');
    return item;
  }
  function seconds(value, duration) {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '')
      throw new Error('请输入秒数。');
    const time = Number(value);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time) || time < 0 || time > duration)
      throw new Error('时间必须在已加载视频的 0～总时长之间。');
    return time;
  }
  function points(comments, duration) {
    if (!Array.isArray(comments)) throw new Error('comments 不是数组；请检查实际 API/Build。');
    return comments.filter(c => c && typeof c.duration === 'number' && Number.isFinite(c.duration)
      && c.duration >= 0 && (!Number.isFinite(duration) || c.duration <= duration))
      .slice().sort((a, b) => a.duration - b.duration);
  }
  function mediaURL(item) {
    const value = item.fileURL || require('url').pathToFileURL(item.filePath).href;
    const url = new URL(value);
    if (url.protocol !== 'file:') throw new Error('素材 URL 必须是本地 file URL。');
    const actual = require('url').fileURLToPath(url);
    if (require('path').resolve(actual).toLowerCase() !== require('path').resolve(item.filePath).toLowerCase())
      throw new Error('fileURL 与 filePath 不一致；停止加载，保留证据。');
    return url.href;
  }
  function sameItem(a, b) { return !!a && !!b && a.itemId === b.id && a.filePath === b.filePath; }
  function checkGrant(grant, proposal, item, playback, attempted) {
    if (!grant || !proposal || grant.allowAdd !== true || !/^[a-f0-9]{16}$/.test(proposal.proposalId)
      || ['proposalId', 'itemId', 'filePath', 'seconds', 'annotation'].some(k => grant[k] !== proposal[k]))
      throw new Error('没有与此提案完全匹配的写入授权。');
    if (!sameItem(proposal, item) || attempted) throw new Error('素材不匹配，或此提案已经尝试写入。');
    if (!playback.paused || playback.seeking || !Number.isFinite(playback.currentTime)
      || Math.abs(playback.currentTime - proposal.seconds) > 0.001)
      throw new Error('播放器必须暂停并保持在获准时间；请重新定位。');
    seconds(proposal.seconds, playback.duration);
  }
  const helpers = { oneMP4, seconds, points, mediaURL, checkGrant };
  if (typeof document === 'undefined') { module.exports = helpers; return; }

  const $ = id => document.getElementById(id);
  const video = $('video');
  const state = { ready: false, busy: false, generation: 0, item: null, comments: [],
    proposal: null, grant: null, receipt: null, events: [], seekTarget: null,
    session: new Date().toISOString().replace(/[:.]/g, '-'), loadedAt: null };
  let fs, path, crypto;
  function status(message, error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
  function log(event, data = {}) {
    state.events.push({ at: new Date().toISOString(), source: 'window-plugin', event, data });
    if (state.events.length > 300) state.events.shift();
    $('log').textContent = JSON.stringify(state.events.slice(-10), null, 2);
  }
  function evidencePath(name) {
    if (!state.ready || !/^[a-zA-Z0-9_.-]+\.json$/.test(name)) throw new Error('无效的实验输出位置。');
    const dir = path.join(ROOT, 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    const relative = path.relative(fs.realpathSync(ROOT), fs.realpathSync(dir));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('证据目录不能指向实验目录外。');
    const target = path.join(dir, name);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('拒绝写入符号链接。');
    return target;
  }
  function save(name, data, exclusive = false) {
    fs.writeFileSync(evidencePath(name), JSON.stringify(data, null, 2), { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' });
  }
  function optionalJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function snapshot() {
    return { schema: 1, session: state.session, exportedAt: new Date().toISOString(), source: 'actual-window-plugin',
      runtime: { node: process.versions.node, chrome: process.versions.chrome, platform: process.platform },
      item: state.item && { id: state.item.id, name: state.item.name, filePath: state.item.filePath, fileURL: state.item.fileURL },
      loadedAt: state.loadedAt, comments: state.comments, proposal: state.proposal, receipt: state.receipt,
      playback: { currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused, seeking: video.seeking, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight },
      observations: { source: 'user-entered-not-automatically-verified', seekPicture: $('seekObservation').value,
        nativeImmediate: $('nativeImmediate').value, nativeReopen: $('nativeReopen').value }, events: state.events };
  }
  function attempted() {
    return !!state.proposal && fs.existsSync(evidencePath(`attempt-${state.proposal.proposalId}.json`));
  }
  function controls() {
    const active = state.ready && !state.busy;
    const loaded = active && !!state.item;
    const playable = loaded && Number.isFinite(video.duration) && video.duration > 0;
    $('load').disabled = !active; $('export').disabled = !active;
    $('refresh').disabled = !loaded;
    for (const id of ['seconds', 'seek', 'timeline', 'prepare']) $(id).disabled = !playable;
    $('approval').disabled = !active || !state.proposal;
    $('add').disabled = true; $('remove').disabled = true;
    if (playable && state.proposal && state.grant) {
      try { checkGrant(state.grant, state.proposal, state.item, video, attempted()); $('add').disabled = false; } catch (_) {}
      $('remove').disabled = !(state.grant.allowRemove === true && state.receipt && !state.receipt.removed
        && state.receipt.comment && state.receipt.comment.id && sameItem(state.receipt, state.item));
    }
  }
  async function run(stage, action) {
    if (state.busy) return;
    state.busy = true; controls();
    try { await action(); }
    catch (error) { log('error', { stage, message: error.message, code: error.code || null }); status(`${stage}失败：${error.message}`, true); }
    finally { state.busy = false; controls(); }
  }
  function invalidate() {
    state.generation++; video.pause(); video.removeAttribute('src'); video.load();
    state.item = null; state.comments = []; state.proposal = null; state.grant = null; state.receipt = null;
    state.seekTarget = null; state.loadedAt = null;
    $('item').textContent = '尚未读取素材'; $('comments').textContent = '尚未读取标注';
    $('markers').replaceChildren(); $('proposal').textContent = '未准备；未授权';
    $('time').textContent = '0.000 / 未加载'; $('timeline').value = '0';
    for (const id of ['seekObservation', 'nativeImmediate', 'nativeReopen']) $(id).selectedIndex = 0;
    controls();
  }
  function renderComments() {
    $('markers').replaceChildren(); $('comments').replaceChildren();
    const valid = points(state.comments, video.duration);
    const info = document.createElement('p');
    info.textContent = `API 返回 ${state.comments.length} 条；有效时间点 ${valid.length} 条。其余条目保留在证据中，不修改。`;
    $('comments').append(info);
    for (const comment of valid) {
      const button = document.createElement('button');
      button.textContent = `${comment.duration.toFixed(3)}s · ${comment.annotation || '无文字'}`;
      button.addEventListener('click', () => run('标注定位', () => seek(comment.duration, 'comment', comment.id)));
      $('comments').append(button);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const marker = document.createElement('button'); marker.textContent = '▼'; marker.title = button.textContent;
        marker.style.left = `${100 * comment.duration / video.duration}%`;
        marker.addEventListener('click', () => button.click()); $('markers').append(marker);
      }
    }
  }
  function seek(value, source, commentId = null) {
    if (!state.item) throw new Error('没有已加载素材。');
    const target = seconds(value, video.duration); video.pause();
    state.seekTarget = { requested: target, source, commentId, at: new Date().toISOString() };
    log('seek-request', state.seekTarget); video.currentTime = target;
    status('已请求定位；请结合 seeked 日志与实际画面判断结果。');
  }
  async function freshItem() {
    const item = state.item, generation = state.generation;
    if (!item) throw new Error('请先读取素材。');
    const fresh = await eagle.item.getById(item.id);
    if (generation !== state.generation || !fresh || fresh.id !== item.id || fresh.filePath !== item.filePath)
      throw new Error('素材或素材库已变化，停止当前操作。');
    return fresh;
  }
  async function refreshComments() {
    const item = await freshItem();
    if (!Array.isArray(item.comments)) throw new Error('comments 不可用或不是数组；不会当成空标注。');
    state.comments = JSON.parse(JSON.stringify(item.comments)); renderComments();
    log('comments-readback', { itemId: item.id, comments: state.comments });
  }
  async function loadSelected() {
    invalidate(); const generation = state.generation;
    const item = oneMP4(await eagle.item.getSelected());
    if (generation !== state.generation) throw new Error('读取期间素材库变化，请重试读取。');
    const url = mediaURL(item); const stat = fs.statSync(item.filePath);
    if (!stat.isFile()) throw new Error('filePath 不是文件。');
    state.item = item; state.loadedAt = new Date().toISOString();
    const info = { id: item.id, name: item.name, filePath: item.filePath, fileURL: url, bytes: stat.size,
      api: { comments: Array.isArray(item.comments), addComment: typeof item.addComment === 'function',
        updateComment: typeof item.updateComment === 'function', removeComment: typeof item.removeComment === 'function' } };
    $('item').textContent = JSON.stringify(info, null, 2); log('selected-file', info);
    video.src = url; video.load();
    if (!Array.isArray(item.comments)) throw new Error('视频已提交加载，但 comments 不可用；请保存证据。');
    state.comments = JSON.parse(JSON.stringify(item.comments)); renderComments();
    log('comments-initial', { comments: state.comments }); status('素材读取完成；等待视频加载，请播放并检查画面。');
  }
  async function prepare() {
    video.pause(); const item = await freshItem(); const time = seconds(video.currentTime, video.duration);
    if (video.seeking) throw new Error('请等待定位完成后再准备提案。');
    if (state.proposal && attempted()) throw new Error('本提案已尝试写入；先读回核对，不自动生成第二条。');
    const id = crypto.randomBytes(8).toString('hex');
    state.proposal = { proposalId: id, itemId: item.id, filePath: item.filePath, seconds: time, annotation: `POC-A-${id}` };
    state.grant = null; state.receipt = null;
    save('proposal.json', { ...state.proposal, source: 'proposal-only-no-library-write', preparedAt: new Date().toISOString() });
    $('proposal').textContent = JSON.stringify(state.proposal, null, 2);
    log('proposal-prepared', state.proposal); save(`session-${state.session}.json`, snapshot());
    status('已保存提案，未修改 Eagle。请把提案交给 Codex，等待具体写入授权。');
  }
  async function readApproval() {
    state.grant = optionalJSON(path.join(ROOT, 'write-approval.json'));
    if (!state.grant) { status('授权文件不存在，保持只读。'); return; }
    if (!state.proposal || ['proposalId', 'itemId', 'filePath', 'seconds', 'annotation'].some(k => state.grant[k] !== state.proposal[k]))
      throw new Error('授权与当前提案不完全匹配。');
    state.receipt = optionalJSON(evidencePath(`receipt-${state.proposal.proposalId}.json`));
    if (!state.receipt) checkGrant(state.grant, state.proposal, state.item, video, attempted());
    log('approval-file-read', { proposalId: state.grant.proposalId, allowAdd: state.grant.allowAdd, allowRemove: state.grant.allowRemove });
    status('授权文件已读取；执行前仍将核对素材、时间和持久化尝试记录。');
  }
  async function addComment() {
    await readApproval(); const item = await freshItem();
    checkGrant(state.grant, state.proposal, item, video, attempted());
    if (typeof item.addComment !== 'function') throw new Error('addComment 不可用。');
    if (!Array.isArray(item.comments)) throw new Error('无法保存原有标注快照，停止写入。');
    const p = state.proposal;
    save(`before-${p.proposalId}.json`, { proposal: p, comments: item.comments, at: new Date().toISOString() }, true);
    save(`attempt-${p.proposalId}.json`, { proposal: p, state: 'reserved-before-api-call', at: new Date().toISOString() }, true);
    log('add-api-start', { proposal: p });
    // 从这里起，抛错也不自动重试；API 可能已提交而响应/证据保存失败。
    try {
      const comment = await item.addComment({ duration: p.seconds, annotation: p.annotation });
      state.receipt = { ...p, comment, createdAt: new Date().toISOString(), removed: false };
      save(`receipt-${p.proposalId}.json`, state.receipt, true); log('add-api-return', { comment });
      await refreshComments();
      const found = state.comments.find(c => c.id === comment?.id && c.annotation === p.annotation && Math.abs(c.duration - p.seconds) < 0.001);
      if (!comment?.id || !found) throw new Error('API 返回后，独立读回未匹配；保留证据等待排查。');
      save(`session-${state.session}.json`, snapshot()); status('测试标注已由 API 独立读回。原生即时/重开显示仍须人工检查。');
    } catch (error) {
      log('add-uncertain-or-readback-failure', { message: error.message });
      try { save(`session-${state.session}.json`, snapshot()); } catch (_) {}
      throw new Error(`${error.message} 本提案已锁定，勿重复写入；先核对 Eagle 实际数据。`);
    }
  }
  async function removeComment() {
    await readApproval(); const item = await freshItem(); const r = state.receipt;
    if (!r || !state.grant || state.grant.allowRemove !== true || r.removed || !sameItem(r, item)
      || r.proposalId !== state.grant.proposalId || !r.comment?.id || !Array.isArray(item.comments))
      throw new Error('没有针对本次测试标注的删除授权或有效回执。');
    const comment = item.comments.find(c => c.id === r.comment.id);
    if (!comment || comment.annotation !== r.annotation || !Number.isFinite(comment.duration)
      || Math.abs(comment.duration - r.seconds) > 0.001)
      throw new Error('测试标注不存在或内容已变化，不自动删除。');
    if (typeof item.removeComment !== 'function') throw new Error('removeComment 不可用。');
    log('remove-api-start', { itemId: item.id, commentId: comment.id });
    const result = await item.removeComment(comment.id); log('remove-api-return', { result });
    await refreshComments();
    if (state.comments.some(c => c.id === comment.id)) throw new Error('删除后独立读回仍存在该 ID；请核对，勿盲目重试。');
    r.removed = true; r.removedAt = new Date().toISOString(); save(`receipt-${r.proposalId}.json`, r);
    save(`session-${state.session}.json`, snapshot()); status('本次测试标注已删除并独立读回确认；修改时间不保证恢复。');
  }
  const actions = { load: ['素材读取/文件访问', loadSelected], refresh: ['标注读取', refreshComments],
    seek: ['时间定位', () => seek($('seconds').value, 'input')], prepare: ['提案准备', prepare],
    approval: ['授权检查', readApproval], add: ['标注写入', addComment], remove: ['测试标注回退', removeComment],
    export: ['证据保存', () => { const name = `session-${state.session}.json`; save(name, snapshot()); status(`证据已保存：${path.join(ROOT, 'evidence', name)}`); }] };
  for (const [id, [stage, action]] of Object.entries(actions)) $(id).addEventListener('click', () => run(stage, action));
  $('timeline').addEventListener('change', () => run('时间轴定位', () => seek($('timeline').value, 'timeline')));
  for (const type of ['play', 'pause', 'seeking', 'seeked', 'loadedmetadata', 'error', 'ended']) {
    video.addEventListener(type, () => {
      if (!state.item) return;
      log(`media-${type}`, { currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        target: state.seekTarget, error: video.error && { code: video.error.code, message: video.error.message } });
      if (type === 'loadedmetadata') { $('timeline').max = String(video.duration); renderComments(); status('视频元信息已加载；播放与实际画面仍需检查。'); }
      if (type === 'seeked') { status(`定位完成事件：目标 ${state.seekTarget?.requested ?? '原生控件'}s，实际 ${video.currentTime.toFixed(3)}s。请检查画面。`); state.seekTarget = null; }
      if (type === 'error') status(`媒体加载/解码失败（代码 ${video.error?.code}）。请保存证据。`, true);
      controls();
    });
  }
  video.addEventListener('timeupdate', () => {
    $('time').textContent = `${video.currentTime.toFixed(3)} / ${Number.isFinite(video.duration) ? video.duration.toFixed(3) : '未加载'} 秒`;
    $('timeline').value = String(video.currentTime); controls();
  });
  for (const id of ['seekObservation', 'nativeImmediate', 'nativeReopen']) $(id).addEventListener('change', () => {
    log('user-observation', { field: id, value: $(id).value, itemId: state.item?.id,
      currentTime: video.currentTime, commentId: state.receipt?.comment?.id, source: 'user-entered-not-automatically-verified' });
  });
  if (typeof eagle === 'undefined' || typeof eagle.onPluginCreate !== 'function') {
    status('未检测到 Eagle Plugin API。请通过 Eagle 加载本目录；普通浏览器打开不算运行验证。', true); return;
  }
  // 核心入口：由 Eagle 触发，类似蓝图中的启动事件。
  eagle.onPluginCreate(() => {
    try {
      fs = require('fs'); path = require('path'); crypto = require('crypto');
      if (path.resolve(require('url').fileURLToPath(new URL('.', location.href))).toLowerCase() !== path.resolve(ROOT).toLowerCase())
        throw new Error('请从批准的实验目录加载开发插件，不要复制到 Eagle 安装目录。');
      state.ready = true; log('plugin-created', { node: process.versions.node, chrome: process.versions.chrome });
      controls(); run('启动读取', loadSelected);
    } catch (error) { status(`启动失败：${error.message}`, true); }
  });
  if (typeof eagle.onLibraryChanged === 'function') eagle.onLibraryChanged(() => {
    invalidate(); log('library-changed', { action: 'clear-item-and-grant' }); status('素材库变化，已清除素材与授权。请重新读取。');
  });
})();
