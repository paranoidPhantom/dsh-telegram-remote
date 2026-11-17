export const messages = {
  en: {
    title: "Telegram Remote",
    intro:
      "Connect a private Telegram bot and choose the only user allowed to control it.",
    admin: "Admin user ID",
    adminHelp:
      "Numeric Telegram user ID. Changing it revokes the previous admin’s access.",
    token: "Bot token",
    tokenSaved: "Token saved — leave blank to keep it",
    tokenPlaceholder: "Paste the token from BotFather",
    tokenHelp:
      "Stored in DSH credentials, never in plugin configuration. The saved token is not returned to this page.",
    loading: "Loading…",
    saving: "Saving…",
    save: "Save",
    copyDebugLog: "Copy debug log",
    debugCopying: "Copying…",
    debugCopied: "Debug log copied.",
    debugCopyError: "Unable to copy debug log.",
    saved:
      "Saved. The admin ID applies immediately; token changes are read on the next API request.",
    loadError: "Unable to load settings.",
    saveError: "Unable to save settings.",
    adminError: "Admin user ID must be a positive integer.",
    tokenError: "Enter a valid Telegram bot token.",
    credentialError: "The credentials store did not confirm the token write.",
    rejected: "Harness rejected this settings request.",
    ownerError: "Owner access required.",
    methodError: "Method not allowed.",
    jsonError: "JSON required.",
    sizeError: "Request too large.",
  },
  zh: {
    title: "Telegram 远程控制",
    intro: "连接私人 Telegram 机器人，并指定唯一有权控制它的用户。",
    admin: "管理员用户 ID",
    adminHelp: "Telegram 数字用户 ID。更改后，原管理员将失去访问权限。",
    token: "机器人令牌",
    tokenSaved: "令牌已保存 — 留空以保留",
    tokenPlaceholder: "粘贴 BotFather 提供的令牌",
    tokenHelp:
      "仅存储在 DSH 凭据中，不写入插件配置。此页面不会读取已保存的令牌。",
    loading: "加载中…",
    saving: "保存中…",
    save: "保存",
    copyDebugLog: "复制调试日志",
    debugCopying: "复制中…",
    debugCopied: "调试日志已复制。",
    debugCopyError: "无法复制调试日志。",
    saved: "已保存。管理员 ID 立即生效；令牌更改将在下一次 API 请求时使用。",
    loadError: "无法加载设置。",
    saveError: "无法保存设置。",
    adminError: "管理员用户 ID 必须为正整数。",
    tokenError: "请输入有效的 Telegram 机器人令牌。",
    credentialError: "凭据存储未确认令牌写入成功。",
    rejected: "Harness 拒绝了此设置请求。",
    ownerError: "需要所有者权限。",
    methodError: "不支持此请求方法。",
    jsonError: "需要 JSON 格式。",
    sizeError: "请求过大。",
  },
  ru: {
    title: "Удалённый доступ через Telegram",
    intro:
      "Подключите личного Telegram-бота и укажите единственного пользователя, которому разрешено им управлять.",
    admin: "ID администратора",
    adminHelp:
      "Числовой ID пользователя Telegram. После изменения прежний администратор потеряет доступ.",
    token: "Токен бота",
    tokenSaved: "Токен сохранён — оставьте поле пустым, чтобы сохранить его",
    tokenPlaceholder: "Вставьте токен от BotFather",
    tokenHelp:
      "Хранится в учётных данных DSH, а не в конфигурации плагина. Сохранённый токен не возвращается на эту страницу.",
    loading: "Загрузка…",
    saving: "Сохранение…",
    save: "Сохранить",
    copyDebugLog: "Скопировать журнал отладки",
    debugCopying: "Копирование…",
    debugCopied: "Журнал отладки скопирован.",
    debugCopyError: "Не удалось скопировать журнал отладки.",
    saved:
      "Сохранено. ID администратора применяется сразу; новый токен используется при следующем запросе API.",
    loadError: "Не удалось загрузить настройки.",
    saveError: "Не удалось сохранить настройки.",
    adminError: "ID администратора должен быть положительным целым числом.",
    tokenError: "Введите действительный токен Telegram-бота.",
    credentialError: "Хранилище учётных данных не подтвердило запись токена.",
    rejected: "Harness отклонил этот запрос настроек.",
    ownerError: "Требуется доступ владельца.",
    methodError: "Метод не разрешён.",
    jsonError: "Требуется формат JSON.",
    sizeError: "Слишком большой запрос.",
  },
};

export type Locale = keyof typeof messages;
export type MessageKey = keyof typeof messages.en;
export const normalizeLocale = (value: unknown): Locale => {
  const base =
    typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : "";
  return base === "en" || base === "zh" || base === "ru" ? base : "en";
};
export const errorKeys: Readonly<Record<string, MessageKey | undefined>> = {
  "Admin user ID must be a positive integer.": "adminError",
  "Enter a valid Telegram bot token.": "tokenError",
  "The credentials store did not confirm the token write.": "credentialError",
  "Harness rejected this settings request.": "rejected",
  "Owner access required": "ownerError",
  "Method not allowed": "methodError",
  "JSON required": "jsonError",
  "Request too large": "sizeError",
  "Unable to load settings": "loadError",
};
