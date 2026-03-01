export interface ParseResult {
  events: CalendarEvent[];
  notifications: Map<string, NotificationConfig[]>;
}

export function parseICalEvents(
  icalText: string,
  color: string,
  calendar: string,
): CalendarEvent[] {
  const result = parseICalEventsWithNotifications(icalText, color, calendar);
  return result.events;
}

export function parseICalEventsWithNotifications(
  icalText: string,
  color: string,
  calendar: string,
): ParseResult {
  const unfolded = unfoldICalLines(icalText);
  const lines = unfolded.split(/\r?\n/);
  const events: CalendarEvent[] = [];
  const notifications = new Map<string, NotificationConfig[]>();
  let currentEvent: Record<string, unknown> = {};
  let currentAlarms: string[] = [];
  let inAlarm = false;
  let currentAlarmText = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "BEGIN:VALARM") {
      inAlarm = true;
      currentAlarmText = "";
    } else if (trimmed === "END:VALARM") {
      inAlarm = false;
      if (currentAlarmText) {
        currentAlarms.push(currentAlarmText);
      }
      currentAlarmText = "";
    } else if (inAlarm) {
      currentAlarmText += trimmed + "\n";
    } else if (trimmed === "BEGIN:VEVENT") {
      currentEvent = {};
      currentAlarms = [];
    } else if (trimmed === "END:VEVENT") {
      if (
        currentEvent.status !== "CANCELLED" &&
        currentEvent.start &&
        currentEvent.start instanceof Date
      ) {
        const eventId = String(currentEvent.uid || Math.random());
        const parsedReminders =
          currentAlarms.length > 0 ? parseVAlarms(eventId, currentAlarms) : undefined;
        const event: CalendarEvent = {
          id: eventId,
          title: String(currentEvent.summary || "Untitled Event"),
          start: currentEvent.start,
          end: (currentEvent.end instanceof Date
            ? currentEvent.end
            : currentEvent.start) as Date,
          color,
          calendar,
          description: currentEvent.description
            ? String(currentEvent.description)
            : undefined,
          location: currentEvent.location ? String(currentEvent.location) : undefined,
          url: currentEvent.url ? String(currentEvent.url) : undefined,
          organizer: currentEvent.organizer as Organizer | undefined,
          attendees: currentEvent.attendees as Attendee[] | undefined,
          readOnly: true,
          isAllDay: currentEvent.isAllDay as boolean | undefined,
          reminders: parsedReminders?.length ? parsedReminders : undefined,
        };
        events.push(event);

        if (parsedReminders?.length) {
          notifications.set(eventId, parsedReminders);
        }
      }
      currentEvent = {};
      currentAlarms = [];
    } else {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const keyPart = trimmed.slice(0, colonIdx);
      const value = trimmed.slice(colonIdx + 1);
      const key = keyPart.split(";")[0];

      switch (key) {
        case "SUMMARY":
          currentEvent.summary = value;
          break;
        case "DTSTART":
          currentEvent.start = parseICalDate(value, keyPart);
          if (keyPart.includes("VALUE=DATE")) {
            currentEvent.isAllDay = true;
          }
          break;
        case "DTEND":
          currentEvent.end = parseICalDate(value, keyPart);
          break;
        case "UID":
          currentEvent.uid = value;
          break;
        case "DESCRIPTION":
          currentEvent.description = value;
          break;
        case "LOCATION":
          currentEvent.location = value;
          break;
        case "URL":
          currentEvent.url = value;
          break;
        case "STATUS":
          currentEvent.status = value;
          break;
        case "ORGANIZER":
          currentEvent.organizer = parseICalPerson(trimmed);
          break;
        case "ATTENDEE":
          if (!currentEvent.attendees) {
            currentEvent.attendees = [];
          }
          (currentEvent.attendees as Attendee[]).push(parseICalAttendee(trimmed));
          break;
      }
    }
  }
  return { events, notifications };
}

function parseVAlarms(eventId: string, alarms: string[]): NotificationConfig[] {
  const notifications: NotificationConfig[] = [];

  for (let i = 0; i < alarms.length; i++) {
    const alarm = alarms[i];
    const triggerMatch = alarm.match(/TRIGGER[^:]*:([^\n]+)/);

    if (triggerMatch) {
      const trigger = triggerMatch[1].trim();
      const offsetMinutes = parseTriggerDuration(trigger);

      if (offsetMinutes !== null) {
        notifications.push({
          id: `${eventId}-valarm-${i}`,
          triggerOffset: offsetMinutes,
          enabled: true,
        });
      }
    }
  }

  return notifications;
}

