# Daily Routine App

Daily Routine App is a mobile-first habit and routine tracker built with React, Vite and Firebase. It was designed as a focused daily companion: users can sign in, create routines, schedule reminders, track completions across a calendar and keep their habit history synced in the cloud.

The project is open source so other developers can study, reuse and adapt the implementation. If you use it publicly, please keep the attribution to David Trotonda from the `NOTICE` file.

## Highlights

- Google authentication with Firebase Auth.
- Cloud-synced routines and completion history through Firestore.
- Daily and weekly habit planning with configurable repeat days.
- Calendar view, completion state, ordering mode and habit progress stats.
- Browser and PWA support with install prompt handling.
- Push notification token management with Firebase Cloud Messaging.
- Scheduled Firebase Function that checks pending routine tasks every minute and sends reminders.
- Meditation timer with audio and vibration feedback.
- Offline app shell through a service worker.

## Tech Stack

- React 19
- Vite
- Firebase Auth
- Cloud Firestore
- Firebase Cloud Messaging
- Firebase Hosting
- Firebase Cloud Functions
- Lucide React icons

## Getting Started

Install dependencies:

```bash
npm install
```

Copy the environment template:

```bash
cp .env.example .env
```

Fill the Firebase values in `.env`, then run the app:

```bash
npm run dev
```

## Firebase Setup

Create a Firebase web app and enable:

- Authentication with Google provider.
- Cloud Firestore.
- Firebase Cloud Messaging.
- Firebase Hosting.
- Cloud Functions if you want scheduled reminder delivery.

The frontend reads Firebase configuration from Vite environment variables. The service worker in `public/firebase-messaging-sw.js` also needs the same public Firebase web app values because service workers cannot read Vite env variables directly.

For push notifications, create a Web Push certificate in Firebase and set:

```bash
VITE_FIREBASE_VAPID_KEY=your_web_push_certificate_key
```

## Cloud Functions

Install function dependencies:

```bash
cd functions
npm install
```

The reminder function reads optional runtime environment values:

```bash
APP_URL=https://your-project.web.app/
TIME_ZONE=Europe/Madrid
```

Deploy hosting and functions with Firebase CLI:

```bash
firebase deploy
```

## Firestore Shape

The app stores user data under:

```text
usuarios/{uid}
usuarios/{uid}/tokens/{token}
usuarios/{uid}/sentNotifications/{notificationId}
```

Basic security rules are included in `firestore.rules`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
