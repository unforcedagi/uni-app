// The frame-fetch adapter: the one place that knows the wire shape of the
// `pfr` envelope (what `createFrameFetch`/`serveFrameFetch` in surface-client
// will speak). When the published package lands, swap this file.
//   request  {pfr:1, channel, id, method, path, headers, body}
//   response {pfr:1, channel, id, status, statusText, headers, body}

import { ERROR_CODES, type ErrorCode, type FrameFetchRequest, type HostMessage } from "../contract.ts";

export type FetchResult = { status: number; statusText: string; headers: Record<string, string>; body: string };

export const toFrameFetchReply = (req: Pick<FrameFetchRequest, "id" | "channel">, res: FetchResult): HostMessage =>
  ({ pfr: 1, channel: req.channel, id: req.id, status: res.status, statusText: res.statusText, headers: res.headers, body: res.body });

const STATUS: Record<ErrorCode, number> = {
  [ERROR_CODES.badRequest]: 400, [ERROR_CODES.badVersion]: 400, [ERROR_CODES.badParams]: 400, [ERROR_CODES.tooLarge]: 413,
  [ERROR_CODES.unknownNamespace]: 404, [ERROR_CODES.unknownMethod]: 404, [ERROR_CODES.notGranted]: 403, [ERROR_CODES.outOfScope]: 403,
  [ERROR_CODES.rateLimited]: 429, [ERROR_CODES.tooManyPending]: 429, [ERROR_CODES.failed]: 502,
};

export function errorToFrameFetchReply(req: Pick<FrameFetchRequest, "id" | "channel">, code: ErrorCode): HostMessage {
  return toFrameFetchReply(req, { status: STATUS[code] ?? 502, statusText: code, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: code }) });
}
