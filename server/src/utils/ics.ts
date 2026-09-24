export interface IcsEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  status: string;
  organizer: string;
  attendees: string;
  categories: string;
  url: string;
  recurrence: string;
  uid: string;
}

interface IcsLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins RFC 5545 folded lines (a continuation starts with a space or tab). */
function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

/** Splits on `separator` outside of double quotes, which may contain `:` and `;`. */
function splitUnquoted(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === separator && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  parts.push(current);
  return parts;
}

function parseLine(line: string): IcsLine | null {
  const colon = splitUnquoted(line, ":");
  if (colon.length < 2) return null;

  const [namePart, ...valueParts] = colon;
  const [name, ...paramParts] = splitUnquoted(namePart, ";");
  const params: Record<string, string> = {};
  for (const param of paramParts) {
    const equals = param.indexOf("=");
    if (equals < 0) continue;
    params[param.slice(0, equals).trim().toUpperCase()] = param.slice(equals + 1).trim();
  }

  return {
    name: name.trim().toUpperCase(),
    params,
    // The value keeps its own colons; only the first one separates it.
    value: valueParts.join(":"),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocal(date: Date, dateOnly: boolean): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (dateOnly) return day;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface IcsDate {
  text: string;
  allDay: boolean;
  date: Date | null;
}

/**
 * Reads DATE (`20240131`) and DATE-TIME (`20240131T120000[Z]`) values. UTC values are
 * converted to local time; a TZID we cannot resolve is kept as written.
 */
function parseIcsDate(line: IcsLine): IcsDate {
  const value = line.value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return { text: value, allDay: false, date: null };

  const [, year, month, day, hour, minute, second, utc] = match;
  const allDay = !hour || line.params.VALUE === "DATE";
  const parts = [year, month, day, hour ?? "0", minute ?? "0", second ?? "0"].map(Number);
  const date = utc
    ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]))
    : new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);

  return { text: formatLocal(date, allDay), allDay, date };
}

/** `mailto:a@b.c` with `CN="Ada"` reads as `Ada <a@b.c>`. */
function formatPerson(line: IcsLine): string {
  const address = line.value.trim().replace(/^mailto:/i, "");
  const name = line.params.CN?.replace(/^"|"$/g, "").trim();
  if (!name) return address;
  return address ? `${name} <${address}>` : name;
}

function emptyEvent(): IcsEvent {
  return {
    summary: "",
    start: "",
    end: "",
    allDay: false,
    location: "",
    description: "",
    status: "",
    organizer: "",
    attendees: "",
    categories: "",
    url: "",
    recurrence: "",
    uid: "",
  };
}

/** Shifts an exclusive all-day DTEND back to the last day the event covers. */
function inclusiveAllDayEnd(end: IcsDate, start: IcsDate): string {
  if (!end.date || !end.allDay) return end.text;
  const last = new Date(end.date.getTime());
  last.setDate(last.getDate() - 1);
  if (start.date && last.getTime() < start.date.getTime()) return end.text;
  return formatLocal(last, true);
}

export function parseIcsEvents(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let event: IcsEvent | null = null;
  let start: IcsDate | null = null;
  let end: IcsDate | null = null;
  let attendees: string[] = [];
  let nesting = 0;

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === "BEGIN") {
      const component = line.value.trim().toUpperCase();
      if (component === "VEVENT" && !event) {
        event = emptyEvent();
        start = null;
        end = null;
        attendees = [];
      } else if (event) {
        nesting++;
      }
      continue;
    }

    if (line.name === "END") {
      const component = line.value.trim().toUpperCase();
      if (component === "VEVENT" && event && nesting === 0) {
        if (end && start) event.end = inclusiveAllDayEnd(end, start);
        event.attendees = attendees.join(", ");
        events.push(event);
        event = null;
      } else if (nesting > 0) {
        nesting--;
      }
      continue;
    }

    // Properties of a nested VALARM belong to the alarm, not the event.
    if (!event || nesting > 0) continue;

    switch (line.name) {
      case "SUMMARY":
        event.summary = unescapeText(line.value).trim();
        break;
      case "DTSTART":
        start = parseIcsDate(line);
        event.start = start.text;
        event.allDay = start.allDay;
        break;
      case "DTEND":
      case "DUE":
        end = parseIcsDate(line);
        event.end = end.text;
        break;
      case "LOCATION":
        event.location = unescapeText(line.value).trim();
        break;
      case "DESCRIPTION":
        event.description = unescapeText(line.value).trim();
        break;
      case "STATUS":
        event.status = unescapeText(line.value).trim();
        break;
      case "ORGANIZER":
        event.organizer = formatPerson(line);
        break;
      case "ATTENDEE":
        attendees.push(formatPerson(line));
        break;
      case "CATEGORIES":
        event.categories = unescapeText(line.value).trim();
        break;
      case "URL":
        event.url = line.value.trim();
        break;
      case "RRULE":
        event.recurrence = line.value.trim();
        break;
      case "UID":
        event.uid = line.value.trim();
        break;
    }
  }

  return events;
}
