import { TelegramConsole } from "../src/bot/console.js";
import type {
  ConsoleBridge,
  ConsoleStore,
  TelegramApiPort,
} from "../src/bot/contracts.js";

const unused = async (): Promise<never> => {
  throw new Error("Unexpected fixture capability call");
};
export function fixtureBridge(
  overrides: Partial<ConsoleBridge> = {},
): ConsoleBridge {
  // Preserve fixture identity: tests deliberately replace capabilities after construction.
  return Object.assign(overrides, {
    list: unused,
    metadata: unused,
    models: unused,
    selectModel: unused,
    create: unused,
    newSessionSelection: unused,
    prompt: unused,
    stop: unused,
    details: unused,
    files: unused,
    fileForTurn: unused,
    steerQueued: unused,
    ...overrides,
  });
}
export function fixtureApi(
  overrides: Partial<TelegramApiPort> = {},
): TelegramApiPort {
  return Object.assign(overrides, {
    call: unused,
    document: unused,
    ...overrides,
  });
}
export function fixtureStore(
  overrides: Partial<ConsoleStore> = {},
): ConsoleStore {
  return Object.assign(overrides, {
    get: unused,
    set: unused,
    entries: unused,
    ...overrides,
  });
}

export class FixtureConsole extends TelegramConsole {
  constructor(
    options: Omit<
      ConstructorParameters<typeof TelegramConsole>[0],
      "api" | "bridge" | "store"
    > & {
      api: Partial<TelegramApiPort>;
      bridge: Partial<ConsoleBridge>;
      store: Partial<ConsoleStore>;
    },
  ) {
    super({
      ...options,
      api: fixtureApi(options.api),
      bridge: fixtureBridge(options.bridge),
      store: fixtureStore(options.store),
    });
  }
}
