import { describe, expect, it } from "vitest";
import type { ModelListItem, ModelVariant } from "@cursor/sdk";
import { buildCatalog, resolveSelection } from "../src/catalog.js";

function variant(
  params: Record<string, string>,
  options: Partial<ModelVariant> = {},
): ModelVariant {
  return {
    displayName: "SDK variant",
    params: Object.entries(params).map(([id, value]) => ({ id, value })),
    ...options,
  };
}

function model(fields: Partial<ModelListItem> = {}): ModelListItem {
  return { id: "model", displayName: "Model", ...fields };
}

describe("SDK catalog", () => {
  it("groups fixed parameter sets independently of SDK parameter order", () => {
    const catalog = buildCatalog([
      model({
        variants: [
          variant({ "a,b": "c", a: "b,c", effort: "low" }),
          variant({ a: "b,c", "a,b": "c", effort: "high" }),
        ],
      }),
    ]);
    expect(catalog.models).toHaveLength(1);
    expect(resolveSelection(catalog, "model", "high").params).toEqual([
      { id: "a", value: "b,c" },
      { id: "a,b", value: "c" },
      { id: "effort", value: "high" },
    ]);
  });

  it("labels fixed selections without advertising inferred limits for named contexts", () => {
    const catalog = buildCatalog([
      model({
        variants: [
          variant(
            {
              context: "Custom",
              effort: "high",
              thinking: "true",
              fast: "true",
              region: "sdk-specific",
            },
            { isMaxMode: true },
          ),
        ],
      }),
    ]);
    expect(catalog.models[0]).toMatchObject({
      id: "model-custom-max-thinking-fast",
      name: "Model CUSTOM Max Thinking Fast",
      contextWindow: 64000,
    });
    expect(
      resolveSelection(catalog, "model-custom-max-thinking-fast", "high")
        .params,
    ).toContainEqual({ id: "region", value: "sdk-specific" });
  });

  it.each<{ id: string; params: Record<string, string>; expected: string }>([
    { id: "plain", params: { context: "200k" }, expected: "plain-max-mode" },
    {
      id: "gpt-codex-max",
      params: { effort: "high", context: "300k" },
      expected: "gpt-codex-max-max-mode",
    },
    {
      id: "claude",
      params: { thinking: "true", context: "200k" },
      expected: "claude-max-mode",
    },
  ])(
    "uses an unambiguous Max Mode suffix for $id",
    ({ id, params, expected }) => {
      const catalog = buildCatalog([
        {
          id,
          displayName: id,
          variants: [variant(params, { isMaxMode: true })],
        },
      ]);
      expect(catalog.models[0]!.id).toBe(expected);
    },
  );

  it.each([
    ["none", "off"],
    ["extra-high", "xhigh"],
  ])(
    "rejects ambiguous routes %s/%s for the same Pi level",
    (first, second) => {
      expect(() =>
        buildCatalog([
          model({
            variants: [
              variant({ effort: first! }),
              variant({ effort: second! }),
            ],
          }),
        ]),
      ).toThrow(/ambiguous.*route/i);
    },
  );

  it.each<{ label: string; items: ModelListItem[] }>([
    {
      label: "unknown fixed values",
      items: [
        model({
          variants: [
            variant({ effort: "low", region: "one" }),
            variant({ effort: "high", region: "two" }),
          ],
        }),
      ],
    },
    {
      label: "omitted default contexts",
      items: [
        model({
          variants: [
            variant({ context: "200k" }),
            variant({ context: "300k" }),
          ],
        }),
      ],
    },
    {
      label: "Max Mode hidden by 1m",
      items: [
        model({
          variants: [
            variant({ context: "1m" }),
            variant({ context: "1m" }, { isMaxMode: true }),
          ],
        }),
      ],
    },
    {
      label: "synthetic shadows later SDK id",
      items: [
        model({ variants: [variant({ fast: "true" })] }),
        { id: "model-fast", displayName: "Actual" },
      ],
    },
    {
      label: "synthetic shadows earlier SDK id",
      items: [
        { id: "model-fast", displayName: "Actual" },
        model({ variants: [variant({ fast: "true" })] }),
      ],
    },
    {
      label: "different duplicate SDK ids",
      items: [model({ displayName: "One" }), model({ displayName: "Two" })],
    },
  ])("rejects model ID collisions: $label", ({ items }) => {
    expect(() => buildCatalog(items)).toThrow(/collision|duplicate/i);
  });

  it.each<{ label: string; item: ModelListItem }>([
    {
      label: "definitions without variants",
      item: model({
        parameters: [{ id: "effort", values: [{ value: "high" }] }],
      }),
    },
    {
      label: "empty variants with definitions",
      item: model({
        variants: [],
        parameters: [{ id: "context", values: [{ value: "1m" }] }],
      }),
    },
    {
      label: "unknown effort",
      item: model({ variants: [variant({ effort: "ultra" })] }),
    },
    {
      label: "invalid thinking boolean",
      item: model({ variants: [variant({ thinking: "auto" })] }),
    },
    {
      label: "missing effort in one variant",
      item: model({
        variants: [variant({ effort: "high" }), variant({})],
      }),
    },
    {
      label: "multiple effort axes",
      item: model({
        variants: [variant({ effort: "high", reasoning: "high" })],
      }),
    },
    {
      label: "duplicate parameter id",
      item: model({
        variants: [
          variant(
            {},
            {
              params: [
                { id: "context", value: "1m" },
                { id: "context", value: "200k" },
              ],
            },
          ),
        ],
      }),
    },
  ])("rejects unsafe parameterization: $label", ({ item }) => {
    expect(() => buildCatalog([item])).toThrow(
      /variants|effort|thinking|parameter/i,
    );
  });

  it("collapses thinking-only booleans to off/high while preserving other fixed params", () => {
    const off = variant({ context: "200k", thinking: "false", fast: "false" });
    const high = variant(
      { context: "200k", thinking: "true", fast: "false" },
      { isDefault: true },
    );
    const catalog = buildCatalog([
      { id: "claude", displayName: "Claude", variants: [off, high] },
    ]);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      id: "claude",
      reasoning: true,
      thinkingLevelMap: {
        off: "false",
        minimal: null,
        low: null,
        medium: null,
        high: "true",
        xhigh: null,
        max: null,
      },
    });
    expect(resolveSelection(catalog, "claude")).toEqual({
      id: "claude",
      params: off.params,
      maxMode: false,
    });
    expect(resolveSelection(catalog, "claude", "high")).toEqual({
      id: "claude",
      params: high.params,
      maxMode: false,
    });
    expect(() => resolveSelection(catalog, "claude", "medium")).toThrow(
      /unsupported/i,
    );
  });

  it.each(["effort", "reasoning_effort", "reasoning"])(
    "maps exact %s values without approximating unsupported levels",
    (axis) => {
      const values = [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "extra-high",
        "max",
      ];
      const levels = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const;
      const catalog = buildCatalog([
        model({
          variants: values.map((value) => variant({ [axis]: value })),
        }),
      ]);
      expect(catalog.models).toHaveLength(1);
      expect(catalog.models[0]).toMatchObject({
        reasoning: true,
        thinkingLevelMap: Object.fromEntries(
          levels.map((level, index) => [level, values[index]]),
        ),
      });
      for (const [index, level] of levels.entries()) {
        expect(resolveSelection(catalog, "model", level).params).toEqual([
          { id: axis, value: values[index] },
        ]);
      }
      expect(resolveSelection(catalog, "model").params).toEqual([
        { id: axis, value: "none" },
      ]);
    },
  );

  it("keeps fixed axes and Max Mode in separate rows without synthesizing combinations", () => {
    const variants = [
      variant({
        context: "272k",
        reasoning: "low",
        fast: "false",
        thinking: "false",
      }),
      variant({
        context: "272k",
        reasoning: "high",
        fast: "true",
        thinking: "false",
      }),
      variant(
        {
          context: "272k",
          reasoning: "high",
          fast: "false",
          thinking: "false",
        },
        { isMaxMode: true },
      ),
      variant(
        { context: "1m", reasoning: "high", fast: "false", thinking: "false" },
        { isMaxMode: true },
      ),
      variant(
        { context: "272k", reasoning: "low", fast: "true", thinking: "true" },
        { isMaxMode: true },
      ),
    ];
    const catalog = buildCatalog([
      { id: "gpt-5.5", displayName: "GPT-5.5", variants },
    ]);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.5-max",
      "gpt-5.5-1m",
      "gpt-5.5-max-thinking-fast",
    ]);
    for (const [index, model] of catalog.models.entries()) {
      const level = index === 0 || index === 4 ? "low" : "high";
      expect(resolveSelection(catalog, model.id, level)).toEqual({
        id: "gpt-5.5",
        params: variants[index]!.params,
        maxMode: variants[index]!.isMaxMode === true,
      });
      expect(() =>
        resolveSelection(catalog, model.id, level === "low" ? "high" : "low"),
      ).toThrow(/unsupported/i);
    }
    expect(catalog.models[3]).toMatchObject({ contextWindow: 1000000 });
    expect(() => resolveSelection(catalog, "gpt-5.5-1m-fast", "high")).toThrow(
      /unknown/i,
    );
  });

  it("collapses only listed effort variants and resolves exact SDK selections", () => {
    const low = variant({ context: "272k", reasoning: "low", fast: "false" });
    const high = variant(
      { context: "272k", reasoning: "high", fast: "false" },
      { isDefault: true },
    );
    const catalog = buildCatalog([
      { id: "gpt-5.5", displayName: "GPT-5.5", variants: [low, high] },
    ]);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      id: "gpt-5.5",
      reasoning: true,
      contextWindow: 272000,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
    });
    expect(catalog.entries.get("gpt-5.5")?.defaultSelection).toEqual({
      id: "gpt-5.5",
      params: high.params,
      maxMode: false,
    });
    expect(resolveSelection(catalog, "gpt-5.5", "low")).toEqual({
      id: "gpt-5.5",
      params: low.params,
      maxMode: false,
    });
    expect(() => resolveSelection(catalog, "gpt-5.5")).toThrow(/unsupported/i);
    expect(() => resolveSelection(catalog, "gpt-5.5", "medium")).toThrow(
      /unsupported/i,
    );
    const selection = resolveSelection(catalog, "gpt-5.5", "low");
    selection.params![0]!.value = "mutated";
    low.params[0]!.value = "also mutated";
    expect(resolveSelection(catalog, "gpt-5.5", "low").params![0]!.value).toBe(
      "272k",
    );
  });

  it("exposes metadata-only items as opaque nonreasoning models", () => {
    const catalog = buildCatalog([{ id: "auto", displayName: "Cursor Auto" }]);
    expect(catalog.models).toEqual([
      {
        id: "auto",
        name: "Cursor Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 8192,
      },
    ]);
    expect(resolveSelection(catalog, "auto")).toEqual({ id: "auto" });
    expect(resolveSelection(catalog, "auto", "off")).toEqual({ id: "auto" });
    expect(() => resolveSelection(catalog, "auto", "high")).toThrow(
      /unsupported/i,
    );
    expect(() => resolveSelection(catalog, "missing")).toThrow(/unknown/i);
  });
});
