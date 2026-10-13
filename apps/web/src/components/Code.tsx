import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { javascript } from "@codemirror/lang-javascript";

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

export function Code({ value, onChange, lang, height = "260px", readOnly, className }: { value: string; onChange?: (v: string) => void; lang: "json" | "sql" | "js" | "tsx"; height?: string; readOnly?: boolean; className?: string }) {
  const dark = useDark();
  const ext = lang === "json" ? [json()] : lang === "sql" ? [sql()] : [javascript({ jsx: lang === "tsx", typescript: lang === "tsx" })];
  return (
    <div className={`overflow-hidden rounded-lg border border-line ${className ?? ""}`}>
      <CodeMirror
        value={value}
        onChange={onChange}
        height={height}
        extensions={ext}
        theme={dark ? "dark" : "light"}
        readOnly={readOnly}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly, autocompletion: true }}
      />
    </div>
  );
}
