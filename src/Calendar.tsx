import { useEffect, useState } from "react";
import { todayStr } from "./lib/notes";

type Props = {
  selected: string;
  onSelect: (date: string) => void;
  progressOf: (date: string) => { done: number; total: number } | null;
};

const HEAD = ["일", "월", "화", "수", "목", "금", "토"];

export default function Calendar({ selected, onSelect, progressOf }: Props) {
  const [month, setMonth] = useState(selected.slice(0, 7));
  useEffect(() => setMonth(selected.slice(0, 7)), [selected]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const today = todayStr();
  const cells: (string | null)[] = [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];

  const move = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <div className="calendar">
      <div className="cal-head">
        <button onClick={() => move(-1)} aria-label="이전 달">
          ‹
        </button>
        <span>
          {y}년 {m}월
        </span>
        <button onClick={() => move(1)} aria-label="다음 달">
          ›
        </button>
      </div>
      <div className="cal-grid">
        {HEAD.map((h) => (
          <span key={h} className="cal-dow">
            {h}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={`b${i}`} />;
          const p = progressOf(d);
          const cls = ["cal-day", d === selected && "sel", d === today && "today"].filter(Boolean).join(" ");
          const dot = p ? (p.total === 0 ? "note" : p.done === p.total ? "full" : "part") : null;
          return (
            <button key={d} className={cls} onClick={() => onSelect(d)}>
              {Number(d.slice(8))}
              {dot && <i className={`dot ${dot}`} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
