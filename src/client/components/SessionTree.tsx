import { useMemo, useState } from "react";
import type { SessionSummary } from "../../shared/domain";
import { sessionDisplayTitle } from "../session-title";

export interface SessionGroup {
  root: SessionSummary;
  children: SessionGroup[];
  orphan: boolean;
}

interface ExpansionOverrides {
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
}

export function groupSessions(entries: SessionSummary[]): SessionGroup[] {
  const byId = new Map(entries.map((session) => [session.id, session]));
  const childrenByParent = new Map<string, SessionSummary[]>();

  for (const session of entries) {
    if (session.parentId && byId.has(session.parentId)) {
      const siblings = childrenByParent.get(session.parentId) ?? [];
      siblings.push(session);
      childrenByParent.set(session.parentId, siblings);
    }
  }

  const visited = new Set<string>();
  const build = (
    root: SessionSummary,
    orphan: boolean,
    ancestors: ReadonlySet<string>,
  ): SessionGroup => {
    visited.add(root.id);
    const lineage = new Set(ancestors).add(root.id);
    return {
      root,
      orphan,
      children: (childrenByParent.get(root.id) ?? [])
        .filter((child) => !lineage.has(child.id))
        .map((child) => build(child, false, lineage)),
    };
  };

  const groups = entries
    .filter((session) => !session.parentId || !byId.has(session.parentId))
    .map((root) => build(
      root,
      Boolean(root.parentId && !byId.has(root.parentId)),
      new Set(),
    ));

  for (const session of entries) {
    if (!visited.has(session.id)) groups.push(build(session, true, new Set()));
  }

  return groups;
}

interface SessionTreeProps {
  entries: SessionSummary[];
}

export function SessionTree({ entries }: SessionTreeProps) {
  const groups = useMemo(() => groupSessions(entries), [entries]);
  const [expansion, setExpansion] = useState<ExpansionOverrides>(() => ({
    expanded: new Set(),
    collapsed: new Set(),
  }));

  const onToggle = (id: string, open: boolean) => {
    setExpansion((current) => {
      const expanded = new Set(current.expanded);
      const collapsed = new Set(current.collapsed);
      updateMembership(expanded, id, !open);
      updateMembership(collapsed, id, open);
      return { expanded, collapsed };
    });
  };

  return (
    <nav aria-label="Sessions">
      <ul className="session-list">
        {groups.map((group) => (
          <SessionBranch
            key={group.root.id}
            group={group}
            expanded={expansion.expanded}
            collapsed={expansion.collapsed}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </nav>
  );
}

interface SessionBranchProps {
  group: SessionGroup;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  child?: boolean;
}

function SessionBranch({
  group,
  expanded,
  collapsed,
  onToggle,
  child = false,
}: SessionBranchProps) {
  const { id, title } = group.root;
  const hasChildren = group.children.length > 0;
  const open = hasChildren && !collapsed.has(id) && expanded.has(id);
  const childListId = `session-children-${id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;

  return (
    <li>
      {group.orphan ? <p className="orphan-label">Parent unavailable</p> : null}
      <div className="session-row">
        {hasChildren
          ? (
              <button
                className={`session-disclosure${open ? " open" : ""}`}
                type="button"
                aria-expanded={open}
                aria-controls={childListId}
                aria-label={`${open ? "Collapse" : "Expand"} ${group.children.length} child sessions under ${title}`}
                onClick={() => onToggle(id, open)}
              >
                <span className="disclosure-mark" aria-hidden="true">›</span>
                <span className="child-count" aria-hidden="true">{group.children.length}</span>
              </button>
            )
          : <span className="session-disclosure-spacer" aria-hidden="true" />}
        <SessionLink
          session={group.root}
          child={child}
        />
      </div>
      {open
        ? (
            <ul className="child-list" id={childListId}>
              {group.children.map((nested) => (
                <SessionBranch
                  key={nested.root.id}
                  group={nested}
                  expanded={expanded}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  child
                />
              ))}
            </ul>
          )
        : null}
    </li>
  );
}

interface SessionLinkProps {
  session: SessionSummary;
  child?: boolean;
}

function SessionLink({ session, child = false }: SessionLinkProps) {
  const taskName = child ? session.agent?.taskName ?? null : null;
  const sessionTitle = sessionDisplayTitle(session);
  const displayTitle = taskName ?? sessionTitle;
  const showOriginalTitle = taskName !== null && taskName !== sessionTitle;
  const agentLabels = child
    ? [...new Set(
        [session.agent?.role, session.agent?.nickname]
          .filter((value): value is string => value !== null && value !== undefined),
      )]
    : [];

  return (
    <a
      className={`session${child ? " child" : ""}`}
      href={`/sessions/${encodeURIComponent(session.id)}`}
    >
      <span className={taskName === null ? "session-title" : "session-title task-name"}>
        {displayTitle}
      </span>
      {session.archived
        ? <span className="archive-label">Archived</span>
        : null}
      <span className="source-label">{session.origin.agentName}</span>
      {showOriginalTitle ? <small className="session-subtitle">{sessionTitle}</small> : null}
      {child && agentLabels.length === 0
        ? null
        : (
            <small className="session-meta-line">
              {child
                ? agentLabels.map((label) => (
                    <span className="agent-label" key={label}>{label}</span>
                  ))
                : session.cwd ?? "Project unavailable"}
            </small>
          )}
    </a>
  );
}

function updateMembership(values: Set<string>, value: string, included: boolean): void {
  if (included) values.add(value);
  else values.delete(value);
}
