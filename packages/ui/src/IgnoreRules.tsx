import { useEffect, useRef, useState } from "react";

/** Common rules, offered as checkboxes. Each is a regular expression the engine removes from lines. */
export const PRESETS = [
  { pattern: "//.*", label: "// 주석", hint: "C, C++, Java, JavaScript, Rust, Go 등" },
  { pattern: "#.*", label: "# 주석", hint: "Python, 셸, YAML, Ruby 등" },
  { pattern: "/\\*.*?\\*/", label: "/* */ 주석 (한 줄 안)", hint: "여러 줄 주석은 줄마다 봅니다" },
  { pattern: "<!--.*?-->", label: "<!-- --> 주석 (한 줄 안)", hint: "HTML, XML" },
  { pattern: "--.*", label: "-- 주석", hint: "SQL, Lua, Haskell" },
] as const;

const STORAGE_KEY = "bigyo.ignoreRules";

export interface IgnoreSettings {
  ignore: string[];
  ignoreBlankLines: boolean;
}

/** The rules used last time, so they survive a restart. */
export function loadIgnoreSettings(): IgnoreSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<IgnoreSettings> | null;
    if (saved && Array.isArray(saved.ignore)) return { ignore: saved.ignore.filter((p) => typeof p === "string"), ignoreBlankLines: !!saved.ignoreBlankLines };
  } catch {
    // Storage can be unavailable or hold something else; start without rules.
  }
  return { ignore: [], ignoreBlankLines: false };
}

function saveIgnoreSettings(settings: IgnoreSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not remembering the rules is fine.
  }
}

const presetPatterns: readonly string[] = PRESETS.map((p) => p.pattern);

interface IgnoreRulesProps {
  settings: IgnoreSettings;
  onChange(settings: IgnoreSettings): void;
  /** Patterns the engine couldn't compile, with its message. */
  invalid: { pattern: string; message: string }[];
  /** Changes hidden by the rules in the current comparison. */
  hidden: number;
}

/** A toolbar button with a panel for choosing what text doesn't matter. */
export function IgnoreRules({ settings, onChange, invalid, hidden }: IgnoreRulesProps) {
  const [open, setOpen] = useState(false);
  // Opens toward whichever side of the button has room.
  const [alignRight, setAlignRight] = useState(false);
  const custom = settings.ignore.filter((p) => !presetPatterns.includes(p));
  const [text, setText] = useState(custom.join("\n"));
  const box = useRef<HTMLDivElement>(null);

  const update = (next: IgnoreSettings) => {
    saveIgnoreSettings(next);
    onChange(next);
  };

  // Typing in the box re-compares after a pause rather than on every key.
  useEffect(() => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.join("\n") === custom.join("\n")) return;
    const timer = setTimeout(() => update({ ...settings, ignore: [...settings.ignore.filter((p) => presetPatterns.includes(p)), ...lines] }), 400);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const togglePreset = (pattern: string, on: boolean) =>
    update({ ...settings, ignore: on ? [...settings.ignore, pattern] : settings.ignore.filter((p) => p !== pattern) });

  const count = settings.ignore.length + (settings.ignoreBlankLines ? 1 : 0);

  return (
    <div className="bm-popover-anchor" ref={box}>
      <button
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAlignRight(rect.left + 400 > window.innerWidth);
          setOpen((o) => !o);
        }}
        className={count ? "bm-active" : undefined}
        aria-expanded={open}
        title="주석처럼 비교에서 빼고 싶은 부분을 정합니다"
      >
        무시 규칙{count ? ` (${count})` : ""}
        {invalid.length > 0 && <span className="bm-error"> !</span>}
      </button>
      {open && (
        <div className={`bm-popover${alignRight ? " bm-popover-right" : ""}`} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <p className="bm-muted">맞는 부분을 지운 뒤 비교합니다. 그렇게 해서 빈 줄만 남는 차이는 흐리게 보이고 이동에서 건너뜁니다.</p>
          {PRESETS.map((p) => (
            <label key={p.pattern} title={p.hint}>
              <input type="checkbox" checked={settings.ignore.includes(p.pattern)} onChange={(e) => togglePreset(p.pattern, e.target.checked)} />
              {p.label}
              <span className="bm-muted bm-hint">{p.hint}</span>
            </label>
          ))}
          <label>
            <input type="checkbox" checked={settings.ignoreBlankLines} onChange={(e) => update({ ...settings, ignoreBlankLines: e.target.checked })} />
            빈 줄만 더하거나 지운 차이
          </label>
          <label className="bm-popover-block">
            직접 쓰는 정규식 (한 줄에 하나)
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} spellCheck={false} placeholder={"예: ^\\s*import .*\nversion = \"[^\"]*\""} />
          </label>
          {invalid.map((e) => (
            <p key={e.pattern} className="bm-error">
              쓸 수 없는 정규식: <code>{e.pattern}</code>
            </p>
          ))}
          {hidden > 0 && <p className="bm-muted">지금 비교에서 {hidden.toLocaleString("ko-KR")}곳을 무시했습니다.</p>}
        </div>
      )}
    </div>
  );
}
