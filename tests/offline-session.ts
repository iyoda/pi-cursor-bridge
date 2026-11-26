import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createCursorSdkProvider,
  type ProviderDependencies,
} from "../src/provider.js";

type CreateSessionInput = NonNullable<Parameters<typeof createAgentSession>[0]>;
type StartedSession = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  manager: ReturnType<typeof SessionManager.inMemory>;
};

export async function withOfflinePiSession(
  prefix: string,
  deps: ProviderDependencies,
  run: (context: {
    directory: string;
    runtime: ModelRuntime;
    start: (
      options: Pick<CreateSessionInput, "model" | "thinkingLevel"> & {
        compaction?: NonNullable<
          Parameters<typeof SettingsManager.inMemory>[0]
        >["compaction"];
        retry?: NonNullable<
          Parameters<typeof SettingsManager.inMemory>[0]
        >["retry"];
        extensionFactories?: NonNullable<
          ConstructorParameters<typeof DefaultResourceLoader>[0]
        >["extensionFactories"];
      },
    ) => Promise<StartedSession>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let dispose: (() => void) | undefined;
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("cursor-sdk", async () => ({
      type: "api_key",
      key: "offline-test-key",
    }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(createCursorSdkProvider(deps));
    await run({
      directory,
      runtime,
      async start(options) {
        if (dispose) throw new Error("Offline Pi session already started.");
        const settings = SettingsManager.inMemory({
          compaction: options.compaction ?? { enabled: false },
          retry: options.retry ?? { enabled: false },
        });
        const loader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          noExtensions: true,
          extensionFactories: options.extensionFactories,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "Answer briefly.",
        });
        await loader.reload();
        const manager = SessionManager.inMemory(directory);
        const { session } = await createAgentSession({
          cwd: directory,
          agentDir: directory,
          modelRuntime: runtime,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          noTools: "all",
          settingsManager: settings,
          resourceLoader: loader,
          sessionManager: manager,
        });
        dispose = () => session.dispose();
        return { session, manager };
      },
    });
  } finally {
    dispose?.();
    await rm(directory, { recursive: true, force: true });
  }
}
