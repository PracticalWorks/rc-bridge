// One webhook message, from the loop guards to the single final post. Whatever a
// deployment adds (voices, routing, approvals, dispatch, traces, control verbs)
// arrives through the hooks in plugin.ts; nothing here knows what they are.
//
// The guard ORDER at the top is load-bearing: bot guards before control, so no
// bot drives the switch; control before the pause, so a resume verb works while
// paused; upload recovery before the addressing gate,
// so a paste that carries its @mention inside the file is heard.
import {
  documentBlock,
  fetchMessageAttachments,
  fetchThreadRoot,
  getMessage,
  pastedMessageText,
  skipNotice,
  threadRootBlock,
  BARE_MENTION_PROMPT,
  DOCUMENT_WITHOUT_CONTEXT_PROMPT,
  IMAGE_WITHOUT_CONTEXT_PROMPT,
  type FetchedMessage,
  type InlineImage,
} from "./attachments.js";
import { fetchRecentImages, lookbackNote } from "./lookback.js";
import { REACTION_HINT, extractReactions, receiptTransition, type ReceiptState } from "./reactions.js";
import { describeTools } from "./response.js";
import { captureRunEvents, type RunEventCapture } from "./run-events.js";
import {
  contextHeader,
  conversationKey,
  nudgeAllowed,
  remember,
  rememberOwner,
  mentionsUs,
  rootAddressesUs,
  rootInvites,
  rootIsOurs,
  stripOurMentions,
  shouldEngage,
  shouldHydrateRoot,
  threadFor,
  worthNudging,
  type BotIdentity,
  type ThreadRoot,
} from "./threading.js";
import type { CoreConfig, Log } from "./config.js";
import { isResetCommand, RESET_ACK } from "./conversation-epochs.js";
import { FOLLOWUP_TTL_MS, holdFollowUp, takeFollowUp } from "./followups.js";
import { isTurnTimeout, type createAgentClient, type AgentTarget, type ParkVerdict } from "./agent.js";
import { createAgentOutages, DEFAULT_PROFILE, outageReply } from "./outage.js";
import type { Hooks } from "./hooks.js";
import type { Turn, WebhookPayload } from "./plugin.js";
import type { RocketChatClient } from "@practicalworks/rc-client";
import type { AttachmentDeps } from "./attachments.js";
import type { createBridgeState } from "./state.js";
import type { TurnTimings } from "./turn-timings.js";

export interface TurnHandlerDeps {
  config: Readonly<CoreConfig>;
  log: Log;
  /** Replies, reactions and room type. Reads of uploads go through `attachmentDepsFor`. */
  rc: Pick<RocketChatClient, "postReply" | "applyReactions" | "isDirectMessage" | "cachedRoomType">;
  /** Attachment reads for one room, as that room's identity (see attachment-deps.ts). */
  attachmentDepsFor(roomId: string): Promise<AttachmentDeps>;
  agent: ReturnType<typeof createAgentClient>;
  state: ReturnType<typeof createBridgeState<WebhookPayload>>;
  turnTimings: TurnTimings;
  hooks: Hooks;
  /** Who we are: every name that counts as addressing us. */
  bot: BotIdentity;
  /** Other bots, by id and lowercased username. Read live: a boot refresh may add to them. */
  denylist: { ids: ReadonlySet<string>; usernames: ReadonlySet<string> };
  /** Where a turn goes when no plugin routes it. */
  defaultTarget: AgentTarget;
  /** Held follow-ups run through the same tracker as webhook turns, so shutdown waits for them. */
  track(work: Promise<void>): void;
  isDraining(): boolean;
}