function parseTriggerDuration(trigger: string): number | null {
  // Parse ISO 8601 duration format: -PT15M, -PT1H, -P1D, etc.
  // Negative means before the event

  const match = trigger.match(
    /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) return null;

  const isNegative = match[1] === "-";
  const days = parseInt(match[2] || "0", 10);
  const hours = parseInt(match[3] || "0", 10);
  const minutes = parseInt(match[4] || "0", 10);

  const totalMinutes = days * 24 * 60 + hours * 60 + minutes;

  // Only support "before" triggers (negative)
  return isNegative ? totalMinutes : null;
}

/**
 * Parses a single VCALENDAR/VEVENT block into a partial CalendarEvent.
 * Used by CalDAV sources where each event arrives as its own iCal string.
 */
export function parseSingleICalEvent(icalText: string): Partial<CalendarEvent> {
  const unfolded = unfoldICalLines(icalText);
  const lines = unfolded.split(/\r?\n|\r/);
  const raw: Record<string, unknown> = {};
  const alarms: string[] = [];
  let inEvent = false;
  let inAlarm = false;
  let currentAlarmText = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      continue;
    }
    if (trimmed === "END:VEVENT") break;
    if (!inEvent) continue;

    if (trimmed === "BEGIN:VALARM") {
      inAlarm = true;
      currentAlarmText = "";
      continue;
    }
    if (trimmed === "END:VALARM") {
      inAlarm = false;
      if (currentAlarmText) alarms.push(currentAlarmText);
      currentAlarmText = "";
      continue;
    }
    if (inAlarm) {
      currentAlarmText += trimmed + "\n";
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const keyPart = trimmed.slice(0, colonIdx);
    const value = trimmed.slice(colonIdx + 1);
    const key = keyPart.split(";")[0];

    switch (key) {
      case "SUMMARY":
        raw.title = value;
        break;
      case "UID":
        raw.id = value;
        break;
      case "DTSTART":
        raw.start = parseICalDate(value, keyPart);
        if (keyPart.includes("VALUE=DATE")) raw.isAllDay = true;
        break;
      case "DTEND":
        raw.end = parseICalDate(value, keyPart);
        break;
      case "DESCRIPTION":
        raw.description = value.replace(/\\n/g, "\n");
        break;
      case "LOCATION":
        raw.location = value;
        break;
      case "URL":
        raw.url = value;
        break;
      case "RRULE":
        raw.rrule = value.trim();
        break;
      case "ORGANIZER":
        raw.organizer = parseICalPerson(trimmed);
        break;
      case "ATTENDEE":
        if (!raw.attendees) raw.attendees = [];
        (raw.attendees as Attendee[]).push(parseICalAttendee(trimmed));
        break;
    }
  }

  const id = raw.id as string | undefined;
  const reminders = id && alarms.length > 0 ? parseVAlarms(id, alarms) : undefined;

  return {
    ...raw,
    reminders: reminders?.length ? reminders : undefined,
  } as Partial<CalendarEvent>;
}

export async function fetchICalEvents(
  credentials: CalendarCredentials,
  color: string,
  name: string,
): Promise<CalendarEvent[]> {
  const url = credentials.url;
  const isExternal = url.startsWith("http://") || url.startsWith("https://");

  const fetchUrl = isExternal ? `/ical-proxy?url=${encodeURIComponent(url)}` : url;

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch iCal: ${response.status}`);
  }
  const text = await response.text();
  return parseICalEvents(text, color, name);
}

export async function fetchICalEventsWithNotifications(
  credentials: CalendarCredentials,
  color: string,
  name: string,
): Promise<ParseResult> {
  const url = credentials.url;
  const isExternal = url.startsWith("http://") || url.startsWith("https://");

  const fetchUrl = isExternal ? `/ical-proxy?url=${encodeURIComponent(url)}` : url;

  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch iCal: ${response.status}`);
  }
  const text = await response.text();
  return parseICalEventsWithNotifications(text, color, name);
}

