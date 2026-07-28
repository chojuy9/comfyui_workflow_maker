// Add these imports to the existing worker.js:
export { ImageQueue, ImageQuota } from "./image-durable-objects.js";
import { cleanupImageRetention, getImageAdminStatus, handleImageApi } from "./image-api.js";

// Add this near the start of the existing fetch router:
//
// if (new URL(request.url).pathname.startsWith("/api/image/")) {
//   const session = await sessionAccount(env, request);
//   const account = session?.acct?.verified && !session.acct.blocked ? session.acct : null;
//   return handleImageApi(request, env, ctx, account);
// }
//
// Add to the existing scheduled() handler:
// ctx.waitUntil(cleanupImageRetention(env));
//
// Add inside the existing handleAdmin(), after adminOk() has succeeded:
// if (action === "image") return json({ ok: true, ...(await getImageAdminStatus(env)) });
