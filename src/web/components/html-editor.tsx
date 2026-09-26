import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { sanitizeHtml } from "~/web/lib/html";

/**
 * A translation field that holds HTML, edited the way a person reads it
 * (docs/translations.md § Editor).
 *
 * A product description is prose with a little markup in it, and a column
 * of `<p>` and `</strong>` is not prose. The field has two views: **Rich
 * text**, where the words are the words and a small toolbar does the
 * markup, and **HTML**, the source itself, for a field with an embed in it
 * or for anyone who would rather see the tags. The source beside it is
 * rendered the same way, so the two columns read as the same document in
 * two languages rather than as two listings of markup.
 *
 * Built from `contenteditable` and Polaris buttons rather than an editor
 * library: a rich text framework is a second design system inside a Polaris
 * page and a large dependency for bold, italic, a list and a link
 * (docs/BUILD_SPEC.md section 2.6). `document.execCommand` is how the
 * platform does those without one; it is deprecated in favour of nothing in
 * particular and every current browser implements it.
 *
 * Nothing renders unsanitised. What is pasted is cleaned before it lands,
 * so a paste from a word processor brings its words and not its markup, and
 * what is rendered on either side goes through the same allowlist
 * (`web/lib/html`).
 */
export type HtmlView = "rich" | "source";

const BOX: CSSProperties = {
  border: "1px solid var(--s-color-border, #e3e3e3)",
  borderRadius: "8px",
  padding: "12px",
  overflowWrap: "anywhere",
  overflowY: "auto",
};

const PROSE: CSSProperties = {
  ...BOX,
  background: "var(--s-color-bg-surface, #ffffff)",
  lineHeight: 1.5,
};

/**
 * The strip across the top of a field box. A fixed height rather than a
 * minimum: the two columns hold different controls, and a strip that grows
 * to its own content starts the two columns' first lines a few pixels apart.
 */
const STRIP: CSSProperties = {
  flexShrink: 0,
  boxSizing: "border-box",
  height: "40px",
  borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  overflow: "hidden",
};

/**
 * A field box: a strip across the top and the content under it, both
 * columns built the same way so the words on either side start on the same
 * line. Without it the editor's toolbar would push its first line below the
 * source's.
 */
function Framed({
  blockSize,
  background,
  strip,
  children,
  ...rest
}: {
  blockSize: string;
  background: string;
  strip: ReactNode;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <div
      {...rest}
      style={{
        ...PROSE,
        padding: 0,
        overflow: "hidden",
        background,
        height: blockSize,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {strip ? <div style={STRIP}>{strip}</div> : null}
      {children}
    </div>
  );
}

/** The source, rendered: the same document, read rather than decoded. */
export function HtmlPreview({
  html,
  blockSize,
  label,
  strip,
}: {
  html: string;
  /** A CSS length, matched to the field beside it so a row is one height. */
  blockSize: string;
  label: string;
  /** What sits across the top, level with the editor's toolbar. */
  strip?: ReactNode;
}) {
  return (
    <Framed
      aria-label={label}
      blockSize={blockSize}
      background="var(--s-color-bg-subdued, #f7f7f7)"
      strip={strip}
    >
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "12px",
          overflowWrap: "anywhere",
        }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
      />
    </Framed>
  );
}

/** The source, as text: read-only, for the field the rich view cannot hold. */
export function HtmlSource({
  html,
  blockSize,
  label,
  strip,
}: {
  html: string;
  blockSize: string;
  label: string;
  strip?: ReactNode;
}) {
  return (
    <Framed
      aria-label={label}
      blockSize={blockSize}
      background="var(--s-color-bg-subdued, #f7f7f7)"
      strip={strip}
    >
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          padding: "12px",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontFamily: "var(--s-font-family-mono, ui-monospace, monospace)",
          fontSize: "13px",
        }}
      >
        {html}
      </div>
    </Framed>
  );
}

