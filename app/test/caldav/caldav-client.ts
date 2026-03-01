import { parseSingleICalEvent, formatICalDate } from "./ical.ts";

/**
 * CalDAV credentials.
 */
export interface CalDAVCredentials extends CalendarCredentials {
  /**
   * CalDAV server URL
   */
  serverUrl: string;
  /**
   * Username for authentication
   */
  username: string;
  /**
   * Password for authentication
   */
  password: string;
}

/**
 * CalDAV calendar information.
 */
interface CalDAVCalendarInfo {
  displayName: string;
  url: string;
  ctag: string;
  color?: string;
}

/**
 * CalDAV source for syncing with CalDAV servers.
 *
 * @example
 * const source = new CalDAVSource(
 *   'caldav-1',
 *   'My CalDAV Calendar',
 *   '#FF6E68',
 *   {
 *     serverUrl: 'https://mail.example.com/caldav/users/username/',
 *     username: 'user@example.com',
 *     password: 'password123'
 *   }
 * );
 *
 * const events = await source.fetchEvents();
 */
export class CalDAVSource implements CalendarSource {
  readonly type = "caldav";
  credentials: CalDAVCredentials;
  enabled: boolean;

  constructor(
    public id: string,
    public name: string,
    public color: string,
    credentials: CalDAVCredentials,
    enabled = true,
  ) {
    this.credentials = credentials;
    this.enabled = enabled;
  }

  /**
   * Get the authorization header for Basic auth.
   */
  private getAuthHeader(): string {
    return "Basic " + btoa(`${this.credentials.username}:${this.credentials.password}`);
  }

  /**
   * Make an authenticated request to the CalDAV server.
   */
  async request(
    url: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/xml; charset=utf-8",
        ...headers,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`CalDAV request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  /**
   * Find the calendar home URL using the well-known CalDAV endpoint.
   */
  private async findCalendarHome(): Promise<string> {
    const wellKnownUrl = new URL(
      "/.well-known/caldav",
      this.credentials.serverUrl,
    ).toString();

    const response = await this.request(
      wellKnownUrl,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`,
      { Depth: "0" },
    );

    const text = await response.text();

    const principalMatch = text.match(
      /<[^:]+:current-user-principal[^>]*>.*?<[^:]+:href[^>]*>(.*?)<\/[^:]+:href>/s,
    );
    if (!principalMatch) {
      throw new Error("Could not find current-user-principal");
    }

    const principalPath = principalMatch[1];
    const principalUrl = new URL(principalPath, this.credentials.serverUrl).toString();

    const principalResponse = await this.request(
      principalUrl,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`,
      { Depth: "0" },
    );

    const principalText = await principalResponse.text();

    const homeMatch = principalText.match(
      /<[^:]+:calendar-home-set[^>]*>.*?<[^:]+:href[^>]*>(.*?)<\/[^:]+:href>/s,
    );
    if (!homeMatch) {
      throw new Error("Could not find calendar-home-set");
    }

    return new URL(homeMatch[1], this.credentials.serverUrl).toString();
  }

  /**
   * Fetch the current user's email address via the CalDAV principal's
   * calendar-user-address-set property (RFC 4791).
   * Falls back to the configured username if the server doesn't support it.
   */
  async fetchCurrentUserEmail(): Promise<string> {
    const wellKnownUrl = new URL(
      "/.well-known/caldav",
      this.credentials.serverUrl,
    ).toString();

    const discoveryResponse = await this.request(
      wellKnownUrl,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`,
      { Depth: "0" },
    );

    const discoveryText = await discoveryResponse.text();
    const principalMatch = discoveryText.match(
      /<[^:]+:current-user-principal[^>]*>.*?<[^:]+:href[^>]*>(.*?)<\/[^:]+:href>/s,
    );
    if (!principalMatch) throw new Error("Could not find current-user-principal");

    const principalUrl = new URL(
      principalMatch[1],
      this.credentials.serverUrl,
    ).toString();

    const principalResponse = await this.request(
      principalUrl,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-user-address-set/>
  </d:prop>
</d:propfind>`,
      { Depth: "0" },
    );

    const principalText = await principalResponse.text();
    const emailMatch = principalText.match(/mailto:([^\s<"]+)/i);
    if (emailMatch) return emailMatch[1];

    throw new Error("Could not determine current user email from CalDAV principal");
  }

  /**
   * Fetch available calendars from the CalDAV server.
   */
  async fetchCalendars(): Promise<CalDAVCalendarInfo[]> {
    const calendarHome = await this.findCalendarHome();

    const response = await this.request(
      calendarHome,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:apple="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
    <apple:calendar-color/>
  </d:prop>
</d:propfind>`,
      { Depth: "1" },
    );

    const text = await response.text();

