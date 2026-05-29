export function formatTime(ts: string | number | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDay(ts: string | number | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

