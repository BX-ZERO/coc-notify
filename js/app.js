/* 升级助手 —— 本地实现
 * 读取游戏导出的玩家 JSON，列出正在进行的升级与完成时刻。
 * 数据只存在本机浏览器里，不联网，不上传。
 */
(function () {
  'use strict';

  var STORE_KEY = 'coc_local_accounts_v1';

  var CATEGORIES = [
    { key: 'buildings',      label: '建筑',        icon: '🏰', kind: 'build' },
    { key: 'heroes',         label: '英雄',        icon: '🦸', kind: 'build' },
    { key: 'traps',          label: '陷阱',        icon: '💣', kind: 'build' },
    { key: 'guardians',      label: '守卫',        icon: '🛡️', kind: 'build' },
    { key: 'units',          label: '兵种',        icon: '⚔️', kind: 'lab' },
    { key: 'spells',         label: '法术',        icon: '✨', kind: 'lab' },
    { key: 'siege_machines', label: '攻城机器',    icon: '🚚', kind: 'lab' },
    { key: 'pets',           label: '战宠',        icon: '🐾', kind: 'pet' },
    { key: 'buildings2',     label: '夜世界建筑',  icon: '🌙', kind: 'night' },
    { key: 'heroes2',        label: '夜世界英雄',  icon: '🌙', kind: 'night' },
    { key: 'units2',         label: '夜世界兵种',  icon: '🌙', kind: 'night' },
    { key: 'traps2',         label: '夜世界陷阱',  icon: '🌙', kind: 'night' }
  ];

  var state = { accounts: {}, order: [], current: null };
  var tickTimer = null;

  /* ---------- DOM ---------- */

  var el = {
    tabs: document.getElementById('tabs'),
    empty: document.getElementById('empty'),
    board: document.getElementById('board'),
    bottombar: document.getElementById('bottombar'),
    modal: document.getElementById('modal'),
    input: document.getElementById('json-input'),
    file: document.getElementById('file-input'),
    msg: document.getElementById('msg')
  };

  /* ---------- 存储 ---------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && saved.accounts) {
        state.accounts = saved.accounts;
        state.order = saved.order || Object.keys(saved.accounts);
        state.current = saved.current || null;
        if (!state.current || !state.accounts[state.current]) {
          state.current = state.order.length ? state.order[0] : null;
        }
      }
    } catch (e) {
      console.warn('读取本地数据失败', e);
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('保存失败', e);
    }
  }

  function current() {
    return state.current ? state.accounts[state.current] : null;
  }

  /* ---------- 数据解析 ---------- */

  function nameOf(id) {
    var table = window.ITEM_NAMES || {};
    var hit = table[String(id)];
    return hit || ('未知(' + id + ')');
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /* 剩余时间(秒) 依据加速状态压缩后的完成时刻 */
  function finishAt(item, data) {
    var ts = num(data.timestamp) || Math.floor(Date.now() / 1000);
    var end = ts + item.timer;
    var boosts = data.boosts || {};
    var helpers = Array.isArray(data.helpers) ? data.helpers : [];

    // 助手：每点减少若干秒，减少量覆盖全程时改为按倍速压缩
    if (item.helperTimer > 0) {
      var ids = item.kind === 'lab'
        ? [93000001, 124000001]
        : [93000000, 124000000];
      var helper = null;
      for (var i = 0; i < helpers.length; i++) {
        if (ids.indexOf(num(helpers[i].data)) >= 0) { helper = helpers[i]; break; }
      }
      if (helper) {
        var lvl = num(helper.lvl);
        var cut = item.helperTimer * lvl;
        if (cut >= item.timer) {
          end = ts + Math.ceil(item.timer / (lvl + 1));
        } else {
          end = end - cut;
        }
      }
    }

    // 药水：剩余量 b 秒。b 秒内可削减 b*削减比，剩余不足 b*阈值时按倍速压缩
    function shrink(m, b, cutMul, thrMul, speed) {
      var remain = m - ts;
      if (remain <= 0) return m;
      if (remain <= b * thrMul) return ts + Math.ceil(remain / speed);
      return Math.max(ts, m - Math.round(b * cutMul));
    }
    function boost(name) { return num(boosts[name]); }

    var v;
    if (item.kind === 'build') {
      v = boost('builder_boost');
      if (v > 0) end = shrink(end, v, 9, 10, 10);
      v = boost('builder_consumable');
      if (v > 0) end = shrink(end, v, 1, 2, 2);
    } else if (item.kind === 'lab' || item.kind === 'pet') {
      v = boost('lab_boost');
      if (v > 0) end = shrink(end, v, 23, 24, 24);
      v = boost('lab_consumable');
      if (v > 0) end = shrink(end, v, 3, 4, 4);
    } else if (item.kind === 'night') {
      v = boost('clocktower_boost');
      if (v > 0) end = shrink(end, v, 9, 10, 10);
    }

    return isFinite(end) ? end : ts + item.timer;
  }

  /* ---------- 导入 ---------- */

  function parseImport(text, persist) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('这段内容不是合法的 JSON');
    }
    if (!data || typeof data !== 'object') throw new Error('数据为空');

    var tag = data.tag || data.playerTag || data.player_tag;
    if (!tag) throw new Error('找不到玩家标签，可能不是玩家数据');
    tag = String(tag).toUpperCase();

    var ts = num(data.timestamp);
    if (!ts) throw new Error('缺少导出时间戳，无法计算完成时刻');

    var record = {
      tag: tag,
      name: data.name || data.playerName || '',
      data: data,
      importedAt: Math.floor(Date.now() / 1000)
    };
    record.items = collectWithData(data);

    state.accounts[tag] = record;
    if (state.order.indexOf(tag) < 0) state.order.push(tag);
    state.current = tag;
    if (persist !== false) save();
    return record;
  }

  function collectWithData(data) {
    var items = [];
    CATEGORIES.forEach(function (cat) {
      var list = data[cat.key];
      if (!Array.isArray(list)) return;
      list.forEach(function (raw) {
        if (num(raw.data) === 1000097 && Array.isArray(raw.types)) {
          raw.types.forEach(function (type) {
            (type.modules || []).forEach(function (mod) {
              if (!(num(mod.timer) > 0)) return;
              var it = {
                key: cat.key, label: cat.label, icon: cat.icon, kind: cat.kind,
                id: num(mod.data), lvl: num(mod.lvl), timer: num(mod.timer),
                helperTimer: num(mod.helper_timer) || num(raw.helper_timer),
                name: nameOf(num(mod.data)) + ' 精制'
              };
              it.finish = finishAt(it, data);
              items.push(it);
            });
          });
          return;
        }
        if (num(raw.timer) > 0) {
          var it = {
            key: cat.key, label: cat.label, icon: cat.icon, kind: cat.kind,
            id: num(raw.data), lvl: num(raw.lvl), timer: num(raw.timer),
            helperTimer: num(raw.helper_timer), name: nameOf(num(raw.data))
          };
          it.finish = finishAt(it, data);
          items.push(it);
        }
      });
    });
    items.sort(function (a, b) { return a.finish - b.finish; });
    return items;
  }

  /* ---------- 时间格式 ---------- */

  function remainingText(sec) {
    if (sec <= 0) return '已完成';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (d > 0) return d + '天 ' + h + '时';
    if (h > 0) return h + '时 ' + m + '分';
    if (m > 0) return m + '分 ' + s + '秒';
    return s + '秒';
  }

  function whenText(ts) {
    var d = new Date(ts * 1000);
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var sameDay = d.toDateString() === now.toDateString();
    var tomorrow = new Date(now.getTime() + 86400000);
    if (sameDay) return '今天 ' + hm;
    if (d.toDateString() === tomorrow.toDateString()) return '明天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function clockText(ts) {
    var d = new Date(ts * 1000);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------- 渲染 ---------- */

  function render() {
    var acct = current();
    if (!acct) {
      el.empty.hidden = false;
      el.board.innerHTML = '';
      el.bottombar.hidden = true;
      el.tabs.innerHTML = '';
      return;
    }
    el.empty.hidden = true;
    el.bottombar.hidden = false;

    renderTabs();
    renderBoard(acct);
    startTick();
    syncPush(false);
  }

  function renderTabs() {
    if (state.order.length <= 1) {
      el.tabs.innerHTML = '';
      return;
    }
    el.tabs.innerHTML = state.order.map(function (tag) {
      var on = tag === state.current ? ' active' : '';
      return '<button class="tab' + on + '" data-tag="' + tag + '">' + tag + '</button>';
    }).join('');
  }

  function renderBoard(acct) {
    var now = Math.floor(Date.now() / 1000);
    var items = acct.items || [];
    var live = items.filter(function (i) { return i.finish > now - 60; });

    var first = live.length ? live[0].finish : 0;

    var html = '';
    html += '<div class="panel">' +
      '<div class="panel-head"><span class="panel-tag">' + acct.tag + '</span>' +
      (acct.name ? '<span class="panel-name">' + escapeHtml(acct.name) + '</span>' : '') +
      '</div>' +
      '<div class="stats">' +
      '<div class="stat hi"><div class="k">进行中</div><div class="v">' + live.length + '</div></div>' +
      '<div class="stat"><div class="k">最近完成</div><div class="v">' + (first ? clockText(first) : '—') + '</div></div>' +
      '<div class="stat"><div class="k">数据导出</div><div class="v">' + clockText(num(acct.data.timestamp)) + '</div></div>' +
      '</div>' +
      '<div class="meta">当前 <b>' + whenText(now) + '</b></div>' +
      '</div>';

    var groups = {};
    live.forEach(function (i) { (groups[i.key] = groups[i.key] || []).push(i); });

    var n = 0;
    CATEGORIES.forEach(function (cat) {
      var list = groups[cat.key];
      if (!list || !list.length) return;
      n += 1;
      html += '<div class="group"><div class="ghead">' +
        '<span class="idx">' + (n < 10 ? '0' + n : n) + '</span>' +
        '<span>' + cat.label + '</span>' +
        '<span class="n">' + list.length + ' 项</span></div>';
      list.forEach(function (i) { html += cardHtml(i, now); });
      html += '</div>';
    });

    if (!live.length) {
      html += '<div class="empty"><div class="empty-icon">✅</div><p class="empty-title">没有进行中的升级</p>' +
        '<p class="hint">重新导出一次数据再导入</p></div>';
    }

    el.board.innerHTML = html;
    bindIcons();
  }

  // 图标缺失时退回分类符号
  function bindIcons() {
    var imgs = el.board.querySelectorAll('.card-img');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        function fallback() {
          img.parentNode.classList.add('no-img');
          img.remove();
        }
        if (img.complete && img.naturalWidth === 0) fallback();
        else img.addEventListener('error', fallback);
      })(imgs[i]);
    }
  }

  /* 倒计时颜色分档：1 小时内红、1-6 小时黄、6-24 小时蓝、更久黑 */
  function toneOf(sec) {
    if (sec <= 0) return 't0';
    if (sec <= 3600) return 't1';
    if (sec <= 21600) return 't2';
    if (sec <= 86400) return 't3';
    return 't4';
  }

  function cardHtml(item, now) {
    var remain = item.finish - now;
    var cls = 'card';
    if (remain <= 0) cls += ' done';
    else if (remain <= 600) cls += ' soon';
    var lvl = item.lvl ? ('Lv.' + item.lvl + ' <span class="arrow">→</span> Lv.' + (item.lvl + 1)) : '';
    return '<div class="' + cls + '">' +
      '<div class="card-icon"><img class="card-img" src="img/' + item.id + '.webp" alt="">' +
      '<span class="card-emoji">' + item.icon + '</span></div>' +
      '<div class="card-main"><div class="card-name">' + escapeHtml(item.name) + '</div>' +
      (lvl ? '<div class="card-lvl">' + lvl + '</div>' : '') + '</div>' +
      '<div class="card-time"><div class="card-remain ' + toneOf(remain) + '" data-finish="' + item.finish + '">' +
      remainingText(remain) + '</div><div class="card-when">' + whenText(item.finish) + '</div></div>' +
      '</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 每秒刷新剩余时间，不重排列表 */
  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(function () {
      var now = Math.floor(Date.now() / 1000);
      var nodes = el.board.querySelectorAll('[data-finish]');
      if (!nodes.length) return;
      for (var i = 0; i < nodes.length; i++) {
        var rem = num(nodes[i].getAttribute('data-finish')) - now;
        nodes[i].textContent = remainingText(rem);
        nodes[i].className = 'card-remain ' + toneOf(rem);
      }
    }, 1000);
  }

  /* ---------- 导出日历 ---------- */

  function utcString(ts) {
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  }

  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  function buildIcs(acct) {
    var now = Math.floor(Date.now() / 1000);
    var items = (acct.items || []).filter(function (i) { return i.finish > now; });
    var out = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//coc-local//upgrade-helper//CN',
      'CALSCALE:GREGORIAN',
      'X-WR-CALNAME:部落升级'
    ];
    items.forEach(function (i) {
      var uid = acct.tag.replace(/#/g, '') + '-' + i.key + '-' + i.id + '-' + i.lvl + '@coc-local';
      out.push('BEGIN:VEVENT');
      out.push('UID:' + uid);
      out.push('DTSTAMP:' + utcString(now));
      out.push('DTSTART:' + utcString(i.finish));
      out.push('SUMMARY:' + icsEscape(i.name + ' 升至 Lv.' + (i.lvl + 1)));
      out.push('DESCRIPTION:' + icsEscape(acct.tag + ' / ' + i.label));
      out.push('BEGIN:VALARM');
      out.push('TRIGGER:-PT10M');
      out.push('ACTION:DISPLAY');
      out.push('DESCRIPTION:' + icsEscape(i.name + ' 即将完成'));
      out.push('END:VALARM');
      out.push('END:VEVENT');
    });
    out.push('END:VCALENDAR');
    return out.join('\r\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /* ---------- 事件 ---------- */

  function openModal() {
    el.msg.textContent = '';
    el.msg.className = 'msg';
    el.modal.hidden = false;
    if (!window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(function () { el.input.focus(); }, 60);
    }
  }

  function closeModal() {
    el.modal.hidden = true;
  }

  function doImport(text) {
    try {
      parseImport(text);
      closeModal();
      el.input.value = '';
      render();
    } catch (e) {
      el.msg.textContent = e.message;
      el.msg.className = 'msg';
    }
  }

  document.getElementById('btn-import').addEventListener('click', openModal);
  document.getElementById('btn-import-2').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-parse').addEventListener('click', function () {
    doImport(el.input.value);
  });

  function showMsg(text) {
    el.msg.textContent = text;
    el.msg.className = 'msg';
  }

  document.getElementById('btn-clip').addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showMsg('这个浏览器不给读剪贴板，手动粘贴吧');
      el.input.focus();
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (!text || !text.trim()) {
        showMsg('剪贴板是空的');
        return;
      }
      el.input.value = text;
      doImport(text);
    }).catch(function () {
      showMsg('没读到剪贴板。系统问「允许粘贴」时要点是，或者直接长按输入框粘贴');
      el.input.focus();
    });
  });

  el.file.addEventListener('change', function () {
    var f = el.file.files && el.file.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { doImport(String(reader.result)); };
    reader.readAsText(f, 'utf-8');
    el.file.value = '';
  });

  el.tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab');
    if (!btn) return;
    state.current = btn.getAttribute('data-tag');
    save();
    render();
  });

  document.getElementById('btn-ics').addEventListener('click', function () {
    var acct = current();
    if (!acct) return;
    download(acct.tag.replace(/#/g, '') + '-升级.ics', buildIcs(acct), 'text/calendar;charset=utf-8');
  });

  document.getElementById('btn-backup').addEventListener('click', function () {
    download('升级助手备份-' + Math.floor(Date.now() / 1000) + '.json',
      JSON.stringify(state, null, 2), 'application/json');
  });

  el.modal.addEventListener('click', function (e) {
    if (e.target === el.modal) closeModal();
  });

  /* ---------- 示例数据（仅预览，不写入本地） ---------- */

  function loadDemo() {
    var now = Math.floor(Date.now() / 1000);
    var sample = {
      tag: '#DEMO0JQ0',
      name: '示例账号',
      timestamp: now,
      buildings: [
        { data: 1000008, lvl: 11, timer: 1273 },
        { data: 1000014, lvl: 11, timer: 11447 },
        { data: 1000007, lvl: 12, timer: 11489 },
        { data: 1000027, lvl: 6, timer: 12651 },
        { data: 1000009, lvl: 15, timer: 33272 },
        { data: 1000068, lvl: 6, timer: 79047 }
      ],
      heroes: [{ data: 28000002, lvl: 18, timer: 12000 }],
      units: [{ data: 4000004, lvl: 6, timer: 6400 }],
      spells: [],
      pets: [{ data: 73000000, lvl: 3, timer: 8800 }],
      traps: [],
      boosts: {},
      helpers: []
    };
    parseImport(JSON.stringify(sample), false);
  }

  /* ---------- 主题 ---------- */

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    var btn = document.getElementById('btn-theme');
    btn.setAttribute('data-mode', mode);
    btn.textContent = '';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#141619' : '#f4f4f5');
  }

  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  document.getElementById('btn-theme').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('coc_theme', next); } catch (e) {}
  });

  /* ---------- 推送提醒 ---------- */

  var VAPID_PUBLIC = 'BNrhP8Q3U6bft3Hed1Ipi2HoQ8Uu4v0nj81oxo8SNUJbNp_RlKcNMP0jUwSKuHlZ0ArqdAyJJ_SHdjXtvVGn3O0';
  var PUSH_URL_DEFAULT = 'https://coc-notify-push.dosomethingforme.workers.dev';
  var PUSH_URL_KEY = 'coc_push_url';
  var lastSync = 0;

  function pushUrl() {
    try { return localStorage.getItem(PUSH_URL_KEY) || PUSH_URL_DEFAULT; } catch (e) { return PUSH_URL_DEFAULT; }
  }

  function b64uToU8(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setBell(on) {
    var btn = document.getElementById('btn-bell');
    if (!btn) return;
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.title = on ? '提醒已开启' : '开启提醒';
    btn.setAttribute('aria-label', btn.title);
  }

  function pushItems() {
    var acct = current();
    if (!acct || !acct.items) return [];
    var now = Math.floor(Date.now() / 1000);
    return acct.items.filter(function (it) {
      return it.finish > now;
    }).map(function (it) {
      return {
        id: acct.tag + '-' + it.key,
        title: it.name + ' 已完成',
        body: 'Lv.' + it.lvl + ' → Lv.' + (it.lvl + 1),
        at: it.finish
      };
    });
  }

  function api(path, payload) {
    var url = pushUrl();
    if (!url) return Promise.reject(new Error('还没有配置推送地址'));
    return fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) { return res.json(); });
  }

  function syncPush(force) {
    if (!pushUrl() || !('serviceWorker' in navigator)) return;
    if (!force && Date.now() - lastSync < 60000) return;
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return null;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return null;
      lastSync = Date.now();
      return api('/sync', { endpoint: sub.endpoint, items: pushItems() });
    }).catch(function () {});
  }

  function enablePush() {
    if (!('serviceWorker' in navigator) || !window.PushManager) {
      alert('这个浏览器不支持推送。iPhone 上要先添加到主屏幕，再从主屏幕图标打开。');
      return;
    }
    var subRef = null;
    /* 必须在点击的同步调用栈里申请权限，iOS 只认这一次手势 */
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('没有拿到通知权限，去 设置 → 通知 里打开');
      return navigator.serviceWorker.register('sw.js');
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64uToU8(VAPID_PUBLIC)
        });
      });
    }).then(function (sub) {
      subRef = sub;
      return api('/sub', { subscription: sub.toJSON(), items: pushItems() });
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || '服务端没有接受订阅');
      setBell(true);
      return api('/test', { endpoint: subRef.endpoint });
    }).then(function () {
      alert('提醒已开启。刚发了一条测试通知，退出去看锁屏。');
    }).catch(function (err) {
      alert('开启失败：' + (err && err.message ? err.message : '未知原因'));
    });
  }

  document.getElementById('btn-bell').addEventListener('click', function () {
    var btn = document.getElementById('btn-bell');
    if (btn.getAttribute('data-on') === '1') {
      syncPush(true);
      alert('已经开始同步了。');
      return;
    }
    enablePush();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return null;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (sub && pushUrl()) { setBell(true); syncPush(false); }
    }).catch(function () {});
  }

  /* ---------- 启动 ---------- */

  load();
  if (/(^|[?&])demo=1/.test(location.search)) loadDemo();
  render();
})();
