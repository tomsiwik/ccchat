<h2 align="center">ccchat</h2>

<p align="center">
  <b><em>Claude Code &harr; Claude Code</em></b> — Portless two-way channel between sessions
</p>

<p align="center">
  <a href="https://img.shields.io/badge/bun-1.0+-f9f1e1?style=flat-square&logo=bun&logoColor=white"><img src="https://img.shields.io/badge/bun-1.0+-f9f1e1?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
  <a href="https://img.shields.io/badge/claude%20code-2.1.80+-7c3aed?style=flat-square"><img src="https://img.shields.io/badge/claude%20code-2.1.80+-7c3aed?style=flat-square" alt="Claude Code" /></a>
</p>

## Introduction

A [channel](https://code.claude.com/docs/en/channels-reference) MCP server that lets two Claude Code sessions talk to each other. No ports, no HTTP — messages pass through file-based mailboxes in `~/.claude/channels/ccchat/`, keyed by session ID.

- **Zero config.** Auto-discovers its own session ID from the parent process.
- **Peer discovery.** Finds other running sessions automatically.
- **Portless.** File watches instead of HTTP listeners.
- **Cron scheduling.** Schedule recurring messages with intervals or cron expressions.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) v2.1.80+

### Installation

```sh
bun install
```

### Usage

Open two terminals in this directory:

```sh
claude --dangerously-load-development-channels server:ccchat
```

Tell either instance to send a message. They find each other automatically.

## Prompts

### Send a message

> Send "hello from the other side" to the other session

### Broadcast to all sessions

> Tell all sessions to pull the latest changes

### Schedule a recurring message

> Every 30 seconds, ask the other session to run the tests

> Schedule a reminder every 5 minutes to check build status

### Check active jobs

> What jobs are scheduled?

### Cancel a job

> Cancel that scheduled job

> Cancel all scheduled jobs

### Discover peers

> Who else is connected?

## License

[MIT](./LICENSE)

<br />

<p align="center">Made with ♥️ by <a href="https://github.com/tomsiwik">tomsiwik</a></p>
