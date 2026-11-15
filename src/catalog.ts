import type { ModelListItem, ModelSelection, ModelVariant } from "@cursor/sdk";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export class CatalogRefreshError extends Error {
  override name = "CatalogRefreshError";
}

export interface CatalogEntry {
  defaultSelection: ModelSelection;
  byThinking: Partial<Record<ModelThinkingLevel, ModelSelection>>;
}

export interface Catalog {
  models: NonNullable<ProviderConfig["models"]>;
  entries: Map<string, CatalogEntry>;
  skipped: string[];
}

const blankThinkingLevels = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
} satisfies Record<ModelThinkingLevel, null>;
const levels = Object.keys(blankThinkingLevels) as ModelThinkingLevel[];
const effortIds = ["effort", "reasoning_effort", "reasoning"];

function blankThinkingMap(): Record<ModelThinkingLevel, string | null> {
  return { ...blankThinkingLevels };
}

function thinkingLevel(
  axis: string | undefined,
  value: string | undefined,
): ModelThinkingLevel | undefined {
  if (axis === "thinking") {
    return value === "true" ? "high" : value === "false" ? "off" : undefined;
  }
  if (value === "none") return "off";
  if (value === "extra-high") return "xhigh";
  return levels.find((level) => level === value);
}

function valueOf(
  variant: ModelVariant | undefined,
  id: string | undefined,
): string | undefined {
  return variant?.params.find((param) => param.id === id)?.value;
}

function commitItem(
  catalog: Catalog,
  item: ModelListItem,
  sdkIds: Set<string>,
): void {
  if (item.parameters?.length && !item.variants?.length) {
    throw new Error(`Parameterized model ${item.id} has no variants`);
  }
  const detectedEffortIds = effortIds.filter((id) =>
    item.variants?.some((variant) => valueOf(variant, id) !== undefined),
  );
  if (detectedEffortIds.length > 1) {
    throw new Error(`Ambiguous effort parameters for ${item.id}`);
  }
  const effortId = detectedEffortIds[0];
  const axis =
    effortId ??
    (item.variants?.some(
      (variant) => valueOf(variant, "thinking") !== undefined,
    )
      ? "thinking"
      : undefined);
  const groups = new Map<string, ModelVariant[]>();
  for (const variant of item.variants ?? []) {
    if (
      new Set(variant.params.map((param) => param.id)).size !==
      variant.params.length
    ) {
      throw new Error(`Duplicate parameter id for ${item.id}`);
    }
    if (axis) {
      const value = valueOf(variant, axis);
      if (thinkingLevel(axis, value) === undefined) {
        throw new Error(
          `Unsupported ${axis} parameter ${JSON.stringify(value)} for ${item.id}`,
        );
      }
    }
    const fixed = variant.params
      .filter((param) => param.id !== axis)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const key = JSON.stringify([
      variant.isMaxMode === true,
      fixed.map(({ id, value }) => [id, value]),
    ]);
    const group = groups.get(key) ?? [];
    group.push(variant);
    groups.set(key, group);
  }
  if (groups.size === 0) groups.set("opaque", []);
  const models: Catalog["models"] = [];
  const entries = new Map<string, CatalogEntry>();
  for (const variants of groups.values()) {
    const representative =
      variants.find((variant) => variant.isDefault) ?? variants[0];
    const selection = (variant: ModelVariant): ModelSelection => ({
      id: item.id,
      params: structuredClone(variant.params),
      maxMode: variant.isMaxMode === true,
    });
    const entry: CatalogEntry = {
      defaultSelection: representative
        ? selection(representative)
        : { id: item.id },
      byThinking: {},
    };
    const thinkingLevelMap = blankThinkingMap();
    for (const variant of variants) {
      const effort = valueOf(variant, axis);
      const level = thinkingLevel(axis, effort);
      if (level !== undefined) {
        if (
          thinkingLevelMap[level] !== null &&
          thinkingLevelMap[level] !== effort
        ) {
          throw new Error(`Ambiguous thinking route for ${item.id}: ${level}`);
        }
        entry.byThinking[level] = selection(variant);
        thinkingLevelMap[level] = effort!;
      }
    }
    const reasoning = Object.keys(entry.byThinking).length > 0;
    const context = valueOf(representative, "context");
    const match = context?.match(/^(\d+(?:\.\d+)?)(k|m)$/i);
    const fast = valueOf(representative, "fast") === "true";
    const thinking =
      valueOf(representative, "thinking") === "true" && Boolean(effortId);
    const extendedContext =
      context && !["200k", "272k", "300k"].includes(context.toLowerCase());
    let maxSuffix = "";
    if (representative?.isMaxMode && context?.toLowerCase() !== "1m") {
      maxSuffix =
        !effortId || /(^|-)max($|-)/i.test(item.id) ? "-max-mode" : "-max";
    }
    const id =
      item.id +
      (extendedContext ? `-${context.toLowerCase()}` : "") +
      maxSuffix +
      (thinking ? "-thinking" : "") +
      (fast ? "-fast" : "");
    if (
      catalog.entries.has(id) ||
      entries.has(id) ||
      (id !== item.id && sdkIds.has(id))
    ) {
      throw new Error(`Model ID collision: ${id} (SDK model ${item.id})`);
    }
    const name = [
      item.displayName,
      extendedContext ? context.toUpperCase() : "",
      maxSuffix === "-max-mode" ? "Max Mode" : maxSuffix ? "Max" : "",
      thinking ? "Thinking" : "",
      fast ? "Fast" : "",
    ]
      .filter(Boolean)
      .join(" ");
    models.push({
      id,
      name,
      reasoning,
      ...(reasoning ? { thinkingLevelMap } : {}),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: match
        ? Number(match[1]) * (match[2]!.toLowerCase() === "k" ? 1000 : 1000000)
        : 64000,
      maxTokens: 8192,
    });
    entries.set(id, entry);
  }
  catalog.models.push(...models);
  for (const [id, entry] of entries) catalog.entries.set(id, entry);
}

