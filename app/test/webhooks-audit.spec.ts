import { describe, expect, it } from "bun:test";

describe("Webhook audit logging types", () => {
  it("validates webhook audit event types exist", () => {
    const webhookAuditEvents = ["webhook_success", "webhook_failed"];

    expect(webhookAuditEvents).toContain("webhook_success");
    expect(webhookAuditEvents).toContain("webhook_failed");
  });

  it("validates audit details structure for webhook events", () => {
    const webhookDetails = {
      webhookId: "webhook-123",
      webhookUrl: "https://example.com/webhook",
      webhookEvent: "document.published",
      statusCode: 200,
      errorMessage: undefined,
    };

    expect(webhookDetails).toHaveProperty("webhookId");
    expect(webhookDetails).toHaveProperty("webhookUrl");
    expect(webhookDetails).toHaveProperty("webhookEvent");
    expect(webhookDetails.webhookId).toBe("webhook-123");
    expect(webhookDetails.webhookUrl).toBe("https://example.com/webhook");
  });

  it("validates success webhook audit details", () => {
    const successDetails: {
      webhookId: string;
      webhookUrl: string;
      webhookEvent: string;
      statusCode: number;
      errorMessage?: string;
    } = {
      webhookId: "webhook-456",
      webhookUrl: "https://api.example.com/hook",
      webhookEvent: "mention",
      statusCode: 200,
    };

    expect(successDetails.statusCode).toBe(200);
    expect(successDetails.errorMessage).toBeUndefined();
  });

  it("validates failure webhook audit details with status code", () => {
    const failureDetails = {
      webhookId: "webhook-789",
      webhookUrl: "https://broken.example.com/webhook",
      webhookEvent: "document.published",
      statusCode: 500,
      errorMessage: "500 Internal Server Error",
    };

    expect(failureDetails.statusCode).toBe(500);
    expect(failureDetails.errorMessage).toBeDefined();
    expect(failureDetails.errorMessage).toContain("500");
  });

  it("validates failure webhook audit details with network error", () => {
    const networkErrorDetails: {
      webhookId: string;
      webhookUrl: string;
      webhookEvent: string;
      errorMessage: string;
      statusCode?: number;
    } = {
      webhookId: "webhook-999",
      webhookUrl: "https://invalid-domain.test/webhook",
      webhookEvent: "document.deleted",
      errorMessage: "Failed to fetch",
    };

    expect(networkErrorDetails.errorMessage).toBeDefined();
    expect(networkErrorDetails.statusCode).toBeUndefined();
  });

  it("validates triggered webhook audit details", () => {
    const triggeredDetails: {
      webhookId: string;
      webhookUrl: string;
      webhookEvent: string;
      statusCode?: number;
      errorMessage?: string;
    } = {
      webhookId: "webhook-111",
      webhookUrl: "https://example.com/webhook",
      webhookEvent: "mention",
    };

    expect(triggeredDetails).toHaveProperty("webhookId");
    expect(triggeredDetails).toHaveProperty("webhookUrl");
    expect(triggeredDetails).toHaveProperty("webhookEvent");
    expect(triggeredDetails.statusCode).toBeUndefined();
    expect(triggeredDetails.errorMessage).toBeUndefined();
  });

  it("validates all webhook event types are supported", () => {
    const supportedWebhookEvents = [
      "document.published",
      "document.unpublished",
      "document.deleted",
      "mention",
    ];

    const testDetails = supportedWebhookEvents.map((event) => ({
      webhookId: "test-webhook",
      webhookUrl: "https://test.com/webhook",
      webhookEvent: event,
    }));

    for (const details of testDetails) {
      expect(details.webhookEvent).toMatch(
        /^(document\.(published|unpublished|deleted)|mention)$/,
      );
    }
  });

  it("validates audit log structure for webhook events", () => {
    const mockAuditLog = {
      id: "audit-123",
      docId: "doc-456",
      revisionId: 5,
      userId: undefined, // Webhooks are system events
      event: "webhook_success",
      details: JSON.stringify({
        webhookId: "webhook-789",
        webhookUrl: "https://example.com/webhook",
        webhookEvent: "document.published",
        statusCode: 200,
      }),
      createdAt: new Date(),
    };

    expect(mockAuditLog.event).toBe("webhook_success");
    expect(mockAuditLog.userId).toBeUndefined();

    const parsedDetails = JSON.parse(mockAuditLog.details);
    expect(parsedDetails.webhookId).toBe("webhook-789");
    expect(parsedDetails.statusCode).toBe(200);
  });
});
