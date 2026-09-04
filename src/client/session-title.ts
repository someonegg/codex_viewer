import type { SessionSummary } from "../shared/domain";

export function sessionDisplayTitle(
  session: Pick<SessionSummary, "title" | "nickname">,
): string {
  return session.nickname ?? session.title;
}