export function buildCatalog(items: ModelListItem[]): Catalog {
  const catalog: Catalog = { models: [], entries: new Map(), skipped: [] };
  const sdkIds = new Set(items.map((item) => item.id));
  // The listing does not say which copy of a repeated id is current. Keep one
  // copy only when every copy matches. Otherwise omit that id entirely.
  const accepted = new Map<string, ModelListItem>();
  const rejected = new Set<string>();
  for (const item of items) {
    if (rejected.has(item.id)) continue;
    const previous = accepted.get(item.id);
    if (!previous) {
      accepted.set(item.id, item);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(item)) {
      accepted.delete(item.id);
      rejected.add(item.id);
      catalog.skipped.push(
        `Duplicate SDK model id with different data: ${item.id}`,
      );
    }
  }
  for (const item of accepted.values()) {
    try {
      commitItem(catalog, item, sdkIds);
    } catch (error) {
      catalog.skipped.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return catalog;
}

export function ensureAuto(catalog: Catalog): Catalog {
  if (catalog.entries.has("auto")) return catalog;
  const fallback = buildCatalog([
    { id: "auto", displayName: "Cursor Auto (SDK fallback)" },
  ]);
  const autoModel = fallback.models[0];
  const autoEntry = fallback.entries.get("auto");
  if (autoModel && autoEntry) {
    catalog.models.push(autoModel);
    catalog.entries.set("auto", autoEntry);
  }
  return catalog;
}

export function serializeSelections(
  catalog: Catalog,
): Record<string, CatalogEntry> {
  return Object.fromEntries(catalog.entries);
}

function isSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as ModelSelection;
  if (typeof selection.id !== "string" || !selection.id) return false;
  if (
    selection.maxMode !== undefined &&
    typeof selection.maxMode !== "boolean"
  ) {
    return false;
  }
  if (selection.params === undefined) return true;
  return (
    Array.isArray(selection.params) &&
    selection.params.every(
      (param) =>
        !!param &&
        typeof param === "object" &&
        typeof param.id === "string" &&
        typeof param.value === "string",
    )
  );
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as CatalogEntry;
  if (!isSelection(entry.defaultSelection)) return false;
  if (!entry.byThinking || typeof entry.byThinking !== "object") return false;
  return Object.values(entry.byThinking).every((selection) =>
    isSelection(selection),
  );
}

function isPiModel(
  value: unknown,
): value is Extract<Catalog["models"][number], { reasoning: boolean }> {
  if (!value || typeof value !== "object") return false;
  const model = value as {
    id?: unknown;
    name?: unknown;
    type?: unknown;
    reasoning?: unknown;
    input?: unknown;
    contextWindow?: unknown;
    maxTokens?: unknown;
    cost?: unknown;
  };
  if (model.type !== undefined && model.type !== "chat") return false;
  return (
    typeof model.id === "string" &&
    typeof model.name === "string" &&
    typeof model.reasoning === "boolean" &&
    Array.isArray(model.input) &&
    typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number" &&
    !!model.cost &&
    typeof model.cost === "object"
  );
}

export function catalogFromStored(stored: unknown): Catalog | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const record = stored as {
    models?: unknown;
    cursorSdkSelections?: unknown;
  };
  if (
    !Array.isArray(record.models) ||
    !record.cursorSdkSelections ||
    typeof record.cursorSdkSelections !== "object"
  ) {
    return undefined;
  }
  const selections = record.cursorSdkSelections as Record<string, unknown>;
  const catalog: Catalog = { models: [], entries: new Map(), skipped: [] };
  for (const model of record.models) {
    if (!isPiModel(model)) continue;
    const entry = selections[model.id];
    if (!isCatalogEntry(entry)) continue;
    catalog.models.push(model);
    catalog.entries.set(model.id, entry);
  }
  if (!catalog.models.length) return undefined;
  return ensureAuto(catalog);
}

export function resolveSelection(
  catalog: Catalog,
  modelId: string,
  thinking?: ModelThinkingLevel,
): ModelSelection {
  const entry = catalog.entries.get(modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);
  if (Object.keys(entry.byThinking).length > 0) {
    // Pi omits reasoning when Thinking is off. Use that route when the model
    // advertises one. Otherwise keep the SDK's default variant.
    if (thinking === undefined || thinking === "off") {
      const off = entry.byThinking.off;
      if (off) return structuredClone(off);
      return structuredClone(entry.defaultSelection);
    }
    const selection = entry.byThinking[thinking];
    if (!selection) throw new Error(`Unsupported thinking level: ${thinking}`);
    return structuredClone(selection);
  }
  if (thinking !== undefined && thinking !== "off") {
    throw new Error(`Unsupported thinking level: ${thinking}`);
  }
  return structuredClone(entry.defaultSelection);
}
