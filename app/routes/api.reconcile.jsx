// app/routes/api.reconcile.jsx
//
// Protected endpoint for the self-healing reconcile pass. This app runs as a
// long-lived Docker container, not on a platform with built-in cron, so
// triggering this on a schedule is left to any free external scheduler
// pointed at this URL, e.g.:
//   - a scheduled GitHub Actions workflow (free, no card needed)
//   - cron-job.org (free)
//   - your hosting platform's own cron feature, if it has one
//
// Suggested schedule: every 15-60 minutes.
//
// Required environment variables:
//   RECONCILE_SECRET  - any random string you generate yourself
//   SHOP_DOMAIN       - your-store.myshopify.com
//
// Call it like:
//   curl -X POST "https://your-app-url/api/reconcile" \
//     -H "x-reconcile-secret: <RECONCILE_SECRET>"

import { unauthenticated } from "../shopify.server";
import { reconcileAll } from "../services/reconcile.server";

async function handleReconcile(request) {
  const url = new URL(request.url);
  const secret = request.headers.get("x-reconcile-secret") || url.searchParams.get("secret");

  if (!process.env.RECONCILE_SECRET || secret !== process.env.RECONCILE_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shop = process.env.SHOP_DOMAIN;
  if (!shop) {
    return new Response("SHOP_DOMAIN environment variable is not set", { status: 500 });
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const result = await reconcileAll(admin);
    return Response.json(result);
  } catch (err) {
    console.error("reconcileAll failed:", err);
    return new Response("Internal error", { status: 500 });
  }
}

export const action = async ({ request }) => handleReconcile(request);
export const loader = async ({ request }) => handleReconcile(request);
