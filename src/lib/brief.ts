// Splits a Daily Brief note into the blocks the brief view renders.
// Contract (from the daily-brief skill):
//   # YYYY-MM-DD (요일) 아침
//   오늘 일정: ...
//   ## 오늘 꼭 / ## 정리됨 / ## 참고 (### 소제목들) / ## 내일 할 것
//   items: "- 내용 — [라벨](url), [라벨](url)", carried items start with "(이월)"

export type BriefItem = {
  line: number; // 1-based line of the bullet
  body: string; // markdown without the bullet / checkbox marker
  links: { label: string; url: string }[]; // trailing "— [a](x), [b](y)" part
  carried: boolean;
};

export type BriefBlock =
  | { kind: "item"; item: BriefItem }
  | { kind: "md"; text: string };

export type BriefGroup = { heading: string | null; blocks: BriefBlock[] };
export type BriefSection = { heading: string; groups: BriefGroup[] };

export type Brief = {
  title: string;
  schedule: string | null;
  intro: string; // other text before the first ## heading
  sections: BriefSection[];
};

const ITEM_RE = /^[-*+]\s+(?:\[[ xX]\]\s?)?(.*)$/;
// URLs may hold balanced parens, e.g. Jira JQL "currentUser()".
const LINK_SRC = String.raw`\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)`;
const LINKS_TAIL_RE = new RegExp(String.raw`\s+—\s+((?:${LINK_SRC}(?:,\s*)?)+)$`);
const CARRIED_RE = /^\(이월\)\s*(?:\[[ xX]\]\s?)?/;

export function isBrief(content: string): boolean {
  return /^##\s+오늘 꼭\s*$/m.test(content);
}

/** Splits the trailing "— [a](x), [b](y)" link chips off an item body. */
export function splitLinks(text: string): { body: string; links: BriefItem["links"] } {
  const tail = LINKS_TAIL_RE.exec(text);
  if (!tail) return { body: text, links: [] };
  const links = [...tail[1].matchAll(new RegExp(LINK_SRC, "g"))].map((m) => ({ label: m[1], url: m[2] }));
  return { body: text.slice(0, tail.index), links };
}

function toItem(line: number, text: string): BriefItem {
  const { body, links } = splitLinks(ITEM_RE.exec(text)?.[1] ?? text);
  const carried = CARRIED_RE.test(body);
  return { line, body: body.replace(CARRIED_RE, ""), links, carried };
}

export function parseBrief(content: string): Brief {
  const brief: Brief = { title: "", schedule: null, intro: "", sections: [] };
  let section: BriefSection | null = null;
  let group: BriefGroup | null = null;
  const intro: string[] = [];
  let inCode = false;

  const push = (block: BriefBlock) => {
    if (!group) return;
    const last = group.blocks[group.blocks.length - 1];
    if (block.kind === "md" && last?.kind === "md") last.text += `\n${block.text}`;
    else group.blocks.push(block);
  };

  content.split("\n").forEach((text, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(text)) inCode = !inCode;
    const h = inCode ? null : /^(#{1,3})\s+(.*)$/.exec(text);

    if (h && h[1] === "#" && !brief.title && !section) {
      brief.title = h[2];
    } else if (h && h[1] === "##") {
      group = { heading: null, blocks: [] };
      section = { heading: h[2].trim(), groups: [group] };
      brief.sections.push(section);
    } else if (h && h[1] === "###" && section) {
      group = { heading: h[2].trim(), blocks: [] };
      section.groups.push(group);
    } else if (!section) {
      const sched = /^오늘 일정:\s*(.*)$/.exec(text);
      if (sched) brief.schedule = sched[1];
      else intro.push(text);
    } else if (!inCode && /^[-*+]\s/.test(text)) {
      push({ kind: "item", item: toItem(line, text) });
    } else if (text.trim() !== "") {
      push({ kind: "md", text });
    }
  });

  brief.intro = intro.join("\n").trim();
  for (const s of brief.sections) s.groups = s.groups.filter((g) => g.heading || g.blocks.length);
  return brief;
}

export function countItems(section: BriefSection): number {
  return section.groups.reduce((n, g) => n + g.blocks.filter((b) => b.kind === "item").length, 0);
}
