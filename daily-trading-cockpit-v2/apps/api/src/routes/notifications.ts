import type { FastifyInstance } from "fastify";

import type { NotificationService } from "../lib/notification-service.js";

export async function registerNotificationRoutes(
  app: FastifyInstance,
  notificationService: NotificationService,
): Promise<void> {
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
  }

  app.get("/api/notifications/status", async () => {
    return notificationService.getStatus();
  });

  app.post("/api/notifications/test", async (_request, reply) => {
    const sent = await notificationService.sendTestMessage();
    const status = notificationService.getStatus();
    if (!sent && !status.enabled) {
      reply.code(503);
    }
    return {
      sent,
      enabled: status.enabled,
      lastSendTime: status.lastSendTime,
      lastError: status.lastError,
    };
  });
}
