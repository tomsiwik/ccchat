#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { watch } from "fs";
import { readdir, unlink } from "fs/promises";
import path from "path";

const HOME = process.env.HOME!;
const SESSIONS_DIR = path.join(HOME, ".claude", "sessions");
const MAILBOX_ROOT = path.join(HOME, ".claude", "channels", "ccchat");

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
      `Use "send" to reply. Use "list_peers" to discover sessions.`,
      `If there's only one peer, "send" targets it automatically.`,
    ].join("\n"),
  }
);

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
      name: "list_peers",
      description: "List other active ccchat sessions",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  if (req.params.name === "list_peers") {
    const peers = await getPeers();
    return text(peers.length ? peers.join("\n") : "No peers found.");
  }

  if (req.params.name === "send") {
    const args = req.params.arguments as { text: string; to_session?: string };

    let target = args.to_session;
    if (!target) {
      const peers = await getPeers();
      if (peers.length === 0) return text("No peers found.");
      if (peers.length > 1) return text(`Multiple peers. Specify to_session: ${peers.join(", ")}`);
      target = peers[0];
    }

    const targetInbox = path.join(MAILBOX_ROOT, target);
    const msgFile = path.join(targetInbox, `${Date.now()}-${SESSION_ID}.json`);

    try {
      await Bun.$`mkdir -p ${targetInbox}`;
      await Bun.write(msgFile, JSON.stringify({ from: SESSION_ID, text: args.text, ts: Date.now() }));
      return text(`Sent to ${target}.`);
    } catch (e: any) {
      return text(`Failed: ${e.message}`);
    }
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
    const msg = await file.json() as { from: string; text: string };
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: msg.text, meta: { from_session: msg.from } },
    });
    await unlink(msgPath).catch(() => {});
  } catch {}
});
