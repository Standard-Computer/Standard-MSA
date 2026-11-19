// Version-to-version body diff (SHA-2959). PURE.
//
// Shown in the update-notice preview so an operator can see what actually
// changed before deciding to notify anyone — the diff is the evidence behind
// "should these recipients hear about this?".
//
// Line-level, over an LCS, because a contract body's unit of meaning is the
// clause/paragraph line. A word-level diff reads better for prose but makes
// a renumbered clause look like a rewritten one, which is the opposite of
// what this screen is for.

export type DiffKind = "same" | "added" | "removed";

export type DiffLine = {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the before/after body; null where absent. */
  beforeLine: number | null;
  afterLine: number | null;
};

export type DiffSummary = { added: number; removed: number; changed: boolean };

/**
 * Bodies longer than this fall back to a coarse whole-body replacement
 * instead of the O(n*m) table. At the cap the table is already ~9 MB, and a
 * legal body of 1500 lines is far past anything an MSA contains — the guard
 * exists so a pasted-in novel degrades the preview instead of the process.
 */
export const MAX_DIFF_LINES = 1500;

function splitLines(body: string): string[] {
  return body.replace(/\r\n?/g, "\n").split("\n");
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text, i) => line("removed", text, i + 1, null)),
      ...b.map((text, i) => line("added", text, null, i + 1)),
    ];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..], flattened row-major.
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(line("same", a[i], i + 1, j + 1));
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      // Removals before additions at the same position, so a replaced line
      // reads as "- old" then "+ new" rather than the other way round.
      out.push(line("removed", a[i], i + 1, null));
      i++;
    } else {
      out.push(line("added", b[j], null, j + 1));
      j++;
    }
  }
  while (i < a.length) out.push(line("removed", a[i], i++ + 1, null));
  while (j < b.length) out.push(line("added", b[j], null, j++ + 1));
  return out;
}

function line(kind: DiffKind, text: string, beforeLine: number | null, afterLine: number | null): DiffLine {
  return { kind, text, beforeLine, afterLine };
}

export function summarizeDiff(lines: readonly DiffLine[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "added") added += 1;
    else if (l.kind === "removed") removed += 1;
  }
  return { added, removed, changed: added + removed > 0 };
}

export type DiffHunk = { lines: DiffLine[] };

/**
 * Only the changed regions, each with `context` unchanged lines around it,
 * so the preview is the change and not the whole agreement. Adjacent regions
 * whose context would overlap are merged into one hunk.
 */
export function diffHunks(lines: readonly DiffLine[], context = 2): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "same") continue;
    any = true;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }
  if (!any) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (!current) {
        current = [];
        hunks.push({ lines: current });
      }
      current.push(lines[i]);
    } else {
      current = null;
    }
  }
  return hunks;
}
