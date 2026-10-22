// 单文件配对面板：零依赖、零构建、loopback-only。
// 用途：卸载 companion 后仍能生成配对资料、批准/拒绝设备（切换日硬前置）。
export const MOBILE_V1_PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobile V1 · 设备配对</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 18px 64px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.lead { margin: 0 0 20px; color: color-mix(in srgb, CanvasText 62%, Canvas); font-size: 13px; }
  section { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  section h2 { font-size: 14px; margin: 0 0 10px; }
  .row { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 8px 0; border-top: 1px dashed color-mix(in srgb, CanvasText 14%, Canvas); }
  .row:first-of-type { border-top: 0; }
  .meta { min-width: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: 12px; color: color-mix(in srgb, CanvasText 55%, Canvas); }
  button { font: inherit; border-radius: 8px; padding: 6px 12px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); background: color-mix(in srgb, CanvasText 6%, Canvas); color: inherit; cursor: pointer; }
  button.primary { background: #2f66f4; border-color: #2f66f4; color: #fff; }
  button.danger { color: #d64545; border-color: color-mix(in srgb, #d64545 45%, Canvas); }
  pre { margin: 10px 0 0; padding: 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 7%, Canvas); overflow: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .hint { font-size: 12px; color: color-mix(in srgb, CanvasText 55%, Canvas); margin-top: 8px; }
  .empty { color: color-mix(in srgb, CanvasText 50%, Canvas); font-size: 13px; }
  .error { color: #d64545; font-size: 13px; }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>
<main>
  <h1>Mobile V1 · 设备配对</h1>
  <p class="lead">此页面仅本机可访问。手机 App 使用 /mobile/v1 协议，配对资料可粘贴到 App 的「手动输入」。</p>

  <section>
    <h2>生成配对资料</h2>
    <div class="bar">
      <button class="primary" id="create">生成配对资料</button>
      <button id="copy" disabled>复制 JSON</button>
    </div>
    <pre id="pairing" hidden></pre>
    <div class="hint" id="pairing-hint" hidden>配对码 120 秒内有效：把 JSON 整段粘贴到 App → 配对 → 桌面批准。</div>
    <div class="error" id="pairing-error" hidden></div>
  </section>

  <section>
    <h2>待批准设备</h2>
    <div class="hint">批准后本设备可访问桌面全部会话（含所有工作区会话与新建会话），请确认是本人在配对的手机。</div>
    <div id="pending" class="empty">加载中…</div>
  </section>

  <section>
    <h2>已配对设备</h2>
    <div id="devices" class="empty">加载中…</div>
  </section>
</main>
<script>
(function () {
  var pendingBox = document.getElementById('pending');
  var devicesBox = document.getElementById('devices');
  var pairingBox = document.getElementById('pairing');
  var pairingHint = document.getElementById('pairing-hint');
  var pairingError = document.getElementById('pairing-error');
  var copyButton = document.getElementById('copy');
  var pairingText = '';
  var busy = false;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function ago(ms) {
    if (!ms) return '';
    var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return sec + ' 秒前';
    return Math.round(sec / 60) + ' 分钟前';
  }
  function api(method, path, body) {
    return fetch('/mgw/mobile-v1' + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (value) {
        if (!response.ok) throw new Error((value.error && value.error.message) || ('HTTP ' + response.status));
        return value;
      });
    });
  }
  function row(name, sub, actions) {
    var line = el('div', 'row');
    var meta = el('div', 'meta');
    meta.appendChild(el('div', 'name', name));
    if (sub) meta.appendChild(el('div', 'sub', sub));
    line.appendChild(meta);
    var bar = el('div', 'bar');
    actions.forEach(function (action) { bar.appendChild(action); });
    line.appendChild(bar);
    return line;
  }
  function renderPending(list) {
    pendingBox.textContent = '';
    if (!list || !list.length) { pendingBox.className = 'empty'; pendingBox.textContent = '暂无待批准请求'; return; }
    pendingBox.className = '';
    list.forEach(function (item) {
      var approve = el('button', 'primary', '批准');
      approve.onclick = function () { decide(item.requestId, true); };
      var deny = el('button', 'danger', '拒绝');
      deny.onclick = function () { decide(item.requestId, false); };
      pendingBox.appendChild(row(item.deviceName || item.requestId, '请求 ' + String(item.requestId).slice(0, 8) + ' · ' + ago(item.createdAt), [approve, deny]));
    });
  }
  function renderDevices(list, currentDeviceId) {
    devicesBox.textContent = '';
    if (!list || !list.length) { devicesBox.className = 'empty'; devicesBox.textContent = '暂无已配对设备'; return; }
    devicesBox.className = '';
    list.forEach(function (item) {
      var actions = [];
      if (!item.revokedAt) {
        var revoke = el('button', 'danger', '撤销');
        revoke.onclick = function () { revokeDevice(item.id, item.name); };
        actions.push(revoke);
      }
      devicesBox.appendChild(row((item.name || item.id) + (item.id === currentDeviceId ? '（当前）' : ''), item.revokedAt ? '已撤销' : ('最近活跃 ' + ago(item.lastSeenAt)), actions));
    });
  }
  function refresh() {
    return api('GET', '/status').then(function (status) {
      renderPending(status.pending);
      renderDevices(status.devices, null);
    }).catch(function (error) {
      pendingBox.className = 'error';
      pendingBox.textContent = '状态获取失败：' + error.message;
    });
  }
  function decide(requestId, approved) {
    if (busy) return;
    busy = true;
    api('POST', approved ? '/pairing/approve' : '/pairing/deny', { requestId: requestId })
      .catch(function (error) { alert((approved ? '批准' : '拒绝') + '失败：' + error.message); })
      .then(function () { busy = false; refresh(); });
  }
  function revokeDevice(id, name) {
    if (!confirm('撤销设备「' + (name || id) + '」？该设备会立即失去访问权。')) return;
    api('POST', '/devices/revoke', { id: id })
      .catch(function (error) { alert('撤销失败：' + error.message); })
      .then(function () { refresh(); });
  }
  document.getElementById('create').onclick = function () {
    pairingError.hidden = true;
    api('POST', '/pairing').then(function (value) {
      pairingText = JSON.stringify(value);
      pairingBox.textContent = pairingText;
      pairingBox.hidden = false;
      pairingHint.hidden = false;
      copyButton.disabled = false;
    }).catch(function (error) {
      pairingError.hidden = false;
      pairingError.textContent = '生成失败：' + error.message;
    });
  };
  copyButton.onclick = function () {
    if (!pairingText) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pairingText).then(function () { copyButton.textContent = '已复制'; setTimeout(function () { copyButton.textContent = '复制 JSON'; }, 1500); });
    } else {
      var area = document.createElement('textarea');
      area.value = pairingText;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      copyButton.textContent = '已复制';
      setTimeout(function () { copyButton.textContent = '复制 JSON'; }, 1500);
    }
  };
  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`
