/* 升级助手 Service Worker
 * 两件事：接住推送弹通知，点击时回到页面。
 * 解析失败也要弹出，宁可显示默认文案，也不能让通知消失。
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var title = '升级完成';
  var body = '';
  var tag = 'coc';
  var url = './';

  try {
    if (event.data) {
      var d = null;
      try {
        d = event.data.json();
      } catch (e1) {
        d = null;
      }
      if (d && typeof d === 'object') {
        if (d.title) title = String(d.title);
        if (d.body) body = String(d.body);
        if (d.tag) tag = String(d.tag);
        if (d.url) url = String(d.url);
      } else {
        try { body = event.data.text(); } catch (e2) { body = ''; }
      }
    }
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: tag,
      icon: 'img/icon-192.png',
      badge: 'img/icon-192.png',
      data: { url: url }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.registration.scope) === 0) {
          return list[i].focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
