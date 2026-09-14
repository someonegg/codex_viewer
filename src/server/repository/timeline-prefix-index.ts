import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  DomainTimelineRecord,
  DomainTokenUsageCounters,
  NormalizedSession,
} from "../domain/session-domain.js";

const PREFIX_BYTES = 24;
const PREFIX_PROTOCOL = "timeline-prefix-v2";

export function deriveTimelinePrefixIndex(
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
): TimelinePrefixIndex {
  const states = new Uint8Array((normalized.timeline.length + 1) * PREFIX_BYTES);
  let previousOrdinal: number | undefined;
  let itemIndex = 0;
  let state: Uint8Array = createHmac("sha256", prefixKey)
    .update(PREFIX_PROTOCOL, "utf8")
    .update("\0", "utf8")
    .update(normalized.session.id, "utf8")
    .digest()
    .subarray(0, PREFIX_BYTES);
  states.set(state, 0);
  for (const item of normalized.timeline) {
    validateOrdinal(item.ordinal, previousOrdinal);
    previousOrdinal = item.ordinal;
    itemIndex += 1;
    state = advancePrefix(state, item, normalized, prefixKey);
    states.set(state, itemIndex * PREFIX_BYTES);
  }
  return TimelinePrefixIndex.fromCompleteStates(itemIndex, states);
}

export function extendsTimelinePrefix(
  previous: NormalizedSession,
  next: NormalizedSession,
): boolean {
  if (
    previous.session.id !== next.session.id ||
    previous.timeline.length > next.timeline.length
  ) {
    return false;
  }
  for (let index = 0; index < previous.timeline.length; index += 1) {
    const item = previous.timeline[index]!;
    if (item !== next.timeline[index]) return false;
    if (
      item.kind === "tool" &&
      previous.toolDetails.get(item.id) !== next.toolDetails.get(item.id)
    ) {
      return false;
    }
    if (
      item.kind === "directive" &&
      previous.directiveDetails.get(item.id) !== next.directiveDetails.get(item.id)
    ) {
      return false;
    }
    if (
      item.kind === "internal" &&
      previous.internalDetails.get(item.id) !== next.internalDetails.get(item.id)
    ) {
      return false;
    }
  }
  return true;
}

export function extendTimelinePrefixIndex(
  previousIndex: TimelinePrefixIndex,
  previous: NormalizedSession,
  next: NormalizedSession,
  prefixKey: Uint8Array,
  /** Internal callers may skip a continuity scan they have just completed. */
  continuityValidated = false,
): TimelinePrefixIndex {
  if (!continuityValidated && !extendsTimelinePrefix(previous, next)) {
    throw new Error("Cannot extend a timeline prefix index across a changed prefix");
  }
  return TimelinePrefixIndex.fromAppend(
    previousIndex,
    previous,
    next,
    prefixKey,
  );
}

export interface TimelinePrefixBoundary {
  readonly throughOrdinal: number;
  readonly timelinePrefixRevision: string;
}

export class TimelinePrefixIndex {
  readonly #itemCount: number;
  readonly #segments: readonly Uint8Array[];
  readonly #segmentEnds: readonly number[];

  private constructor(itemCount: number, segments: readonly Uint8Array[]) {
    this.#itemCount = itemCount;
    this.#segments = segments;
    const segmentEnds: number[] = [];
    let storedSlots = 0;
    for (const segment of segments) {
      if (segment.byteLength === 0 || segment.byteLength % PREFIX_BYTES !== 0) {
        throw new Error("Timeline prefix index has an invalid segment byte length");
      }
      storedSlots += segment.byteLength / PREFIX_BYTES;
      segmentEnds.push(storedSlots);
    }
    if (storedSlots !== itemCount + 1) {
      throw new Error("Timeline prefix index has an invalid byte length");
    }
    this.#segmentEnds = segmentEnds;
  }

  static fromCompleteStates(
    itemCount: number,
    states: Uint8Array,
  ): TimelinePrefixIndex {
    return new TimelinePrefixIndex(itemCount, [states.slice()]);
  }

  static fromAppend(
    previous: TimelinePrefixIndex,
    previousNormalized: NormalizedSession,
    normalized: NormalizedSession,
    prefixKey: Uint8Array,
  ): TimelinePrefixIndex {
    const previousItemCount = previousNormalized.timeline.length;
    if (
      previous.#itemCount !== previousItemCount ||
      normalized.timeline.length <= previousItemCount
    ) {
      throw new Error("Timeline prefix index does not match the append boundary");
    }
    const appendedCount = normalized.timeline.length - previousItemCount;
    const appendedStates = new Uint8Array(appendedCount * PREFIX_BYTES);
    let previousOrdinal = normalized.timeline[previousItemCount - 1]?.ordinal;
    let state = previous.#slot(previousItemCount);
    for (
      let itemIndex = previousItemCount;
      itemIndex < normalized.timeline.length;
      itemIndex += 1
    ) {
      const item = normalized.timeline[itemIndex]!;
      validateOrdinal(item.ordinal, previousOrdinal);
      previousOrdinal = item.ordinal;
      state = advancePrefix(state, item, normalized, prefixKey);
      appendedStates.set(
        state,
        (itemIndex - previousItemCount) * PREFIX_BYTES,
      );
    }
    return new TimelinePrefixIndex(normalized.timeline.length, [
      ...previous.#segments,
      appendedStates,
    ]);
  }

