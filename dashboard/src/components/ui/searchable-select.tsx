import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Searchable select.
 *
 * A native `Select` cannot be filtered: the model catalog is long, and typing
 * the first letters is how an operator finds one. The trigger opens a popover
 * whose input takes focus, filtering narrows the list as you type, and
 * ArrowUp/ArrowDown + Enter pick without leaving the keyboard. Escape closes
 * and returns focus to the trigger.
 *
 * The popover is portalled and fixed-positioned from the trigger's rect, so a
 * card's `overflow: hidden` (rounded panels use it) cannot clip it. Scrolling
 * closes it instead of leaving it floating away from its anchor.
 *
 * The trigger/list reuse the console's shared select skin classes; this is a
 * behavior wrapper, not a second visual language.
 */

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SearchableSelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SearchableSelectOption[];
  readonly label?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly emptyMessage?: string;
  readonly searchPlaceholder?: string;
  readonly "aria-label"?: string;
}

interface PanelPosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  label,
  placeholder = "Select…",
  disabled = false,
  emptyMessage = "No matches",
  searchPlaceholder = "Search…",
  "aria-label": ariaLabel,
}: SearchableSelectProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const triggerId = useId();
  const optionId = (index: number): string => `${listId}-option-${index}`;

  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const close = (): void => {
    setOpen(false);
    setPosition(null);
    triggerRef.current?.focus();
  };

  const openPanel = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
      setPosition(null);
    };
    // Page scroll only (no capture): a capture listener also sees the option
    // list's own scroll, which closed the panel the moment arrow keys moved
    // the highlight. An element's scroll does not bubble to `window`, so a
    // plain listener ignores it while still catching the document scroll.
    const onScroll = (): void => {
      setOpen(false);
      setPosition(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onScroll);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, filtered.length]);

  const choose = (next: string): void => {
    onValueChange(next);
    close();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(filtered.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option !== undefined) choose(option.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      setPosition(null);
    }
  };

  return (
    <div className="form-group">
      {label !== undefined ? (
        <label className="form-label" htmlFor={triggerId}>
          <span>{label}</span>
        </label>
      ) : null}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="radix-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPanel();
          }
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: value.length > 0 ? "var(--text-primary)" : "var(--text-tertiary)",
          }}
        >
          {value.length > 0 ? selectedLabel : placeholder}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={panelRef}
              className="radix-select-content"
              style={{
                position: "fixed",
                top: `${position.top}px`,
                left: `${position.left}px`,
                width: `${position.width}px`,
                maxHeight: "none",
                overflow: "visible",
              }}
            >
              <div style={{ padding: "5px", borderBottom: "1px solid var(--inner-border)" }}>
                <input
                  ref={inputRef}
                  className="form-input"
                  role="combobox"
                  aria-expanded={true}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-label={searchPlaceholder}
                  aria-activedescendant={
                    filtered[activeIndex] === undefined ? undefined : optionId(activeIndex)
                  }
                  value={query}
                  placeholder={searchPlaceholder}
                  autoFocus
                  style={{ height: "30px", fontSize: "12px" }}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={onInputKeyDown}
                />
              </div>
              <div
                id={listId}
                role="listbox"
                aria-label={ariaLabel ?? label ?? "Options"}
                style={{ maxHeight: "280px", overflowY: "auto", padding: "5px" }}
              >
                {filtered.length === 0 ? (
                  <div
                    style={{
                      padding: "8px 10px",
                      fontSize: "12px",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {emptyMessage}
                  </div>
                ) : (
                  filtered.map((option, index) => (
                    <div
                      key={option.value}
                      id={optionId(index)}
                      role="option"
                      aria-selected={option.value === value}
                      className="radix-select-item"
                      data-highlighted={index === activeIndex ? "" : undefined}
                      data-state={option.value === value ? "checked" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option.value)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {option.label}
                      </span>
                      {option.value === value ? (
                        <span className="radix-select-indicator">
                          <Check size={13} aria-hidden="true" />
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
