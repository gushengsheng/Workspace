// One JSON message in, one out. The page never touches the disk: every path
// comes from the C# side, which is why the browser sandbox can't break it.

const pending = new Map();
let seq = 0;

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

if (host) {
  host.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || '调用失败'));
      return;
    }
    if (msg && msg.event) {
      for (const fn of listeners) fn(msg);
    }
  });
}

const listeners = [];
export function onHostEvent(fn) { listeners.push(fn); }

export function call(method, params = {}) {
  if (!host) return Promise.reject(new Error('没有原生宿主'));
  // String ids: the host echoes the JSON token back, and a numeric 1 would not
  // match a string "1" in a Map.
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.postMessage({ id, method, params });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('超时：' + method)); }
    }, 200000);
  });
}
