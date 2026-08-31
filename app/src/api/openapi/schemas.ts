import type { JsonSchema } from "./types.ts";

const timestamp = { type: "string", format: "date-time" };

/**
 * The response shapes the API's read endpoints share. They mirror the types the
 * `@vektorapp/api` client is written against — that client is the contract this
 * schema is describing, so the two are kept in step.
 */
export const SCHEMAS: Record<string, JsonSchema> = {
  Error: {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string", description: "Human-readable reason." } },
  },

  InstanceInfo: {
    type: "object",
    properties: {
      service: { type: "string", const: "vektor" },
      version: { type: "integer" },
      apiVersion: { type: "string" },
      documentEndpoint: { type: "string" },
      openapiEndpoint: { type: "string" },
    },
  },

  CreatedSpace: {
    type: "object",
    properties: { space: { $ref: "#/components/schemas/Space" } },
  },

  Preferences: {
    type: "object",
    description: "Space preferences. A `user:`-prefixed key is the caller's own.",
    additionalProperties: { type: "string" },
  },

  PropertyValue: {
    description: "A document property holds either one value or a list of them.",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },

  Properties: {
    type: "object",
    additionalProperties: { $ref: "#/components/schemas/PropertyValue" },
  },

  Space: {
    type: "object",
    required: ["id", "name", "slug", "createdBy", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      createdBy: { type: "string" },
      preferences: { $ref: "#/components/schemas/Preferences" },
      userPreferences: { $ref: "#/components/schemas/Preferences" },
      userRole: { type: "string" },
      memberCount: { type: "integer" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },

  SpaceRef: {
    type: "object",
    description: "The abbreviated space a single-document response is served from.",
    properties: {
      id: { type: "string" },
      slug: { type: "string" },
      name: { type: "string" },
    },
  },

  Document: {
    type: "object",
    required: ["id", "slug", "currentRev", "createdAt", "updatedAt", "createdBy"],
    properties: {
      id: { type: "string" },
      slug: { type: "string" },
      type: { type: ["string", "null"] },
      content: { type: "string", description: "HTML. Omitted from listings." },
      currentRev: { type: "integer" },
      publishedRev: { type: ["integer", "null"] },
      properties: { $ref: "#/components/schemas/Properties" },
      parentId: { type: ["string", "null"] },
      readonly: { type: "boolean" },
      archived: { type: "boolean" },
      mentionCount: { type: "integer" },
      headerImageAspectRatio: { type: ["number", "null"] },
      fileUrl: {
        type: "string",
        description: "Set on uploaded-file entries — read the file from here.",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: { type: "string" },
    },
  },

  DocumentResponse: {
    type: "object",
    properties: {
      document: { $ref: "#/components/schemas/Document" },
      space: { $ref: "#/components/schemas/SpaceRef" },
    },
  },

  DocumentPage: {
    type: "object",
    properties: {
      documents: { type: "array", items: { $ref: "#/components/schemas/Document" } },
      total: { type: "integer" },
      limit: { type: "integer", description: "Absent when the response is unpaginated." },
      nextCursor: {
        type: ["string", "null"],
        description: "Null on the last page; pass it back as `cursor` for the next one.",
      },
    },
  },

  Revision: {
    type: "object",
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      rev: { type: "integer" },
      slug: { type: "string" },
      content: { type: "string" },
      checksum: { type: "string" },
      parentRev: { type: ["integer", "null"] },
      status: {
        type: ["string", "null"],
        description: "`suggestion` for a proposed edit; null for an ordinary revision.",
      },
      message: { type: ["string", "null"] },
      createdAt: timestamp,
      createdBy: { type: "string" },
    },
  },

  Category: {
    type: "object",
    required: ["id", "name", "slug", "order"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: ["string", "null"] },
      color: { type: ["string", "null"] },
      icon: { type: ["string", "null"] },
      order: { type: "integer", description: "Sort position within the space." },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  },

  SearchResponse: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          allOf: [
            { $ref: "#/components/schemas/Document" },
            {
              type: "object",
              properties: { rank: { type: "number" }, snippet: { type: "string" } },
            },
          ],
        },
      },
      query: { type: "string" },
      limit: { type: "integer" },
      nextCursor: { type: ["string", "null"] },
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: { type: ["string", "null"] },
          },
        },
      },
    },
  },

  CurrentUser: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string", format: "email" },
      image: { type: ["string", "null"] },
      canCreateSpace: { type: "boolean" },
      adminGroups: {
        type: "array",
        items: { type: "string" },
        description: "The groups a 'gain access' request can be written to.",
      },
      isAdmin: { type: "boolean" },
    },
  },
};
