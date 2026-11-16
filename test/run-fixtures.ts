import type { z } from "zod";
import {
  foldRun,
  initialRun,
  runProjection,
} from "../src/projection/run-projection.js";

// Fixture events form a deliberately small subset of the production event port.
export type RunState = z.infer<typeof runProjection.stateSchema>;
export type TextBlock = { type: "text" | "reasoning"; text: string };
type EventEnvelope<Type extends string, Data> = {
  type: Type;
  time?: number;
  seq?: number;
  data: Data;
};
export type RunEvent =
  | EventEnvelope<"turn/start", { turn: number }>
  | EventEnvelope<"turn/end", { reason: { kind: "completed" | "aborted" } }>
  | EventEnvelope<"request/header", { header: { config: { model: string } } }>
  | EventEnvelope<"session/title", { title: string }>
  | EventEnvelope<
      "tool/call",
      { callId: string; name: string; arguments: string }
    >
  | EventEnvelope<
      "tool/result",
      {
        meta?: Record<string, unknown>;
        message: {
          toolCallId: string;
          source?: { callId: string };
          isError: boolean;
          content: TextBlock[];
        };
      }
    >
  | EventEnvelope<
      "assistant/message",
      {
        turn?: number;
        step?: number;
        message: { content: TextBlock[] };
      }
    >
  | EventEnvelope<
      "assistant/attempt",
      {
        stream: (
          | { type: "reasoning-chunks" | "text-chunks"; texts: string[] }
          | { type: "chunk"; chunk: { type: "text-delta"; text: string } }
        )[];
      }
    >;

export { initialRun, foldRun };
