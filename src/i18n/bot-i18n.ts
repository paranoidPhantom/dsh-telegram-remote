import { TOPIC_MODE_HELP, TOPIC_TUTORIAL } from "./topic-mode.js";

/** Only plugin-owned UI copy belongs here. Never translate model/tool/backend data. */
const messages = {
  stop: ["⏹ Stop", "⏹ 停止", "⏹ Остановить"],
  model: ["Model", "模型", "Модель"],
  details: ["Details", "详情", "Подробности"],
  endTopic: ["End topic", "结束话题", "Завершить тему"],
  directoryPath: ["Directory: {path}", "目录：{path}", "Каталог: {path}"],
  directory: ["Directory", "目录", "Каталог"],
  deepDiving: ["Deep diving", "深入思考中", "Углублённый анализ"],
  tools: ["Tools", "工具", "Инструменты"],
  working: ["working", "进行中", "в работе"],
  finished: ["finished", "已结束", "завершено"],
  running: ["running", "运行中", "выполняется"],
  completed: ["completed", "已完成", "выполнено"],
  failed: ["failed", "失败", "ошибка"],
  cancelled: ["cancelled", "已取消", "отменено"],
  idle: ["Idle", "空闲", "Ожидание"],
  activeModel: ["Active", "当前模型", "Активная"],
  context: ["Context", "上下文", "Контекст"],
  approvalRequired: ["Approval required", "需要审批", "Требуется согласование"],
  reason: ["Reason", "原因", "Причина"],
  command: ["Command", "命令", "Команда"],
  paths: ["Paths", "路径", "Пути"],
  consequences: ["Consequences", "影响", "Последствия"],
  requestedAccess: [
    "Requested access",
    "请求的访问权限",
    "Запрашиваемый доступ",
  ],
  fullAccess: [
    "Full access — outside the workspace sandbox",
    "完全访问权限——超出工作区沙箱范围",
    "Полный доступ — вне песочницы рабочего каталога",
  ],
  removedBundle: ["Remove plugin bundle", "移除扩展包", "Удалить пакет"],
  installBundle: ["Install plugin bundle", "安装扩展包", "Установить пакет"],
  changeBundle: ["Change plugin bundle", "更改扩展包", "Изменить пакет"],
  changePlugin: ["Change plugin", "更改插件", "Изменить плагин"],
  noAnswer: ["No answer returned.", "（无回答）", "(нет ответа)"],
  unableComplete: [
    "Unable to complete the request.",
    "无法完成",
    "Не удалось завершить",
  ],
  stopped: ["Stopped.", "已停止", "Остановлено"],
  originalWidgetSource: [
    "Original widget source",
    "原始小组件源码",
    "Исходный код виджета",
  ],
  widgetNotDelivered: [
    "Widget not delivered",
    "小组件未送达",
    "Виджет не доставлен",
  ],
  offline: [
    "⚠ DSH offline. /status to retry.",
    "⚠ DSH 离线。使用 /status 重试。",
    "⚠ DSH недоступен. Повторите через /status.",
  ],
  sessionGoneTitle: ["⚠ Session gone", "⚠ 会话已不存在", "⚠ Сессия недоступна"],
  sessionGoneSessions: [
    "Session gone in DSH. Use /sessions.",
    "DSH 中的会话已不存在。使用 /sessions。",
    "Сессия в DSH недоступна. Используйте /sessions.",
  ],
  unauthorized: ["Not authorized.", "未获授权。", "Нет доступа."],
  confirmationExpiredAlert: [
    "Confirmation expired. Send another message here or use /new to confirm again.",
    "确认已过期。请在此再发一条消息或使用 /new 重新确认。",
    "Подтверждение устарело. Отправьте сюда ещё сообщение или используйте /new.",
  ],
  confirmationExpired: [
    "Confirmation expired. No DSH session was created. Queued topic messages are retained in memory; send another message here to confirm again.",
    "确认已过期，未创建 DSH 会话。话题中的排队消息仍保留在内存中；请在此再发一条消息以重新确认。",
    "Подтверждение устарело. Сессия DSH не создана. Сообщения темы сохранены в очереди в памяти; отправьте сюда ещё сообщение для повторного подтверждения.",
  ],
  controlsExpired: [
    "Controls expired. Refreshed; choose again.",
    "控件已过期并已刷新，请重新选择。",
    "Кнопки устарели и обновлены. Выберите снова.",
  ],
  topicKept: [
    "Topic kept. DSH session unchanged.",
    "话题已保留，DSH 会话未更改。",
    "Тема сохранена. Сессия DSH не изменена.",
  ],
  steeringNow: [
    "Steering now.",
    "正在引导。",
    "Сообщение направлено в текущий запуск.",
  ],
  noLongerQueued: [
    "This message is no longer queued.",
    "此消息已不在队列中。",
    "Это сообщение больше не в очереди.",
  ],
  topicReady: [
    "Session topic ready.",
    "会话话题已就绪。",
    "Тема сессии готова.",
  ],
  openTopic: ["Open topic", "打开话题", "Открыть тему"],
  deniedReason: [
    "Denied. Optional reason? Reply with one line.",
    "已拒绝。可回复一行文字说明原因。",
    "Отклонено. При желании ответьте одной строкой с причиной.",
  ],
  reasonNoted: [
    "Reason noted in Telegram only; DSH approval API accepts outcomes, not denial reasons.",
    "原因仅记录在 Telegram 中；DSH 审批 API 只接受结果，不接受拒绝原因。",
    "Причина отмечена только в Telegram; API согласований DSH принимает решения, но не причины отказа.",
  ],
  version: [
    "Telegram Remote {version} · host {pid}",
    "Telegram Remote {version} · 主机 {pid}",
    "Telegram Remote {version} · хост {pid}",
  ],
  versionRuntime: [
    "Supervisor {hostPid} · child {childPid}\nBuild {build} · generation {generation}",
    "监督进程 {hostPid} · 子进程 {childPid}\n构建 {build} · 代次 {generation}",
    "Супервизор {hostPid} · дочерний процесс {childPid}\nСборка {build} · поколение {generation}",
  ],
  unknown: ["unknown", "未知", "неизвестно"],
  help: [
    "/sessions — open a live DSH session\n/new — create session\n/status — fresh compact status\n/stop — stop this session\n/files — deliver artifacts\n/help\nSend prompts inside a bound session topic. Model selection is in the pinned card. Approvals support Allow once or Deny, never Always allow.",
    "/sessions — 打开实时 DSH 会话\n/new — 创建会话\n/status — 刷新简要状态\n/stop — 停止此会话\n/files — 发送产物文件\n/help\n请在已绑定的会话话题中发送提示词。在置顶卡片中选择模型。审批仅支持“允许一次”或“拒绝”，不支持“始终允许”。",
    "/sessions — открыть сессию DSH\n/new — создать сессию\n/status — обновить краткий статус\n/stop — остановить эту сессию\n/files — получить файлы\n/help\nОтправляйте запросы в тему привязанной сессии. Выбор модели — в закреплённой карточке. Согласования поддерживают «Разрешить один раз» и «Отклонить», но не постоянное разрешение.",
  ],
  openSessionHint: [
    "Open a session with /sessions, or create a new topic in Telegram.",
    "使用 /sessions 打开会话，或在 Telegram 中创建新话题。",
    "Откройте сессию через /sessions или создайте новую тему в Telegram.",
  ],
  sessionGone: [
    "Session gone in DSH. Use /new or /sessions.",
    "DSH 中的会话已不存在。使用 /new 或 /sessions。",
    "Сессия в DSH недоступна. Используйте /new или /sessions.",
  ],
  goneRetry: [
    "Session gone. Use /new or /sessions.",
    "会话已不存在。使用 /new 或 /sessions。",
    "Сессия недоступна. Используйте /new или /sessions.",
  ],
  unknownCommand: [
    "Unknown command. Use /help.",
    "未知命令。使用 /help。",
    "Неизвестная команда. Используйте /help.",
  ],
  queued: ["Queued in DSH.", "已在 DSH 中排队。", "Добавлено в очередь DSH."],
  steerNow: ["Steer now", "立即引导", "Направить сейчас"],
  warning: ["⚠ {error}", "⚠ {error}", "⚠ {error}"],
  approvalOutcome: [
    "Approval: {outcome}",
    "审批：{outcome}",
    "Согласование: {outcome}",
  ],
  "outcome.allowed-once": ["allowed-once", "允许一次", "разрешено один раз"],
  "outcome.rejected": ["rejected", "已拒绝", "отклонено"],
  "outcome.cancelled": ["cancelled", "已取消", "отменено"],
  "outcome.unavailable": ["unavailable", "不可用", "недоступно"],
  allowOnce: ["Allow once", "允许一次", "Разрешить один раз"],
  deny: ["Deny", "拒绝", "Отклонить"],
  previous: ["‹ Previous", "‹ 上一页", "‹ Назад"],
  next: ["Next ›", "下一页 ›", "Далее ›"],
  newSession: ["New session", "新建会话", "Новая сессия"],
  sessionsPage: [
    "DSH sessions · page {page}",
    "DSH 会话 · 第 {page} 页",
    "Сессии DSH · страница {page}",
  ],
  noSessions: [
    "No sessions. Use /new.",
    "暂无会话。使用 /new。",
    "Сессий нет. Используйте /new.",
  ],
  chooseProvider: [
    "Choose provider (live DSH catalog)",
    "选择提供商（实时 DSH 目录）",
    "Выберите провайдера (актуальный каталог DSH)",
  ],
  providers: ["‹ Providers", "‹ 提供商", "‹ Провайдеры"],
  modelsPage: [
    "{provider} · page {page}",
    "{provider} · 第 {page} 页",
    "{provider} · страница {page}",
  ],
  selectionUnacknowledged: [
    "DSH did not acknowledge selection",
    "DSH 未确认选择",
    "DSH не подтвердил выбор",
  ],
  selectionUnconfirmed: [
    "DSH has not confirmed this selection yet",
    "DSH 尚未确认此选择",
    "DSH ещё не подтвердил этот выбор",
  ],
  nextTurn: [
    "Applies next turn.",
    "下一轮生效。",
    "Применится в следующем ходе.",
  ],
  nextStep: [
    "Applies at the next DSH step boundary.",
    "在 DSH 下一步骤边界生效。",
    "Применится на границе следующего шага DSH.",
  ],
  modelUnchanged: [
    "⚠ Model unchanged: {error}",
    "⚠ 模型未更改：{error}",
    "⚠ Модель не изменена: {error}",
  ],
  noModel: [
    "DSH has no model selected. Choose a default model in DSH first.",
    "DSH 尚未选择模型。请先在 DSH 中选择默认模型。",
    "В DSH не выбрана модель. Сначала выберите модель по умолчанию в DSH.",
  ],
  confirmNew: ["Confirm new session", "确认新建会话", "Подтвердить создание"],
  cancel: ["Cancel", "取消", "Отмена"],
  createSession: [
    "Create DSH session with {provider} / {model}{effort}?{hint}",
    "使用 {provider} / {model}{effort} 创建 DSH 会话？{hint}",
    "Создать сессию DSH с {provider} / {model}{effort}?{hint}",
  ],
  nativeNewHint: [
    "\nChoose a model, then confirm. Your messages wait here. Cancel deletes this topic and its history.",
    "\n请选择模型后确认。您的消息将在此等待。取消将删除此话题及其历史记录。",
    "\nВыберите модель и подтвердите. Ваши сообщения будут ждать здесь. Отмена удалит эту тему и её историю.",
  ],
  newHint: [
    "\nAfter confirmation, open the new topic using its link.",
    "\n确认后，请使用链接打开新话题。",
    "\nПосле подтверждения откройте новую тему по ссылке.",
  ],
  creationCancelled: [
    "Session creation cancelled. Queued messages were not sent to DSH.",
    "已取消创建会话。排队消息未发送到 DSH。",
    "Создание сессии отменено. Сообщения из очереди не отправлены в DSH.",
  ],
  topicAlreadyBound: [
    "This topic is already bound.",
    "此话题已绑定。",
    "Эта тема уже привязана.",
  ],
  modelUnacknowledged: [
    "DSH did not acknowledge model selection",
    "DSH 未确认模型选择",
    "DSH не подтвердил выбор модели",
  ],
  cannotOpenTopic: [
    "Unable to open the new session topic",
    "无法打开新会话话题",
    "Не удалось открыть тему новой сессии",
  ],
  nativeReady: [
    "Session ready in this topic.",
    "会话已在此话题中就绪。",
    "Сессия готова в этой теме.",
  ],
  newReady: [
    "New session ready. Open the topic below; Telegram cannot switch topics automatically.",
    "新会话已就绪。请打开下方话题；Telegram 无法自动切换话题。",
    "Новая сессия готова. Откройте тему ниже; Telegram не может переключить тему автоматически.",
  ],
  openSession: ["Open session", "打开会话", "Открыть сессию"],
  setupFailed: [
    "⚠ Session setup failed: {error}. No new-topic link was published. Use /sessions to inspect DSH before retrying.",
    "⚠ 会话设置失败：{error}。未发布新话题链接。重试前请使用 /sessions 检查 DSH。",
    "⚠ Не удалось настроить сессию: {error}. Ссылка на новую тему не опубликована. Проверьте DSH через /sessions перед повтором.",
  ],
  deleteTopic: [
    "Delete Telegram topic",
    "删除 Telegram 话题",
    "Удалить тему Telegram",
  ],
  closeConfirmation: [
    "Close session in Telegram? This deletes only its Telegram topic. The DSH session and any active DSH run are preserved and continue. Reopen it later with /sessions.",
    "在 Telegram 中关闭会话？这只会删除其 Telegram 话题。DSH 会话和任何正在运行的 DSH 任务都将保留并继续。稍后可使用 /sessions 重新打开。",
    "Закрыть сессию в Telegram? Будет удалена только тема Telegram. Сессия DSH и активный запуск сохранятся и продолжат работу. Откройте её снова через /sessions.",
  ],
  topicModeHelp: [
    TOPIC_MODE_HELP,
    `此机器人尚未开启话题消息。\n\n打开 @BotFather → /mybots → 选择此机器人 → Bot Settings → Topics，开启私聊话题。然后返回此处发送 /sessions。\n\n教程：${TOPIC_TUTORIAL}`,
    `Для этого бота отключены темы.\n\nОткройте @BotFather → /mybots → выберите бота → Bot Settings → Topics и включите темы в личных чатах. Затем вернитесь сюда и отправьте /sessions.\n\nИнструкция: ${TOPIC_TUTORIAL}`,
  ],
} satisfies Record<string, readonly [string, string, string]>;

export type BotLocale = "en" | "zh" | "ru";
export type MessageKey = keyof typeof messages;
export type TranslationParams = Readonly<Record<string, unknown>>;
export type Translator = (key: string, params?: TranslationParams) => string;

type Dictionary = Readonly<Record<string, string | undefined>>;

/** Complete parallel dictionaries are exported for parity checks and shared formatters. */
export const dictionaries: Readonly<Record<BotLocale, Dictionary>> =
  Object.freeze({
    en: dictionary(0),
    zh: dictionary(1),
    ru: dictionary(2),
  });

function dictionary(index: 0 | 1 | 2): Dictionary {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(messages).map(([key, values]) => [key, values[index]]),
    ),
  );
}

export function normalizeLocale(tag: unknown): BotLocale {
  const base =
    typeof tag === "string" ? tag.trim().toLowerCase().split(/[-_]/)[0] : "";
  return base === "zh" || base === "ru" ? base : "en";
}

/** Locale is read for every call so existing consoles follow preference changes. */
export function createTranslator(
  getLocale: () => unknown = () => "en",
): Translator {
  return (key, params = {}) => {
    const locale = normalizeLocale(getLocale());
    const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
  };
}
