export const TOPIC_TUTORIAL =
  "https://www.reddit.com/r/hermesagent/comments/1ta5o5g/tutorial_threaded_messages_on_telegram_dm/";
export const TOPIC_MODE_HELP =
  "Threaded messages are turned off for this bot.\n\nOpen @BotFather → /mybots → select this bot → Bot Settings → Topics, and enable topics in private chats. Then return here and send /sessions.\n\nTutorial: " +
  TOPIC_TUTORIAL;
export const topicModeError = (error: unknown): boolean =>
  /chat is not a forum|topic mode.*(?:disabled|off)|forum.*(?:not enabled|disabled)/i.test(
    String(errorMessage(error) ?? error),
  );

function errorMessage(error: unknown): unknown {
  return error != null && typeof error === "object" && "message" in error
    ? error.message
    : undefined;
}
