import { createInterface } from "node:readline";

/**
 * The interactive launcher menu.
 *
 * Rendering and selection are separate on purpose: {@link renderMenu} is a pure
 * string builder so the box can be asserted in a test without a TTY, and
 * {@link promptMenu} owns the terminal. The split also keeps the fallback
 * honest — a piped stdin still has a menu, it just answers by number.
 */

export type MenuAction = "update" | "web" | "tui" | "tray" | "exit";

export interface MenuItem {
  readonly action: MenuAction;
  readonly label: string;
}

export interface MenuInput {
  readonly version: string;
  readonly port: number;
  /** Present only when a newer release exists; the update row is omitted otherwise. */
  readonly update?: { readonly latest: string } | undefined;
  /** Row the `>` cursor sits on. Out-of-range values clamp. */
  readonly selectedIndex?: number | undefined;
}

const BOX_RULE = "=".repeat(40);

/** Rows in fixed order; the update row leads because it is the reason to open the menu. */
export function buildMenuItems(input: MenuInput): readonly MenuItem[] {
  const items: MenuItem[] = [];
  if (input.update !== undefined) {
    items.push({
      action: "update",
      label: `Update to v${input.update.latest} (current: v${input.version})`,
    });
  }
  items.push(
    { action: "web", label: "Web UI (Open in Browser)" },
    { action: "tui", label: "Terminal UI (Interactive CLI)" },
    { action: "tray", label: "Hide to Tray (Background)" },
    { action: "exit", label: "Exit" },
  );
  return items;
}

/** Renders the menu box, cursor included. No terminal writes, no reads. */
export function renderMenu(input: MenuInput): string {
  const items = buildMenuItems(input);
  const requested = input.selectedIndex ?? 0;
  const cursor = Math.min(Math.max(requested, 0), items.length - 1);

  const lines: string[] = [
    BOX_RULE,
    `  Choose Interface (v${input.version})`,
    `  🚀 Server: http://localhost:${input.port}`,
    BOX_RULE,
    "",
  ];
  items.forEach((item, index) => {
    lines.push(`  ${index === cursor ? ">" : " "} ${item.label}`);
  });
  return lines.join("\n");
}

export interface PromptOptions {
  /** Streams are injectable so the non-TTY path is testable. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

/**
 * Presents the menu and resolves the chosen action.
 *
 * TTY: raw mode, arrow keys, Enter, `q`/Ctrl-C to exit. Non-TTY (piped, CI):
 * a numbered prompt read line by line, because raw mode on a pipe never emits
 * keypresses and waiting for one hangs the process forever.
 */
export async function promptMenu(input: MenuInput, options: PromptOptions = {}): Promise<MenuAction> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const items = buildMenuItems(input);
  if (stdin.isTTY === true && stdout.isTTY === true) {
    return await promptInteractive(input, items, stdin, stdout);
  }
  return await promptNumbered(input, items, stdin, stdout);
}

async function promptInteractive(
  input: MenuInput,
  items: readonly MenuItem[],
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<MenuAction> {
  let cursor = 0;
  const lineCount = items.length + 5;
  const draw = (): void => {
    stdout.write(renderMenu({ ...input, selectedIndex: cursor }));
  };

  // Raw mode must be undone on every path, including a throw from the listener
  // or from `draw` — a shell left in raw mode has no echo and no line editing.
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?25l");
  draw();

  try {
    return await new Promise<MenuAction>((resolve) => {
      const finish = (action: MenuAction): void => {
        stdin.off("data", onData);
        resolve(action);
      };
      const onData = (chunk: Buffer): void => {
        const key = chunk.toString("utf8");
        if (key === "\u001b[A" || key === "k") {
          cursor = (cursor - 1 + items.length) % items.length;
          redraw();
          return;
        }
        if (key === "\u001b[B" || key === "j") {
          cursor = (cursor + 1) % items.length;
          redraw();
          return;
        }
        if (key === "\r" || key === "\n") {
          const item = items[cursor];
          finish(item === undefined ? "exit" : item.action);
          return;
        }
        if (key === "q" || key === "\u0003") {
          finish("exit");
        }
      };
      const redraw = (): void => {
        // Rewind to the top of the box and clear it, then paint again. The
        // erase is what keeps a shrinking menu (update row gone) from leaving
        // stale rows behind.
        stdout.write(`\x1b[${lineCount}A\x1b[J`);
        draw();
      };
      stdin.on("data", onData);
    });
  } finally {
    stdout.write("\x1b[?25h");
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\n");
  }
}

async function promptNumbered(
  input: MenuInput,
  items: readonly MenuItem[],
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<MenuAction> {
  stdout.write(`${renderMenu(input)}\n\n`);
  for (const [index, item] of items.entries()) {
    stdout.write(`  ${index + 1}) ${item.label}\n`);
  }
  stdout.write(`\nSelect [1-${items.length}]: `);

  const rl = createInterface({ input: stdin, terminal: false });
  try {
    for await (const raw of rl) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        stdout.write(`Select [1-${items.length}]: `);
        continue;
      }
      const choice = Number.parseInt(trimmed, 10);
      if (Number.isInteger(choice) && choice >= 1 && choice <= items.length) {
        const item = items[choice - 1];
        if (item !== undefined) {
          return item.action;
        }
      }
      if (trimmed === "q") {
        return "exit";
      }
      stdout.write(`Invalid selection. Select [1-${items.length}]: `);
    }
    // Input closed without an answer (empty pipe, Ctrl-D). Exiting is the only
    // safe default: a non-interactive caller has nobody to ask again.
    return "exit";
  } finally {
    rl.close();
  }
}
