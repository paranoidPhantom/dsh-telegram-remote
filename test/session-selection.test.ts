import test from "node:test";
import assert from "node:assert/strict";
import {
  type SessionSelectionDependencies,
  newSessionSelection,
} from "../src/bridge/session-selection.js";
test("source selection comes from live DSH not a bot preference", async () => {
  const value = await newSessionSelection(
    {
      metadata: async () => ({ selection: { provider: "p", model: "m" } }),
      controller: {
        modelCatalog: async () => {
          throw Error("unneeded");
        },
        list: () => {
          throw Error("unneeded");
        },
      },
    },
    "s",
  );
  assert.deepEqual(value, { provider: "p", model: "m" });
});
test("uses most recently active root session, not child", async () => {
  const value = await newSessionSelection({
    controller: {
      modelCatalog: async () => {
        throw Error("unneeded");
      },
      list: async () => ({
        items: [
          {
            sessionId: "child",
            running: false,
            cwd: "/work",
            updatedAt: 5,
            parentSessionId: "x",
            projections: {
              values: {
                modelSelection: { next: { provider: "child", model: "x" } },
              },
            },
          },
          {
            sessionId: "new",
            running: false,
            cwd: "/work",
            updatedAt: 3,
            projections: {
              values: {
                modelSelection: { next: { provider: "p", model: "new" } },
              },
            },
          },
          {
            sessionId: "old",
            running: false,
            cwd: "/work",
            updatedAt: 1,
            projections: {
              values: {
                modelSelection: { next: { provider: "p", model: "old" } },
              },
            },
          },
        ],
      }),
    },
  });
  assert.equal(value.model, "new");
});
test("fresh catalog default is fallback and missing default is explicit", async () => {
  const controller: SessionSelectionDependencies["controller"] = {
    list: async () => ({ items: [] }),
    modelCatalog: async () => ({
      groups: [],
      default: { provider: "p", model: "default" },
    }),
  };
  assert.equal((await newSessionSelection({ controller })).model, "default");
  controller.modelCatalog = async () => ({ groups: [] });
  await assert.rejects(newSessionSelection({ controller }), /no model/);
});
