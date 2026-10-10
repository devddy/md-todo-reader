// Line-level helpers for daily notes. Everything here works on the raw
// markdown text so edits touch only the lines they mean to and keep the
// rest of the file byte-for-byte intact.

export type DailyNote = { date: string; path: string; content: string };

export type TaskItem = {
  line: number; // 1-based, matches remark positions
  text: string;
  done: boolean;
};

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s?)/;
const BULLET_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)/;
const TODO_HEADING_RE = /(할\s?일|할\s?것|오늘\s?꼭|todo|to-do|tasks?)/i;
const TOMORROW_HEADING_RE = /내일|tomorrow/i;

export function todayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return todayStr(new Date(y, m - 1, d + days));
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
export function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

type LineInfo = { text: string; section: string; inCode: boolean };

/** Annotates each line with the level-2 section it sits in. */
function scan(content: string): LineInfo[] {
  let section = "";
  let inCode = false;
  return content.split("\n").map((text) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inCode = !inCode;
      return { text, section, inCode: true };
    }
    if (!inCode) {
      const h = /^(#{1,2})\s+(.*)$/.exec(text);
      if (h) section = h[1].length === 2 ? h[2] : "";
    }
    return { text, section, inCode };
  });
}

function stripMarker(text: string): string {
  return text.replace(TASK_RE, "").replace(BULLET_RE, "").trim();
}

/**
 * Lines that get a checkbox: explicit `- [ ]` tasks anywhere, plus plain
 * top-level bullets inside a to-do-ish section ("오늘 꼭", "내일 할 것", ...).
 */
export function checkableItems(content: string): TaskItem[] {
  const items: TaskItem[] = [];
  scan(content).forEach((l, i) => {
    if (l.inCode) return;
    const task = TASK_RE.exec(l.text);
    if (task) {
      items.push({ line: i + 1, text: stripMarker(l.text), done: task[2] !== " " });
    } else if (/^[-*+]\s+\S/.test(l.text) && TODO_HEADING_RE.test(l.section)) {
      items.push({ line: i + 1, text: stripMarker(l.text), done: false });
    }
  });
  return items;
}

/** Open items listed under a "내일 ..." section, i.e. plans for the next day. */
export function tomorrowItems(content: string): TaskItem[] {
  const lines = scan(content);
  return checkableItems(content).filter(
    (t) => !t.done && TOMORROW_HEADING_RE.test(lines[t.line - 1].section),
  );
}

/** Checkable items, open and done, under the level-2 sections whose heading matches. */
export function itemsUnder(content: string, heading: RegExp): TaskItem[] {
  const lines = scan(content);
  return checkableItems(content).filter((t) => heading.test(lines[t.line - 1].section));
}

/** Unchecked explicit `- [ ]` tasks. */
export function openTasks(content: string): TaskItem[] {
  return checkableItems(content).filter(
    (t) => !t.done && TASK_RE.test(content.split("\n")[t.line - 1]),
  );
}

/** Flips one line: `[ ]`↔`[x]`, and a plain bullet becomes `[x]`. */
export function toggleLine(content: string, line: number): string {
  const lines = content.split("\n");
  const cur = lines[line - 1];
  if (cur === undefined) return content;
  const task = TASK_RE.exec(cur);
  if (task) {
    const mark = task[2] === " " ? "x" : " ";
    lines[line - 1] = cur.replace(TASK_RE, `$1[${mark}]$3`);
  } else if (BULLET_RE.test(cur)) {
    lines[line - 1] = cur.replace(BULLET_RE, "$1[x] ");
  }
  return lines.join("\n");
}

export type AddTarget = "today" | "tomorrow";

/**
 * Adds a task at the end of the first to-do section ("오늘 꼭", "할 일", ...)
 * or, for "tomorrow", of the "내일 ..." section. Appends the section if missing.
 */
