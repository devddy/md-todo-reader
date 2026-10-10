import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type AddTarget,
  type DailyNote,
  type TaskItem,
  addTodo,
  briefSkeleton,
  checkableItems,
  folderForNew,
  openTasks,
  progress,
  shiftDate,
  todayStr,
  toggleLine,
  tomorrowItems,
  weekday,
} from "./lib/notes";
import Calendar from "./Calendar";
import BriefView from "./BriefView";
import SprintView, { ItemRow } from "./SprintView";
import { AddInput, Check, InlineMd, Link } from "./components";
import { isBrief } from "./lib/brief";
import {
  type SprintFile,
  addToSection,
  type DailyRow,
  type Sprint,
  dDay,
  dailySprintItems,
  overallProgress,
  parseSprint,
  pickSprint,
  toggleSprintLine,
} from "./lib/sprint";
import { sendReminder, useEveningReminder } from "./reminder";
import "./App.css";

const VAULT_KEY = "vault";
const CARRY_DAYS = 14;
const REMIND_KEY = "remind-at";
const MODE_KEY = "view-mode";

type ViewMode = "daily" | "sprint";

function loadMode(): ViewMode {
  try {
    return localStorage.getItem(MODE_KEY) === "sprint" ? "sprint" : "daily";
  } catch {
    return "daily";
  }
}

