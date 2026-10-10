// Parses sprint notes written by the /sprint-sync skill into what the sprint view renders.
// Contract (shared with the skill), file: <vault>/sprints/*.md
//   # <name> (YYYY-MM-DD ~ YYYY-MM-DD)
//   <!-- sprint-sync: project=BE3 sprintId=1234 synced=2026-10-06T09:12 -->
//   목표: ...
//   ## 팀원            ← rewritten by the skill; read-only here
//   ### <담당자>
//   - [ ] 내용 (Jira 상태) ~MM-DD — [BE3-1](url), [..](..)
//   ## 리스크 / 블로커, ## 팀장 할 일, ## 회고 메모, ... ← hand-written; checkable / addable
// Hand-written files without the sync comment or with missing sections are fine.

import { splitLinks } from "./brief";
import { toggleLine } from "./notes";

export type SprintFile = { path: string; name: string; content: string };

export type SprintItem = {
  line: number; // 1-based
  body: string; // markdown without marker, status, due and link chips
  done: boolean;
  task: boolean; // explicit `[ ]` / `[x]` checkbox (plain bullets are false)
  status?: string; // Jira status, member items only
  due?: string; // YYYY-MM-DD
  links: { label: string; url: string }[];
};

export type SprintMember = { name: string; line: number; items: SprintItem[] };

export type SprintSection = {
  heading: string;
  line: number; // line of the `## ` heading
  items: SprintItem[];
  notes: string[]; // other non-empty, non-comment lines (free text)
};

export type Sprint = {
  file: SprintFile;
  title: string; // sprint name without the date range
  start: string; // YYYY-MM-DD, "" when the title has none
  end: string;
  goal: string;
  synced?: string; // e.g. 2026-10-06T09:12
  meta: Record<string, string>; // all key=value pairs of the sprint-sync comment
  members: SprintMember[];
  sections: SprintSection[]; // manual sections, in file order
};

export const MEMBERS_HEADING = "팀원";
const MEMBERS_RE = /^팀원(?![가-힣])/;
const RISK_RE = /리스크|블로커|risk|block/i;
const MEMO_RE = /회고|메모|노트|memo|note/i;

const TITLE_RE = /^(.*?)\s*\(\s*(\d{4}-\d{2}-\d{2})\s*[~–—-]\s*(\d{4}-\d{2}-\d{2})\s*\)\s*$/;
const SYNC_RE = /<!--\s*sprint-sync:(.*?)-->/;
const GOAL_RE = /^\s*목표\s*[:：]\s*(.*)$/;
const ITEM_RE = /^[-*+]\s+(?:\[( |x|X)\]\s?)?(.*)$/;
const DUE_RE = /\s+~((?:\d{4}-)?\d{1,2}-\d{1,2})\s*$/;
const STATUS_RE = /\s+\(([^()]+)\)\s*$/;

export const isMembersHeading = (heading: string) => MEMBERS_RE.test(heading.trim());
export const isRiskHeading = (heading: string) => RISK_RE.test(heading);
/** Free-text sections (회고 메모 ...): plain bullets there are notes, not tasks. */
export const isMemoHeading = (heading: string) => MEMO_RE.test(heading) && !RISK_RE.test(heading);

const pad = (n: number) => String(n).padStart(2, "0");

