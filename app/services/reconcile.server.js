// app/services/reconcile.server.js
//
// Self-healing pass. Webhooks handle discounts/create, /update, /delete
// instantly — but Shopify does NOT send a webhook when a discount simply
// expires (endsAt passes) or when someone edits a collection's product list
// after the discount was already created. This job catches both by walking
// every "product_offer" metaobject this app has ever created and re-running
// the same sync logic the webhooks use.
//
// Call reconcileAll(admin) periodically (see app/routes/api.reconcile.jsx
// for how it's triggered from outside the app, since this is a long-running
// Docker app, not a serverless platform with its own built-in cron).

import {
  getDiscountDetails,
  syncDiscountToProducts,
  removeDiscountFromProducts,
  writeCartOffersMetafield,
} from "./discountSync.server";

async function listAllOfferMetaobjects(admin) {
  let nodes = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `query listOffers($cursor: String) {
        metaobjects(type: "$app:product_offer", first: 50, after: $cursor) {
          nodes { id fields { key value } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await response.json();
    const conn = json.data.metaobjects;
    nodes.push(...conn.nodes);
    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return nodes;
}

export async function reconcileAll(admin) {
  const offers = await listAllOfferMetaobjects(admin);
  let processed = 0;
  let failures = 0;

  for (const offer of offers) {
    const discountGid = offer.fields.find((f) => f.key === "discount_gid")?.value;
    if (!discountGid) continue;

    try {
      const node = await getDiscountDetails(admin, discountGid);
      const d = node?.discount;
      const isExpired = d?.endsAt && new Date(d.endsAt) < new Date();
      const isUnsupported =
        !d || (d.__typename !== "DiscountCodeBasic" && d.__typename !== "DiscountAutomaticBasic");

      if (isUnsupported || isExpired) {
        // Discount was deleted, expired, or is no longer a type we track —
        // tear the offer down the same way the delete webhook would.
        await removeDiscountFromProducts(admin, discountGid);
      } else {
        // Still valid — re-sync in case collection membership changed since
        // the last webhook fired.
        await syncDiscountToProducts(admin, discountGid);
      }
      processed++;
    } catch (err) {
      console.error(`Reconcile failed for discount ${discountGid}:`, err);
      failures++;
    }
  }

  // Belt-and-braces: rebuild the shop's cart_offers metafield once from
  // final state, in case an individual sync above wrote it and a later one
  // in the same run failed partway through.
  try {
    await writeCartOffersMetafield(admin);
  } catch (err) {
    console.error("Failed to rebuild cart_offers metafield during reconcile:", err);
  }

  return { processed, failures };
}