    const calendars: CalDAVCalendarInfo[] = [];
    const responseRegex = /<[^:]+:response[^>]*>(.*?)<\/[^:]+:response>/gs;

    for (const match of text.matchAll(responseRegex)) {
      const responseBlock = match[1];

      if (!responseBlock.includes("calendar") && !responseBlock.includes("CALENDAR")) {
        continue;
      }

      const hrefMatch = responseBlock.match(/<[^:]+:href[^>]*>(.*?)<\/[^:]+:href>/);
      const displayNameMatch = responseBlock.match(
        /<[^:]+:displayname[^>]*>(.*?)<\/[^:]+:displayname>/i,
      );
      const ctagMatch = responseBlock.match(
        /<[^:]+:getctag[^>]*>(.*?)<\/[^:]+:getctag>/i,
      );
      const colorMatch = responseBlock.match(
        /<[^:]+:calendar-color[^>]*>(.*?)<\/[^:]+:calendar-color>/i,
      );

      if (hrefMatch) {
        const url = new URL(hrefMatch[1], this.credentials.serverUrl).toString();
        calendars.push({
          displayName: displayNameMatch?.[1] || "Unnamed Calendar",
          url,
          ctag: ctagMatch?.[1] || "",
          color: colorMatch?.[1] || undefined,
        });
      }
    }

