import { useEffect, useRef } from "react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { type DailyNote, plainText, todayOpenItems, todayStr, tomorrowItems } from "./lib/notes";

const LAST_KEY = "reminded-on";

function lastReminded(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

function markReminded(date: string) {
  try {
    localStorage.setItem(LAST_KEY, date);
  } catch {
    /* may repeat after a restart; harmless */
  }
}

async function canNotify(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** Sends the "left for today" notification. Returns false when there is nothing left. */
export async function sendReminder(note: DailyNote | undefined): Promise<boolean> {
  const open = note ? todayOpenItems(note.content) : [];
  if (open.length === 0 || !(await canNotify())) return false;
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const lines = open.slice(0, 3).map((t) => `• ${short(plainText(t.text))}`);
  if (open.length > 3) lines.push(`외 ${open.length - 3}개`);
  if (note && tomorrowItems(note.content).length === 0) lines.push("내일 할 것도 적어 두세요");
  sendNotification({ title: `남은 할 일 ${open.length}개`, body: lines.join("\n") });
  return true;
}

/**
 * Once a day, at or after `at` ("HH:MM"), notifies about today's unchecked items.
 * Opening the app later in the evening still sends that day's reminder.
 */
export function useEveningReminder(at: string, notes: DailyNote[]) {
  const notesRef = useRef(notes);
  notesRef.current = notes;

  useEffect(() => {
    if (!at) return;
    const [h, m] = at.split(":").map(Number);
    const tick = async () => {
      const now = new Date();
      const today = todayStr(now);
      if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
      if (lastReminded() === today || notesRef.current.length === 0) return;
      markReminded(today);
      await sendReminder(notesRef.current.find((n) => n.date === today));
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [at]);
}
