/**
 * Replaces the contents of `#` comments and string literals with spaces
 * (preserving newlines and overall string length, so line/column offsets
 * computed against the result stay valid against the original source) -
 * everything else is left untouched.
 *
 * This is the Python-ecosystem counterpart to what real AST parsing gives
 * `UsageAnalyzer` for free for JS/TS: since there's no lightweight,
 * dependency-free Python parser available the way `typescript` serves as
 * one for JS/TS, `PythonUsageAnalyzer` works over masked text instead of a
 * real syntax tree (see that file's doc comment for what this trade-off
 * means in practice).
 *
 * Handles single/double-quoted strings, triple-quoted strings/docstrings
 * (`'''...'''` / `"""..."""`, which can span multiple lines), and all
 * valid string prefixes (`r`, `b`, `u`, `f`, and combinations like
 * `rb`/`fr`). f-string interpolations (`{expr}`) are deliberately left
 * live - masking them wholesale would be a regression, since real code
 * frequently calls functions inside an f-string (`f"Result: {old_api()}"`)
 * and that's genuine usage. Doubled braces (`{{`/`}}`, an escaped literal
 * brace in an f-string) are recognized and not mistaken for interpolation.
 */
export function maskPythonCommentsAndStrings(source: string): string {
  const out: string[] = Array.from(source);
  const n = out.length;

  const blank = (idx: number) => {
    if (out[idx] !== "\n" && out[idx] !== "\r") out[idx] = " ";
  };

  interface StringStart {
    prefixLen: number;
    quote: string;
    isFString: boolean;
    triple: boolean;
  }

  function matchStringStart(i: number): StringStart | null {
    let prefixLen = 0;
    while (prefixLen < 2 && i + prefixLen < n && /[bBrRuUfF]/.test(out[i + prefixLen])) {
      prefixLen++;
    }
    const quoteStart = i + prefixLen;
    if (quoteStart >= n) return null;
    const c = out[quoteStart];
    if (c !== "'" && c !== '"') return null;

    let isFString = false;
    for (let k = 0; k < prefixLen; k++) {
      if (out[i + k] === "f" || out[i + k] === "F") isFString = true;
    }
    const triple = quoteStart + 2 < n && out[quoteStart + 1] === c && out[quoteStart + 2] === c;
    return { prefixLen, quote: c, isFString, triple };
  }

  /** Consumes a `{ ... }` f-string interpolation body (already past the opening "{"), tracking brace depth and masking any nested strings found inside it. */
  function consumeExpression(start: number): number {
    let j = start;
    let depth = 1;
    while (j < n && depth > 0) {
      if (out[j] === "{") {
        depth++;
        j++;
        continue;
      }
      if (out[j] === "}") {
        depth--;
        j++;
        continue;
      }
      const strMatch = matchStringStart(j);
      if (strMatch) {
        j = consumeStringFrom(j, strMatch);
        continue;
      }
      j++; // ordinary code character inside the expression - leave live
    }
    return j;
  }

  function consumeSimpleQuoted(start: number, quote: string, isFString: boolean): number {
    let j = start;
    while (j < n) {
      if (out[j] === "\\") {
        blank(j);
        j++;
        if (j < n) {
          blank(j);
          j++;
        }
        continue;
      }
      if (out[j] === quote) {
        blank(j);
        return j + 1;
      }
      if (out[j] === "\n") return j; // unterminated/malformed - bail without consuming the newline
      if (isFString && out[j] === "{") {
        if (out[j + 1] === "{") {
          blank(j);
          blank(j + 1);
          j += 2;
          continue;
        }
        blank(j);
        j++;
        j = consumeExpression(j);
        continue;
      }
      if (isFString && out[j] === "}" && out[j + 1] === "}") {
        blank(j);
        blank(j + 1);
        j += 2;
        continue;
      }
      blank(j);
      j++;
    }
    return j;
  }

  function consumeTripleQuoted(start: number, quote: string, isFString: boolean): number {
    let j = start;
    while (j < n) {
      if (out[j] === "\\") {
        blank(j);
        j++;
        if (j < n) {
          blank(j);
          j++;
        }
        continue;
      }
      if (out[j] === quote && out[j + 1] === quote && out[j + 2] === quote) {
        blank(j);
        blank(j + 1);
        blank(j + 2);
        return j + 3;
      }
      if (isFString && out[j] === "{") {
        if (out[j + 1] === "{") {
          blank(j);
          blank(j + 1);
          j += 2;
          continue;
        }
        blank(j);
        j++;
        j = consumeExpression(j);
        continue;
      }
      if (isFString && out[j] === "}" && out[j + 1] === "}") {
        blank(j);
        blank(j + 1);
        j += 2;
        continue;
      }
      blank(j); // includes newlines inside the triple-quoted body, correctly preserved (not turned into spaces) by blank()
      j++;
    }
    return j;
  }

  function consumeStringFrom(i: number, match: StringStart): number {
    for (let k = 0; k < match.prefixLen; k++) blank(i + k);
    const quoteStart = i + match.prefixLen;
    if (match.triple) {
      blank(quoteStart);
      blank(quoteStart + 1);
      blank(quoteStart + 2);
      return consumeTripleQuoted(quoteStart + 3, match.quote, match.isFString);
    }
    blank(quoteStart);
    return consumeSimpleQuoted(quoteStart + 1, match.quote, match.isFString);
  }

  let i = 0;
  while (i < n) {
    if (out[i] === "#") {
      while (i < n && out[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }

    const strMatch = matchStringStart(i);
    if (strMatch) {
      i = consumeStringFrom(i, strMatch);
      continue;
    }

    i++;
  }

  return out.join("");
}