export function createTurnHandler(deps: TurnHandlerDeps) {
  const { config, log, rc, agent, state, turnTimings, hooks, bot, denylist, attachmentDepsFor } = deps;
  // Bound: these are methods of a class instance, and destructured bare they lose `this`.
  const postReply = rc.postReply.bind(rc);
  const react = rc.applyReactions.bind(rc);
  const isDirectMessage = rc.isDirectMessage.bind(rc);
  const cachedRoomType = rc.cachedRoomType.bind(rc);
  const { paused, conversationEpochs, roomFor, persistEngagement } = state;
  const { busyConversations, heldFollowUps, startedConversations, markConversationStarted } = state;

  // Nudge and busy-reply throttles: once per thread, not once per message.
  const lastNudges = new Map<string, number>();
  const lastBusyReplies = new Map<string, number>();
  // Who has heard "it broke": once per room per outage, kept per profile, so one
  // profile recovering never re-arms another's warning (see outage.ts).
  const outages = createAgentOutages();

  /** The root of `tmid`, read at most once per thread. Never throws: an
   * unreadable root is cached as `null` and answers every question with "no". */
  async function readThreadRoot(roomId: string, tmid: string): Promise<ThreadRoot | undefined> {
    let root = state.cachedThreadRoot(tmid);
    if (root === undefined) {
      const fetched = await getMessage(await attachmentDepsFor(roomId), tmid);
      root = fetched ? { u: fetched.u, mentions: fetched.mentions, msg: fetched.msg } : null;
      state.cacheThreadRoot(tmid, root);
    }
    return root ?? undefined;
  }

  /** Post as participation: record the posted id and its thread as engaged
   * (persisted), which only gates the "Not picking this up" nudge. Refusals and
   * control output go through `postReply` directly. Never throws. */
  async function reply(roomId: string, text: string, tmid?: string): Promise<string | undefined> {
    const id = await postReply(roomId, text, tmid);
    const room = roomFor(roomId);
    remember(room.engagedIds, id);
    remember(room.engagedIds, tmid);
    persistEngagement();
    return id;
  }

  /** Everything after the fast 200: run the agent turn and relay its reply. */
  async function handleMessage(payload: WebhookPayload): Promise<void> {
    // Loop guards: never react to ourselves. `bot` is checked for TRUTH, not
    // `=== true`: Rocket.Chat sends `{ i: "<integration id>" }`.
    if (payload.bot) return;
    if (payload.user_id && payload.user_id === config.rc.userId) return;
    if (payload.user_name && payload.user_name.toLowerCase() === config.rc.botUsername) return;
    // …and never react to a voice a plugin says is ours (a second account speaking for us must not answer itself).
    if (hooks.isOwnVoice(payload)) return;
    // …and never to other bots: `payload.bot` is unreliable, so match the denylist.
    if (payload.user_id && denylist.ids.has(payload.user_id)) {
      log(`ignoring message from denylisted bot id ${payload.user_id}`);
      return;
    }
    if (payload.user_name && denylist.usernames.has(payload.user_name.toLowerCase())) {
      log(`ignoring message from denylisted bot ${payload.user_name}`);
      return;
    }

    const roomId = payload.channel_id;
    if (!roomId) return;

    if (config.allowedRoomIds.length > 0 && !config.allowedRoomIds.includes(roomId)) {
      log(`ignoring message from unlisted room ${roomId}`);
      return;
    }

    // Control commands: after the bot guards, before the pause and any agent
    // call, so the switch works when the agent is wedged.
    const command = hooks.controlCommand(payload.text ?? "");
    if (command) {
      await command({ payload, roomId, thread: threadFor(payload) });
      return;
    }
    // A near-miss stops here with usage, never an agent turn. Uncapped:
    // a post cap that already fired must not hide the right spelling.
    const usage = hooks.controlNearMiss(payload.text ?? "");
    if (usage) {
      log(`near-miss control command from ${payload.user_name}: ${JSON.stringify(payload.text)}`);
      await postReply(roomId, usage, threadFor(payload), { uncapped: true });
      return;
    }

    // Paused: nothing is picked up, silently — "I'm paused" would be its own flood.
    if (paused.active) {
      log(`paused (by ${paused.by ?? "unknown"}) — ignoring message in ${roomId}`);
      return;
    }

    // An upload arrives with empty `text`; re-read it for the caption. A message
    // RC converted to a text file IS the message, and becomes
    // `rawText` HERE, before the addressing gate: its @mention is inside the file.
    let fetched: FetchedMessage | undefined;
    let rawText = payload.text?.trim() ?? "";
    if (!rawText) {
      if (!payload.message_id) return;
      fetched = await fetchMessageAttachments(await attachmentDepsFor(roomId), payload.message_id);
      if (!fetched) return;
      rawText = pastedMessageText(fetched) || fetched.text;
      if (!rawText && !fetched.images.length && !fetched.documents.length && !fetched.skipped.length) return;
    }

    const room = roomFor(roomId);
    // Threaded replies only, so ordinary prompts pay no extra RC read, and a
    // consumed reply (an approval) never becomes an agent turn.
    if (payload.tmid && hooks.interceptsReplies) {
      const root = await readThreadRoot(roomId, payload.tmid);
      if (await hooks.interceptReply({ payload, roomId, text: rawText, root })) return;
    }

    // Everything said about this message goes in ONE thread: the one the human
    // is in, or a new one rooted on their message.
    const thread = threadFor(payload);
    const isDM = await isDirectMessage(roomId);
    // ANY of our faces counts as a mention.
    const mentionedUs = mentionsUs(rawText, bot);

    // Engage only when addressed (see `shouldEngage`): an @mention, a DM, the
    // thread's owner, someone our root named, or anyone under a root
    // that tagged us. The root is read ONLY when the cheap local
    // checks fail. RESPOND_TO_ALL=1 bypasses the gate.
    if (!config.respondToAll) {
      const addressing = {
        mentioned: mentionedUs,
        isDM,
        tmid: payload.tmid,
        sender: payload.user_name,
        threadOwners: room.threadOwners,
      };
      let engage = shouldEngage(addressing);
      if (!engage && payload.tmid) {
        const root = await readThreadRoot(roomId, payload.tmid);
        const invited = rootInvites(root, bot, payload.user_name);
        const ourRoot = rootIsOurs(root, bot);
        const addressesUs = rootAddressesUs(root, bot);
        engage = shouldEngage({ ...addressing, invited, ourRoot, rootAddressesUs: addressesUs });
        if (engage) {
          log(
            invited
              ? `engaging: ${payload.user_name} was named in thread root ${payload.tmid}`
              : addressesUs
                ? `engaging: ${payload.user_name} replied in thread ${payload.tmid}, whose root @mentions us`
                : `engaging: ${payload.user_name} answered our unclaimed thread ${payload.tmid}`,
          );
        }
      }
      if (!engage) {
        log(
          `ignoring ${roomId}: not @mentioned, not a DM with us, not named in or owner of thread ${payload.tmid ?? "(none)"}`,
        );
        // Nudge only someone who had reason to expect an answer: a reply in a
        // thread we are already in. `postReply`, not `reply`: a
        // refusal is not participation.
        if (config.nudgeWhenIgnored && worthNudging(payload, room) && nudgeAllowed(lastNudges, `${roomId}:${thread}`, Date.now())) {
          await postReply(roomId, `Not picking this up — @${config.rc.botUsername} me and I will.`, thread);
        }
        hooks.onTurnSettled({
          roomId,
          roomName: payload.channel_name,
          threadId: thread,
          requester: payload.user_name,
          promptChars: rawText.length,
          images: fetched?.images.length ?? 0,
          documents: fetched?.documents.length ?? 0,
          replyChars: 0,
          durationMs: 0,
          tools: [],
          status: "ignored",
        });
        return;
      }
    }

    // First writer wins the thread; recorded before any await.
    rememberOwner(room.threadOwners, thread, payload.user_name);

    // The receipt: 👀 on pickup, then ✅ / ⚠️ / ⏳ when the turn
    // settles. Chained so the moves land in order; never awaited by the turn.
    let receipt: ReceiptState | undefined;
    let receiptChain: Promise<void> = Promise.resolve();
    const setReceipt = (to: ReceiptState | undefined) => {
      const messageId = payload.message_id;
      if (!messageId) return;
      const changes = receiptTransition(receipt, to);
      receipt = to;
      if (changes.length) receiptChain = receiptChain.then(() => react(roomId, messageId, changes));
    };
    setReceipt("seen");

    let prompt = stripOurMentions(rawText, bot);

    // `/new` starts the room over: after the gate, before any agent
    // call, and never forwarded — the gateway ignores reset triggers here.
    if (isResetCommand(prompt)) {
      const epoch = conversationEpochs.bump(roomId);
      log(`${payload.user_name} reset ${roomId}: top-level conversation now on epoch ${epoch}`);
      await reply(roomId, RESET_ACK, thread);
      setReceipt("done");
      return;
    }

    // Uploads are fetched only now that we engage, so chatter costs no RC read.
    if (!fetched && payload.message_id) {
      fetched = await fetchMessageAttachments(await attachmentDepsFor(roomId), payload.message_id);
    }
    const images = fetched?.images ?? [];
    // A converted paste is already `prompt`; fencing it too would say it twice.
    const pasted = fetched ? pastedMessageText(fetched) : undefined;
    const documents = pasted ? [] : (fetched?.documents ?? []);
    const skipped = fetched?.skipped ?? [];
    if (pasted) {
      log(`read a ${pasted.length}-char message Rocket.Chat had converted to a file`);
    }

    if (skipped.length) {
      await reply(roomId, `I couldn't read what you sent:\n${skipNotice(skipped)}`, thread);
    }
    if (!prompt && !images.length && !documents.length && !mentionedUs) {
      log(`nothing to answer in ${roomId} — empty message, no attachments`);
      setReceipt(undefined);
      return;
    }

    // An attachment alone, or a bare @mention, is not a request —
    // but it is being spoken to, so the agent is told to describe and ask.
    if (!prompt) {
      prompt = images.length || documents.length
        ? (documents.length ? DOCUMENT_WITHOUT_CONTEXT_PROMPT : IMAGE_WITHOUT_CONTEXT_PROMPT)
        : BARE_MENTION_PROMPT;
    }

    // Document text goes AFTER the human's words, fenced as reference material.
    if (documents.length) {
      prompt = `${prompt}\n\n${documentBlock(documents)}`;
      log(
        `read ${documents.length} document(s): ${documents
          .map(
            (d) =>
              `${d.name} (${d.pages === undefined ? "text" : `${d.pages}p`}, ${d.text.length} chars${d.truncated ? ", truncated" : ""})`,
          )
          .join(", ")}`,
      );
    }

    // `payload.tmid`, not just `thread`: a threaded DM is its own conversation.
    const conversation = conversationKey(roomId, thread, isDM, payload.tmid, conversationEpochs.epochFor(roomId));
    if (busyConversations.has(conversation)) {
      // HELD, not dropped: it runs when this turn ends — see `finally`.
      const { replaced } = holdFollowUp(heldFollowUps, conversation, payload, Date.now());
      log(
        `busy on ${conversation} — holding this message until the turn ends` +
          (replaced ? " (replacing an earlier held one)" : ""),
      );
      // Throttled, and thread-scoped in its wording on purpose.
      if (nudgeAllowed(lastBusyReplies, conversation, Date.now(), config.loop.busyReplyCooldownMs)) {
        await reply(
          roomId,
          "⏳ Still on the previous message in this thread — I've got this one and will answer it next. Other threads carry on as normal.",
          thread,
        );
      } else {
        log(`busy on ${conversation} — reply suppressed by cooldown`);
      }
      return;
    }
    // No cap on turns per thread; the post cap bounds what we EMIT.
    busyConversations.add(conversation);
    const startedAt = Date.now();

    // Context images join the message's own under ONE cap.
    let turnImages: InlineImage[] = images;
    const imageBudget = () => config.attachments.maxImages - turnImages.length;

    // Pulled into a thread that started without us: carry its root as context,
    // once, on the conversation's first turn, images too.
    // DMs and RESPOND_TO_ALL already relayed the root: nothing to recover there.
    if (
      payload.tmid &&
      shouldHydrateRoot({
        tmid: payload.tmid,
        isDM,
        respondToAll: config.respondToAll,
        conversationStarted: startedConversations.has(conversation),
      })
    ) {
      const root = await fetchThreadRoot(await attachmentDepsFor(roomId), payload.tmid, imageBudget());
      if (root && (root.text || root.images.length)) {
        prompt = `${threadRootBlock(root.text ?? "", root.images.length)}\n\n${prompt}`;
        turnImages = [...turnImages, ...root.images];
        log(`hydrated thread root ${payload.tmid} into ${conversation} (${root.text?.length ?? 0} chars, ${root.images.length} image(s))`);
      }
      if (root?.skipped.length) log(`thread root ${payload.tmid}: left out ${skipNotice(root.skipped)}`);
    }

    // An addressed channel message with no image of its own: "that" may be the
    // sender's untagged upload a few minutes ago. One history read,
    // only here, past the gate; a DM or RESPOND_TO_ALL already turned each upload.
    if (!isDM && !config.respondToAll && !images.length && config.attachments.lookbackMs > 0 && imageBudget() > 0) {
      const recent = await fetchRecentImages(await attachmentDepsFor(roomId), {
        roomId,
        roomType: cachedRoomType(roomId),
        senderId: payload.user_id,
        senderName: payload.user_name,
        messageId: payload.message_id,
        tmid: payload.tmid,
        windowMs: config.attachments.lookbackMs,
        budget: imageBudget(),
        now: Date.now(),
        bot,
      });
      if (recent?.images.length) {
        prompt = `${prompt}\n\n${lookbackNote(recent.images.length, config.attachments.lookbackMs)}`;
        turnImages = [...turnImages, ...recent.images];
        log(`carried ${recent.images.length} recent image(s) from ${payload.user_name} into ${conversation}`);
      }
      if (recent?.skipped.length) log(`recent uploads in ${roomId}: left out ${skipNotice(recent.skipped)}`);
    }
    const turn: Turn = { payload, roomId, thread, isDM, conversation, prompt };
    const streaming = agent.shouldTryStreaming();
    let runEvents: RunEventCapture | undefined;
    // For /health's turn timings: when the agent call began, and which profile took it.
    let agentStartedAt: number | undefined;
    let profile: string | undefined;

    const traceBase = {
      roomId,
      roomName: payload.channel_name,
      threadId: thread,
      requester: payload.user_name,
      conversation,
      promptChars: prompt.length,
      images: turnImages.length,
      documents: documents.length,
    };
    try {
      // The context header tells the agent where it is standing and who asked, with
      // the room and thread ids a scheduled run needs to speak back.
      const framed = [contextHeader(payload, isDM, thread), ...(await hooks.framing(turn)), REACTION_HINT, prompt]
        .filter(Boolean)
        .join("\n");
      const routed = (await hooks.targetForRoom(roomId)) ?? { target: deps.defaultTarget, profile: DEFAULT_PROFILE };
      const { target } = routed;
      profile = routed.profile;
      // The stream went quiet: is the run parked on a human? A plain GET, never a
      // touch on the stream. Told once per turn.
      const parkCheck = async (responseId: string): Promise<ParkVerdict> => {
        const run = await agent.readRun(target, responseId);
        if (!run.ok) {
          log(`park check failed for ${responseId}: ${run.error}`);
          return "unknown";
        }
        if (run.done || !run.parked) return run.done ? "unknown" : "running";
        if (!runEvents) {
          runEvents = captureRunEvents({ url: target.url, apiKey: target.apiKey, runId: responseId });
        }
        const details = runEvents.snapshot();
        await hooks.onRunParked(turn, {
          runId: responseId,
          status: run.status,
          ...(details.command ? { command: details.command } : {}),
          ...(details.choices ? { choices: details.choices } : {}),
          ...(run.createdAt ? { createdAt: run.createdAt } : {}),
          ...(run.lastEvent ? { lastEvent: run.lastEvent } : {}),
        });
        return "parked";
      };
      agentStartedAt = Date.now();
      const { text: answer, tools, unknownTypes, timings, ...turnUsage } = streaming
        ? await agent.askStreaming(
            target,
            conversation,
            framed,
            turnImages,
            (responseId) => {
              runEvents = captureRunEvents({ url: target.url, apiKey: target.apiKey, runId: responseId });
            },
            parkCheck,
          )
        : await agent.ask(target, conversation, framed, turnImages);
      turnTimings.record({ at: new Date().toISOString(), room: roomId, profile, status: "ok", ...timings, tools: tools.length });
      runEvents?.close();
      runEvents = undefined;
      outages.recovered(profile); // this profile is reachable again
      // The gateway now chains this conversation: no further root hydration.
      markConversationStarted(conversation);
      log(`turn done in ${Date.now() - startedAt}ms · ${describeTools(tools)}`);
      if (unknownTypes.length) log(`unrecognised output item types: ${[...new Set(unknownTypes)].join(", ")}`);
      // `[react: 👍]` anywhere in the reply becomes a reaction on the human's
      // message; a reply that was ONLY a reaction posts nothing.
      const said = extractReactions(answer);
      if (said.unknown.length) log(`ignored unknown reaction(s) ${said.unknown.join(" ")} — not on the shortcode map`);
      const finalText = (await hooks.onAnswer(turn, said.text)) || (said.emoji.length ? "" : "(no reply)");
      // Posted ONCE, finished: the creation is the notification.
      if (finalText) await reply(roomId, finalText, thread);
      if (said.emoji.length && payload.message_id) {
        const messageId = payload.message_id;
        receiptChain = receiptChain.then(() =>
          react(roomId, messageId, said.emoji.map((emoji) => ({ emoji, shouldReact: true }))),
        );
      }
      // The agent's own reaction already says "answered"; a ✅ beside it is noise.
      setReceipt(said.emoji.length ? undefined : "done");
      hooks.onTurnSettled({
        ...traceBase,
        replyChars: answer.length,
        durationMs: Date.now() - startedAt,
        tools,
        status: "ok",
        startedAt,
        usage: turnUsage,
        answer: said.text,
      });
    } catch (err) {
      runEvents?.close();
      runEvents = undefined;
      const message = (err as Error)?.message ?? String(err);
      log("turn failed:", message);
      if (agentStartedAt !== undefined) {
        const totalMs = Date.now() - agentStartedAt;
        turnTimings.record({ at: new Date().toISOString(), room: roomId, profile, status: "error", firstEventMs: null, firstTextMs: null, totalMs, tools: 0 });
      }
      hooks.onTurnSettled({
        ...traceBase,
        replyChars: 0,
        durationMs: Date.now() - startedAt,
        tools: [],
        status: "error",
        error: message,
      });
      // A turn ceiling is not a failure: the gateway keeps working after we hang
      // up and the conversation keeps its state, so say that calmly. Classified
      // on the error's TYPE: the streamed request's message never matched a regex.
      const agentTimedOut = isTurnTimeout(err);
      // On the message itself, even when the breaker keeps the room quiet.
      setReceipt(agentTimedOut ? "waiting" : "failed");

      // CIRCUIT BREAKER: a profile being down is ONE fact per room. Each room
      // hears it once, naming the kind of failure, then stays quiet until a turn
      // on that profile succeeds; the log still gets every failure.
      if (!agentTimedOut) {
        const outageProfile = profile ?? DEFAULT_PROFILE;
        if (!outages.failed(outageProfile, roomId)) {
          log(`Agent failing on profile ${outageProfile} — already said so, staying quiet in ${roomId}: ${message}`);
          return;
        }
      }
      await reply(
        roomId,
        agentTimedOut
          ? `This one ran past my ${Math.round(config.agent.timeoutMs / 60_000)}-minute wait, but the agent is still working server-side — anything it announces will land here, and a follow-up in this thread picks the conversation right back up.`
          : outageReply(err),
        thread,
      );
    } finally {
      busyConversations.delete(conversation);
      // Whatever arrived mid-turn runs now, tracked like a webhook
      // turn so a shutdown waits for it — unless we are draining.
      const held = takeFollowUp(heldFollowUps, conversation, Date.now(), FOLLOWUP_TTL_MS);
      if (held && deps.isDraining()) {
        log(`draining — dropping the message held on ${conversation}`);
      } else if (held) {
        log(`running the message held on ${conversation}`);
        deps.track(handleMessage(held));
      }
    }
  }

  return { handleMessage, reply };
}
