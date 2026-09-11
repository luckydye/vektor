# Inbound Job Notification Replies

## Minimal Plan

1. Configure Resend Receiving for a dedicated reply domain or its managed `<id>.resend.app` domain.
2. Send each `job_notification` with `Reply-To: reply+<notification-id>@<inbound-domain>`.
3. Add `POST /api/v1/inbound-email/resend`, reachable publicly over HTTPS.
4. Read the raw body and verify Resend's `svix-id`, `svix-timestamp`, and `svix-signature` using `RESEND_WEBHOOK_SECRET`.
5. Accept only valid `email.received` events addressed to a known notification reply address.
6. Deduplicate Resend event/email IDs to block webhook replay.
7. Retrieve the full received email body through Resend's Received Emails API.
8. Send the reply text, source job report, and limited job context to `agentPrompt`.
9. Email the agent response back in the same thread through Resend SMTP.
10. Reject unknown notification IDs, unverified senders, attachments, oversized mail, and agent/tool actions in v1.

https://resend.com/docs/dashboard/receiving/introduction