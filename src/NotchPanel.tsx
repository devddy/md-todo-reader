import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type AddTarget,
  type DailyNote,
  type TaskItem,
  addTodo,
  briefSkeleton,
  checkableItems,
  itemsUnder,
  todayStr,
  toggleLine,
} from "./lib/notes";
import { splitLinks } from "./lib/brief";
import { InlineMd, Link } from "./components";
import "./NotchPanel.css";

// The notch panel: today's "오늘 꼭" and "내일 할 것" — check items, add new ones.
// Rust (notch.rs) shows/hides the window on hover; this side renders the
// note, reports its height, toggles lines and appends bullets.

const VAULT_KEY = "vault"; // same key as App.tsx; localStorage is shared per origin
const TODAY_RE = /^오늘\s?꼭/;
const TOMORROW_RE = /내일|tomorrow/i;
const CARRIED_RE = /^\(이월\)\s*/;
const SLACK = 4; // px added to the reported height

type NotchState = { open: boolean; maxHeight: number };

function loadVault(): string | null {
  try {
    return localStorage.getItem(VAULT_KEY);
  } catch {
    return null;
  }
}

export default function NotchPanel() {
  const [note, setNote] = useState<DailyNote | null | undefined>(undefined); // undefined = not loaded
  const [error, setError] = useState<string | null>(null);
  const [maxHeight, setMaxHeight] = useState(() => Math.round(window.screen.availHeight * 0.85));
  const [openCount, setOpenCount] = useState(0); // remounts the panel to replay the drop-in
  const box = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<AddTarget>("tomorrow"); // daily-todo's default too
  const [focused, setFocused] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: false }); // list edges with more to scroll

  // Reads today's note fresh; the vault may have been picked in the main window meanwhile.
  const refresh = useCallback(async () => {
    const vault = loadVault();
    if (!vault) {
      setNote(null);
      setError("메인 창에서 노트 폴더를 먼저 골라 주세요");
      return;
    }
    try {
      setNote(await invoke<DailyNote | null>("find_daily", { vault, date: todayStr() }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // The main window owns the watcher; `vault-changed` is broadcast to every window.
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    refresh();
    const unVault = listen("vault-changed", () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refresh, 150);
    });
    const unState = listen<NotchState>("notch-state", ({ payload }) => {
      setMaxHeight(payload.maxHeight);
      if (!payload.open) input.current?.blur();
      if (payload.open) {
        setOpenCount((n) => n + 1);
        refresh(); // date may have rolled over since the last open
      }
    });
    return () => {
      unVault.then((f) => f());
      unState.then((f) => f());
    };
  }, [refresh]);

  // Window height follows the content, so the "inside" area for auto-collapse matches
  // what is drawn. Report the natural height — the panel minus the visible part of the
  // list plus its full scrollHeight — never the window's current height, or the window
  // could never grow. Rust caps it (85% of the screen); past the cap the list scrolls.
  const measure = useCallback(() => {
    const el = box.current;
    const list = scroll.current;
    if (!el || !list) return;
    // offsetHeight already covers the paddings and the add row; a few pt of slack
    // keep the window from ever ending above the drawn bottom edge.
    const height = el.offsetHeight - list.clientHeight + list.scrollHeight + SLACK;
    invoke("notch_set_height", { height: Math.ceil(height) }).catch(() => {});
    updateFade();
  }, []);

  // Fade only the list edge that has more content beyond it.
  function updateFade() {
    const list = scroll.current;
    if (!list) return;
    const top = list.scrollTop > 0;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  }

  useEffect(() => {
    const ro = new ResizeObserver(measure);
    for (const el of [box.current, scroll.current?.firstElementChild]) if (el) ro.observe(el);
    const frame = requestAnimationFrame(measure); // after the drop-in starts on open
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measure, openCount]);

  useLayoutEffect(measure, [measure, note, error, maxHeight]);

  // While typing (or holding unsent text) the panel must not auto-collapse, and it
  // needs to be the key window to get keystrokes; dropping focus hands the keyboard back.
  const pinned = focused || draft.trim() !== "";
  useEffect(() => {
    invoke("notch_set_pinned", { pinned, key: focused }).catch(() => {});
  }, [pinned, focused]);

  // Clicking another app takes key status away without blurring the input.
  useEffect(() => {
    const onBlur = () => input.current?.blur();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Re-read right before writing and check the line still holds the same item,
  // so a toggle never clobbers edits from the main window, Obsidian or /daily-brief.
  async function toggle(item: TaskItem) {
    if (!note) return;
    try {
      const fresh = await invoke<string>("read_note", { path: note.path });
      const cur = checkableItems(fresh).find((t) => t.line === item.line);
      if (!cur || cur.text !== item.text) {
        refresh();
        return;
      }
      const content = toggleLine(fresh, item.line);
      setNote({ ...note, content });
      await invoke("write_note", { path: note.path, content });
    } catch (e) {
      setError(String(e));
      refresh();
    }
  }

  // Same line format as the daily-todo skill (see addTodo), on a fresh read of the file.
  // A missing note is created with the skill's skeleton next to the other daily notes.
  async function add(text: string, to: AddTarget) {
    const vault = loadVault();
    if (!vault) return;
    const date = todayStr();
    try {
      const found = await invoke<DailyNote | null>("find_daily", { vault, date });
      const path = found?.path ?? (await invoke<string>("new_daily_path", { vault, date }));
      const base = found?.content ?? briefSkeleton(date);
      const content = addTodo(base, text, to);
      if (content === base) return; // empty or already there
      setNote({ date, path, content });
      await invoke("write_note", { path, content });
    } catch (e) {
      setError(String(e));
      refresh();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // Korean IME: Enter commits the syllable first
    if (e.key === "Enter") {
      e.preventDefault();
      if (draft.trim()) add(draft, target);
      setDraft("");
      input.current?.blur();
    } else if (e.key === "Escape") {
      setDraft("");
      input.current?.blur();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setTarget((t) => (t === "today" ? "tomorrow" : "today"));
    }
  }

  // Clicking a list title picks it as the add target and jumps into the input.
  function addTo(to: AddTarget) {
    setTarget(to);
    invoke("notch_set_pinned", { pinned: true, key: true }).catch(() => {});
    input.current?.focus();
  }

  const today = note ? itemsUnder(note.content, TODAY_RE) : [];
  const tomorrow = note ? itemsUnder(note.content, TOMORROW_RE) : [];

  return (
    <div
      className="notch"
      ref={box}
      key={openCount}
      style={{ maxHeight }}
    >
      <div
        className={`notch-scroll${fade.top ? " fade-top" : ""}${fade.bottom ? " fade-bottom" : ""}`}
        ref={scroll}
        onScroll={updateFade}
      >
        <div>
          {error ? (
            <p className="notch-empty">{error}</p>
          ) : note === null ? (
            <p className="notch-empty">오늘 브리핑 노트 없음</p>
          ) : note ? (
            <>
              <NotchList title="오늘 꼭" items={today} onToggle={toggle} onAdd={() => addTo("today")} />
              <NotchList
                title="내일 할 것"
                items={tomorrow}
                onToggle={toggle}
                onAdd={() => addTo("tomorrow")}
              />
            </>
          ) : null}
        </div>
      </div>
      {!error && note !== undefined && (
        <div className="notch-add">
          <div className="notch-seg" role="radiogroup" title="Tab으로도 전환">
            {(["today", "tomorrow"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={target === t}
                className={target === t ? "on" : ""}
                onMouseDown={(e) => e.preventDefault()} // keep the input focused
                onClick={() => setTarget(t)}
              >
                {t === "today" ? "오늘" : "내일"}
              </button>
            ))}
          </div>
          <input
            ref={input}
            value={draft}
            placeholder={target === "today" ? "오늘 꼭에 추가" : "내일 할 것에 추가"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            // Become key before WebKit decides about focus in a non-key window.
            onMouseDown={() => invoke("notch_set_pinned", { pinned: true, key: true }).catch(() => {})}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

function NotchList({
  title,
  items,
  onToggle,
  onAdd,
}: {
  title: string;
  items: TaskItem[];
  onToggle: (item: TaskItem) => void;
  onAdd: () => void;
}) {
  const left = items.filter((t) => !t.done).length;
  return (
    <section className="notch-section">
      <h2>
        <button
          type="button"
          className="notch-title"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAdd}
          title={`${title}에 추가`}
        >
          {title}
          <span className="notch-plus">+</span>
        </button>
        <span className="notch-count">{items.length ? `${left}/${items.length}` : ""}</span>
      </h2>
      {items.length === 0 ? (
        <p className="notch-none">없음</p>
      ) : (
        <ul>
          {items.map((t) => {
            // Same rendering as the main window's brief items: inline markdown
            // (links, bare URLs via remark-gfm) plus the trailing "— [a](x)" chips.
            const { body, links } = splitLinks(t.text);
            const carried = CARRIED_RE.test(body);
            return (
              <li key={t.line}>
                <div
                  role="checkbox"
                  aria-checked={t.done}
                  className={t.done ? "notch-item done" : "notch-item"}
                  onClick={() => onToggle(t)}
                >
                  <span className="notch-box" />
                  {/* Link opens in the browser and prevents navigation; stopping here
                      keeps a link click from also toggling the row. */}
                  <span
                    className="notch-text"
                    onClick={(e) => {
                      if ((e.target as Element).closest("a")) e.stopPropagation();
                    }}
                  >
                    {carried && <span className="notch-tag">이월</span>}
                    <InlineMd text={body.replace(CARRIED_RE, "")} />
                    {links.length > 0 && (
                      <span className="notch-links">
                        {links.map((l) => (
                          <Link key={l.url} href={l.url}>
                            {l.label}
                          </Link>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