    return calendars;
  }

  /**
   * Fetch calendar objects (events) from a specific calendar.
   */
  private async fetchCalendarObjects(calendarUrl: string): Promise<string[]> {
    const response = await this.request(
      calendarUrl,
      "REPORT",
      `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
      { Depth: "1" },
    );

    const text = await response.text();

    const calendarData: string[] = [];
    const calendarDataRegex = /<[^:]+:calendar-data[^>]*>(.*?)<\/[^:]+:calendar-data>/gs;

    for (const match of text.matchAll(calendarDataRegex)) {
      let icalData = match[1].trim();
      // Unescape XML entities
      icalData = icalData
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

      if (icalData) {
        calendarData.push(icalData);
      }
    }

    return calendarData;
  }

  /**
   * Serialize a CalendarEvent to iCal format.
   */
  private serializeEventToICal(event: CalendarEvent): string {
    const now = formatICalDate(new Date());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Calendar//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${event.id}`,
      `DTSTAMP:${now}`,
      `SUMMARY:${event.title}`,
      `CREATED:${now}`,
      `LAST-MODIFIED:${now}`,
    ];

    if (event.isAllDay) {
      const startStr = formatICalDate(event.start).slice(0, 8);
      const endStr = formatICalDate(event.end).slice(0, 8);
      lines.push(`DTSTART;VALUE=DATE:${startStr}`);
      lines.push(`DTEND;VALUE=DATE:${endStr}`);
    } else {
      lines.push(`DTSTART:${formatICalDate(event.start)}`);
      lines.push(`DTEND:${formatICalDate(event.end)}`);
    }

    if (event.description) {
      const escaped = event.description.replace(/\n/g, "\\n");
      lines.push(`DESCRIPTION:${escaped}`);
    }

    if (event.location) {
      lines.push(`LOCATION:${event.location}`);
    }

    if (event.url) {
      lines.push(`URL:${event.url}`);
    }

    if (event.rrule) {
      lines.push(`RRULE:${event.rrule}`);
    }

    if (event.organizer) {
      const cn = event.organizer.name ? `CN="${event.organizer.name}"` : "";
      lines.push(`ORGANIZER${cn ? ";" + cn : ""}:mailto:${event.organizer.email}`);
    }

    if (event.attendees && event.attendees.length > 0) {
      for (const attendee of event.attendees) {
        const params: string[] = [];
        if (attendee.name) params.push(`CN="${attendee.name}"`);
        if (attendee.role) params.push(`ROLE=${attendee.role}`);
        if (attendee.status) params.push(`PARTSTAT=${attendee.status}`);
        const paramString = params.join(";");
        lines.push(
          `ATTENDEE${paramString ? ";" + paramString : ""}:mailto:${attendee.email}`,
        );
      }
    }

    if (event.reminders?.length) {
      for (const reminder of event.reminders) {
        const minutes = reminder.triggerOffset;
        lines.push("BEGIN:VALARM");
        lines.push("ACTION:DISPLAY");
        lines.push(`DESCRIPTION:Reminder`);
        lines.push(`TRIGGER:-PT${minutes}M`);
        lines.push("END:VALARM");
      }
    }

    lines.push("END:VEVENT");
    lines.push("END:VCALENDAR");

    return lines.join("\r\n");
  }

  /**
   * Map a parsed VCALENDAR event to CalendarEvent.
   */
  private mapToCalendarEvent(
    parsed: Partial<CalendarEvent>,
    calendarDisplayName: string,
    calendarUrl: string,
    calendarColor?: string,
  ): CalendarEvent | null {
    if (!parsed.start || !parsed.id) return null;

    return {
      id: parsed.id,
      title: parsed.title || "Untitled Event",
      start: parsed.start,
      end: parsed.end || parsed.start,
      color: calendarColor || this.color,
      calendar: calendarDisplayName,
      calendarId: calendarUrl,
      sourceId: this.id,
      description: parsed.description,
      location: parsed.location,
      url: parsed.url,
      rrule: parsed.rrule,
      organizer: parsed.organizer,
      attendees: parsed.attendees,
      readOnly: false,
      isAllDay: parsed.isAllDay,
      reminders: parsed.reminders,
    };
  }

  /**
   * Fetch events from a single CalDAV calendar URL.
   */
  async fetchEventsForCalendar(
    calendarUrl: string,
    displayName: string,
    color?: string,
  ): Promise<CalendarEvent[]> {
    const calendarObjects = await this.fetchCalendarObjects(calendarUrl);
    return calendarObjects
      .map((ical) =>
        this.mapToCalendarEvent(
          parseSingleICalEvent(ical),
          displayName,
          calendarUrl,
          color,
        ),
      )
      .filter((e): e is CalendarEvent => e !== null);
  }

  /**
   * Fetch events from the CalDAV server.
   * Fetches events from all available calendars.
   */
  async fetchEvents(): Promise<CalendarEvent[]> {
    if (!this.enabled) return [];

    const calendars = await this.fetchCalendars();
    const allEvents: CalendarEvent[] = [];

    for (const calendar of calendars) {
      const events = await this.fetchEventsForCalendar(
        calendar.url,
        calendar.displayName,
        calendar.color,
      );
      allEvents.push(...events);
    }

    return allEvents;
  }

  /**
   * Create a new event on the CalDAV server.
   * The event must have calendarId set to the target calendar URL.
   */
  async createEvent(
    event: Omit<CalendarEvent, "calendar" | "color">,
  ): Promise<CalendarEvent> {
    if (!event.calendarId) throw new Error("Cannot create event: calendarId is required");
    const calendarUrl = event.calendarId;

    const fullEvent: CalendarEvent = {
      ...event,
      calendar: this.name,
      color: this.color,
      calendarId: calendarUrl,
      sourceId: this.id,
    };

    const eventUrl = `${calendarUrl.replace(/\/$/, "")}/${event.id}.ics`;
    const icalData = this.serializeEventToICal(fullEvent);

    await this.request(eventUrl, "PUT", icalData, {
      "Content-Type": "text/calendar; charset=utf-8",
    });

    return fullEvent;
  }

  /**
   * Update an existing event on the CalDAV server.
   * Derives the calendar URL from updates.calendarId, falling back to the event cache.
   */
  async updateEvent(id: string, updates: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const calendarUrl = updates.calendarId ?? this.eventCalendarMap.get(id);
    if (!calendarUrl) throw new Error(`Cannot update event ${id}: calendar URL unknown`);
    const eventUrl = `${calendarUrl.replace(/\/$/, "")}/${id}.ics`;

    // For updates, we need to fetch the existing event first
    // This is a simplified implementation
    const response = await this.request(eventUrl, "GET", undefined, {
      Accept: "text/calendar",
    });

    const existingIcal = await response.text();
    const existing = parseSingleICalEvent(existingIcal);

    const updatedEvent: CalendarEvent = {
      id,
      title: updates.title ?? existing.title ?? "Untitled Event",
      start: updates.start ?? existing.start ?? new Date(),
      end: updates.end ?? existing.end ?? new Date(),
      color: this.color,
      calendar: this.name,
      calendarId: updates.calendarId ?? existing.calendarId ?? calendarUrl,
      sourceId: updates.sourceId ?? existing.sourceId ?? this.id,
      description:
        updates.description !== undefined ? updates.description : existing.description,
      location: updates.location !== undefined ? updates.location : existing.location,
      url: updates.url !== undefined ? updates.url : existing.url,
      rrule: updates.rrule !== undefined ? updates.rrule : existing.rrule,
      organizer: updates.organizer !== undefined ? updates.organizer : existing.organizer,
      attendees: updates.attendees !== undefined ? updates.attendees : existing.attendees,
      readOnly: false,
      isAllDay: updates.isAllDay !== undefined ? updates.isAllDay : existing.isAllDay,
      reminders: updates.reminders !== undefined ? updates.reminders : existing.reminders,
    };

    const icalData = this.serializeEventToICal(updatedEvent);

    await this.request(eventUrl, "PUT", icalData, {
      "Content-Type": "text/calendar; charset=utf-8",
    });

    return updatedEvent;
  }

  /**
   * Test the connection to the CalDAV server.
   * Returns true if the credentials are valid.
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.findCalendarHome();
      return true;
    } catch (error) {
      return false;
    }
  }
}
