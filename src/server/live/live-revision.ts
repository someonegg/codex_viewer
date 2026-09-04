import { createHmac, randomBytes } from "node:crypto";
import type {
  InteractionResponse,
  LiveRevision,
  SessionLiveResponse,
} from "../../shared/api-contract.js";
import type { SessionDetail } from "../../shared/domain.js";

export type LiveRevisionFactory = (
  session: LiveRevisionSession,
  interaction: InteractionResponse,
) => LiveRevision;

export type LiveRevisionSession = Omit<SessionDetail, "nickname">;

export function createProcessLiveRevisionFactory(
  secret: Uint8Array = randomBytes(32),
): LiveRevisionFactory {
  return (session, interaction) => createHmac("sha256", secret)
    .update(canonicalJson({ session, interaction }))
    .digest("base64url") as LiveRevision;
}

export function withLiveRevision<T extends {
  readonly session: SessionDetail;
  readonly interaction: InteractionResponse;
}>(
  value: T,
  createRevision: LiveRevisionFactory,
): T & Pick<SessionLiveResponse, "liveRevision"> {
  const { nickname: _nickname, ...revisionSession } = value.session;
  return {
    ...value,
    liveRevision: createRevision(revisionSession, value.interaction),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
