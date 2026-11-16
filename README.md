<img src="icon.svg" width="150">

# Telegram Remote

[![npm](https://img.shields.io/npm/v/dsh-telegram-remote?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/dsh-telegram-remote)

[English](README.md) · [简体中文](README.zh-CN.md) · [Русский](README.ru.md)

Control DeepSeek Harness from a private Telegram bot, built around **Telegram threads and modern native messaging features**.

- **Threads by design:** each DSH session has its own private-chat topic. Open existing sessions on demand or start one with Telegram’s native **New Topic** action.
- **Native streaming:** animated draft replies, Telegram’s Stop button, live tool previews, and typing indicators. Completed messages and stopped partial answers stay in the chat.
- **Built for tool-heavy work:** compact, collapsed tool logs; updates coalesced per session; only changed log pages are edited; independent draft/edit scheduling across topics with flood-control backoff.
- **Controls where you work:** informative approvals with colored buttons, in-place model and existing-workspace selection for new sessions, pinned session details, queue steering, and native photo/video/audio or document delivery.

## Preview

<a href="https://raw.githubusercontent.com/paranoidPhantom/dsh-telegram-remote/main/preview.mp4"><img src="preview.png" width="320" alt="Telegram Remote video preview"></a>

[Watch the demo](https://raw.githubusercontent.com/paranoidPhantom/dsh-telegram-remote/main/preview.mp4).

## Install

1. Open DSH **Plugin Manager** and install **`dsh-telegram-remote`** from npm.
2. Restart DSH if requested, then open **Settings → Telegram Remote**.
3. Save your BotFather bot token and numeric Telegram admin user ID. Tokens are stored in DSH credentials.
4. Enable private-chat topics in **@BotFather → /mybots → your bot → Bot Settings → Topics**. [Tutorial](https://www.reddit.com/r/hermesagent/comments/1ta5o5g/tutorial_threaded_messages_on_telegram_dm/).
5. Open your bot and send `/start`. Use `/sessions` or Telegram’s **New Topic** to begin.

DSH must remain running: Telegram networking runs in a child process supervised by the DSH plugin, not an independent daemon. Only the configured admin can control the bot.
