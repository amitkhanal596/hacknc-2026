/**
 * Local DM simulator: text the bot as different people from one terminal.
 * Runs the real bot, ledger, jobs, and HTTP API (so pay links open locally).
 *
 *   npm run sim                 in-memory DB (fresh every run)
 *   npm run sim -- --persist    keeps data in ./data/sim.db
 */
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { createApp } from "./api/app";
import { FAKE_RECEIPT_MIME } from "./ai/types";
import { handleDM } from "./bot/handler";
import { describeFeatures, loadConfig } from "./config";
import { createContext } from "./context";
import { openDb } from "./db/client";
import { runJobs } from "./jobs";
import { parseDollarsToCents } from "./ledger/money";
import { MemoryMessenger } from "./messaging/memory";
import { normalizeHandle } from "./messaging/types";

const persist = process.argv.includes("--persist");
const config = loadConfig();

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", reset: "\x1b[0m" };

// Friendly names ↔ fake phone numbers.
const people = new Map<string, string>(); // name -> phone
const nameByPhone = new Map<string, string>();
function phoneFor(name: string): string {
  if (/^\+?\d[\d\s()-]{6,}$/.test(name)) return normalizeHandle(name);
  const key = name.toLowerCase();
  if (!people.has(key)) {
    const phone = `+1919555${String(1000 + people.size).padStart(4, "0")}`;
    people.set(key, phone);
    nameByPhone.set(phone, key);
  }
  return people.get(key)!;
}

const messenger = new MemoryMessenger((m) => {
  const who = nameByPhone.get(m.to) ?? m.to;
  const body = m.text.split("\n").map((l, i) => (i === 0 ? l : `   ${l}`)).join("\n");
  console.log(`${c.cyan}📱 Tab → ${who}:${c.reset} ${body}`);
});

let offsetMs = 0;
const ctx = createContext(config, messenger, {
  db: openDb(persist ? "./data/sim.db" : ":memory:"),
  now: () => Date.now() + offsetMs,
});
await messenger.listen((dm) => handleDM(ctx, dm));
const server = serve({ fetch: createApp(ctx).fetch, port: config.port });

let speaker = "amit";
phoneFor(speaker);

console.log(`${c.bold}Tab simulator${c.reset} ${c.dim}(API on http://localhost:${config.port})${c.reset}
${describeFeatures(config)}

Type a message to send it to the bot as the current person.
  ${c.yellow}/as <name>${c.reset}                 switch who's texting (new names get a fake number)
  ${c.yellow}/receipt <amount> [merchant] [| caption]${c.reset}   send a fake receipt photo
  ${c.yellow}/photo <file> [| caption]${c.reset}  send a real image (read by Gemini if configured)
  ${c.yellow}/jobs${c.reset}                      run reminders / auto-approve now
  ${c.yellow}/advance <minutes>${c.reset}         move the clock forward, then run jobs
  ${c.yellow}/who${c.reset}  ${c.yellow}/quit${c.reset}
Try: ${c.dim}new trip Asheville${c.reset} → ${c.dim}/as jake${c.reset} → ${c.dim}JOIN <code>${c.reset}
`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const send = (text: string | null, images: Parameters<MemoryMessenger["receive"]>[2] = []) =>
  messenger.receive(phoneFor(speaker), text, images);

while (true) {
  const line = (await rl.question(`${c.green}[${speaker}]${c.reset} > `).catch(() => "/quit")).trim();
  if (!line) continue;
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ");
  try {
    if (cmd === "/quit" || cmd === "/exit") break;
    else if (cmd === "/as") {
      if (!arg) console.log("Usage: /as <name>");
      else {
        speaker = arg.toLowerCase();
        console.log(`${c.dim}now texting as ${speaker} (${phoneFor(speaker)})${c.reset}`);
      }
    } else if (cmd === "/who") {
      for (const [name, phone] of people) console.log(`  ${name === speaker ? "▶" : " "} ${name} ${c.dim}${phone}${c.reset}`);
    } else if (cmd === "/receipt") {
      const [left, caption] = arg.split("|").map((s) => s.trim());
      const [amount, ...merchantWords] = (left ?? "").split(/\s+/);
      const totalCents = parseDollarsToCents(amount ?? "");
      if (!totalCents) console.log("Usage: /receipt 80.00 Shell | gas, everyone");
      else {
        const body = Buffer.from(
          JSON.stringify({ totalCents, merchant: merchantWords.join(" ") || undefined, date: new Date(ctx.now()).toISOString().slice(0, 10) }),
        );
        await send(caption || null, [{ name: "receipt.jpg", mimeType: FAKE_RECEIPT_MIME, read: async () => body }]);
      }
    } else if (cmd === "/photo") {
      const [file, caption] = arg.split("|").map((s) => s.trim());
      if (!file) console.log("Usage: /photo ~/Desktop/receipt.jpg | gas, everyone");
      else {
        const path = file.replace(/^~/, process.env.HOME ?? "~");
        const data = readFileSync(path);
        const ext = extname(path).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : ext === ".heic" ? "image/heic" : "image/jpeg";
        await send(caption || null, [{ name: path, mimeType, read: async () => data }]);
      }
    } else if (cmd === "/jobs") {
      console.log(c.dim, await runJobs(ctx), c.reset);
    } else if (cmd === "/advance") {
      const minutes = Number(arg);
      if (!minutes) console.log("Usage: /advance 30");
      else {
        offsetMs += minutes * 60_000;
        console.log(`${c.dim}clock +${minutes}m${c.reset}`);
        console.log(c.dim, await runJobs(ctx), c.reset);
      }
    } else if (cmd?.startsWith("/")) {
      console.log("Unknown command. /as, /receipt, /photo, /jobs, /advance, /who, /quit");
    } else {
      await send(line);
    }
  } catch (err) {
    console.error(err);
  }
}

rl.close();
server.close();
process.exit(0);
