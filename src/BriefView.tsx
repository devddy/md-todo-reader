import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type BriefBlock, type BriefSection, countItems, parseBrief } from "./lib/brief";
import { type DailyNote, type TaskItem, checkableItems } from "./lib/notes";
import { AddInput, Check, InlineMd, Link, useCollapsed } from "./components";

type Props = {
  note: DailyNote;
  onToggle: (line: number) => void;
  onAddTomorrow: (text: string) => void;
};

const COLLAPSE_KEY = "collapsed-sections";

/** Card layout for notes written by the Daily Brief skill. */
export default function BriefView({ note, onToggle, onAddTomorrow }: Props) {
  const brief = useMemo(() => parseBrief(note.content), [note.content]);
  const checkable = useMemo(
    () => new Map(checkableItems(note.content).map((t) => [t.line, t])),
    [note.content],
  );
  const [collapsed, toggleSection] = useCollapsed(COLLAPSE_KEY);

  return (
    <article className="brief">
      {(brief.schedule || brief.intro) && (
        <div className="brief-top">
          {brief.schedule && (
            <div className="schedule">
              <span className="label">일정</span>
              <InlineMd text={brief.schedule} />
            </div>
          )}
          {brief.intro && (
            <div className="intro">
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: Link }}>
                {brief.intro}
              </Markdown>
            </div>
          )}
        </div>
      )}
      {brief.sections.map((s) => (
        <Section
          key={s.heading}
          section={s}
          checkable={checkable}
          onToggle={onToggle}
          collapsed={collapsed.has(s.heading)}
          onCollapse={() => toggleSection(s.heading)}
          onAdd={/내일/.test(s.heading) ? onAddTomorrow : undefined}
        />
      ))}
    </article>
  );
}

function sectionKind(heading: string): string {
  if (/오늘 꼭/.test(heading)) return "must";
  if (/내일/.test(heading)) return "tomorrow";
  if (/정리됨/.test(heading)) return "done";
  if (/참고/.test(heading)) return "ref";
  return "other";
}

type SectionProps = {
  section: BriefSection;
  checkable: Map<number, TaskItem>;
  onToggle: (line: number) => void;
  collapsed: boolean;
  onCollapse: () => void;
  onAdd?: (text: string) => void;
};

function Section({ section, checkable, onToggle, collapsed, onCollapse, onAdd }: SectionProps) {
  const kind = sectionKind(section.heading);
  const count = countItems(section);
  const doneCount = section.groups
    .flatMap((g) => g.blocks)
    .filter((b) => b.kind === "item" && checkable.get(b.item.line)?.done).length;
  const showProgress = kind === "must" || kind === "tomorrow";

  return (
    <section className={`card ${kind}${collapsed ? " collapsed" : ""}`}>
      <button className="card-head" onClick={onCollapse} aria-expanded={!collapsed}>
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <h2>{section.heading}</h2>
        <span className="count">{showProgress && count > 0 ? `${doneCount}/${count}` : count || ""}</span>
      </button>
      {!collapsed && (
        <div className="card-body">
          {section.groups.map((g, gi) => (
            <div key={gi} className="group">
              {g.heading && <h3>{g.heading}</h3>}
              <ul>
                {g.blocks.map((b, bi) => (
                  <Block key={bi} block={b} checkable={checkable} onToggle={onToggle} />
                ))}
              </ul>
            </div>
          ))}
          {count === 0 && !onAdd && <p className="hint">비어 있음</p>}
          {onAdd && <AddInput placeholder="내일 할 것 추가 후 Enter" onAdd={onAdd} />}
        </div>
      )}
    </section>
  );
}

function Block({
  block,
  checkable,
  onToggle,
}: {
  block: BriefBlock;
  checkable: Map<number, TaskItem>;
  onToggle: (line: number) => void;
}) {
  if (block.kind === "md") {
    return (
      <li className="md">
        <Markdown remarkPlugins={[remarkGfm]} components={{ a: Link }}>
          {block.text}
        </Markdown>
      </li>
    );
  }
  const { item } = block;
  const task = checkable.get(item.line);
  return (
    <li className={`item${task?.done ? " done" : ""}${task ? "" : " plain"}`}>
      {task ? <Check checked={task.done} onClick={() => onToggle(item.line)} /> : <span className="bullet" />}
      <div className="item-body">
        {item.carried && <span className="badge">이월</span>}
        <span className="text">
          <InlineMd text={item.body} />
        </span>
        {item.links.length > 0 && (
          <span className="links">
            {item.links.map((l) => (
              <Link key={l.url} href={l.url}>
                {l.label}
              </Link>
            ))}
          </span>
        )}
      </div>
    </li>
  );
}
