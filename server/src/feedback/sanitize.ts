// Tester text is untrusted and ends up (rewritten) in a GitHub issue that an AI agent may later read.
// Everything that reaches GitHub passes through here: no hidden comments, no HTML, no mentions,
// no issue cross-references, no links or images.

const ZWSP = "​";

export function cleanText(input: string, max: number): string {
  return String(input)
    .replace(/<!--[\s\S]*?-->/g, " ") // hidden comments (the trace marker lives in one)
    .replace(/<!--/g, " ")
    .replace(/<\/?[a-z!][^>]*>/gi, " ") // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images (tracking pixels)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links keep their text only
    .replace(/\bhttps?:\/\/\S+/gi, "[link removed]")
    .replace(/@([A-Za-z0-9_-])/g, `@${ZWSP}$1`) // no mentions
    .replace(/#(\d)/g, `#${ZWSP}$1`) // no issue/PR cross-references
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export const oneLine = (input: string, max: number) => cleanText(input, max).replace(/\s+/g, " ");
