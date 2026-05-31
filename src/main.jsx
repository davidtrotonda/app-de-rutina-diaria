import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();

      for (const registration of registrations) {
        if (registration.active?.scriptURL.endsWith('/sw.js')) {
          await registration.unregister();
        }
      }

      await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
        scope: '/'
      });

      console.log('Firebase Messaging Service Worker registrado');
    } catch (error) {
      console.error('Error registrando Service Worker:', error);
    }
  });
}