// Read one line from the terminal without showing it (for keys and passphrases). Needs an interactive terminal.
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("This needs an interactive terminal so what you type stays hidden."));
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(buf); }
        if (ch === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