export function addTask(content: string, text: string, target: AddTarget = "today"): string {
  // "내일 할 것" uses plain bullets, the format the brief skill carries over as "- (이월) ...".
  const item = target === "tomorrow" ? `- ${text}` : `- [ ] ${text}`;
  const wanted = (section: string) =>
    target === "tomorrow"
      ? TOMORROW_HEADING_RE.test(section)
      : TODO_HEADING_RE.test(section) && !TOMORROW_HEADING_RE.test(section);
  const lines = scan(content);
  const start = lines.findIndex((l) => !l.inCode && /^##\s/.test(l.text) && wanted(l.section));
  const raw = content.split("\n");
  if (start === -1) {
    const body = content.replace(/\s*$/, "");
    const heading = target === "tomorrow" ? "## 내일 할 것" : "## 오늘 꼭";
    return `${body}${body ? "\n\n" : ""}${heading}\n${item}\n`;
  }
  let end = start + 1;
  while (end < raw.length && !/^#{1,2}\s/.test(raw[end])) end++;
  let insertAt = end;
  while (insertAt > start + 1 && raw[insertAt - 1].trim() === "") insertAt--;
  raw.splice(insertAt, 0, item);
  return raw.join("\n");
}

const MEMO = "(메모)";

/**
 * Appends one bullet the way the daily-todo skill's add_todo.sh does, so the
 * notch panel, the skill and /daily-brief agree on the format:
 *   "## 오늘 꼭"    → "- (메모) text"  (the marker /daily-brief keeps on regeneration)
 *   "## 내일 할 것" → "- text"          (carried over next morning as "(이월)")
 * Goes at the end of the section (before trailing blank lines); a missing heading
 * is appended at the end of the file. An identical bullet already there is a no-op.
 */
export function addTodo(content: string, text: string, target: AddTarget): string {
  const clean = text.trim().replace(/^-\s*/, "");
  if (!clean) return content;
  const heading = target === "today" ? "## 오늘 꼭" : "## 내일 할 것";
  const bullet = target === "today" && !clean.startsWith(MEMO) ? `- ${MEMO} ${clean}` : `- ${clean}`;
  const raw = content.split("\n");
  const start = raw.findIndex((l) => l.startsWith(heading));
  if (start === -1) {
    const body = content.endsWith("\n") || !content ? content : `${content}\n`;
    return `${body}${heading}\n${bullet}\n`;
  }
  let end = start + 1;
  while (end < raw.length && !raw[end].startsWith("## ")) end++;
  if (raw.slice(start + 1, end).includes(bullet)) return content;
  let insertAt = end;
  while (insertAt > start + 1 && raw[insertAt - 1].trim() === "") insertAt--;
  raw.splice(insertAt, 0, bullet);
  return raw.join("\n");
}

/** The skeleton add_todo.sh writes for a missing note (the Daily Brief output contract). */
export function briefSkeleton(date: string): string {
  return `# ${date} (${weekday(date)}) 아침\n오늘 일정: 일정 소스 없음\n## 오늘 꼭\n## 정리됨\n## 참고\n## 내일 할 것\n`;
}

/** Same skeleton the Daily Brief skill writes, so a later brief run slots in cleanly. */
export function newNoteContent(date: string): string {
  return `# ${date} (${weekday(date)})\n\n## 오늘 꼭\n\n## 내일 할 것\n`;
}

export function progress(content: string): { done: number; total: number } {
  const items = checkableItems(content);
  return { done: items.filter((t) => t.done).length, total: items.length };
}

/** Folder for a new daily note: next to the latest existing one, else `<vault>/daily`. */
export function folderForNew(vault: string, notes: DailyNote[]): string {
  const last = notes[notes.length - 1];
  if (!last) return `${vault.replace(/\/$/, "")}/daily`;
  return last.path.slice(0, last.path.lastIndexOf("/"));
}

/** Open checkable items outside the "내일 ..." section: what is left for today. */
export function todayOpenItems(content: string): TaskItem[] {
  const lines = scan(content);
  return checkableItems(content).filter(
    (t) => !t.done && !TOMORROW_HEADING_RE.test(lines[t.line - 1].section),
  );
}

/** Item text for places without markdown (notifications): drops trailing links, keeps link labels. */
export function plainText(text: string): string {
  return text
    .replace(/\s+—\s+(?:\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\)(?:,\s*)?)+$/, "")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}
