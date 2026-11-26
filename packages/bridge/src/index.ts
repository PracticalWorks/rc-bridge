// The public surface: the plugin seam, and the pieces main.ts composes, so a
// deployment with plugins can compose them the same way.
export type {
  BridgePlugin,
  ControlContext,
  ControlVerbs,
  ParkedRun,
  RoutedTarget,
  ThreadedReply,
  Turn,
  TurnRecord,
  WebhookPayload,
} from "./plugin.js";
export { composeHooks, type Hooks } from "./hooks.js";

export { createLog, envList, loadCoreConfig, type CoreConfig, type Log } from "./config.js";
export {
  AgentHttpError,
  AgentRunFailedError,
  createAgentClient,
  isTurnTimeout,
  type AgentClientOptions,
  type AgentTarget,
  type AgentTimings,
  type AgentTurn,
  type ParkVerdict,
  type RunRead,
} from "./agent.js";
export { createAgentOutages, describeAgentFailure, outageReply, DEFAULT_PROFILE } from "./outage.js";
export { createAttachmentDeps, type AttachmentDepsOptions } from "./attachment-deps.js";
export {
  MAX_RESIZE_INPUT_BYTES,
  type AttachmentDeps,
  type AttachmentLimits,
  type ImageResizer,
} from "./attachments.js";
export { createBotDenylist, type BotDenylistOptions } from "./denylist.js";
export { coreHealthResponse, createHttpHandler, type HttpHandlerDeps } from "./http.js";
export {
  createBridgeState,
  jsonStateFile,
  stateFilesFromEnv,
  type BridgeStateOptions,
  type JsonStateFile,
  type JsonStateFileOptions,
  type PauseState,
} from "./state.js";
export { createTurnHandler, type TurnHandlerDeps } from "./turn.js";
export { createTurnTimings, type TurnTiming, type TurnTimings } from "./turn-timings.js";
export type { BotIdentity, ThreadRoot } from "./threading.js";
export {
  describeTools,
  errorText,
  summarizeResponse,
  usageFrom,
  type ResponseSummary,
  type TokenUsage,
  type ToolCall,
} from "./response.js";
