importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

const firebaseConfig = {
    apiKey: "your_api_key",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project",
    storageBucket: "your-project.appspot.com",
    messagingSenderId: "000000000000",
    appId: "1:000000000000:web:0000000000000000000000"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

const CACHE_NAME = "rutina-diaria-v5";

const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(APP_SHELL);
        })
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );

    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        fetch(event.request).catch(() => {
            return caches.match(event.request).then((cached) => {
                if (cached) return cached;

                if (event.request.mode === "navigate") {
                    return caches.match("/index.html");
                }

                return null;
            });
        })
    );
});

messaging.onBackgroundMessage((payload) => {
    const title =
        payload.data?.title ||
        payload.notification?.title ||
        "Rutina diaria";

    const options = {
        body:
            payload.data?.body ||
            payload.notification?.body ||
            "Tienes una tarea pendiente.",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: payload.data || {},
        tag: payload.data?.tag || "rutina-notificacion",
        requireInteraction: false
    };

    self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ("focus" in client) return client.focus();
            }

            if (clients.openWindow) return clients.openWindow("/");
        })
    );
});
