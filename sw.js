"use strict";

const CACHE = "genesis-ilustrada-v3-2";
const SHELL = [
  "./", "./index.html", "./css/app.css", "./js/app.js", "./books/gn.js",
  "./fonts/cinzel.ttf", "./fonts/inter.ttf", "./fonts/literata.ttf",
  "./icons/icon-192.png", "./icons/icon-512.png", "./manifest.json",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith("genesis-ilustrada-") && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === "navigate") {
      try {
        return await fetch(event.request);
      } catch {
        return await cache.match("./index.html") || Response.error();
      }
    }
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const network = await fetch(event.request);
      if (network.ok) await cache.put(event.request, network.clone()).catch(() => {});
      return network;
    } catch {
      return event.request.destination === "image" ? new Response(null, { status: 204 }) : Response.error();
    }
  }));
});