/** `MM-DD` → `YYYY-MM-DD` using the sprint's year (the end year for a sprint that crosses New Year). */
function resolveDue(raw: string, start: string, end: string): string | undefined {
  const parts = raw.split("-").map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  let [y, m, d] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  if (!y) {
    const sy = Number(start.slice(0, 4)) || Number(end.slice(0, 4)) || new Date().getFullYear();
    const ey = Number(end.slice(0, 4)) || sy;
    y = ey > sy && m < Number(start.slice(5, 7)) ? ey : sy;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

function toItem(line: number, text: string, start: string, end: string, withStatus: boolean): SprintItem {
  const m = ITEM_RE.exec(text);
  const mark = m?.[1];
  let { body, links } = splitLinks((m?.[2] ?? text).trim());
  let status: string | undefined;
  let due: string | undefined;
  // `(status) ~due` in either order.
  for (let i = 0; i < 2; i++) {
    const dm = due ? null : DUE_RE.exec(body);
    if (dm) {
      due = resolveDue(dm[1], start, end);
      body = body.slice(0, dm.index);
      continue;
    }
    const sm = withStatus && !status ? STATUS_RE.exec(body) : null;
    if (sm) {
      status = sm[1].trim();
      body = body.slice(0, sm.index);
    }
  }
  return {
    line,
    body: body.trim(),
    done: mark !== undefined && mark !== " ",
    task: mark !== undefined,
    status,
    due,
    links,
  };
}

export function parseSprint(file: SprintFile): Sprint {
  const sprint: Sprint = {
    file,
    title: "",
    start: "",
    end: "",
    goal: "",
    meta: {},
    members: [],
    sections: [],
  };
  const raw: { line: number; text: string; section: SprintSection | null; member: SprintMember | null }[] = [];
  let section: SprintSection | null = null;
  let inMembers = false;
  let member: SprintMember | null = null;
  let inCode = false;

  file.content.split("\n").forEach((text, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(text)) {
      inCode = !inCode;
      if (section) section.notes.push(text);
      return;
    }
    const h = inCode ? null : /^(#{1,3})\s+(.*?)\s*#*\s*$/.exec(text);
    const sync = SYNC_RE.exec(text);
    if (sync) {
      for (const [, k, v] of sync[1].matchAll(/(\S+?)=(\S+)/g)) sprint.meta[k] = v;
      sprint.synced = sprint.meta.synced;
      return;
    }

    if (h && h[1] === "#" && !sprint.title && !section && !inMembers) {
      const t = TITLE_RE.exec(h[2]);
      if (t) [sprint.title, sprint.start, sprint.end] = [t[1].trim(), t[2], t[3]];
      else sprint.title = h[2].trim();
    } else if (h && h[1] === "##") {
      member = null;
      inMembers = isMembersHeading(h[2]);
      section = inMembers ? null : { heading: h[2].trim(), line, items: [], notes: [] };
      if (section) sprint.sections.push(section);
    } else if (h && h[1] === "###" && inMembers) {
      member = { name: h[2].trim(), line, items: [] };
      sprint.members.push(member);
    } else if (!inMembers && !section) {
      const g = GOAL_RE.exec(text);
      if (g && !sprint.goal) sprint.goal = g[1].trim();
    } else {
      // Items are resolved below, once the title's dates are known.
      if (!inCode && /^[-*+]\s/.test(text)) {
        raw.push({ line, text, section, member });
        return;
      }
      if (section && text.trim() !== "" && !/^\s*<!--.*-->\s*$/.test(text)) section.notes.push(text);
    }
  });

  if (!sprint.title) sprint.title = file.name;
  for (const r of raw) {
    if (!r.section) {
      // Bullets under "## 팀원" before any "### 담당자" are kept under an unnamed member.
      let m = r.member;
      if (!m) {
        m = sprint.members.find((x) => x.name === "") ?? { name: "", line: r.line, items: [] };
        if (!sprint.members.includes(m)) sprint.members.unshift(m);
      }
      m.items.push(toItem(r.line, r.text, sprint.start, sprint.end, true));
    } else {
      r.section.items.push(toItem(r.line, r.text, sprint.start, sprint.end, false));
    }
  }
  return sprint;
}

/** Whether a section item gets a checkbox: explicit tasks always, plain bullets outside memo sections. */
export function isCheckable(section: SprintSection, item: SprintItem): boolean {
  return item.task || !isMemoHeading(section.heading);
}

/** Days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** The sprint running on `today`; otherwise the latest one that ended; otherwise the next upcoming one. */
export function currentSprint(files: SprintFile[], today: string): Sprint | null {
  return pickSprint(files.map(parseSprint), today);
}

/** `currentSprint` over already-parsed sprints. */
export function pickSprint(all: Sprint[], today: string): Sprint | null {
  const dated = all.filter((s) => s.start && s.end);
  const active = dated
    .filter((s) => s.start <= today && today <= s.end)
    .sort((a, b) => b.start.localeCompare(a.start))[0];
  if (active) return active;
  const ended = dated.filter((s) => s.end < today).sort((a, b) => b.end.localeCompare(a.end))[0];
  if (ended) return ended;
  const upcoming = [...dated].sort((a, b) => a.start.localeCompare(b.start))[0];
  return upcoming ?? all[all.length - 1] ?? null;
}

/** "D-3" / "D-day" / "종료" (or "시작 전" before the sprint starts). */
export function dDay(sprint: Sprint, today: string): string {
  if (!sprint.end) return "";
  if (sprint.start && today < sprint.start) return "시작 전";
  const left = daysBetween(today, sprint.end);
  if (left < 0) return "종료";
  return left === 0 ? "D-day" : `D-${left}`;
}

export type Progress = { done: number; total: number };

export function progressOf(items: SprintItem[]): Progress {
  return { done: items.filter((t) => t.done).length, total: items.length };
}

/** Sprint scope progress: all member (Jira) items. */
export function overallProgress(sprint: Sprint): Progress {
  return progressOf(sprint.members.flatMap((m) => m.items));
}

export const overdue = (item: SprintItem, today: string) => !item.done && !!item.due && item.due < today;
export const dueBy = (item: SprintItem, today: string) => !item.done && !!item.due && item.due <= today;

export type DailyRow = { item: SprintItem; tag: string };

export type DailySprint = {
  due: DailyRow[]; // hand-written, due by `today` (overdue first)
  blockers: DailyRow[]; // open risk / blocker items not already in `due`
  undated: DailyRow[]; // other hand-written items without a due date, shown every sprint day
  members: DailyRow[]; // Jira items due by `today`; read-only
};

/** What the daily view shows of `sprint` on `today`. Only `members` rows are read-only. */
export function dailySprintItems(sprint: Sprint, today: string): DailySprint {
  const out: DailySprint = { due: [], blockers: [], undated: [], members: [] };
  for (const section of sprint.sections) {
    for (const item of section.items) {
      if (item.done || !isCheckable(section, item)) continue;
      const row = { item, tag: section.heading };
      if (dueBy(item, today)) out.due.push(row);
      else if (isRiskHeading(section.heading)) out.blockers.push(row);
      else if (!item.due) out.undated.push(row);
    }
  }
  for (const m of sprint.members) {
    for (const item of m.items) if (dueBy(item, today)) out.members.push({ item, tag: m.name });
  }
  const byDue = (a: DailyRow, b: DailyRow) => (a.item.due ?? "").localeCompare(b.item.due ?? "");
  out.due.sort(byDue);
  out.members.sort(byDue);
  return out;
}

type Scanned = { text: string; h2: string | null; inCode: boolean };

function scanH2(content: string): Scanned[] {
  let h2: string | null = null;
  let inCode = false;
  return content.split("\n").map((text) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inCode = !inCode;
      return { text, h2, inCode: true };
    }
    const h = inCode ? null : /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(text);
    if (h) h2 = h[1].length === 2 ? h[2] : null;
    return { text, h2, inCode };
  });
}

