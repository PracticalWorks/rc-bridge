// The seam between the core relay and whatever a deployment adds. Every hook is
// optional. Where more than one plugin answers: identityForRoom, targetForRoom
// and isDirectMessageFallback take the first non-undefined answer; framing,
// outbound and onAnswer chain in plugin order; every other hook fans out.
import type { AgentTarget } from "./agent.js";
import type { ResponseSummary, ToolCall } from "./response.js";
import type { PostVoice } from "@practicalworks/rc-client";
import type { ThreadRoot } from "./threading.js";

/** What Rocket.Chat's outgoing webhook POSTs for one message. */
export interface WebhookPayload {
  token?: string;
  channel_id?: string;
  channel_name?: string;
  user_id?: string;
  user_name?: string;
  text?: string;
  // Present ONLY on integration-authored messages, and NOT a boolean: Rocket.Chat
  // sends `{ i: "<integration id>" }`. Typed as it arrives so the guard reads it
  // for truth — declaring it `boolean` is what let `=== true` look correct.
  bot?: unknown;
  /** The message's own id: used to re-read uploads, and as the thread root of a top-level message. */
  message_id?: string;
  /** The thread root, set when the message IS a threaded reply. */
  tmid?: string;
}

/** A threaded reply, before the addressing gate: all interceptReply is shown. */
export interface ThreadedReply {
  payload: WebhookPayload;
  roomId: string;
  /** The message text, after upload recovery. */
  text: string;
  /** The thread's root, or undefined when Rocket.Chat would not give it to us. */
  root: ThreadRoot | undefined;
}

/** One engaged turn, as the hooks after the addressing gate see it. */
export interface Turn {
  payload: WebhookPayload;
  roomId: string;
  /** Where everything about this message is posted. */
  thread: string | undefined;
  isDM: boolean;
  conversation: string;
  /** The prompt as the agent receives it, before framing. */
  prompt: string;
}

/** A run that has parked on a human approval. */
export interface ParkedRun {
  runId: string;
  status: string;
  command?: string;
  choices?: readonly string[];
  createdAt?: string;
  lastEvent?: string;
}

/** Where a turn goes, and the profile name /health and the turn timings show. */
export interface RoutedTarget {
  target: AgentTarget;
  profile: string;
}

/** How a turn ended. `ignored` = the addressing gate declined it. */
export interface TurnRecord {
  status: "ok" | "error" | "ignored";
  roomId: string;
  roomName?: string;
  threadId?: string;
  requester?: string;
  conversation?: string;
  promptChars: number;
  images: number;
  documents: number;
  replyChars: number;
  durationMs: number;
  tools: ToolCall[];
  error?: string;
  /** ok only: when the turn began. */
  startedAt?: number;
  /** ok only: the response's id, model and token counts. */
  usage?: Pick<ResponseSummary, "id" | "model" | "usage">;
  /** ok only: the agent's reply text, reaction markers removed, before onAnswer ran. */
  answer?: string;
}

/** Where a control command is answered. */
export interface ControlContext {
  payload: WebhookPayload;
  roomId: string;
  thread: string | undefined;
}

export interface ControlVerbs {
  /** A runner when the WHOLE message is one of this plugin's commands. */
  match(text: string): ((ctx: ControlContext) => Promise<void>) | undefined;
  /** The usage reply for a message that claims to be a command but is not one. */
  nearMiss?(text: string): string | undefined;
}

export interface BridgePlugin {
  name: string;
  /** Auth headers to speak AS in this room; undefined = the bot's own. */
  identityForRoom?(roomId: string): Promise<Record<string, string> | undefined>;
  /** Asked when rooms.info refuses us: is this nonetheless a DM we answer? */
  isDirectMessageFallback?(roomId: string): Promise<boolean | undefined>;
  /** Is this message ours, in a voice the core does not know? */
  isOwnVoice?(payload: WebhookPayload): boolean;
  targetForRoom?(roomId: string): Promise<RoutedTarget | undefined>;
  /** A preamble placed after the context header. */
  framing?(turn: Turn): Promise<string | undefined>;
  /** Rewrites a reply before it is split: strips markers, picks a voice (alias and avatar). */
  outbound?(text: string): { text: string; voice?: PostVoice };
  /** True when the reply was consumed and must not become a turn. */
  interceptReply?(reply: ThreadedReply): Promise<boolean>;
  onRunParked?(turn: Turn, run: ParkedRun): Promise<void>;
  /** Rewrites the answer before its single post. */
  onAnswer?(turn: Turn, text: string): Promise<string>;
  /** Never awaited: a slow sink must not hold the turn. */
  onTurnSettled?(record: TurnRecord): void | Promise<void>;
  controlVerbs?: ControlVerbs;
  /** Fields merged into /health next to the core's. */
  health?(): Record<string, unknown>;
}
