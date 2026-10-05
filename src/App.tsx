import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type DailyNote,
  type TaskItem,
  addTask,
  checkableItems,
  folderForNew,
  newNoteContent,
  openTasks,
  progress,
  shiftDate,
  todayStr,
  toggleLine,
  tomorrowItems,
  weekday,
} from "./lib/notes";
import Calendar from "./Calendar";
import "./App.css";

const VAULT_KEY = "vault";
const CARRY_DAYS = 14;

function loadVault(): string | null {
  try {
    return localStorage.getItem(VAULT_KEY);
  } catch {
    return null;
  }
}

export default function App() {
  const [vault, setVault] = useState<string | null>(loadVault);
  const [notes, setNotes] = useState<DailyNote[]>([]);
  const [date, setDate] = useState(todayStr());
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const reload = useCallback(async () => {
    if (!vault) return;
    try {
      setNotes(await invoke<DailyNote[]>("load_daily", { vault }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vault]);

  // Load the vault and keep it in sync with edits made elsewhere (Obsidian, an editor, a script).
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!vault) return;
    reload();
    invoke("watch_vault", { vault }).catch((e) => setError(String(e)));
    const unlisten = listen("vault-changed", () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(reload, 150);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [vault, reload]);

  const byDate = useMemo(() => new Map(notes.map((n) => [n.date, n])), [notes]);
  const note = byDate.get(date);
  const prev = useMemo(() => [...notes].reverse().find((n) => n.date < date), [notes, date]);

  const planned = useMemo(() => (prev ? tomorrowItems(prev.content) : []), [prev]);

  // Open `- [ ]` tasks from recent days, minus the ones already shown as yesterday's plan.
  const carried = useMemo(() => {
    const from = shiftDate(date, -CARRY_DAYS);
    const plannedLines = new Set(planned.map((t) => t.line));
    return notes
      .filter((n) => n.date < date && n.date >= from)
      .flatMap((n) =>
        openTasks(n.content)
          .filter((t) => n !== prev || !plannedLines.has(t.line))
          .map((t) => ({ note: n, task: t })),
      )
      .reverse();
  }, [notes, date, prev, planned]);

  async function pickVault() {
    const dir = await open({ directory: true, title: "할일 md 폴더 선택" });
    if (typeof dir !== "string") return;
    try {
      localStorage.setItem(VAULT_KEY, dir);
    } catch {
      /* not persisted; fine for this session */
    }
    setVault(dir);
  }

  async function save(target: DailyNote, content: string) {
    setNotes((ns) => {
      const rest = ns.filter((n) => n.path !== target.path);
      return [...rest, { ...target, content }].sort((a, b) => a.date.localeCompare(b.date));
    });
    try {
      await invoke("write_note", { path: target.path, content });
    } catch (e) {
      setError(String(e));
      reload();
    }
  }

  function toggle(target: DailyNote, line: number) {
    save(target, toggleLine(target.content, line));
  }

  function submitDraft(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !vault) return;
    const target = note ?? {
      date,
      path: `${folderForNew(vault, notes)}/${date}.md`,
      content: newNoteContent(date),
    };
    save(target, addTask(target.content, text));
    setDraft("");
  }

  if (!vault) {
    return (
      <main className="empty">
        <h1>MD Todo</h1>
        <p>날짜별 할일 md 파일이 있는 폴더를 골라 주세요.</p>
        <p className="hint">파일 이름이 2026-10-05.md 처럼 날짜면 자동으로 인식해요.</p>
        <button className="primary" onClick={pickVault}>
          폴더 선택
        </button>
      </main>
    );
  }

  const isToday = date === todayStr();

  return (
    <div className="layout">
      <aside className="sidebar">
        <button className="vault" onClick={pickVault} title={vault}>
          {vault.split("/").pop()}
        </button>
        <Calendar
          selected={date}
          onSelect={setDate}
          progressOf={(d) => {
            const n = byDate.get(d);
            return n ? progress(n.content) : null;
          }}
        />
        <ul className="recent">
          {[...notes]
            .reverse()
            .slice(0, 30)
            .map((n) => {
              const p = progress(n.content);
              return (
                <li key={n.path}>
                  <button className={n.date === date ? "active" : ""} onClick={() => setDate(n.date)}>
                    <span>
                      {n.date.slice(5)} ({weekday(n.date)})
                    </span>
                    {p.total > 0 && (
                      <span className="count">
                        {p.done}/{p.total}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
      </aside>

      <main className="content">
        <header className="toolbar">
          <button onClick={() => setDate(shiftDate(date, -1))} aria-label="이전 날">
            ‹
          </button>
          <h1>
            {date} <span className="weekday">({weekday(date)})</span>
          </h1>
          <button onClick={() => setDate(shiftDate(date, 1))} aria-label="다음 날">
            ›
          </button>
          {!isToday && (
            <button className="today" onClick={() => setDate(todayStr())}>
              오늘
            </button>
          )}
          <span className="spacer" />
          {note && (
            <button onClick={() => openPath(note.path)} title="기본 앱으로 원본 열기">
              원본 열기
            </button>
          )}
        </header>

        {error && <div className="error">{error}</div>}

        <form className="quick-add" onSubmit={submitDraft}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`${date} 할일 추가 후 Enter`}
          />
        </form>

        {planned.length > 0 && prev && (
          <Panel title={`${prev.date.slice(5)}에 적어 둔 할 일`}>
            {planned.map((t) => (
              <TaskRow key={t.line} task={t} onToggle={() => toggle(prev, t.line)} />
            ))}
          </Panel>
        )}

        {carried.length > 0 && (
          <Panel title={`밀린 일 ${carried.length}`}>
            {carried.map(({ note: n, task }) => (
              <TaskRow
                key={`${n.date}:${task.line}`}
                task={task}
                tag={n.date.slice(5)}
                onToggle={() => toggle(n, task.line)}
              />
            ))}
          </Panel>
        )}

        {note ? (
          <NoteView note={note} onToggle={(line) => toggle(note, line)} />
        ) : (
          <p className="hint">이 날짜의 파일이 없어요. 위에서 할일을 추가하면 새로 만들어져요.</p>
        )}
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <ul>{children}</ul>
    </section>
  );
}

function TaskRow({ task, tag, onToggle }: { task: TaskItem; tag?: string; onToggle: () => void }) {
  return (
    <li className={task.done ? "task done" : "task"}>
      <Check checked={task.done} onClick={onToggle} />
      <span className="inline-md">
        <Markdown remarkPlugins={[remarkGfm]} components={{ p: ({ children }) => <>{children}</>, a: Link }}>
          {task.text}
        </Markdown>
      </span>
      {tag && <span className="tag">{tag}</span>}
    </li>
  );
}

function Check({ checked, onClick }: { checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={checked ? "check on" : "check"}
      onClick={onClick}
    />
  );
}

function Link({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

function NoteView({ note, onToggle }: { note: DailyNote; onToggle: (line: number) => void }) {
  const items = useMemo(
    () => new Map(checkableItems(note.content).map((t) => [t.line, t])),
    [note.content],
  );

  const components: Components = {
    a: Link,
    // remark-gfm's own (disabled) checkbox is replaced by ours in <li>.
    input: () => null,
    li: ({ node, children, className }) => {
      const item = items.get(node?.position?.start.line ?? -1);
      if (!item) return <li className={className}>{children}</li>;
      return (
        <li className={item.done ? "task done" : "task"}>
          <Check checked={item.done} onClick={() => onToggle(item.line)} />
          <div className="task-body">{children}</div>
        </li>
      );
    },
  };

  return (
    <article className="note">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {note.content}
      </Markdown>
    </article>
  );
}