  get byteLength(): number {
    return (this.#itemCount + 1) * PREFIX_BYTES;
  }

  boundaryAt(
    timeline: readonly DomainTimelineRecord[],
    throughOrdinal: number,
  ): TimelinePrefixBoundary | null {
    const maximumOrdinal = timeline.at(-1)?.ordinal ?? 0;
    if (timeline.length !== this.#itemCount) {
      throw new Error("Timeline prefix index does not match the timeline");
    }
    if (throughOrdinal > maximumOrdinal) return null;
    let low = 0;
    let high = timeline.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (timeline[middle]!.ordinal <= throughOrdinal) low = middle + 1;
      else high = middle;
    }
    return this.#boundary(timeline, low);
  }

  boundaryAtOrBefore(
    timeline: readonly DomainTimelineRecord[],
    throughOrdinal: number,
  ): TimelinePrefixBoundary {
    const maximumOrdinal = timeline.at(-1)?.ordinal ?? 0;
    return this.boundaryAt(timeline, Math.min(throughOrdinal, maximumOrdinal))!;
  }

  matches(
    timeline: readonly DomainTimelineRecord[],
    boundary: TimelinePrefixBoundary,
    candidate: string,
  ): boolean {
    const encoded = Buffer.from(candidate, "base64url");
    if (encoded.byteLength !== PREFIX_BYTES) return false;
    const slotIndex = boundary.throughOrdinal === 0
      ? 0
      : upperBound(timeline, boundary.throughOrdinal);
    const slot = slotIndex === 0 ||
        timeline[slotIndex - 1]?.ordinal === boundary.throughOrdinal
      ? this.#slot(slotIndex)
      : null;
    return slot !== null && timingSafeEqual(slot, encoded);
  }

  #boundary(
    timeline: readonly DomainTimelineRecord[],
    slot: number,
  ): TimelinePrefixBoundary {
    return {
      throughOrdinal: slot === 0 ? 0 : timeline[slot - 1]!.ordinal,
      timelinePrefixRevision: Buffer.from(this.#slot(slot))
        .toString("base64url"),
    };
  }

  #slot(index: number): Uint8Array {
    let low = 0;
    let high = this.#segmentEnds.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.#segmentEnds[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    const segment = this.#segments[low];
    if (segment === undefined) {
      throw new Error("Timeline prefix slot is out of bounds");
    }
    const segmentStart = low === 0 ? 0 : this.#segmentEnds[low - 1]!;
    const start = (index - segmentStart) * PREFIX_BYTES;
    return segment.subarray(start, start + PREFIX_BYTES);
  }
}

function validateOrdinal(
  ordinal: number,
  previousOrdinal: number | undefined,
): void {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    (previousOrdinal !== undefined && ordinal <= previousOrdinal)
  ) {
    throw new Error("Timeline ordinals must be strictly increasing positive integers");
  }
}

function advancePrefix(
  state: Uint8Array,
  item: DomainTimelineRecord,
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
): Uint8Array {
  const chunks: Buffer[] = [];
  writeTimelineItem(new DigestWriter((chunk) => {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk),
    );
  }), item, normalized);
  return createHmac("sha256", prefixKey)
    .update(state)
    .update(Buffer.concat(chunks))
    .digest()
    .subarray(0, PREFIX_BYTES);
}

function upperBound(
  timeline: readonly DomainTimelineRecord[],
  ordinal: number,
): number {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (timeline[middle]!.ordinal <= ordinal) low = middle + 1;
    else high = middle;
  }
  return low;
}

