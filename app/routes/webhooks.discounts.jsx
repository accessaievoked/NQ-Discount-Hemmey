import { authenticate } from "../shopify.server";
import { syncDiscountToProducts, removeDiscountFromProducts } from "../services/discountSync.server";

export const action = async ({ request }) => {
  const { topic, payload, admin } = await authenticate.webhook(request);

  try {
    if (topic === "DISCOUNTS_DELETE") {
      await removeDiscountFromProducts(admin, payload.admin_graphql_api_id);
    } else {
      await syncDiscountToProducts(admin, payload.admin_graphql_api_id);
    }
  } catch (err) {
    // Swallow the error so Shopify sees a 200 instead of a 500. Returning an
    // error here makes Shopify retry the webhook and, after enough repeated
    // failures, disable the subscription entirely — worse than missing one
    // sync, since it would silently stop future discounts from syncing too.
    // The next edit to this discount, or the reconcile job, will catch up.
    console.error(`Discount sync failed for ${payload.admin_graphql_api_id} (topic ${topic}):`, err);
  }

  return new Response();
};