import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

import {
  Plus,
  Check,
  Activity,
  Book,
  Dumbbell,
  Bell,
  Flame,
  ListFilter,
  X,
  Play,
  Pause,
  RotateCcw,
  LogOut,
  Loader2,
  Download,
  ChevronUp,
  ChevronDown,
  Trash2
} from 'lucide-react';

import { auth, googleProvider, db, messagingPromise } from './firebase';

import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'firebase/auth';

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from 'firebase/firestore';

import { getToken, onMessage } from 'firebase/messaging';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY || "";

// --- FECHAS ---
const getDaysArray = (start, daysToAdd) => {
  const days = [];

  for (let i = 0; i <= daysToAdd; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }

  return days;
};

const formatDateString = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}`;
};

const parseDateString = (dateStr) => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
};

const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const dayNamesShort = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

// --- SONIDO Y VIBRACIÓN ---
let appAudioContext = null;

const getAudioContext = () => {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;

    if (!AudioContext) return null;

    if (!appAudioContext) {
      appAudioContext = new AudioContext();
    }

    if (appAudioContext.state === 'suspended') {
      appAudioContext.resume();
    }

    return appAudioContext;
  } catch (error) {
    console.error('Audio no disponible:', error);
    return null;
  }
};

const playTone = (frequency = 880, duration = 130, volume = 0.08) => {
  const ctx = getAudioContext();

  if (!ctx) return;

  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration / 1000);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000 + 0.03);
  } catch (error) {
    console.error('Error reproduciendo sonido:', error);
  }
};

const playPhaseSound = () => {
  playTone(1100, 170, 0.18);
  setTimeout(() => playTone(760, 170, 0.15), 210);
};

const playFinishSound = () => {
  playTone(700, 170, 0.18);
  setTimeout(() => playTone(950, 170, 0.18), 210);
  setTimeout(() => playTone(1200, 240, 0.2), 440);
};

const doVibrate = (pattern) => {
  if ('vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
};

const unlockAudio = () => {
  const ctx = getAudioContext();

  if (!ctx) return;

  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();

    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (error) {
    console.error('No se pudo desbloquear audio:', error);
  }
};

// --- ORDEN MANUAL ---
const getOrderFromTime = (time) => {
  if (!time) return 9999900;

  const [hours, minutes] = time.split(':').map(Number);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 9999900;
  }

  return ((hours * 60) + minutes) * 100;
};

const normalizeTasksOrder = (tasksList) => {
  return [...tasksList].map((task, index) => ({
    ...task,
    repeatDays: Array.isArray(task.repeatDays) ? task.repeatDays : [],
    order: typeof task.order === 'number'
      ? task.order
      : getOrderFromTime(task.time) + index
  }));
};

const sortTasksByOrder = (tasksList) => {
  return normalizeTasksOrder(tasksList).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;

    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;

    return a.time.localeCompare(b.time);
  });
};

const getOrderForNewTask = (tasksList, time) => {
  const baseOrder = getOrderFromTime(time);
  const existingOrders = normalizeTasksOrder(tasksList).map(task => task.order);

  const sameHourOrders = existingOrders.filter(order =>
    order >= baseOrder && order < baseOrder + 100
  );

  if (sameHourOrders.length > 0) {
    return Math.max(...sameHourOrders) + 1;
  }

  return baseOrder;
};

// --- PORCENTAJE POR TAREA ---
const getTaskCompletionStats = (task, completions, today = new Date()) => {
  const repeatDays = Array.isArray(task.repeatDays) ? task.repeatDays : [];

  if (repeatDays.length === 0) {
    return {
      totalDays: 0,
      completedDays: 0,
      missedDays: 0,
      percentage: 0
    };
  }

  const completionDates = Object.keys(completions || {}).sort();

  const todayDate = new Date(today);
  todayDate.setHours(0, 0, 0, 0);

  let startDate;

  if (task.createdAtDate) {
    startDate = parseDateString(task.createdAtDate);
  } else if (completionDates.length > 0) {
    startDate = parseDateString(completionDates[0]);
  } else {
    startDate = new Date(todayDate);
  }

  if (startDate > todayDate) {
    startDate = new Date(todayDate);
  }

  let totalDays = 0;
  let completedDays = 0;

  const cursor = new Date(startDate);

  while (cursor <= todayDate) {
    const dateStr = formatDateString(cursor);
    const dayOfWeek = cursor.getDay();

    if (repeatDays.includes(dayOfWeek)) {
      totalDays += 1;

      if (completions?.[dateStr]?.[task.id]) {
        completedDays += 1;
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  const percentage = totalDays === 0
    ? 0
    : Math.round((completedDays / totalDays) * 100);

  return {
    totalDays,
    completedDays,
    missedDays: Math.max(0, totalDays - completedDays),
    percentage
  };
};

// --- TEMPORIZADOR MEDITACIÓN ---
const MeditationTimer = ({ onClose, onComplete }) => {
  const TOTAL_MS = 300000;

  const [remainingMs, setRemainingMs] = useState(TOTAL_MS);
  const [isActive, setIsActive] = useState(false);

  const endAtRef = useRef(null);
  const remainingWhenPausedRef = useRef(TOTAL_MS);
  const frameRef = useRef(null);
  const finishedRef = useRef(false);

  const finishTimer = useCallback(() => {
    if (finishedRef.current) return;

    finishedRef.current = true;
    setIsActive(false);
    setRemainingMs(0);
    remainingWhenPausedRef.current = 0;
    endAtRef.current = null;

    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    doVibrate([700, 150, 700]);
    playFinishSound();

    setTimeout(() => {
      onComplete();
    }, 350);
  }, [onComplete]);

  useEffect(() => {
    if (!isActive) return;

    if (!endAtRef.current) {
      endAtRef.current = performance.now() + remainingWhenPausedRef.current;
    }

    const tick = () => {
      const now = performance.now();
      const nextRemaining = Math.max(0, endAtRef.current - now);

      setRemainingMs(nextRemaining);

      if (nextRemaining <= 0) {
        finishTimer();
        return;
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isActive, finishTimer]);

  const toggleTimer = () => {
    unlockAudio();

    if (finishedRef.current) return;

    if (isActive) {
      remainingWhenPausedRef.current = remainingMs;
      endAtRef.current = null;
      setIsActive(false);
    } else {
      playTone(700, 180, 0.16);
      endAtRef.current = null;
      setIsActive(true);
    }
  };

  const resetTimer = () => {
    finishedRef.current = false;
    setIsActive(false);
    setRemainingMs(TOTAL_MS);

    remainingWhenPausedRef.current = TOTAL_MS;
    endAtRef.current = null;

    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  const elapsedMs = TOTAL_MS - remainingMs;
  const totalSecondsLeft = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSecondsLeft / 60);
  const seconds = totalSecondsLeft % 60;
  const progress = (elapsedMs / TOTAL_MS) * 100;

  return (
    <div className="absolute inset-0 z-[70] bg-[#0f172a] flex flex-col items-center justify-between py-12 px-6">
      <div className="w-full flex justify-between items-center">
        <button onClick={onClose} className="p-2 bg-slate-800 rounded-full text-indigo-300 hover:text-white">
          <X size={24} />
        </button>

        <h2 className="text-xl font-bold text-indigo-400 tracking-widest uppercase">Meditación</h2>

        <div className="w-10" />
      </div>

      <div className="relative w-72 h-72 flex flex-col items-center justify-center mt-10">
        <svg className="absolute inset-0 w-full h-full -rotate-90">
          <circle cx="144" cy="144" r="136" className="stroke-slate-800" strokeWidth="6" fill="none" />

          <circle
            cx="144"
            cy="144"
            r="136"
            className="stroke-indigo-500 transition-all duration-75 ease-linear"
            strokeWidth="8"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="854"
            strokeDashoffset={854 - (854 * progress) / 100}
          />
        </svg>

        <div className="z-10 flex flex-col items-center text-center">
          <div className="text-6xl font-light text-white tabular-nums tracking-tight drop-shadow-lg">
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
          </div>

          <div className="mt-4 text-indigo-300 text-sm tracking-widest uppercase opacity-80">
            {isActive ? 'Respira profundamente' : remainingMs <= 0 ? 'Completado' : 'Pausa'}
          </div>
        </div>

        <div className={`absolute inset-0 bg-indigo-500/10 rounded-full blur-3xl -z-10 transition-opacity duration-1000 ${isActive ? 'opacity-100' : 'opacity-0'}`} />
      </div>

      <div className="flex gap-6 mt-auto mb-10">
        <button
          onClick={resetTimer}
          className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-indigo-300 hover:text-white transition-colors"
        >
          <RotateCcw size={24} />
        </button>

        <button
          onClick={toggleTimer}
          className={`w-20 h-20 rounded-full flex items-center justify-center text-white shadow-xl transition-all active:scale-95 ${isActive ? 'bg-slate-700 shadow-black' : 'bg-indigo-600 shadow-indigo-600/30'}`}
        >
          {isActive ? <Pause size={32} className="fill-white" /> : <Play size={36} className="fill-white ml-2" />}
        </button>
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataReady, setDataReady] = useState(false);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());

  const [tasks, setTasks] = useState([]);
  const [completions, setCompletions] = useState({});

  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskTime, setTaskTime] = useState('');
  const [taskDays, setTaskDays] = useState([1, 2, 3, 4, 5]);
  const [formError, setFormError] = useState('');
  const [taskToDelete, setTaskToDelete] = useState(null);

  const [activeMeditationTask, setActiveMeditationTask] = useState(null);

  const [longPressTaskId, setLongPressTaskId] = useState(null);
  const [longPressProgress, setLongPressProgress] = useState(0);

  const [isOrdering, setIsOrdering] = useState(false);

  const calendarRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressIntervalRef = useRef(null);
  const longPressTriggeredRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    if (longPressIntervalRef.current) clearInterval(longPressIntervalRef.current);

    longPressTimerRef.current = null;
    longPressIntervalRef.current = null;

    setLongPressTaskId(null);
    setLongPressProgress(0);
  };

  const openEditModalFromTask = (task) => {
    setEditingTask(task);
    setTaskTitle(task.title);
    setTaskTime(task.time || '');
    setTaskDays(Array.isArray(task.repeatDays) ? [...task.repeatDays] : []);
    setFormError('');
    setTaskToDelete(null);
    setIsModalOpen(true);
  };

  const startLongPressToEdit = (task, event) => {
    if (isOrdering) return;
    if (event.button && event.button !== 0) return;

    clearLongPress();
    longPressTriggeredRef.current = false;

    const startedAt = Date.now();

    setLongPressTaskId(task.id);
    setLongPressProgress(0);

    longPressIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(100, (elapsed / 3000) * 100);
      setLongPressProgress(progress);
    }, 50);

    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      clearLongPress();
      doVibrate([100, 70, 100]);
      playTone(500, 120, 0.07);
      openEditModalFromTask(task);
    }, 3000);
  };

  useEffect(() => {
    return () => clearLongPress();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentDate(new Date());
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setAuthLoading(true);

      if (!currentUser) {
        setUser(null);
        setDataReady(false);
        setAuthLoading(false);
        return;
      }

      try {
        setUser(currentUser);
        setDataReady(false);

        const userRef = doc(db, 'usuarios', currentUser.uid);
        const snap = await getDoc(userRef);

        if (snap.exists()) {
          const data = snap.data();

          setTasks(Array.isArray(data.tasks) ? normalizeTasksOrder(data.tasks) : []);
          setCompletions(data.completions || {});
        } else {
          setTasks([]);
          setCompletions({});

          await setDoc(userRef, {
            email: currentUser.email,
            displayName: currentUser.displayName || '',
            photoURL: currentUser.photoURL || '',
            tasks: [],
            completions: {},
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          }, { merge: true });
        }

        setDataReady(true);
      } catch (error) {
        console.error('Error cargando datos:', error);
        setTasks([]);
        setCompletions({});
        setDataReady(true);
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !dataReady) return;

    const timeout = setTimeout(async () => {
      try {
        await setDoc(doc(db, 'usuarios', user.uid), {
          email: user.email,
          displayName: user.displayName || '',
          photoURL: user.photoURL || '',
          tasks: normalizeTasksOrder(tasks),
          completions,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } catch (error) {
        console.error('Error guardando datos:', error);
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [tasks, completions, user, dataReady]);

  useEffect(() => {
    const handler = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };

    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  const handleInstallApp = async () => {
    if (!installPrompt) return;

    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.warn('Popup falló, usando redirect:', error);
      await signInWithRedirect(auth, googleProvider);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const calendarStrip = useMemo(() => {
    const start = new Date(currentDate);
    start.setDate(currentDate.getDate() - 15);
    return getDaysArray(start, 30);
  }, [currentDate]);

  const selectedDateStr = formatDateString(selectedDate);
  const todayStr = formatDateString(currentDate);
  const dayOfWeek = selectedDate.getDay();

  useEffect(() => {
    if (calendarRef.current) {
      const todayEl = calendarRef.current.querySelector('.is-today');

      if (todayEl) {
        todayEl.scrollIntoView({
          behavior: 'smooth',
          inline: 'center',
          block: 'nearest'
        });
      }
    }
  }, [dataReady]);

  const dailyTasks = useMemo(() => {
    return sortTasksByOrder(
      tasks.filter(task => task.repeatDays.includes(dayOfWeek))
    );
  }, [tasks, dayOfWeek]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      setNotificationsEnabled(true);
    }
  }, []);

  const showBrowserNotification = async (title, options = {}) => {
    if (!('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;

    const finalOptions = {
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      ...options
    };

    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;

        if (registration && registration.showNotification) {
          await registration.showNotification(title, finalOptions);
          return true;
        }
      }

      new Notification(title, finalOptions);
      return true;
    } catch (error) {
      console.error('Error mostrando notificación:', error);

      try {
        new Notification(title, finalOptions);
        return true;
      } catch {
        return false;
      }
    }
  };

  const requestNotifications = async () => {
    if (!user) {
      alert("Inicia sesión primero.");
      return;
    }

    if (!("Notification" in window)) {
      alert("Este navegador no soporta notificaciones.");
      return;
    }

    try {
      unlockAudio();

      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        alert("Permiso denegado. Actívalo desde los ajustes del navegador o móvil.");
        return;
      }

      const messaging = await messagingPromise;

      if (!messaging) {
        alert("Firebase Messaging no está soportado en este navegador.");
        return;
      }

      if (!VAPID_KEY) {
        alert("Configura VITE_FIREBASE_VAPID_KEY para activar las notificaciones push.");
        return;
      }

      const registration = await navigator.serviceWorker.ready;

      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration
      });

      if (!token) {
        alert("No se pudo obtener el token de notificaciones.");
        return;
      }

      await setDoc(doc(db, "usuarios", user.uid, "tokens", token), {
        token,
        email: user.email,
        userAgent: navigator.userAgent,
        platform: navigator.platform || "",
        updatedAt: serverTimestamp()
      }, { merge: true });

      setNotificationsEnabled(true);

      doVibrate([100, 70, 100]);
      playFinishSound();

      await showBrowserNotification("Notificaciones activadas", {
        body: "Ya puedo avisarte cuando toque una tarea.",
        tag: "notificaciones-activadas"
      });

      alert("Notificaciones activadas correctamente.");
    } catch (error) {
      console.error("Error activando notificaciones:", error);
      alert("No se pudieron activar las notificaciones. Abre la consola para ver el error.");
    }
  };

  useEffect(() => {
    let unsubscribe = null;

    const startForegroundMessages = async () => {
      const messaging = await messagingPromise;

      if (!messaging) return;

      unsubscribe = onMessage(messaging, (payload) => {
        showBrowserNotification(
          payload.data?.title || payload.notification?.title || "Rutina diaria",
          {
            body: payload.data?.body || payload.notification?.body || "Tienes una tarea pendiente.",
            tag: payload.data?.tag || `rutina-${Date.now()}`
          }
        );

        doVibrate([300, 100, 300]);
        playPhaseSound();
      });
    };

    startForegroundMessages();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const toggleTask = (taskId) => {
    setCompletions(prev => {
      const dayCompletions = prev[selectedDateStr] || {};

      return {
        ...prev,
        [selectedDateStr]: {
          ...dayCompletions,
          [taskId]: !dayCompletions[taskId]
        }
      };
    });
  };

  const markTaskComplete = (taskId) => {
    setCompletions(prev => {
      const dayCompletions = prev[selectedDateStr] || {};

      return {
        ...prev,
        [selectedDateStr]: {
          ...dayCompletions,
          [taskId]: true
        }
      };
    });
  };

  const handleTaskClick = (task) => {
    if (isOrdering) return;

    const titleLower = task.title.toLowerCase();
    const isMeditation = titleLower.includes('meditar') || titleLower.includes('meditación');

    if (!completions[selectedDateStr]?.[task.id]) {
      if (isMeditation) {
        setActiveMeditationTask(task);
        return;
      }
    }

    toggleTask(task.id);
  };

  const openCreateModal = () => {
    setEditingTask(null);
    setTaskTitle('');
    setTaskTime('');
    setTaskDays([1, 2, 3, 4, 5]);
    setFormError('');
    setTaskToDelete(null);
    setIsModalOpen(true);
  };

  const toggleDaySelection = (dayIndex) => {
    if (taskDays.includes(dayIndex)) {
      setTaskDays(taskDays.filter(d => d !== dayIndex));
    } else {
      setTaskDays([...taskDays, dayIndex]);
    }
  };

  const saveTask = () => {
    if (!taskTitle.trim() || taskDays.length === 0) {
      setFormError('Debes poner un título y elegir al menos un día.');
      return;
    }

    setFormError('');

    if (editingTask) {
      setTasks(sortTasksByOrder(
        tasks.map(t => {
          if (t.id !== editingTask.id) return t;

          const timeChanged = t.time !== taskTime;

          return {
            ...t,
            title: taskTitle.trim(),
            time: taskTime,
            repeatDays: taskDays,
            order: timeChanged
              ? getOrderForNewTask(tasks.filter(task => task.id !== t.id), taskTime)
              : t.order
          };
        })
      ));
    } else {
      const newTask = {
        id: Date.now().toString(),
        title: taskTitle.trim(),
        time: taskTime,
        type: 'Tarea',
        icon: 'Plus',
        color: 'bg-pink-600',
        repeatDays: taskDays,
        order: getOrderForNewTask(tasks, taskTime),
        createdAtDate: todayStr
      };

      setTasks(sortTasksByOrder([...tasks, newTask]));
    }

    setIsModalOpen(false);
    setEditingTask(null);
    setTaskToDelete(null);
  };

  const deleteTask = (taskId) => {
    if (!taskId) return;

    setTasks(tasks.filter(t => t.id !== taskId));

    setCompletions(prev => {
      const updated = { ...prev };

      Object.keys(updated).forEach(dateKey => {
        if (updated[dateKey]?.[taskId] !== undefined) {
          const dayCopy = { ...updated[dateKey] };
          delete dayCopy[taskId];
          updated[dateKey] = dayCopy;
        }
      });

      return updated;
    });

    setTaskToDelete(null);
    setEditingTask(null);
    setIsModalOpen(false);
  };

  const confirmDelete = () => {
    if (!taskToDelete) return;
    deleteTask(taskToDelete);
  };

  const moveTask = (taskId, direction) => {
    const currentIndex = dailyTasks.findIndex(task => task.id === taskId);
    const targetIndex = currentIndex + direction;

    if (currentIndex === -1 || targetIndex < 0 || targetIndex >= dailyTasks.length) {
      return;
    }

    const currentTask = dailyTasks[currentIndex];
    const targetTask = dailyTasks[targetIndex];

    setTasks(prevTasks => {
      const normalized = normalizeTasksOrder(prevTasks);

      return normalized.map(task => {
        if (task.id === currentTask.id) {
          return { ...task, order: targetTask.order };
        }

        if (task.id === targetTask.id) {
          return { ...task, order: currentTask.order };
        }

        return task;
      });
    });
  };

  const completedCount = dailyTasks.filter(t => completions[selectedDateStr]?.[t.id]).length;
  const totalTasks = dailyTasks.length;
  const progressPercent = totalTasks === 0 ? 100 : Math.round((completedCount / totalTasks) * 100);

  const calculateStreak = () => {
    if (tasks.length === 0) return 0;

    const completionDates = Object.keys(completions).sort();

    if (completionDates.length === 0) return 0;

    const firstDate = parseDateString(completionDates[0]);

    let streak = 0;

    const today = new Date(currentDate);
    today.setHours(0, 0, 0, 0);

    const diffTime = today.getTime() - firstDate.getTime();
    const diffDays = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    for (let i = 0; i <= diffDays; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);

      const dateStr = formatDateString(d);
      const currentDayOfWeek = d.getDay();

      const dayTasks = tasks.filter(t => t.repeatDays.includes(currentDayOfWeek));

      if (dayTasks.length === 0) {
        streak++;
        continue;
      }

      const completedOfDay = dayTasks.filter(t => completions[dateStr]?.[t.id]).length;

      if (i === 0) {
        if (completedOfDay === dayTasks.length) {
          streak++;
        }
      } else {
        if (completedOfDay === dayTasks.length) {
          streak++;
        } else {
          break;
        }
      }
    }

    return streak;
  };

  const currentStreak = calculateStreak();

  const renderIcon = (iconName, colorClass) => {
    const textColor = colorClass ? colorClass.replace('bg-', 'text-') : 'text-gray-400';

    switch (iconName) {
      case 'Activity':
        return <Activity size={18} className={textColor} />;
      case 'Book':
        return <Book size={18} className={textColor} />;
      case 'Dumbbell':
        return <Dumbbell size={18} className={textColor} />;
      default:
        return <Plus size={18} className={textColor} />;
    }
  };

  if (authLoading) {
    return (
      <div className="fixed inset-0 bg-[#121212] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="animate-spin text-pink-600" size={36} />
          <p className="text-sm text-gray-400">Cargando rutina...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="fixed inset-0 bg-[#121212] text-white flex items-center justify-center px-5 overflow-hidden">
        <div className="w-full max-w-sm bg-[#1a1a1a] border border-neutral-800 rounded-3xl p-7 shadow-2xl">
          <div className="w-20 h-20 rounded-3xl bg-pink-600 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-pink-600/30">
            <Flame size={42} className="text-white" />
          </div>

          <h1 className="text-3xl font-black text-center mb-2">Rutina diaria</h1>

          <p className="text-gray-400 text-center text-sm mb-7">
            Inicia sesión para guardar tus tareas, checks, racha y notificaciones.
          </p>

          <button
            onClick={handleLogin}
            className="w-full bg-white text-black font-bold py-4 rounded-2xl flex items-center justify-center gap-3 active:scale-[0.98] transition-transform"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>

            Continuar con Google
          </button>

          <p className="text-xs text-gray-500 text-center mt-5">
            Tus datos se guardan en Firebase asociados a tu email.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-[#121212] text-gray-200 font-sans overflow-hidden overscroll-none">
      <div className="h-[100dvh] w-full max-w-md mx-auto relative flex flex-col overflow-hidden bg-[#121212]">

        <header className="px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-2 shrink-0">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <ListFilter size={24} className="text-pink-600 shrink-0" />

              <h1 className="text-2xl font-bold text-white truncate">
                {selectedDateStr === todayStr ? 'Hoy' : `${dayNames[dayOfWeek]} ${selectedDate.getDate()}`}
              </h1>

              <div className="ml-1 flex items-center gap-1 bg-orange-500/20 px-2 py-1 rounded-full shrink-0">
                <Flame size={16} className="text-orange-500" />
                <span className="text-orange-500 font-bold text-sm">{currentStreak}</span>
              </div>
            </div>

            <div className="flex gap-2 text-gray-400 items-center shrink-0">
              {installPrompt && (
                <button onClick={handleInstallApp} className="p-2 bg-neutral-800 rounded-full hover:text-white">
                  <Download size={19} />
                </button>
              )}

              <button
                onClick={() => setIsOrdering(!isOrdering)}
                className={`px-3 py-2 rounded-full text-xs font-bold transition-colors ${isOrdering ? 'bg-lime-500 text-black' : 'bg-neutral-800 text-gray-300'
                  }`}
                title="Ordenar tareas"
              >
                {isOrdering ? 'Hecho' : 'Ordenar'}
              </button>

              <button
                onClick={requestNotifications}
                className={`p-2 rounded-full hover:text-white ${notificationsEnabled ? 'bg-pink-600 text-white' : 'bg-neutral-800'}`}
                title="Activar notificaciones push"
              >
                <Bell size={19} />
              </button>

              <button onClick={handleLogout} className="p-2 bg-neutral-800 rounded-full hover:text-red-400">
                <LogOut size={19} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3">
            {user.photoURL && (
              <img src={user.photoURL} alt="perfil" className="w-7 h-7 rounded-full" />
            )}

            <p className="text-xs text-gray-500 truncate">{user.email}</p>
          </div>

          <div ref={calendarRef} className="flex overflow-x-auto hide-scrollbar gap-2 pb-2 scroll-smooth">
            {calendarStrip.map((date, idx) => {
              const dateStr = formatDateString(date);
              const isSelected = dateStr === selectedDateStr;
              const isToday = dateStr === todayStr;

              return (
                <div
                  key={idx}
                  onClick={() => setSelectedDate(date)}
                  className={`flex flex-col items-center justify-center min-w-[3.5rem] py-2 rounded-xl cursor-pointer transition-colors ${isToday ? 'is-today' : ''}
                    ${isSelected ? 'bg-pink-600 text-white' : 'bg-neutral-800/50 text-gray-400 hover:bg-neutral-800'}
                    ${isToday && !isSelected ? 'border border-pink-600/50' : ''}
                  `}
                >
                  <span className="text-xs mb-1">{dayNames[date.getDay()]}</span>
                  <span className="text-lg font-bold">{date.getDate()}</span>
                </div>
              );
            })}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] space-y-1 custom-scrollbar">

          {!notificationsEnabled && (
            <div
              onClick={requestNotifications}
              className="bg-pink-600/10 border border-pink-600/30 text-pink-500 rounded-xl p-3 flex items-center justify-between cursor-pointer mb-4 mt-1 hover:bg-pink-600/20 transition-colors"
            >
              <span className="text-sm font-medium">Activar notificaciones push</span>
              <Bell size={18} className="animate-pulse" />
            </div>
          )}

          <div className="text-xs text-gray-600 mb-2 px-1">
            {isOrdering
              ? 'Usa las flechas para mover las tareas arriba o abajo.'
              : 'Mantén pulsada una tarea 3 segundos para editarla.'}
          </div>

          {dailyTasks.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
              <p>No hay tareas para este día.</p>
              <p className="text-sm mt-2">¡Día de descanso, tu racha está a salvo!</p>
            </div>
          ) : (
            dailyTasks.map((task) => {
              const isCompleted = completions[selectedDateStr]?.[task.id];
              const stats = getTaskCompletionStats(task, completions, currentDate);

              return (
                <div
                  key={task.id}
                  onPointerDown={(e) => startLongPressToEdit(task, e)}
                  onPointerUp={clearLongPress}
                  onPointerCancel={clearLongPress}
                  onPointerLeave={clearLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                  className={`relative flex items-center justify-between group py-2.5 px-1 border-b border-neutral-800/50 transition-colors rounded-lg select-none ${isOrdering ? 'bg-neutral-900/40' : 'hover:bg-neutral-800/30'
                    }`}
                >
                  {longPressTaskId === task.id && (
                    <div
                      className="absolute left-0 bottom-0 h-0.5 bg-pink-500 rounded-full transition-all"
                      style={{ width: `${longPressProgress}%` }}
                    />
                  )}

                  <div
                    className="flex items-center gap-3 flex-1 cursor-pointer overflow-hidden"
                    onClick={(e) => {
                      if (longPressTriggeredRef.current) {
                        e.preventDefault();
                        longPressTriggeredRef.current = false;
                        return;
                      }

                      handleTaskClick(task);
                    }}
                  >
                    <div className="shrink-0">
                      {renderIcon(task.icon, task.color)}
                    </div>

                    {task.time && (
                      <span className="text-sm font-bold text-pink-500 shrink-0">{task.time}</span>
                    )}

                    <span className={`text-[15px] truncate transition-colors ${isCompleted ? 'text-gray-600 line-through' : 'text-gray-200'}`}>
                      {task.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {isOrdering ? (
                      <>
                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveTask(task.id, -1);
                          }}
                          className="text-gray-400 hover:text-white p-1 transition-colors"
                          title="Subir tarea"
                        >
                          <ChevronUp size={20} />
                        </button>

                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveTask(task.id, 1);
                          }}
                          className="text-gray-400 hover:text-white p-1 transition-colors"
                          title="Bajar tarea"
                        >
                          <ChevronDown size={20} />
                        </button>
                      </>
                    ) : (
                      <>
                        <div
                          className={`min-w-[44px] text-right text-xs font-black ${stats.percentage >= 80
                            ? 'text-lime-500'
                            : stats.percentage >= 50
                              ? 'text-orange-400'
                              : 'text-red-400'
                            }`}
                          title={`${stats.completedDays}/${stats.totalDays} días completados`}
                        >
                          {stats.percentage}%
                        </div>

                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          className="w-6 h-6 flex items-center justify-center cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleTask(task.id);
                          }}
                        >
                          {isCompleted ? (
                            <div className="w-5 h-5 rounded-full bg-lime-500 flex items-center justify-center">
                              <Check size={12} className="text-black" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-600" />
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {dailyTasks.length > 0 && (
            <div className="mt-8 mb-4 p-4 bg-neutral-900 rounded-2xl border border-neutral-800">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-400">Progreso Diario</span>
                <span className="font-bold text-white">{completedCount} / {totalTasks} ({progressPercent}%)</span>
              </div>

              <div className="w-full h-3 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-pink-600 to-orange-500 transition-all duration-500 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              {progressPercent === 100 && (
                <p className="text-center text-lime-500 text-sm mt-3 font-medium">¡Día completado! Racha asegurada 🔥</p>
              )}
            </div>
          )}
        </main>

        <button
          onClick={openCreateModal}
          className="absolute bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] right-6 w-14 h-14 bg-pink-600 hover:bg-pink-700 transition-colors rounded-2xl flex items-center justify-center shadow-lg shadow-pink-600/30 z-10"
        >
          <Plus size={30} className="text-white" />
        </button>

        {isModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-[#1a1a1a] border border-neutral-800 rounded-t-3xl sm:rounded-3xl p-6 w-full max-w-sm space-y-6 pb-safe">

              <div className="flex justify-between items-center border-b border-neutral-800 pb-4">
                <h2 className="text-xl font-bold text-white">
                  {editingTask ? 'Editar Hábito' : 'Nuevo Hábito'}
                </h2>

                <button
                  onClick={() => {
                    setIsModalOpen(false);
                    setEditingTask(null);
                    setTaskToDelete(null);
                  }}
                  className="bg-neutral-800 p-2 rounded-full hover:bg-neutral-700 transition-colors"
                >
                  <X size={20} className="text-gray-400" />
                </button>
              </div>

              <div className="space-y-4">
                {formError && (
                  <div className="bg-red-500/10 border border-red-500/50 text-red-500 px-4 py-2 rounded-xl text-sm">
                    {formError}
                  </div>
                )}

                <div>
                  <label className="text-sm text-gray-400 mb-1 block">
                    ¿Qué quieres lograr?
                  </label>

                  <input
                    type="text"
                    value={taskTitle}
                    onChange={e => setTaskTitle(e.target.value)}
                    placeholder="Ej: Leer 20 páginas"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-white text-base outline-none focus:border-pink-600 transition-colors"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-400 mb-1 block">
                    Hora del recordatorio
                  </label>

                  <input
                    type="time"
                    value={taskTime}
                    onChange={e => setTaskTime(e.target.value)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-white text-base outline-none focus:border-pink-600 transition-colors [color-scheme:dark]"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-400 mb-2 block">
                    Días de la semana
                  </label>

                  <div className="flex justify-between">
                    {dayNamesShort.map((dayLabel, index) => {
                      const isSelected = taskDays.includes(index);

                      return (
                        <button
                          key={index}
                          onClick={() => toggleDaySelection(index)}
                          className={`w-10 h-10 rounded-full flex items-center justify-center font-medium transition-colors ${isSelected
                            ? 'bg-pink-600 text-white shadow-md shadow-pink-600/20'
                            : 'bg-neutral-800 text-gray-400 hover:bg-neutral-700'
                            }`}
                        >
                          {dayLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {editingTask && (
                  <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-sm font-bold text-white">Opciones de esta tarea</p>
                        <p className="text-xs text-gray-500">Aquí puedes eliminarla definitivamente.</p>
                      </div>

                      <button
                        onClick={() => setTaskToDelete(editingTask.id)}
                        className="bg-red-500/10 border border-red-500/30 text-red-500 hover:bg-red-500/20 px-3 py-2 rounded-xl flex items-center gap-2 text-sm font-bold transition-colors"
                      >
                        <Trash2 size={16} />
                        Borrar
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-4 border-t border-neutral-800">
                <button
                  onClick={saveTask}
                  className="flex-1 bg-pink-600 hover:bg-pink-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-pink-600/20"
                >
                  Guardar Hábito
                </button>
              </div>

            </div>
          </div>
        )}

        {taskToDelete && (
          <div className="absolute inset-0 z-[80] bg-black/85 flex items-center justify-center p-4">
            <div className="bg-[#1a1a1a] border border-neutral-800 rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-2xl">
              <h3 className="text-lg font-bold text-white">¿Borrar hábito?</h3>

              <p className="text-gray-400 text-sm">
                Esta acción no se puede deshacer y la tarea se eliminará de tu rutina diaria.
              </p>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setTaskToDelete(null)}
                  className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-white font-medium py-3 rounded-xl transition-colors"
                >
                  Cancelar
                </button>

                <button
                  onClick={confirmDelete}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-red-600/20"
                >
                  Sí, borrar
                </button>
              </div>
            </div>
          </div>
        )}

        {activeMeditationTask && (
          <MeditationTimer
            onClose={() => setActiveMeditationTask(null)}
            onComplete={() => {
              markTaskComplete(activeMeditationTask.id);
              setActiveMeditationTask(null);
            }}
          />
        )}

        <style dangerouslySetInnerHTML={{
          __html: `
            .hide-scrollbar::-webkit-scrollbar {
              display: none;
            }

            .hide-scrollbar {
              -ms-overflow-style: none;
              scrollbar-width: none;
            }

            .custom-scrollbar::-webkit-scrollbar {
              width: 4px;
            }

            .custom-scrollbar::-webkit-scrollbar-track {
              background: transparent;
            }

            .custom-scrollbar::-webkit-scrollbar-thumb {
              background: #333;
              border-radius: 10px;
            }

            .pb-safe {
              padding-bottom: env(safe-area-inset-bottom, 1rem);
            }

            button,
            input {
              touch-action: manipulation;
            }

            * {
              -webkit-tap-highlight-color: transparent;
            }
          `
        }} />
      </div>
    </div>
  );
}