export function parseICalDate(dateStr: string, keyPart?: string): Date | null {
  if (!dateStr) return null;
  const clean = dateStr.replace(/[^0-9T]/g, "");
  const year = Number.parseInt(clean.slice(0, 4), 10);
  const month = Number.parseInt(clean.slice(4, 6), 10) - 1;
  const day = Number.parseInt(clean.slice(6, 8), 10);

  if (clean.includes("T")) {
    const hour = Number.parseInt(clean.slice(9, 11), 10);
    const minute = Number.parseInt(clean.slice(11, 13), 10);
    const second = Number.parseInt(clean.slice(13, 15), 10) || 0;

    // Check for UTC
    if (dateStr.endsWith("Z")) {
      return new Date(Date.UTC(year, month, day, hour, minute, second));
    }

    // Check for TZID in keyPart
    if (keyPart) {
      const tzidMatch = keyPart.match(/TZID=([^;:]+)/);
      if (tzidMatch) {
        const tzid = tzidMatch[1];
        // Use Intl to determine the correct UTC offset for the given timezone and date,
        // which correctly accounts for DST transitions.
        try {
          // Classic "reverse offset" trick using Intl:
          // 1. Treat the wall-clock digits as if they were UTC (utcGuess)
          // 2. Format utcGuess in the target tz → reveals what UTC+offset looks like
          // 3. Compute offsetMs = utcGuess − that formatted time (also expressed as UTC ms)
          // 4. actualUTC = utcGuess + offsetMs  (subtracts the tz offset)
          const utcGuess = Date.UTC(year, month, day, hour, minute, second);
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tzid,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).formatToParts(new Date(utcGuess));
          const get = (type: string) =>
            Number(parts.find((p) => p.type === type)?.value ?? "0");
          const tzAsUtc = Date.UTC(
            get("year"),
            get("month") - 1,
            get("day"),
            get("hour") % 24,
            get("minute"),
            get("second"),
          );
          const offsetMs = utcGuess - tzAsUtc;
          return new Date(utcGuess + offsetMs);
        } catch {
          // Unknown timezone — fall through to local time interpretation
        }
      }
    }

    return new Date(year, month, day, hour, minute, second);
  }
  return new Date(year, month, day);
}

export function unfoldICalLines(text: string): string {
  return text.replace(/(\r\n|\r|\n)[ \t]/g, "");
}

export function formatICalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

export function formatICalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function parseICalPerson(line: string): Organizer {
  const colonIdx = line.indexOf(":");
  const keyPart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const emailMatch = value.match(/mailto:([^\s]+)/i) || value.match(/([^\s@]+@[^\s]+)/);
  const email = emailMatch ? emailMatch[1] : value;

  const cnMatch = keyPart.match(/CN=([^;:]+)/i);
  const name = cnMatch ? cnMatch[1].replace(/^"(.*)"$/, "$1") : undefined;

  return { email, name };
}

function parseICalAttendee(line: string): Attendee {
  const colonIdx = line.indexOf(":");
  const keyPart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const emailMatch = value.match(/mailto:([^\s]+)/i) || value.match(/([^\s@]+@[^\s]+)/);
  const email = emailMatch ? emailMatch[1] : value;

  const cnMatch = keyPart.match(/CN=([^;:]+)/i);
  const name = cnMatch ? cnMatch[1].replace(/^"(.*)"$/, "$1") : undefined;

  const roleMatch = keyPart.match(/ROLE=([^;:]+)/i);
  const role = roleMatch ? (roleMatch[1] as Attendee["role"]) : undefined;

  const partstatMatch = keyPart.match(/PARTSTAT=([^;:]+)/i);
  const status = partstatMatch ? (partstatMatch[1] as Attendee["status"]) : undefined;

  return { email, name, role, status };
}

export function serializeEventsToICal(events: CalendarEvent[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calendar//EN"];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.id}`);
    lines.push(`SUMMARY:${event.title}`);
    if (event.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatICalDateOnly(event.start)}`);
      lines.push(`DTEND;VALUE=DATE:${formatICalDateOnly(event.end)}`);
    } else {
      lines.push(`DTSTART:${formatICalDate(event.start)}`);
      lines.push(`DTEND:${formatICalDate(event.end)}`);
    }

    if (event.description) {
      lines.push(`DESCRIPTION:${event.description}`);
    }
    if (event.location) {
      lines.push(`LOCATION:${event.location}`);
    }
    if (event.url) {
      lines.push(`URL:${event.url}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
