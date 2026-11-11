// Service worker for the push test. Every push MUST show a notification (iOS revokes push otherwise).
function report(k, v) {
  return fetch("/v1/push-test/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: k, v: String(v) }) }).catch(function () {});
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(d.title || "Change inbox", {
        body: d.body || "",
        tag: d.tag || "push-test",
        data: { url: d.url || "/push-test/?from=push" },
      });
      // Tell the server (and any open page) what happened, so nobody has to answer questions.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.some((w) => w.visibilityState === "visible");
      await report("push_shown", (visible ? "app-visible" : "app-closed-or-hidden") + " " + new Date().toISOString());
      windows.forEach((w) => w.postMessage({ type: "push-shown", visible: visible }));
      // Home-screen badge number. Not every browser exposes this inside a service worker, so failure is fine.
      if (typeof d.badge === "number") {
        try {
          if (d.badge > 0) await self.navigator.setAppBadge(d.badge);
          else await self.navigator.clearAppBadge();
          await report("badge_set", d.badge);
        } catch { /* badge API unavailable here */ }
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(report("tap_opens", "notification-click " + new Date().toISOString()));
  const url = new URL((event.notification.data && event.notification.data.url) || "/push-test/?from=push", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        await w.focus();
        try { await w.navigate(url); } catch { /* some browsers disallow navigate; the page is focused anyway */ }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
