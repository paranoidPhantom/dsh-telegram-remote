# Telegram 远程控制

[English](README.md) · [简体中文](README.zh-CN.md) · [Русский](README.ru.md)

通过私人 Telegram 机器人控制 DeepSeek Harness，以 **Telegram 话题和现代原生消息功能**为核心。

- **以话题组织会话：** 每个 DSH 会话对应一个私聊话题。按需打开已有会话，或通过 Telegram 原生的 **New Topic（新建话题）**操作创建会话。
- **原生流式输出：** 动态草稿回复、Telegram 停止按钮、实时工具预览和输入状态提示。完整消息和已停止的部分回答都会保留在聊天中。
- **适合密集工具调用：** 紧凑、折叠的工具日志；按会话合并更新；仅编辑有变化的日志页；不同话题独立调度草稿和编辑，并在限流时退避。
- **就地操作：** 交互式审批、原地模型选择、队列引导，以及原生图片、视频、音频或文档发送。

## 安装

1. 打开 DSH **插件管理器（Plugin Manager）**，从 npm 安装 **`dsh-telegram-remote`**。
2. 如有提示，重启 DSH，然后打开 **设置 → Telegram 远程控制**。
3. 保存 BotFather 提供的机器人令牌和 Telegram 数字管理员用户 ID。令牌存储在 DSH 凭据中。
4. 在 **@BotFather → /mybots → 你的机器人 → Bot Settings → Topics** 中启用私聊话题。[教程](https://www.reddit.com/r/hermesagent/comments/1ta5o5g/tutorial_threaded_messages_on_telegram_dm/)。
5. 打开机器人并发送 `/start`。使用 `/sessions` 或 Telegram 的 **New Topic（新建话题）**开始。

DSH 必须保持运行。只有配置的管理员可以控制机器人。