function loadRemindAt(): string {
  try {
    return localStorage.getItem(REMIND_KEY) ?? "18:00";
  } catch {
    return "18:00";
  }
}

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
  const [remindAt, setRemindAt] = useState(loadRemindAt); // "" = off
  const [sprints, setSprints] = useState<SprintFile[]>([]);
  const [mode, setMode] = useState<ViewMode>(loadMode);
  const [sprintPath, setSprintPath] = useState<string | null>(null); // null = current sprint

  const reload = useCallback(async () => {
    if (!vault) return;
    try {
      const [daily, sprintFiles] = await Promise.all([
        invoke<DailyNote[]>("load_daily", { vault }),
        invoke<SprintFile[]>("load_sprints", { vault }),
      ]);
      setNotes(daily);
      setSprints(sprintFiles);
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

  useEveningReminder(remindAt, notes);

  function changeRemindAt(value: string) {
    setRemindAt(value);
    try {
      localStorage.setItem(REMIND_KEY, value);
    } catch {
      /* per-session only */
    }
  }

  function changeMode(value: ViewMode) {
    setMode(value);
    try {
      localStorage.setItem(MODE_KEY, value);
    } catch {
      /* per-session only */
    }
  }

  const byDate = useMemo(() => new Map(notes.map((n) => [n.date, n])), [notes]);
  const note = byDate.get(date);
  const prev = useMemo(() => [...notes].reverse().find((n) => n.date < date), [notes, date]);

  // The brief skill already carries yesterday's "내일 할 것" into today's "오늘 꼭" as "(이월)".
  // Show them separately only until that has happened.
  const planned = useMemo(
    () => (prev && !(note && isBrief(note.content)) ? tomorrowItems(prev.content) : []),
    [prev, note],
  );

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

  const sprintList = useMemo(
    () =>
      sprints.map(parseSprint).sort((a, b) => (b.start || b.file.name).localeCompare(a.start || a.file.name)),
    [sprints],
  );

  // Sprint shown in sprint mode: the picked file, else the one running today.
  const viewedSprint = useMemo(() => {
    return sprintList.find((s) => s.file.path === sprintPath) ?? pickSprint(sprintList, todayStr());
  }, [sprintList, sprintPath]);

  // Daily panel: the sprint running on the selected date and what of it matters that day.
  const sprintToday = useMemo(() => {
    const sprint = pickSprint(sprintList, date);
    if (!sprint || (sprint.end && sprint.end < date) || (sprint.start && sprint.start > date)) return null;
    return { sprint, ...dailySprintItems(sprint, date) };
  }, [sprintList, date]);

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

  // Every write goes through here: optimistic local update, then the file; reload on failure.
  async function persist(path: string, content: string) {
    try {
      await invoke("write_note", { path, content });
    } catch (e) {
      setError(String(e));
      reload();
    }
  }

  function save(target: DailyNote, content: string) {
    setNotes((ns) => {
      const rest = ns.filter((n) => n.path !== target.path);
      return [...rest, { ...target, content }].sort((a, b) => a.date.localeCompare(b.date));
    });
    persist(target.path, content);
  }

  function saveSprint(target: SprintFile, content: string) {
    if (content === target.content) return;
    setSprints((ss) => ss.map((f) => (f.path === target.path ? { ...f, content } : f)));
    persist(target.path, content);
  }

  function toggleSprint(target: SprintFile, line: number) {
    saveSprint(target, toggleSprintLine(target.content, line));
  }

  function toggle(target: DailyNote, line: number) {
    save(target, toggleLine(target.content, line));
  }

  // Same line format as the daily-todo skill and the notch panel (see addTodo), applied
  // to a fresh read of the file so edits from Obsidian or /daily-brief are not overwritten.
  // A missing note is created with the skill's skeleton.
  async function add(text: string, target: AddTarget = "today") {
    if (!vault) return;
    try {
      const path = note?.path ?? `${folderForNew(vault, notes)}/${date}.md`;
      const base = note ? await invoke<string>("read_note", { path }) : briefSkeleton(date);
      const content = addTodo(base, text, target);
      if (content === base) return; // empty or already there
      save({ date, path, content: base }, content);
    } catch (e) {
      setError(String(e));
      reload();
    }
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
        <div className="mode-switch" role="tablist">
          {(["daily", "sprint"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => changeMode(m)}
            >
              {m === "daily" ? "데일리" : "스프린트"}
            </button>
          ))}
        </div>
        {mode === "sprint" ? (
          <ul className="recent">
            {sprintList.map((s) => (
              <li key={s.file.path}>
                <button
                  className={s.file.path === viewedSprint?.file.path ? "active" : ""}
                  onClick={() => setSprintPath(s.file.path)}
                  title={s.file.path}
                >
                  <span className="ellipsis">{s.title}</span>
                  <span className="count">{dDay(s, todayStr())}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
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
          </>
        )}
        <div className="settings">
          <label>
            <input
              type="checkbox"
              checked={remindAt !== ""}
              onChange={(e) => changeRemindAt(e.target.checked ? "18:00" : "")}
            />
            남은 할 일 알림
          </label>
          {remindAt && (
            <div className="remind-row">
              <input type="time" value={remindAt} onChange={(e) => e.target.value && changeRemindAt(e.target.value)} />
              <button
                onClick={async () => {
                  const sent = await sendReminder(byDate.get(todayStr()));
                  if (!sent) setError("오늘 남은 할 일이 없거나 알림 권한이 꺼져 있어요.");
                }}
              >
                테스트
              </button>
            </div>
          )}
        </div>
      </aside>

      {mode === "sprint" ? (
        <main className="content">
          {error && <div className="error">{error}</div>}
          <SprintView
            sprint={viewedSprint}
            today={todayStr()}
            onToggle={(line) => viewedSprint && toggleSprint(viewedSprint.file, line)}
            onAdd={(heading, text) =>
              viewedSprint && saveSprint(viewedSprint.file, addToSection(viewedSprint.file.content, heading, text))
            }
            onOpen={() => viewedSprint && openPath(viewedSprint.file.path)}
          />
        </main>
      ) : (
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

          <div className="quick-add">
            <AddInput placeholder={`${date.slice(5)} 오늘 꼭에 추가 후 Enter`} onAdd={(t) => add(t)} />
          </div>

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

          {sprintToday && (
            <Panel title={sprintTitle(sprintToday.sprint, date)} onTitleClick={() => changeMode("sprint")}>
              {(
                [
                  ["기한", sprintToday.due],
                  ["블로커", sprintToday.blockers],
                  ["기한 없음", sprintToday.undated],
                  ["팀원 · Jira", sprintToday.members],
                ] as [string, DailyRow[]][]
              ).map(([label, rows]) =>
                rows.length === 0 ? null : (
                  <li key={label} className="panel-group">
                    <h3>{label}</h3>
                    <ul>
                      {rows.map(({ item, tag }) =>
                        label === "팀원 · Jira" ? (
                          <ItemRow key={item.line} item={item} today={date} mode="readonly" tag={tag} />
                        ) : (
                          <ItemRow
                            key={item.line}
                            item={item}
                            today={date}
                            mode="check"
                            tag={tag}
                            onToggle={() => toggleSprint(sprintToday.sprint.file, item.line)}
                          />
                        ),
                      )}
                    </ul>
                  </li>
                ),
              )}
              {!sprintToday.due.length &&
                !sprintToday.blockers.length &&
                !sprintToday.undated.length &&
                !sprintToday.members.length && <li className="hint">이 날짜에 챙길 스프린트 할 일은 없어요.</li>}
            </Panel>
          )}

          {note && isBrief(note.content) ? (
            <BriefView
              note={note}
              onToggle={(line) => toggle(note, line)}
              onAddTomorrow={(t) => add(t, "tomorrow")}
            />
          ) : note ? (
            <NoteView note={note} onToggle={(line) => toggle(note, line)} />
          ) : (
            <p className="hint">이 날짜의 파일이 없어요. 위에서 할일을 추가하면 새로 만들어져요.</p>
          )}
        </main>
      )}
    </div>
  );
}

/** "스프린트 · <name> · D-3 · 12/30" for the daily panel; D-day counts from the selected date. */
function sprintTitle(sprint: Sprint, date: string): string {
  const { done, total } = overallProgress(sprint);
  return ["스프린트", sprint.title, dDay(sprint, date), total ? `${done}/${total}` : ""].filter(Boolean).join(" · ");
}

function Panel({
  title,
  onTitleClick,
  children,
}: {
  title: string;
  onTitleClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <h2>
        {onTitleClick ? (
          <button className="panel-link" onClick={onTitleClick} title="스프린트 보기">
            {title} ›
          </button>
        ) : (
          title
        )}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

function TaskRow({ task, tag, onToggle }: { task: TaskItem; tag?: string; onToggle: () => void }) {
  return (
    <li className={task.done ? "task done" : "task"}>
      <Check checked={task.done} onClick={onToggle} />
      <span className="inline-md">
        <InlineMd text={task.text} />
      </span>
      {tag && <span className="tag">{tag}</span>}
    </li>
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