/** Toggles one line of a sprint file. Lines in the skill-managed "## 팀원" section are never touched. */
export function toggleSprintLine(content: string, line: number): string {
  const l = scanH2(content)[line - 1];
  if (!l || l.inCode || l.h2 === null || isMembersHeading(l.h2)) return content;
  return toggleLine(content, line);
}

/**
 * Appends a bullet at the end of the `## heading` section (before the next `#`/`##` heading,
 * after its last non-blank line), creating the section at the end of the file if missing.
 * Tasks are `- [ ] text`; memo sections get plain `- text`. Refuses the "팀원" section.
 */
export function addToSection(content: string, heading: string, text: string): string {
  if (isMembersHeading(heading)) return content;
  const item = isMemoHeading(heading) ? `- ${text}` : `- [ ] ${text}`;
  const lines = scanH2(content);
  const start = lines.findIndex((l) => !l.inCode && /^##\s/.test(l.text) && l.h2?.trim() === heading.trim());
  const raw = content.split("\n");
  if (start === -1) {
    const body = content.replace(/\s*$/, "");
    return `${body}${body ? "\n\n" : ""}## ${heading.trim()}\n${item}\n`;
  }
  let end = start + 1;
  while (end < raw.length && !(!lines[end].inCode && /^#{1,2}\s/.test(raw[end]))) end++;
  let insertAt = end;
  while (insertAt > start + 1 && raw[insertAt - 1].trim() === "") insertAt--;
  raw.splice(insertAt, 0, item);
  return raw.join("\n");
}

/** "2026-10-06T09:12" → "10-06 09:12". */
export function formatSynced(synced: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(synced);
  return m ? `${m[1]} ${m[2]}` : synced;
}
