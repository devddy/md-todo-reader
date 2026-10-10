import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type Progress,
  type Sprint,
  type SprintItem,
  type SprintMember,
  type SprintSection,
  dDay,
  formatSynced,
  isCheckable,
  isRiskHeading,
  overallProgress,
  overdue,
  progressOf,
} from "./lib/sprint";
import { AddInput, Check, InlineMd, Link, useCollapsed } from "./components";

type Props = {
  sprint: Sprint | null;
  today: string;
  onToggle: (line: number) => void;
  onAdd: (heading: string, text: string) => void;
  onOpen: () => void;
};

const COLLAPSE_KEY = "collapsed-sprint";
const RISK_HEADING = "리스크 / 블로커";
const LEAD_HEADING = "팀장 할 일";

const emptySection = (heading: string): SprintSection => ({ heading, line: 0, items: [], notes: [] });

/** Team-lead view of a sprint note written by the /sprint-sync skill. */
export default function SprintView({ sprint, today, onToggle, onAdd, onOpen }: Props) {
  const [collapsed, toggleCollapsed] = useCollapsed(COLLAPSE_KEY);

  // Risk card pinned on top; "팀장 할 일" always offered so there is somewhere to add to.
  const { risks, manual } = useMemo(() => {
    const sections = sprint?.sections ?? [];
    const risks = sections.filter((s) => isRiskHeading(s.heading));
    const manual = sections.filter((s) => !isRiskHeading(s.heading));
    if (!risks.length) risks.push(emptySection(RISK_HEADING));
    if (!manual.some((s) => s.heading === LEAD_HEADING)) manual.unshift(emptySection(LEAD_HEADING));
    return { risks, manual };
  }, [sprint]);

  if (!sprint) {
    return (
      <div className="sprint-empty">
        <h2>스프린트 파일이 없어요</h2>
        <p>
          Claude Code에서 <code>/sprint-sync</code>를 실행하면 Jira 스프린트를 읽어 vault의{" "}
          <code>sprints/*.md</code> 파일로 만들어 줘요. 파일이 생기면 여기에 바로 나타나요.
        </p>
        <p className="hint">
          직접 만들어도 돼요: 첫 줄을 <code># 스프린트 이름 (2026-10-06 ~ 2026-10-17)</code>로 쓰고{" "}
          <code>## 팀장 할 일</code> 같은 섹션 아래에 <code>- [ ] 할 일 ~10-08</code>을 적으면 돼요.
        </p>
      </div>
    );
  }

  const total = overallProgress(sprint);
  const dd = dDay(sprint, today);
  const ddKind = dd === "종료" ? "over" : dd === "D-day" || /^D-[1-2]$/.test(dd) ? "soon" : "";

  const sectionCard = (s: SprintSection, kind: string) => {
    const key = `section:${s.heading}`;
    return (
      <SectionCard
        key={key}
        kind={kind}
        section={s}
        today={today}
        collapsed={collapsed.has(key)}
        onCollapse={() => toggleCollapsed(key)}
        onToggle={onToggle}
        onAdd={(t) => onAdd(s.heading, t)}
      />
    );
  };

  return (
    <article className="brief sprint">
      <header className="sprint-head">
        <div className="sprint-title">
          <h1>{sprint.title}</h1>
          {dd && <span className={`dday ${ddKind}`}>{dd}</span>}
          <span className="spacer" />
          <button onClick={onOpen} title="기본 앱으로 원본 열기">
            원본 열기
          </button>
        </div>
        <div className="sprint-meta">
          {sprint.start && (
            <span>
              {sprint.start} ~ {sprint.end}
            </span>
          )}
          {sprint.synced ? <span>동기화 {formatSynced(sprint.synced)}</span> : <span>동기화 기록 없음</span>}
        </div>
        {sprint.goal && (
          <div className="schedule">
            <span className="label">목표</span>
            <InlineMd text={sprint.goal} />
          </div>
        )}
        {total.total > 0 && <ProgressBar p={total} big />}
      </header>

      {risks.map((s) => sectionCard(s, "risk"))}

      {sprint.members.map((m) => {
        const key = `member:${m.name}`;
        return (
          <MemberCard
            key={key}
            member={m}
            today={today}
            collapsed={collapsed.has(key)}
            onCollapse={() => toggleCollapsed(key)}
          />
        );
      })}
      {sprint.members.length === 0 && (
        <p className="hint">팀원 섹션이 비어 있어요. /sprint-sync 를 다시 실행하면 채워져요.</p>
      )}

      {manual.map((s) => sectionCard(s, /팀장/.test(s.heading) ? "must" : "other"))}
    </article>
  );
}

function ProgressBar({ p, big }: { p: Progress; big?: boolean }) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <span className={`progress${big ? " big" : ""}`} title={`${p.done}/${p.total}`}>
      <span className="bar">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      {big && (
        <span className="count">
          {p.done}/{p.total} · {pct}%
        </span>
      )}
    </span>
  );
}

type MemberProps = { member: SprintMember; today: string; collapsed: boolean; onCollapse: () => void };

function MemberCard({ member, today, collapsed, onCollapse }: MemberProps) {
  const p = progressOf(member.items);
  const late = member.items.filter((t) => overdue(t, today)).length;
  return (
    <section className={`card member${collapsed ? " collapsed" : ""}`}>
      <button className="card-head" onClick={onCollapse} aria-expanded={!collapsed}>
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <h2>{member.name || "담당자 미지정"}</h2>
        {late > 0 && <span className="late">지연 {late}</span>}
        <span className="count">
          {p.done}/{p.total}
        </span>
        <ProgressBar p={p} />
      </button>
      {!collapsed && (
        <div className="card-body">
          <ul className="items">
            {member.items.map((t) => (
              <ItemRow key={t.line} item={t} today={today} mode="readonly" />
            ))}
          </ul>
          {member.items.length === 0 && <p className="hint">비어 있음</p>}
        </div>
      )}
    </section>
  );
}

type SectionProps = {
  kind: string;
  section: SprintSection;
  today: string;
  collapsed: boolean;
  onCollapse: () => void;
  onToggle: (line: number) => void;
  onAdd: (text: string) => void;
};

function SectionCard({ kind, section, today, collapsed, onCollapse, onToggle, onAdd }: SectionProps) {
  const tasks = section.items.filter((t) => isCheckable(section, t));
  const open = tasks.filter((t) => !t.done).length;
  const notes = section.notes.join("\n").trim();
  return (
    <section className={`card ${kind}${collapsed ? " collapsed" : ""}`}>
      <button className="card-head" onClick={onCollapse} aria-expanded={!collapsed}>
        <span className="caret">{collapsed ? "▸" : "▾"}</span>
        <h2>{section.heading}</h2>
        <span className="count">
          {tasks.length > 0 ? (kind === "risk" ? `열림 ${open}` : `${tasks.length - open}/${tasks.length}`) : ""}
        </span>
      </button>
      {!collapsed && (
        <div className="card-body">
          <ul className="items">
            {section.items.map((t) => (
              <ItemRow
                key={t.line}
                item={t}
                today={today}
                mode={isCheckable(section, t) ? "check" : "plain"}
                onToggle={() => onToggle(t.line)}
              />
            ))}
          </ul>
          {notes && (
            <div className="md">
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: Link }}>
                {notes}
              </Markdown>
            </div>
          )}
          <AddInput placeholder={`${section.heading}에 추가 후 Enter (~MM-DD 로 기한)`} onAdd={onAdd} />
        </div>
      )}
    </section>
  );
}

function statusKind(status: string): string {
  if (/완료|done|closed|resolved|종료/i.test(status)) return "done";
  if (/보류|블록|block|hold/i.test(status)) return "blocked";
  if (/진행|progress|리뷰|review|qa|테스트|test|검토/i.test(status)) return "doing";
  return "todo";
}

type RowProps = {
  item: SprintItem;
  today: string;
  mode: "check" | "readonly" | "plain";
  tag?: string;
  onToggle?: () => void;
};

/** One sprint item: body, Jira status, due date and link chips. */
export function ItemRow({ item, today, mode, tag, onToggle }: RowProps) {
  const late = overdue(item, today);
  const dueToday = !item.done && item.due === today;
  return (
    <li className={`item${item.done ? " done" : ""}${late ? " overdue" : ""}`}>
      {mode === "check" ? (
        <Check checked={item.done} onClick={() => onToggle?.()} />
      ) : mode === "readonly" ? (
        <span className={`check static${item.done ? " on" : ""}`} aria-label={item.done ? "완료" : "미완료"} />
      ) : (
        <span className="bullet" />
      )}
      <div className="item-body">
        <span className="text">
          <InlineMd text={item.body} />
        </span>
        {item.status && <span className={`status ${statusKind(item.status)}`}>{item.status}</span>}
        {item.due && (
          <span className={`due${late ? " late" : dueToday ? " today" : ""}`}>
            ~{item.due.slice(5)}
            {late ? " 지남" : dueToday ? " 오늘" : ""}
          </span>
        )}
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
      {tag && <span className="tag">{tag}</span>}
    </li>
  );
}
