#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Cron } from "croner";
import { watch } from "fs";
import { readdir, unlink } from "fs/promises";
import path from "path";

const HOME = process.env.HOME!;
const SESSIONS_DIR = path.join(HOME, ".claude", "sessions");
const MAILBOX_ROOT = path.join(HOME, ".claude", "channels", "ccchat");

type Msg = { from: string; text: string; ts: number };
type ScheduledJob = { id: string; to: string; text: string; cron: string; job: Cron };
const jobs: ScheduledJob[] = [];

async function findSessionId(): Promise<string> {
  const ppid = process.ppid;

  const direct = Bun.file(path.join(SESSIONS_DIR, `${ppid}.json`));
  if (await direct.exists()) return (await direct.json()).sessionId;

  for (const f of await readdir(SESSIONS_DIR).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = await Bun.file(path.join(SESSIONS_DIR, f)).json();
      if (data.pid === ppid) return data.sessionId;
    } catch {}
  }

  return crypto.randomUUID();
}

async function getPeers(): Promise<string[]> {
  const entries = await readdir(MAILBOX_ROOT).catch(() => [] as string[]);
  return entries.filter((e) => e !== SESSION_ID && !e.startsWith("."));
}

async function resolveTarget(to_session?: string): Promise<string | null> {
  if (to_session) return to_session;
  const peers = await getPeers();
  return peers.length === 1 ? peers[0] : null;
}

async function deliver(target: string, msg: Msg) {
  const targetInbox = path.join(MAILBOX_ROOT, target);
  await Bun.$`mkdir -p ${targetInbox}`;
  await Bun.write(path.join(targetInbox, `${Date.now()}-${msg.from}.json`), JSON.stringify(msg));
}

async function broadcast(msg: Msg) {
  const peers = await getPeers();
  await Promise.all(peers.map((p) => deliver(p, msg)));
  return peers.length;
}

function delayToCron(delay: string): string | null {
  const m = delay.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  switch (m[2]) {
    case "s": return `*/${n} * * * * *`;
    case "m": return `0 */${n} * * * *`;
    case "h": return `0 0 */${n} * * *`;
    case "d": return `0 0 0 */${n} * *`;
  }
  return null;
}

const SESSION_ID = await findSessionId();
const MY_INBOX = path.join(MAILBOX_ROOT, SESSION_ID);
await Bun.$`mkdir -p ${MY_INBOX}`;

const mcp = new Server(
  { name: "ccchat", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `You are in a two-way chat with another Claude Code instance.`,
      `Your session: "${SESSION_ID}".`,
      `Inbound messages arrive as <channel source="ccchat" from_session="...">.`,
      `Tools: "send" (one-off), "broadcast" (send to all), "schedule" (recurring cron), "cancel", "list_peers", "list_jobs".`,
      `If there's only one peer, "send" targets it automatically.`,
      `"schedule" is always recurring. Use "every" (30s, 5m) or "cron" expression. Cancel with "cancel".`,
    ].join("\n"),
  }
);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send",
      description: "Send a message to another Claude Code session",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message to send" },
          to_session: { type: "string", description: "Target session ID (optional if one peer)" },
        },
        required: ["text"],
      },
    },
    {
      name: "broadcast",
      description: "Send a message to all connected sessions",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message to send to all peers" },
        },
        required: ["text"],
      },
    },
    {
      name: "schedule",
      description: "Schedule a recurring message. Use interval (30s, 5m, 2h) or cron expression. Always recurring — use cancel to stop.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The message to send" },
          every: { type: "string", description: "Interval shorthand: 30s, 5m, 2h, 1d" },
          cron: { type: "string", description: "Cron expression (6-field with seconds), e.g. */30 * * * * *" },
          to_session: { type: "string", description: "Target session ID, 'all' for broadcast (optional if one peer)" },
        },
        required: ["text"],
      },
    },
    {
      name: "cancel",
      description: "Cancel a scheduled job by ID, or 'all' to cancel everything",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Job ID from list_jobs, or 'all'" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_peers",
      description: "List other active ccchat sessions",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_jobs",
      description: "List active scheduled jobs",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "list_peers") {
    const peers = await getPeers();
    return text(peers.length ? peers.join("\n") : "No peers found.");
  }

  if (req.params.name === "list_jobs") {
    const active = jobs.filter((j) => j.job.isRunning());
    if (!active.length) return text("No active jobs.");
    return text(active.map((j) => {
      const next = j.job.nextRun()?.toLocaleTimeString() ?? "—";
      return `[${j.id}] ${j.cron} -> ${j.to}: "${j.text.slice(0, 40)}" next: ${next}`;
    }).join("\n"));
  }

  if (req.params.name === "cancel") {
    const { id } = req.params.arguments as { id: string };
    if (id === "all") {
      jobs.forEach((j) => j.job.stop());
      const count = jobs.length;
      jobs.length = 0;
      return text(`Cancelled ${count} job(s).`);
    }
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return text(`Job ${id} not found.`);
    jobs[idx].job.stop();
    jobs.splice(idx, 1);
    return text(`Cancelled ${id}.`);
  }

  if (req.params.name === "broadcast") {
    const { text: msgText } = req.params.arguments as { text: string };
    const count = await broadcast({ from: SESSION_ID, text: msgText, ts: Date.now() });
    return text(count ? `Broadcast to ${count} peer(s).` : "No peers found.");
  }

  if (req.params.name === "send") {
    const args = req.params.arguments as { text: string; to_session?: string };
    const target = await resolveTarget(args.to_session);
    if (!target) {
      const peers = await getPeers();
      return text(peers.length ? `Multiple peers. Specify to_session: ${peers.join(", ")}` : "No peers found.");
    }
    try {
      await deliver(target, { from: SESSION_ID, text: args.text, ts: Date.now() });
      return text(`Sent to ${target}.`);
    } catch (e: any) {
      return text(`Failed: ${e.message}`);
    }
  }

  if (req.params.name === "schedule") {
    const args = req.params.arguments as { text: string; every?: string; cron?: string; to_session?: string };
    const target = await resolveTarget(args.to_session);
    if (!target) {
      const peers = await getPeers();
      return text(peers.length ? `Multiple peers. Specify to_session: ${peers.join(", ")}` : "No peers found.");
    }

    const cronExpr = args.cron ?? (args.every ? delayToCron(args.every) : null);
    if (!cronExpr) return text("Provide 'every' (30s, 5m, 2h, 1d) or 'cron' expression.");

    const id = crypto.randomUUID().slice(0, 8);
    const job = new Cron(cronExpr, async () => {
      const msg = { from: SESSION_ID, text: args.text, ts: Date.now() };
      if (target === "all") await broadcast(msg);
      else await deliver(target, msg);
    });

    jobs.push({ id, to: target, text: args.text, cron: cronExpr, job });
    const next = job.nextRun()?.toLocaleTimeString() ?? "now";
    return text(`Job ${id} scheduled (${cronExpr}). Next: ${next}. Use cancel("${id}") to stop.`);
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

watch(MY_INBOX, async (_event, filename) => {
  if (!filename?.endsWith(".json")) return;
  const msgPath = path.join(MY_INBOX, filename);
  try {
    const file = Bun.file(msgPath);
    if (!(await file.exists())) return;
    const msg = await file.json() as Msg;
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: msg.text, meta: { from_session: msg.from } },
    });
    await unlink(msgPath).catch(() => {});
  } catch {}
});