function writeTimelineItem(
  writer: DigestWriter,
  item: DomainTimelineRecord,
  normalized: NormalizedSession,
): void {
  writer.string("kind", item.kind);
  writer.string("id", item.id);
  writer.number("ordinal", item.ordinal);
  writer.nullableString("timestamp", item.timestamp);
  switch (item.kind) {
    case "message":
      writer.string("role", item.role);
      writer.nullableString("phase", item.phase);
      writer.nullableString("itemType", item.itemType ?? null);
      writer.string("markdown", item.markdown);
      return;
    case "directive":
      writer.boolean("hasDetail", item.hasDetail);
      if (!item.hasDetail) {
        writer.string("text", item.text);
        return;
      }
      writer.string("summary", item.summary);
      writer.number("charCount", item.charCount);
      writer.nullableObject(
        "detail",
        normalized.directiveDetails.get(item.id) ?? null,
        (entry, detail) => {
          entry.string("text", detail.text);
          entry.boolean("truncated", detail.truncated);
        },
      );
      return;
    case "tool":
      writer.string("stage", item.stage);
      writer.string("callId", item.callId);
      writer.string("toolName", item.toolName);
      if (item.stage === "output") writer.string("status", item.status);
      writer.nullableString("preview", item.preview);
      writer.number("charCount", item.charCount);
      writer.boolean("hasDetail", item.hasDetail);
      writer.nullableObject(
        "detail",
        normalized.toolDetails.get(item.id) ?? null,
        (entry, detail) => {
          entry.nullableString("input", detail.input);
          entry.nullableString("output", detail.output);
          entry.boolean("truncated", detail.truncated);
        },
      );
      return;
    case "user_input":
      writer.string("stage", item.stage);
      writer.string("callId", item.callId);
      if (item.stage === "request") {
        writer.array("questions", item.questions, (entry, question) => {
          entry.string("id", question.id);
          entry.string("header", question.header);
          entry.string("question", question.question);
          entry.array("options", question.options, (optionEntry, option) => {
            optionEntry.string("label", option.label);
            optionEntry.string("description", option.description);
          });
        });
        return;
      }
      writer.string("outcome", item.outcome);
      if (item.outcome === "answered") {
        writer.array("answers", item.answers, (entry, answer) => {
          entry.string("questionId", answer.questionId);
          entry.array("answers", answer.answers, (answerEntry, value) => {
            answerEntry.valueString(value);
          });
        });
      } else if (item.outcome === "unavailable") {
        writer.string("summary", item.summary);
      }
      return;
    case "token":
      writer.nullableObject("tokenUsage.total", item.tokenUsage.total, writeTokenCounters);
      writer.nullableObject("tokenUsage.last", item.tokenUsage.last, writeTokenCounters);
      return;
    case "internal":
      writer.string("eventType", item.eventType);
      writer.nullableObject(
        "detail",
        normalized.internalDetails.get(item.id) ?? null,
        (entry, detail) => {
          entry.string("json", detail.json);
          entry.boolean("truncated", detail.truncated);
        },
      );
      return;
  }
}

function writeTokenCounters(
  writer: DigestWriter,
  counters: DomainTokenUsageCounters,
): void {
  writer.nullableNumber("totalTokens", counters.totalTokens);
  writer.nullableNumber("inputTokens", counters.inputTokens);
  writer.nullableNumber("cachedInputTokens", counters.cachedInputTokens);
  writer.nullableNumber("cacheWriteInputTokens", counters.cacheWriteInputTokens);
  writer.nullableNumber("outputTokens", counters.outputTokens);
  writer.nullableNumber("reasoningOutputTokens", counters.reasoningOutputTokens);
}

class DigestWriter {
  constructor(
    private readonly update: (chunk: string | Uint8Array) => void,
  ) {
  }

  string(name: string, value: string): void {
    this.#field(name, "string");
    this.valueString(value);
  }

  nullableString(name: string, value: string | null): void {
    this.#field(name, "nullable-string");
    if (value === null) {
      this.#token("null");
      return;
    }
    this.valueString(value);
  }

  boolean(name: string, value: boolean): void {
    this.#field(name, "boolean");
    this.#token(value ? "true" : "false");
  }

  number(name: string, value: number): void {
    this.#field(name, "number");
    this.#token(String(value));
  }

  nullableNumber(name: string, value: number | null): void {
    this.#field(name, "nullable-number");
    this.#token(value === null ? "null" : String(value));
  }

  nullableObject<T>(
    name: string,
    value: T | null,
    write: (writer: DigestWriter, value: T) => void,
  ): void {
    this.#field(name, "nullable-object");
    if (value === null) {
      this.#token("null");
      return;
    }
    this.#token("object-start");
    write(this, value);
    this.#token("object-end");
  }

  array<T>(
    name: string,
    values: readonly T[],
    write: (writer: DigestWriter, value: T) => void,
  ): void {
    this.#field(name, "array");
    this.#token(String(values.length));
    for (const value of values) {
      this.#token("item-start");
      write(this, value);
      this.#token("item-end");
    }
  }

  valueString(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    this.update(`value:${bytes}:`);
    this.update(value);
    this.update(";");
  }

  #field(name: string, type: string): void {
    this.#token(`field:${type}`);
    this.valueString(name);
  }

  #token(value: string): void {
    this.update(`${value.length}:${value};`);
  }
}
