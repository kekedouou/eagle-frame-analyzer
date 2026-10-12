'use strict';

// Read-only, opt-in observation. No history, controls or file capabilities.
const LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 8192, depth: 16, stringBytes: 64 * 1024, subscribers: 8 });
function copied(value) {
  let nodes = 0, bytes = 0;
  const parents = new Set();
  function charge(amount) { bytes += amount; if (bytes > LIMITS.bytes) throw new Error('诊断数据超过容量限制。'); }
  function visit(item, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('诊断数据结构超过限制。');
    if (item === null || item === undefined) { charge(4); return null; }
    if (typeof item === 'string') {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > LIMITS.stringBytes) throw new Error('诊断文字超过限制。'); charge(size); return item;
    }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('诊断数值无效。'); charge(32); return item; }
    if (typeof item === 'boolean') { charge(5); return item; }
    if (typeof item !== 'object' || parents.has(item)) throw new Error('诊断仅接受无循环的数据。');
    const prototype = Object.getPrototypeOf(item);
    // Renderer and CommonJS may have different Object.prototype identities.
    const plain = prototype === null || Object.getPrototypeOf(prototype) === null &&
      Object.prototype.hasOwnProperty.call(prototype, 'constructor') && prototype.constructor.name === 'Object';
    if (!Array.isArray(item) && !plain) throw new Error('诊断不能暴露对象实例。');
    parents.add(item); charge(2);
    let result;
    if (Array.isArray(item)) {
      if (item.length > LIMITS.nodes) throw new Error('诊断数组超过限制。');
      result = item.map(child => { charge(1); return visit(child, depth + 1); });
    } else {
      result = {};
      const keys = Object.keys(item); if (keys.length > LIMITS.nodes) throw new Error('诊断属性超过限制。');
      for (const key of keys) {
        if (key.length > 256) throw new Error('诊断字段名超过限制。');
        charge(Buffer.byteLength(JSON.stringify(key)) + 2);
        const child = item[key];
        if (child !== undefined) Object.defineProperty(result, key, { value: visit(child, depth + 1), enumerable: true });
      }
    }
    parents.delete(item); return Object.freeze(result);
  }
  return visit(value, 0);
}
function createDiagnostics(options = {}) {
  if (typeof options.snapshot !== 'function') throw new Error('诊断需要只读快照接口。');
  const subscribers = new Set(); let serial = 0;
  const publicApi = Object.freeze({
    snapshot() { return copied(options.snapshot()); },
    subscribe(observer) {
      if (typeof observer !== 'function') throw new Error('诊断订阅者必须是函数。');
      if (!subscribers.has(observer) && subscribers.size >= LIMITS.subscribers) throw new Error('诊断订阅数超过限制。');
      subscribers.add(observer); let active = true;
      return () => { if (active) { active = false; subscribers.delete(observer); } };
    }
  });
  function publish(type, value) {
    if (!subscribers.size) return false;
    let message;
    try {
      if (typeof type !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(type)) return false;
      message = Object.freeze({ type, serial: ++serial, value: copied(typeof value === 'function' ? value() : value) });
    } catch (_) { return false; }
    for (const observer of [...subscribers]) {
      if (!subscribers.has(observer)) continue;
      try { observer(message); } catch (_) { /* Observers never own application behavior. */ }
    }
    return true;
  }
  return Object.freeze({ public: publicApi, publish });
}
module.exports = { createDiagnostics, LIMITS };