/** Rich text or the source, chosen for the whole field. */
export function HtmlViewSwitch({
  view,
  onChange,
  richDisabled,
  disabledReason,
}: {
  view: HtmlView;
  onChange: (view: HtmlView) => void;
  /** Rich text would mangle this field, so it is not offered. */
  richDisabled?: boolean;
  disabledReason?: string;
}) {
  const tipId = `html-view-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <s-stack
      direction="inline"
      gap="small-500"
      alignItems="center"
      accessibilityLabel="How this field is shown"
    >
      <s-button
        variant={view === "rich" ? "secondary" : "tertiary"}
        onClick={() => onChange("rich")}
        {...(richDisabled ? { disabled: true } : {})}
        {...(richDisabled && disabledReason ? { interestFor: tipId } : {})}
      >
        Rich text
      </s-button>
      <s-button
        variant={view === "source" ? "secondary" : "tertiary"}
        onClick={() => onChange("source")}
      >
        HTML
      </s-button>
      {richDisabled && disabledReason ? (
        <s-tooltip id={tipId}>{disabledReason}</s-tooltip>
      ) : null}
    </s-stack>
  );
}

/** Polaris names its own icons; the toolbar uses that type rather than a string. */
type IconName = NonNullable<React.ComponentProps<"s-button">["icon"]>;

interface Command {
  label: string;
  icon: IconName;
  run: () => void;
}

/**
 * What the browser writes, in the document's own vocabulary: bold and
 * italic come back as `<b>` and `<i>`, and a description written in
 * `<strong>` and `<em>` should not become a mixture of both.
 */
function normalise(html: string): string {
  return html.replace(/<(\/?)b>/g, "<$1strong>").replace(/<(\/?)i>/g, "<$1em>");
}

export function HtmlEditor({
  value,
  onChange,
  blockSize,
  label,
  placeholder,
  busy,
}: {
  value: string;
  onChange: (html: string) => void;
  /** A CSS length for the whole field, toolbar included. */
  blockSize: string;
  label: string;
  placeholder: string;
  busy: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [url, setUrl] = useState("");
  const [linking, setLinking] = useState(false);
  /** Where the caret was when the link popover took the focus. */
  const saved = useRef<Range | null>(null);

  // Enter opens a paragraph rather than a bare `<div>`, so the markup the
  // editor writes is the markup the document is already made of.
  useEffect(() => {
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      // An older browser keeps its own separator; nothing here depends on it.
    }
  }, []);

  /*
   * Only an edit made somewhere else is written in. Writing on every
   * keystroke would put the caret back at the start of the field, and —
   * less obviously — every write clears the browser's own undo history,
   * which is what the undo button goes through. So the comparison is
   * against what this field *would* emit, not against its raw markup: the
   * browser writes `<b>`, the field emits `<strong>`, and those two are the
   * same edit rather than a reason to rewrite the field.
   */
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    if (normalise(element.innerHTML) !== value) element.innerHTML = value;
  }, [value]);

  const emit = () => {
    const element = editor.current;
    if (!element) return;
    onChange(normalise(element.innerHTML));
  };

  /** Runs a command with the caret where the person left it. */
  const run = (command: string, argument?: string) => {
    editor.current?.focus();
    // A remembered range can outlive what it pointed at — an undo, or an
    // edit somewhere else — and restoring a stale one throws.
    try {
      if (saved.current) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(saved.current);
      }
    } catch {
      saved.current = null;
    }
    document.execCommand(command, false, argument);
    emit();
  };

  /**
   * Undo and redo are the browser's own, over the field's own history, so
   * they go back through typing and toolbar commands alike. They run on the
   * focused field without restoring a remembered caret: undo puts the caret
   * back where the edit it took away had been.
   */
  const stepHistory = (command: "undo" | "redo") => {
    editor.current?.focus();
    document.execCommand(command);
    saved.current = null;
    remember();
    emit();
  };

  /** Puts the typed address on the words the caret was left on. */
  const apply = () => {
    run("createLink", url.trim());
    setLinking(false);
    setUrl("");
  };

  const remember = () => {
    const selection = window.getSelection();
    saved.current =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).cloneRange()
        : null;
  };

  const history: Command[] = [
    { label: "Undo", icon: "undo", run: () => stepHistory("undo") },
    { label: "Redo", icon: "redo", run: () => stepHistory("redo") },
  ];

  const commands: Command[] = [
    { label: "Bold", icon: "text-bold", run: () => run("bold") },
    { label: "Italic", icon: "text-italic", run: () => run("italic") },
    {
      label: "Heading",
      icon: "text-title",
      run: () => run("formatBlock", "<h3>"),
    },
    {
      label: "Paragraph",
      icon: "text",
      run: () => run("formatBlock", "<p>"),
    },
    {
      label: "Bulleted list",
      icon: "list-bulleted",
      run: () => run("insertUnorderedList"),
    },
    {
      label: "Numbered list",
      icon: "list-numbered",
      run: () => run("insertOrderedList"),
    },
    {
      label: "Clear formatting",
      icon: "eraser",
      run: () => run("removeFormat"),
    },
  ];

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    event.preventDefault();
    const clean = html
      ? sanitizeHtml(html)
      : text.replace(/[<>&]/g, (c) =>
          c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
        );
    document.execCommand("insertHTML", false, clean);
    emit();
  };

  const empty = value.replace(/<[^>]*>/g, "").trim() === "";

  return (
    /*
     * One box, toolbar and all: the field beside it is a box of the same
     * height, and a toolbar above the box would start the two columns on
     * different lines.
     */
    <div
      style={{
        ...PROSE,
        padding: 0,
        overflow: "hidden",
        height: blockSize,
        display: "flex",
        flexDirection: "column",
        outline: focused
          ? "2px solid var(--s-color-border-focus, #005bd3)"
          : "none",
        outlineOffset: "1px",
      }}
    >
      <div style={STRIP}>
        <s-stack direction="inline" gap="small-500" alignItems="center">
          {history.map((command) => (
            <s-button
              key={command.label}
              variant="tertiary"
              icon={command.icon}
              accessibilityLabel={command.label}
              {...(busy ? { disabled: true } : {})}
              onClick={command.run}
            />
          ))}
          {/* Going back is not formatting; a rule says so without a word. */}
          <div
            aria-hidden="true"
            style={{
              width: "1px",
              height: "20px",
              margin: "0 4px",
              background: "var(--s-color-border, #e3e3e3)",
            }}
          />
          {commands.map((command) => (
            <s-button
              key={command.label}
              variant="tertiary"
              icon={command.icon}
              accessibilityLabel={command.label}
              {...(busy ? { disabled: true } : {})}
              onClick={command.run}
            />
          ))}
          <s-button
            variant="tertiary"
            icon="link"
            accessibilityLabel="Add link"
            {...(busy ? { disabled: true } : {})}
            onClick={() => {
              remember();
              setLinking((now) => !now);
            }}
          />
        </s-stack>
      </div>

      {/*
       * The link row is part of the field rather than a floating panel: it
       * opens under the toolbar, takes the focus, and closes on Escape or
       * once the link is made. A row cannot be mispositioned, and it is
       * reachable by tab from the button that opened it.
       */}
      {linking ? (
        <div
          style={{
            flexShrink: 0,
            borderBottom: "1px solid var(--s-color-border, #e3e3e3)",
            padding: "8px",
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setLinking(false);
            }
            if (event.key === "Enter" && url.trim() !== "") {
              event.preventDefault();
              apply();
            }
          }}
        >
          <s-grid
            gridTemplateColumns="minmax(0, 1fr) auto auto"
            gap="small-300"
            alignItems="end"
          >
            <s-url-field
              label="Link address"
              labelAccessibilityVisibility="exclusive"
              placeholder="https://recharge.si/collections/sup"
              value={url}
              onInput={(event) => setUrl(event.currentTarget.value)}
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
            <s-button
              variant="secondary"
              {...(url.trim() === "" ? { disabled: true } : {})}
              onClick={apply}
            >
              Add link
            </s-button>
            <s-button
              variant="tertiary"
              onClick={() => {
                run("unlink");
                setLinking(false);
                setUrl("");
              }}
            >
              Remove link
            </s-button>
          </s-grid>
        </div>
      ) : null}

      {/* The placeholder sits behind the field rather than inside it, so an
          empty field is never a field with a word in it to delete. */}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        {empty && !focused ? (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: "12px",
              left: "12px",
              pointerEvents: "none",
              color: "var(--s-color-text-subdued, #616161)",
            }}
          >
            {placeholder}
          </div>
        ) : null}
        <div
          ref={editor}
          contentEditable={!busy}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          tabIndex={0}
          spellCheck
          style={{
            height: "100%",
            overflowY: "auto",
            overflowWrap: "anywhere",
            padding: "12px",
            lineHeight: 1.5,
            outline: "none",
            opacity: busy ? 0.6 : 1,
          }}
          onInput={emit}
          onBlur={() => {
            setFocused(false);
            remember();
            emit();
          }}
          onFocus={() => setFocused(true)}
          onKeyUp={remember}
          onMouseUp={remember}
          onPaste={onPaste}
        />
      </div>
    </div>
  );
}
