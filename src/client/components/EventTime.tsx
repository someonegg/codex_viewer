const EVENT_DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function EventTime({ timestamp }: { timestamp: string | null }) {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return <> · <time dateTime={timestamp}>{EVENT_DATE_TIME_FORMAT.format(date)}</time></>;
}
