import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Check({ checked, onClick }: { checked: boolean; onClick: () => void }) {
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

/** Links open in the default browser instead of navigating the app window. */
export function Link({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

/** One line of markdown rendered without a wrapping <p>. */
export function InlineMd({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ p: ({ children }) => <>{children}</>, a: Link }}>
      {text}
    </Markdown>
  );
}

export function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  return (
    <form
      className="add-input"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
        const text = input.value.trim();
        if (text) onAdd(text);
        input.value = "";
      }}
    >
      <input name="text" placeholder={placeholder} autoComplete="off" />
    </form>
  );
}

/** A set of collapsed card keys, remembered in localStorage under `storageKey`. */
export function useCollapsed(storageKey: string): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      /* per-session only */
    }
  };
  return [collapsed, toggle];
}
