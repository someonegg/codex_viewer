import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import type { SessionSource } from "./source/session-source.js";
import {
  SessionReadService,
  type SessionReadServiceDependencies,
} from "./application/session-read-service.js";

export function createSessionReadService(
  sources: readonly SessionSource[],
  dependencies?: SessionReadServiceDependencies,
): SessionReadService {
  return new SessionReadService(sources, undefined, undefined, dependencies);
}

export async function createCodexSessionReadService(
  codexHome: string,
): Promise<SessionReadService> {
  const source = await createCodexSessionSource(codexHome);
  return createSessionReadService([source], {
    resolveNickname: (session) => source.nicknameFor(session),
  });
}
