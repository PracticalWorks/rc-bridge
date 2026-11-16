// Several plugins, composed into the one set of hooks the core calls. The rules
// are the ones plugin.ts states: first answer wins for identity, target and
// the DM fallback; framing, outbound and onAnswer chain; the rest fan out.
import type { PostVoice } from "@practicalworks/rc-client";
import type { Log } from "./config.js";
import type {
  BridgePlugin,
  ControlContext,
  ParkedRun,
  RoutedTarget,
  ThreadedReply,
  Turn,
  TurnRecord,
  WebhookPayload,
} from "./plugin.js";

export type Hooks = ReturnType<typeof composeHooks>;

export function composeHooks(plugins: readonly BridgePlugin[], log: Log) {
  /** The first plugin whose hook answers something other than undefined. */
  async function first<T>(ask: (p: BridgePlugin) => Promise<T | undefined> | undefined): Promise<T | undefined> {
    for (const p of plugins) {
      const answer = await ask(p);
      if (answer !== undefined) return answer;
    }
    return undefined;
  }

  return {
    identityForRoom: (roomId: string) => first((p) => p.identityForRoom?.(roomId)),
    isDirectMessageFallback: async (roomId: string) =>
      (await first((p) => p.isDirectMessageFallback?.(roomId))) ?? false,
    isOwnVoice: (payload: WebhookPayload) => plugins.some((p) => p.isOwnVoice?.(payload) === true),
    targetForRoom: (roomId: string): Promise<RoutedTarget | undefined> => first((p) => p.targetForRoom?.(roomId)),
    /** Every plugin's preamble, in plugin order. */
    async framing(turn: Turn): Promise<string[]> {
      const parts: string[] = [];
      for (const p of plugins) {
        const part = await p.framing?.(turn);
        if (part) parts.push(part);
      }
      return parts;
    },
    outbound(text: string): { text: string; voice?: PostVoice } {
      let out: { text: string; voice?: PostVoice } = { text };
      for (const p of plugins) {
        if (!p.outbound) continue;
        const next = p.outbound(out.text);
        out = { text: next.text, voice: next.voice ?? out.voice };
      }
      return out;
    },
    /** Whether any plugin looks at threaded replies; if none, the root is not read. */
    interceptsReplies: plugins.some((p) => p.interceptReply),
    async interceptReply(reply: ThreadedReply): Promise<boolean> {
      for (const p of plugins) if (await p.interceptReply?.(reply)) return true;
      return false;
    },
    async onRunParked(turn: Turn, run: ParkedRun): Promise<void> {
      for (const p of plugins) await p.onRunParked?.(turn, run);
    },
    async onAnswer(turn: Turn, text: string): Promise<string> {
      let out = text;
      for (const p of plugins) if (p.onAnswer) out = await p.onAnswer(turn, out);
      return out;
    },
    /** Called in plugin order and never awaited; a throw is logged, never raised. */
    onTurnSettled(record: TurnRecord): void {
      for (const p of plugins) {
        try {
          const pending = p.onTurnSettled?.(record);
          if (pending) void pending.catch((err) => log(`${p.name} onTurnSettled failed: ${(err as Error)?.message ?? err}`));
        } catch (err) {
          log(`${p.name} onTurnSettled threw: ${(err as Error)?.message ?? err}`);
        }
      }
    },
    controlCommand(text: string): ((ctx: ControlContext) => Promise<void>) | undefined {
      for (const p of plugins) {
        const run = p.controlVerbs?.match(text);
        if (run) return run;
      }
      return undefined;
    },
    controlNearMiss(text: string): string | undefined {
      for (const p of plugins) {
        const usage = p.controlVerbs?.nearMiss?.(text);
        if (usage) return usage;
      }
      return undefined;
    },
    health(): Record<string, unknown> {
      return Object.assign({}, ...plugins.map((p) => p.health?.() ?? {}));
    },
  };
}
