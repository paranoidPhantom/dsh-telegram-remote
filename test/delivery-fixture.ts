import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type { TelegramMethod, TelegramParams } from "../src/bot/contracts.js";

export interface DeliveryTool {
  callId?: string;
  name: string;
  summary?: string;
  status: string;
}

export interface DeliveryView {
  turn: number;
  answer?: string;
  partialAnswer?: string;
  partialId?: string;
  outputs?: { id: string; text: string; toolCount?: number }[];
  toolLog?: DeliveryTool[];
  final?: boolean;
  status?: string;
}

export type DeliveryParams = TelegramParams;

type DeliveryResult = true | { message_id: number };

interface DeliveryApi {
  call(
    method: TelegramMethod,
    params?: TelegramParams,
  ): Promise<DeliveryResult>;
}

export interface DeliveryCall {
  method: string;
  params: DeliveryParams;
  result: DeliveryResult;
}

interface OutputReceipt {
  id: string;
  messageIds: number[];
}

interface StoredDelivery {
  chatId?: number;
  threadId?: number;
  cardId?: number;
  latestControlMessageId?: number;
  messageId?: number;
  final?: boolean;
  superseded?: boolean;
  outputs?: OutputReceipt[];
  logStart?: number;
  logMessageIds?: number[];
  sealedLogMessageIds?: number[];
  finalMessageIds?: number[];
}

interface DeliveryStore {
  get(key: string): Promise<StoredDelivery | undefined>;
  set(key: string, value: StoredDelivery): Promise<void>;
  entries(): Promise<[string, StoredDelivery][]>;
}

export function deliveryFixture(
  t: TestContext,
  options: { cardId?: number; ownerId?: number } = {},
) {
  const data = new Map<string, StoredDelivery>([
    [
      "console:topic:s",
      {
        chatId: 1,
        threadId: 2,
        ...(options.cardId === undefined ? {} : { cardId: options.cardId }),
      },
    ],
  ]);
  const calls: DeliveryCall[] = [];
  let next = 100;
  let scans = 0;
  const api: DeliveryApi = {
    async call(method, params = {}) {
      const result = method === "sendMessage" ? { message_id: ++next } : true;
      calls.push({ method, params, result });
      return result;
    },
  };
  const store: DeliveryStore = {
    async get(key) {
      return structuredClone(data.get(key));
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async entries() {
      scans++;
      return [...data];
    },
  };
  const surface = new TelegramConsole({
    api,
    store,
    bridge: {},
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
  });
  t.after(() => surface.close());
  const record = (key: string) => {
    const value = data.get(key);
    assert.ok(value, `Expected stored delivery ${key}`);
    return value;
  };
  return {
    surface,
    console: surface,
    api,
    data,
    calls,
    record,
    get scans() {
      return scans;
    },
  };
}

export function outputReceipts(record: StoredDelivery) {
  assert.ok(record.outputs);
  return record.outputs;
}

export function logMessageIds(record: StoredDelivery) {
  assert.ok(record.logMessageIds);
  return record.logMessageIds;
}

export function replyMarkup(call: DeliveryCall) {
  assert.ok(
    call.params.reply_markup && "inline_keyboard" in call.params.reply_markup,
  );
  return call.params.reply_markup;
}

export function sentMessageId(call: DeliveryCall) {
  assert.notEqual(call.result, true);
  assert.ok(typeof call.result === "object");
  return call.result.message_id;
}
