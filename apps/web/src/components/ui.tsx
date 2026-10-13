import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { create } from "zustand";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger" | "soft";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:brightness-110 shadow-sm",
  secondary: "bg-surface border border-line text-ink hover:bg-surface2",
  ghost: "text-ink hover:bg-surface2",
  danger: "bg-danger text-white hover:brightness-110",
  soft: "bg-accent-soft text-accent hover:brightness-95",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }>(
  function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
          size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
          VARIANTS[variant],
          className,
        )}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
        {children}
      </button>
    );
  },
);

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button aria-label={label} title={label} className={cx("inline-grid size-8 place-items-center rounded-lg text-muted hover:bg-surface2 hover:text-ink transition", className)} {...rest}>
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx("h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent/40 focus:border-accent", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx("w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent/40 focus:border-accent", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink focus:outline-2 focus:outline-accent/40", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]", className)} {...rest}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "danger"; className?: string }) {
  const t = {
    neutral: "bg-surface2 text-muted border-line",
    accent: "bg-accent-soft text-accent border-transparent",
    success: "bg-success/10 text-success border-success/20",
    warning: "bg-warning/10 text-warning border-warning/25",
    danger: "bg-danger/10 text-danger border-danger/20",
  }[tone];
  return <span className={cx("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium", t, className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-accent", className)} />;
}

export function PageLoader() {
  return (
    <div className="grid h-64 place-items-center">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="mb-3 text-accent">{icon}</div>}
      <div className="text-base font-semibold">{title}</div>
      {text && <div className="mt-1 max-w-md text-muted">{text}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: { errors?: { path: string; message: string }[] } }).details;
  return (
    <div className={cx("rounded-lg border border-danger/25 bg-danger/8 px-3 py-2 text-[13px] text-danger", className)}>
      <div className="font-medium">{msg}</div>
      {details?.errors?.length ? (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {details.errors.slice(0, 12).map((e, i) => (
            <li key={i}>
              <code>{e.path}</code>: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = "max-w-lg" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx("w-full rounded-2xl border border-line bg-surface shadow-2xl", width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="text-[15px] font-semibold">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx("no-scrollbar flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition", value === t.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function Menu({ trigger, children, align = "right" }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div className={cx("absolute z-40 mt-1 min-w-52 rounded-xl border border-line bg-surface p-1 shadow-xl", align === "right" ? "right-0" : "left-0")}>{children(() => setOpen(false))}</div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, disabled }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-surface2 disabled:opacity-50", danger ? "text-danger" : "text-ink")}>
      {icon && <span className="text-muted [&>svg]:size-4">{icon}</span>}
      {children}
    </button>
  );
}

/* toasts */
interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
}
const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, "id">) => void; drop: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.tone === "error" ? 7000 : 3500);
  },
  drop: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
export const toast = {
  success: (text: string) => useToasts.getState().push({ tone: "success", text }),
  error: (e: unknown) => useToasts.getState().push({ tone: "error", text: e instanceof Error ? e.message : String(e) }),
  info: (text: string) => useToasts.getState().push({ tone: "info", text }),
};
export function Toasts() {
  const { toasts, drop } = useToasts();
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] shadow-lg" role="status">
          {t.tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : t.tone === "error" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" /> : <Info className="mt-0.5 size-4 shrink-0 text-accent" />}
          <div className="flex-1 break-words">{t.text}</div>
          <button className="text-muted hover:text-ink" onClick={() => drop(t.id)} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* confirm dialog */
const useConfirmStore = create<{ req: { title: string; text: string; danger?: boolean; resolve: (ok: boolean) => void } | null }>(() => ({ req: null }));
export function confirmDialog(title: string, text: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.setState({ req: { title, text, danger, resolve } }));
}
export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  const close = (ok: boolean) => {
    req?.resolve(ok);
    useConfirmStore.setState({ req: null });
  };
  return (
    <Modal
      open={!!req}
      onClose={() => close(false)}
      title={req?.title}
      width="max-w-md"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={req?.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
            Confirm
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-muted">{req?.text}</p>
    </Modal>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition", checked ? "bg-accent" : "bg-line")}>
      <span className={cx("inline-block size-4 rounded-full bg-white shadow transition", checked ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto rounded-xl border border-line bg-surface", className)}>
      <table className="w-full text-left text-[13px]">
        <thead className="border-b border-line bg-surface2 text-xs uppercase tracking-wide text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
