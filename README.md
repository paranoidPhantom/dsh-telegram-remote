# Telegram Remote

Control DeepSeek Harness from a private Telegram bot: session topics, streaming replies, tool logs, approvals, model selection, and file/media delivery.

## Install

1. Open DSH **Plugin Manager** and install **`dsh-telegram-remote`** from npm.
2. Restart DSH if requested, then open **Settings → Telegram Remote**.
3. Save your BotFather bot token and numeric Telegram admin user ID. Tokens are stored in DSH credentials.
4. Enable private-chat topics in **@BotFather → /mybots → your bot → Bot Settings → Topics**. [Tutorial](https://www.reddit.com/r/hermesagent/comments/1ta5o5g/tutorial_threaded_messages_on_telegram_dm/).
5. Open your bot and send `/start`. Use `/sessions` or Telegram’s **New Topic** to begin.

DSH must remain running. Only the configured admin can control the bot.
