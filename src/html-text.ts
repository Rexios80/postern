import { htmlToText } from "html-to-text";

// htmlparser2's open-element stack makes parsing quadratic in nesting depth, and
// html-to-text's walk overflows around 2000 levels. mailparser applies this guard
// only when it converts HTML itself, which it skips for nested parts.
const MAX_HTML_NESTING_DEPTH = 1000;
const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
// A sibling start tag closes these, so a long unclosed run is not really nested.
const HTML_IMPLIED_END_ELEMENTS = new Set([
  "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "rt", "rp",
]);

function isTagNameChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)
    || code === 0x2d || code === 0x3a || code === 0x5f;
}

function exceedsHtmlNestingDepth(html: string, maxDepth: number): boolean {
  const stack: string[] = [];
  const open = new Map<string, number>();
  const len = html.length;
  let i = html.indexOf("<");
  while (i >= 0) {
    let pos = i + 1;
    if (html.startsWith("!--", pos)) {
      const end = html.indexOf("-->", pos + 3);
      i = end < 0 ? -1 : html.indexOf("<", end + 3);
      continue;
    }
    const closing = html.charCodeAt(pos) === 0x2f;
    if (closing) pos++;
    const nameStart = pos;
    while (pos < len && isTagNameChar(html.charCodeAt(pos))) pos++;
    if (pos === nameStart) {
      i = html.indexOf("<", pos);
      continue;
    }
    const name = html.slice(nameStart, pos).toLowerCase();
    const end = html.indexOf(">", pos);
    if (end < 0) break;
    if (!HTML_VOID_ELEMENTS.has(name) && !HTML_IMPLIED_END_ELEMENTS.has(name)) {
      if (!closing) {
        stack.push(name);
        open.set(name, (open.get(name) ?? 0) + 1);
        if (stack.length > maxDepth) return true;
      } else if (open.get(name)) {
        let popped: string | undefined;
        do {
          popped = stack.pop();
          if (!popped) break;
          open.set(popped, (open.get(popped) ?? 0) - 1);
        } while (popped !== name);
      }
    }
    i = html.indexOf("<", end + 1);
  }
  return false;
}

const HTML_TO_TEXT = {
  limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
  selectors: [
    { selector: "tr", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "td", format: "inlineSurround", options: { suffix: " " } },
    { selector: "th", format: "inlineSurround", options: { suffix: " " } },
  ],
};

export function htmlToPlainText(html: string): { text: string; textError?: string } {
  if (exceedsHtmlNestingDepth(html, MAX_HTML_NESTING_DEPTH)) {
    return { text: "", textError: `HTML nested deeper than ${MAX_HTML_NESTING_DEPTH} levels` };
  }
  try {
    const text = htmlToText(html, HTML_TO_TEXT).replace(/[ \t]+$/gm, "").trim();
    if (!text) {
      return { text: "", textError: "The message has an HTML body, but no readable text could be extracted from it." };
    }
    return { text };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "Failed to convert HTML to text";
    return { text: "", textError: message };
  }
}
