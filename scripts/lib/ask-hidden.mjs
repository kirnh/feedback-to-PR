// Read one line from the terminal without showing it (for keys and passphrases). Needs an interactive terminal.

/** Some terminals wrap pasted text in invisible marker codes. Remove them, and any other control characters. */
export function cleanTyped(chunk) {
  return chunk.replace(/\u001b\[20[01]~/g, "").replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/g, "");
}

export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("This needs an interactive terminal so what you type stays hidden."));
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const onData = (raw) => {
      for (const ch of cleanTyped(raw)) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(buf); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;
      }
      if (raw.includes("\u0003")) { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
    };
    stdin.on("data", onData);
  });
}
