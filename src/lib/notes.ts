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

/**
 * Adds `- [ ] text` at the end of the first to-do section, or appends a
 * new "## 할 일" section when the note has none.
 */
export function addTask(content: string, text: string): string {
  const item = `- [ ] ${text}`;
  const lines = scan(content);
  const start = lines.findIndex(
    (l) => !l.inCode && /^##\s/.test(l.text) && TODO_HEADING_RE.test(l.section) && !TOMORROW_HEADING_RE.test(l.section),
  );
  const raw = content.split("\n");
  if (start === -1) {
    const body = content.replace(/\s*$/, "");
    return `${body}${body ? "\n\n" : ""}## 할 일\n${item}\n`;
  }
  let end = start + 1;
  while (end < raw.length && !/^#{1,2}\s/.test(raw[end])) end++;
  let insertAt = end;
  while (insertAt > start + 1 && raw[insertAt - 1].trim() === "") insertAt--;
  raw.splice(insertAt, 0, item);
  return raw.join("\n");
}

export function newNoteContent(date: string): string {
  return `# ${date} (${weekday(date)})\n\n## 할 일\n`;
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
