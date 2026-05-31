const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();

const APP_URL = process.env.APP_URL || "https://your-project.web.app/";
const TIME_ZONE = process.env.TIME_ZONE || "Europe/Madrid";

const getMadridParts = () => {
    const now = new Date();

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short"
    }).formatToParts(now);

    const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    const weekdayMap = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6
    };

    return {
        dateStr: `${values.year}-${values.month}-${values.day}`,
        timeStr: `${values.hour}:${values.minute}`,
        dayOfWeek: weekdayMap[values.weekday]
    };
};

exports.sendRoutineNotifications = onSchedule(
    {
        schedule: "* * * * *",
        timeZone: TIME_ZONE,
        region: "europe-west1"
    },
    async () => {
        const { dateStr, timeStr, dayOfWeek } = getMadridParts();

        console.log(`Revisando tareas: ${dateStr} ${timeStr} día ${dayOfWeek}`);

        const usersSnap = await db.collection("usuarios").get();

        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const uid = userDoc.id;

            const tasks = Array.isArray(userData.tasks) ? userData.tasks : [];
            const completions = userData.completions || {};

            const dueTasks = tasks.filter((task) => {
                return (
                    task.time &&
                    task.time === timeStr &&
                    Array.isArray(task.repeatDays) &&
                    task.repeatDays.includes(dayOfWeek) &&
                    !completions?.[dateStr]?.[task.id]
                );
            });

            if (dueTasks.length === 0) continue;

            const tokensSnap = await db
                .collection("usuarios")
                .doc(uid)
                .collection("tokens")
                .get();

            const tokens = tokensSnap.docs
                .map((doc) => doc.data().token)
                .filter(Boolean);

            if (tokens.length === 0) continue;

            for (const task of dueTasks) {
                const sentId = `${dateStr}_${task.id}`;

                const sentRef = db
                    .collection("usuarios")
                    .doc(uid)
                    .collection("sentNotifications")
                    .doc(sentId);

                const sentSnap = await sentRef.get();

                if (sentSnap.exists) {
                    continue;
                }

                await sentRef.set({
                    taskId: task.id,
                    title: task.title,
                    time: task.time,
                    date: dateStr,
                    sentAt: FieldValue.serverTimestamp()
                });

                const title = "¡Hora de tu hábito!";
                const body = `${task.time} · ${task.title}`;

                const message = {
                    tokens,
                    data: {
                        title,
                        body,
                        tag: sentId,
                        taskId: String(task.id),
                        date: dateStr,
                        time: task.time,
                        url: APP_URL
                    },
                    webpush: {
                        fcmOptions: {
                            link: APP_URL
                        }
                    }
                };

                const response = await getMessaging().sendEachForMulticast(message);

                console.log(
                    `Enviada tarea ${task.title} a ${tokens.length} tokens. Correctas: ${response.successCount}`
                );

                const invalidCodes = new Set([
                    "messaging/registration-token-not-registered",
                    "messaging/invalid-registration-token"
                ]);

                await Promise.all(
                    response.responses.map(async (r, index) => {
                        if (!r.success && r.error && invalidCodes.has(r.error.code)) {
                            const badToken = tokens[index];

                            await db
                                .collection("usuarios")
                                .doc(uid)
                                .collection("tokens")
                                .doc(badToken)
                                .delete();
                        }
                    })
                );
            }
        }
    }
);
