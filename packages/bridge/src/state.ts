// The bridge's room state: the pause switch, conversation epochs, engagement,
// turn locks, held follow-ups, started conversations and the thread-root cache.
// Every state file keeps a stable path, env var and JSON shape, so a new version
// reads what the previous one wrote.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deserializeEngagement,
  MAX_TRACKED_IDS,
  serializeEngagement,
  type RoomEngagement,
  type ThreadRoot,
} from "./threading.js";
import type { Log } from "./config.js";
import { ConversationEpochs } from "./conversation-epochs.js";
import type { HeldFollowUp } from "./followups.js";

export interface JsonStateFileOptions<T> {
  /** Raw JSON → state. A throw counts as an invalid file. */
  parse: (raw: unknown) => T;
  /** State → the JSON value written. Defaults to the state itself. */
  serialize?: (value: T) => unknown;
  log: Log;
  /** Names the file in "could not persist <label> to <path>". */
  label: string;
  /** Names the file in "<invalidLabel> <path> is not valid JSON"; unset, junk is ignored silently. */
  invalidLabel?: string;
}

export interface JsonStateFile<T> {
  readonly path: string;
  /** undefined when the file is missing or invalid — a first boot, not an error. */
  load(): T | undefined;
  /** Best-effort: a failed write logs and never throws. */
  persist(value: T): void;
}

/** One small JSON file of best-effort state, read on boot and rewritten on change. */
export function jsonStateFile<T>(path: string, opts: JsonStateFileOptions<T>): JsonStateFile<T> {
  const serialize = opts.serialize ?? ((v: T) => v);
  return {
    path,
    load() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      try {
        return opts.parse(JSON.parse(raw));
      } catch (err) {
        if (opts.invalidLabel) opts.log(`${opts.invalidLabel} ${path} is not valid JSON: ${(err as Error)?.message ?? err}`);
        return undefined;
      }
    },
    persist(value) {
      try {
        writeFileSync(path, JSON.stringify(serialize(value)), "utf8");
      } catch (err) {
        opts.log(`could not persist ${opts.label} to ${path}: ${(err as Error)?.message ?? err}`);
      }
    },
  };
}

/** Drop oldest-first until `keys` fits `max`, never evicting `keep` (the key just written). */
export function evictOldest(keys: Set<string> | Map<string, unknown>, max: number, keep: string): void {
  while (keys.size > max) {
    const oldest = keys.keys().next().value;
    if (oldest === undefined || oldest === keep) break;
    keys.delete(oldest);
  }
}

export interface PauseState {
  active: boolean;
  by?: string;
}

export interface BridgeStateOptions {
  pauseFile: string;
  conversationEpochFile: string;
  engagementFile: string;
  log: Log;
}

/** The three state files: each env var if set, else under ~/rocketchat-bridge/. */
export function stateFilesFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<BridgeStateOptions, "log"> {
  const home = path.join(os.homedir(), "rocketchat-bridge");
  return {
    pauseFile: env.RC_PAUSE_STATE_FILE ?? path.join(home, "paused.json"),
    conversationEpochFile: env.CONVERSATION_EPOCH_STATE_FILE ?? path.join(home, "conversation-epochs.json"),
    engagementFile: env.ENGAGEMENT_STATE_FILE ?? path.join(home, "engaged-threads.json"),
  };
}

/** How many conversations `startedConversations` remembers. */
const MAX_STARTED_CONVERSATIONS = 500;

/** Loads every persisted file on creation; `P` is the webhook payload a held follow-up carries. */
export function createBridgeState<P>(opts: BridgeStateOptions) {
  const { log } = opts;

  // Persisted, so a pause survives a restart. A kill switch that a deploy or a
  // crash silently undoes is worse than none: you'd believe it was off.
  const pauseFile = jsonStateFile<PauseState>(opts.pauseFile, {
    parse: (raw) => raw as PauseState,
    log,
    label: "pause state",
  });
  const paused: PauseState = { active: false };
  const loadedPause = pauseFile.load();
  if (loadedPause?.active) {
    paused.active = true;
    paused.by = typeof loadedPause.by === "string" ? loadedPause.by : undefined;
    log(`RESUMING PAUSED: bridge is paused (by ${paused.by ?? "unknown"}). Resume it from a control verb, or delete ${opts.pauseFile}.`);
  }

  // A room's agent conversation is bounded: keyed on a daily epoch,
  // bumped by `/new`. Persisted for the same reason as the pause — a reset that
  // a restart quietly undoes would hand the room its old context straight back.
  const conversationEpochs = new ConversationEpochs(opts.conversationEpochFile, log);

  // Engagement: held in memory only, it would die on every restart and a
  // thread the agent had been answering would go silent. Snapshotted on change and
  // reloaded on boot; a broken file costs engagement memory, never a turn.
  const engagementFile = jsonStateFile<Map<string, RoomEngagement>>(opts.engagementFile, {
    parse: deserializeEngagement,
    serialize: serializeEngagement,
    log,
    label: "engaged threads",
    invalidLabel: "engagement state file",
  });
  const rooms = engagementFile.load() ?? new Map<string, RoomEngagement>();
  if (rooms.size) log(`restored engaged threads for ${rooms.size} room(s) from ${engagementFile.path}`);

  function roomFor(id: string): RoomEngagement {
    let r = rooms.get(id);
    if (!r) {
      r = { engagedIds: new Set(), threadOwners: new Map() };
      rooms.set(id, r);
    }
    return r;
  }

  // Unpersisted: losing it costs one redundant thread-root read,
  // not silence, so it is not worth another file on disk.
  const startedConversations = new Set<string>();
  const threadRoots = new Map<string, ThreadRoot | null>();

  return {
    paused: paused as Readonly<PauseState>,
    pause(by: string | undefined): void {
      paused.active = true;
      paused.by = by;
      pauseFile.persist(paused);
    },
    resume(): void {
      paused.active = false;
      paused.by = undefined;
      pauseFile.persist(paused);
    },
    conversationEpochs,
    rooms,
    roomFor,
    persistEngagement: (): void => engagementFile.persist(rooms),
    /** Turn locks, one per CONVERSATION (not per room). */
    busyConversations: new Set<string>(),
    /** Messages held while their conversation was busy. */
    heldFollowUps: new Map<string, HeldFollowUp<P>>(),
    startedConversations,
    markConversationStarted(conversation: string): void {
      startedConversations.delete(conversation);
      startedConversations.add(conversation);
      evictOldest(startedConversations, MAX_STARTED_CONVERSATIONS, conversation);
    },
    /** A cached root; `null` = RC would not give it to us, `undefined` = never read. */
    cachedThreadRoot: (tmid: string): ThreadRoot | null | undefined => threadRoots.get(tmid),
    cacheThreadRoot(tmid: string, root: ThreadRoot | null): void {
      threadRoots.set(tmid, root);
      evictOldest(threadRoots, MAX_TRACKED_IDS * 4, tmid);
    },
  };
}
