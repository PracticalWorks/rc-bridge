// The bridge's two routes: GET /health and POST /rocketchat/webhook. The webhook
// is acked fast and its turn runs detached, tracked so a restart waits for it.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebhookPayload } from "./plugin.js";

export interface HttpHandlerDeps {
  port: number;
  tlsEnabled: boolean;
  webhookToken: string;
  isDraining(): boolean;
  inFlight: { count(): number; track(work: Promise<void>): unknown };
  handleMessage(payload: WebhookPayload): Promise<void>;
  /** The readiness verdict and body: 200 serving, 503 draining, `extra` merged in.
   * Unset, `coreHealthResponse` answers. A deployment can pass its own, for
   * example to fail health on a rejected bot credential. */
  healthResponse?(draining: boolean, extra: Record<string, unknown>): { code: number; body: Record<string, unknown> } | Promise<{ code: number; body: Record<string, unknown> }>;

  /** Plugin fields, merged between the core's in-flight count and its turn timings. */
  pluginHealth(): Record<string, unknown>;
  turns(): unknown[];
}

/** The readiness reply a deployment gets when it passes none: 200 serving, 503
 * draining, `extra` merged in. */
export function coreHealthResponse(
  draining: boolean,
  extra: Record<string, unknown>,
): { code: number; body: Record<string, unknown> } {
  return { code: draining ? 503 : 200, body: { ok: !draining, draining, ...extra } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createHttpHandler(deps: HttpHandlerDeps) {
  const tokenBytes = Buffer.from(deps.webhookToken);
  const validWebhookToken = (token: string | undefined): boolean => {
    if (!token) return false;
    const bytes = Buffer.from(token);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };
  const healthResponse = deps.healthResponse ?? coreHealthResponse;
  const json = (res: ServerResponse, code: number, body: unknown) =>
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `${deps.tlsEnabled ? "https" : "http"}://localhost:${deps.port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const { code, body } = await healthResponse(deps.isDraining(), {
        inFlight: deps.inFlight.count(),
        ...deps.pluginHealth(),
        // Where recent turns' time went: room ids and numbers only.
        turns: deps.turns(),
      });
      json(res, code, body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/rocketchat/webhook") {
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(await readBody(req)) as WebhookPayload;
      } catch {
        json(res, 400, { error: "bad json" });
        return;
      }
      // Token check before anything else — a wrong/absent token never triggers a turn.
      if (!validWebhookToken(payload.token)) {
        json(res, 401, { error: "bad token" });
        return;
      }
      // Draining: refuse honestly. RC treats a 200 as delivered and never
      // resends, so an accepted-then-abandoned turn is a silently lost message.
      if (deps.isDraining()) {
        json(res, 503, { error: "draining" });
        return;
      }
      // Ack fast so RC's webhook does not time out; the reply comes back via postMessage.
      json(res, 200, { ok: true });
      void deps.inFlight.track(deps.handleMessage(payload));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("POST /rocketchat/webhook or GET /health\n");
  };
}
