// app/services/discountSync.server.js
//
// Flow: discount saved (webhook) -> read the discount (code OR automatic) ->
// read its selected collections and/or specific products -> get every
// product in scope -> create/update a metaobject with the offer details ->
// link that metaobject onto each product's active_offers metafield.
//
// Only handles merchant-created "Basic" discounts (amount/percentage off),
// for both the discount-code and automatic-discount types. App-created
// discounts (DiscountCodeApp / DiscountAutomaticApp) and other discount
// shapes (BOGO, free shipping, "all products") are skipped on purpose.

const BATCH_SIZE = 25; // how many products to write to per batch, keeps API usage safe

const DISCOUNT_FIELDS = `
  __typename
  ... on DiscountCodeBasic {
    title
    summary
    usageLimit
    startsAt
    endsAt
    codes(first: 1) { nodes { code } }
    minimumRequirement {
      __typename
      ... on DiscountMinimumSubtotal {
        greaterThanOrEqualToSubtotal { amount }
      }
    }
    customerGets {
      value {
        __typename
        ... on DiscountPercentage { percentage }
        ... on DiscountAmount { amount { amount } }
      }
      items {
        __typename
        ... on DiscountCollections {
          collections(first: 50) { nodes { id } }
        }
        ... on DiscountProducts {
          products(first: 50) { nodes { id } }
        }
      }
    }
  }
  ... on DiscountAutomaticBasic {
    title
    summary
    startsAt
    endsAt
    minimumRequirement {
      __typename
      ... on DiscountMinimumSubtotal {
        greaterThanOrEqualToSubtotal { amount }
      }
    }
    customerGets {
      value {
        __typename
        ... on DiscountPercentage { percentage }
        ... on DiscountAmount { amount { amount } }
      }
      items {
        __typename
        ... on DiscountCollections {
          collections(first: 50) { nodes { id } }
        }
        ... on DiscountProducts {
          products(first: 50) { nodes { id } }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers to turn Shopify's minimum-requirement / value shapes into the
// simple fields the offer metaobject (and the storefront cart) expects.
// ---------------------------------------------------------------------------
function extractMinimumAmount(minimumRequirement) {
  if (minimumRequirement?.__typename === "DiscountMinimumSubtotal") {
    const amount = minimumRequirement.greaterThanOrEqualToSubtotal?.amount;
    return amount != null ? Number(amount) : null;
  }
  return null;
}

function formatSavingsLabel(value) {
  if (!value) return "";
  if (value.__typename === "DiscountPercentage" && value.percentage != null) {
    const pct = Math.round(value.percentage * 100);
    return `${pct}% off`;
  }
  if (value.__typename === "DiscountAmount" && value.amount?.amount != null) {
    return `₹${value.amount.amount} off`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 1. Read the discount (code OR automatic) + which collection(s)/product(s)
//    it targets. Uses the unified discountNode query so one code path
//    handles both discount types.
// ---------------------------------------------------------------------------
export async function getDiscountDetails(admin, discountGid) {
  const response = await admin.graphql(
    `query getDiscount($id: ID!) {
      discountNode(id: $id) {
        id
        discount {
          ${DISCOUNT_FIELDS}
        }
      }
    }`,
    { variables: { id: discountGid } }
  );
  const json = await response.json();
  return json.data.discountNode;
}

// ---------------------------------------------------------------------------
// 2. Get every product ID in a collection (paginated, no cap on size)
// ---------------------------------------------------------------------------
export async function getCollectionProductIds(admin, collectionId) {
  let ids = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `query getProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionId, cursor } }
    );
    const json = await response.json();
    const conn = json.data.collection.products;
    ids.push(...conn.nodes.map((n) => n.id));
    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return ids;
}

// ---------------------------------------------------------------------------
// 3. Find an existing offer metaobject by its stored discount_gid field
// ---------------------------------------------------------------------------
async function findOfferMetaobjectByDiscountGid(admin, discountGid) {
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `query findOffer($cursor: String) {
        metaobjects(type: "$app:product_offer", first: 50, after: $cursor) {
          nodes {
            id
            fields { key value }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await response.json();
    const conn = json.data.metaobjects;

    const match = conn.nodes.find((node) =>
      node.fields.some((f) => f.key === "discount_gid" && f.value === discountGid)
    );
    if (match) {
      const linkedField = match.fields.find((f) => f.key === "linked_product_ids");
      let linkedProductIds = [];
      if (linkedField?.value) {
        try {
          linkedProductIds = JSON.parse(linkedField.value);
        } catch {
          linkedProductIds = [];
        }
      }
      const description = match.fields.find((f) => f.key === "description")?.value || "";
      const descriptionOverride =
        match.fields.find((f) => f.key === "description_override")?.value === "true";
      const approved = match.fields.find((f) => f.key === "approved")?.value === "true";
      return { id: match.id, linkedProductIds, description, descriptionOverride, approved };
    }

    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Create or update the offer metaobject
// ---------------------------------------------------------------------------
async function upsertOfferMetaobject(admin, data) {
  const existing = await findOfferMetaobjectByDiscountGid(admin, data.discount_gid);

  // If the merchant has manually edited the description in-app, keep it —
  // don't let this sync (webhook or reconcile) stomp it back to Shopify's
  // auto-generated summary.
  const description = existing?.descriptionOverride
    ? existing.description
    : data.description || "";

  // Approval gate: a brand-new offer (no existing metaobject) always starts
  // UNAPPROVED, so a discount created in Shopify admin never shows on the
  // storefront cart until a merchant reviews and approves it in the app
  // dashboard. Once an offer exists, this sync (webhook or reconcile) must
  // never flip approval on its own — it only preserves whatever the
  // merchant last chose, the same way descriptionOverride is preserved.
  const approved = existing ? existing.approved : false;

  const fields = [
    { key: "title", value: data.title || "" },
    { key: "description", value: description },
    { key: "description_override", value: existing?.descriptionOverride ? "true" : "false" },
    { key: "approved", value: approved ? "true" : "false" },
    { key: "code", value: data.code || "" },
    { key: "usage_limit", value: data.usage_limit != null ? String(data.usage_limit) : "" },
    { key: "starts_at", value: data.starts_at || "" },
    { key: "ends_at", value: data.ends_at || "" },
    { key: "discount_gid", value: data.discount_gid },
    { key: "linked_product_ids", value: JSON.stringify(data.linked_product_ids || []) },
    {
      key: "minimum_amount",
      value: data.minimum_amount != null ? String(data.minimum_amount) : "",
    },
    { key: "savings_label", value: data.savings_label || "" },
  ];

  if (existing) {
    const response = await admin.graphql(
      `mutation updateOffer($id: ID!, $fields: [MetaobjectFieldInput!]!) {
        metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
          metaobject { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: existing.id, fields } }
    );
    const json = await response.json();
    return { id: json.data.metaobjectUpdate.metaobject.id, previouslyLinked: existing.linkedProductIds };
  }

  const response = await admin.graphql(
    `mutation createOffer($fields: [MetaobjectFieldInput!]!) {
      metaobjectCreate(metaobject: { type: "$app:product_offer", fields: $fields }) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    { variables: { fields } }
  );
  const json = await response.json();
  return { id: json.data.metaobjectCreate.metaobject.id, previouslyLinked: [] };
}

// ---------------------------------------------------------------------------
// 5. Attach the metaobject to a single product's active_offers list
// ---------------------------------------------------------------------------
async function attachOfferToOneProduct(admin, productId, metaobjectId) {
  const readResponse = await admin.graphql(
    `query getProductOffers($id: ID!) {
      product(id: $id) {
        metafield(namespace: "custom", key: "active_offers") {
          value
        }
      }
    }`,
    { variables: { id: productId } }
  );
  const readJson = await readResponse.json();
  const currentRaw = readJson.data.product.metafield?.value;

  let currentIds = [];
  if (currentRaw) {
    try {
      currentIds = JSON.parse(currentRaw);
    } catch {
      currentIds = [];
    }
  }

  if (currentIds.includes(metaobjectId)) return; // already linked, nothing to do
  currentIds.push(metaobjectId);

  const writeResponse = await admin.graphql(
    `mutation setOffers($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: "custom",
            key: "active_offers",
            type: "list.metaobject_reference",
            value: JSON.stringify(currentIds),
          },
        ],
      },
    }
  );
  const writeJson = await writeResponse.json();
  const errors = writeJson.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(
      `metafieldsSet failed for product ${productId}: ${JSON.stringify(errors)}`
    );
  }
}

async function attachOfferToProducts(admin, productIds, metaobjectId) {
  for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
    const batch = productIds.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((id) => attachOfferToOneProduct(admin, id, metaobjectId)));
  }
}

// ---------------------------------------------------------------------------
// 6. Remove the metaobject reference from a single product
// ---------------------------------------------------------------------------
async function removeOfferFromOneProduct(admin, productId, metaobjectId) {
  const readResponse = await admin.graphql(
    `query getProductOffers($id: ID!) {
      product(id: $id) {
        metafield(namespace: "custom", key: "active_offers") {
          value
        }
      }
    }`,
    { variables: { id: productId } }
  );
  const readJson = await readResponse.json();
  const currentRaw = readJson.data.product.metafield?.value;
  if (!currentRaw) return;

  let currentIds = [];
  try {
    currentIds = JSON.parse(currentRaw);
  } catch {
    return;
  }

  const filtered = currentIds.filter((id) => id !== metaobjectId);
  if (filtered.length === currentIds.length) return; // wasn't linked, nothing to change

  const writeResponse = await admin.graphql(
    `mutation setOffers($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: "custom",
            key: "active_offers",
            type: "list.metaobject_reference",
            value: JSON.stringify(filtered),
          },
        ],
      },
    }
  );
  const writeJson = await writeResponse.json();
  const errors = writeJson.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(
      `metafieldsSet failed for product ${productId}: ${JSON.stringify(errors)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 7. MAIN ENTRY POINT — called from the discounts/create + discounts/update webhook
//    (and from the reconcile job). Handles both discount-code and automatic
//    discounts, both collection-targeted and product-targeted. Skips
//    app-created discounts and anything that isn't a "Basic" discount.
// ---------------------------------------------------------------------------
export async function syncDiscountToProducts(admin, discountGid) {
  const node = await getDiscountDetails(admin, discountGid);
  const d = node?.discount;
  if (!d) return; // discount doesn't exist (deleted, or bad id) — nothing to sync

  const typename = d.__typename;
  if (typename !== "DiscountCodeBasic" && typename !== "DiscountAutomaticBasic") {
    // Covers DiscountCodeApp / DiscountAutomaticApp (app- or Function-created
    // discounts — not human-created in admin) plus BOGO / free-shipping
    // shapes this integration doesn't render on the PDP.
    return;
  }
  const isAutomatic = typename === "DiscountAutomaticBasic";

  const items = d.customerGets?.items;
  const itemsType = items?.__typename;

  let collectionIds = [];
  let directProductIds = [];
  if (itemsType === "DiscountCollections") {
    collectionIds = items.collections?.nodes.map((c) => c.id) || [];
  } else if (itemsType === "DiscountProducts") {
    directProductIds = items.products?.nodes.map((p) => p.id) || [];
  }
  // itemsType === "AllDiscountItems" (whole catalog, e.g. "spend ₹999, get 10%
  // off your order") has no products/collections to tag — that's fine for
  // the per-product "active offers" badge, which this skips on purpose. But
  // these whole-cart discounts are exactly the ones the cart drawer's Top
  // Offers panel needs to know about, so they still get an offer metaobject
  // below; they just never get attached to any product (allProductIds stays
  // empty and attachOfferToProducts/removeOfferFromOneProduct below are
  // no-ops for an empty list).

  // Gather every product across every selected collection, plus any directly
  // selected products (de-duplicated)
  let allProductIds = [...directProductIds];
  for (const collectionId of collectionIds) {
    const productIds = await getCollectionProductIds(admin, collectionId);
    allProductIds.push(...productIds);
  }
  allProductIds = [...new Set(allProductIds)];

  const { id: metaobjectId, previouslyLinked } = await upsertOfferMetaobject(admin, {
    title: d.title,
    description: d.summary,
    code: isAutomatic ? "" : d.codes?.nodes[0]?.code || "",
    usage_limit: isAutomatic ? null : d.usageLimit,
    starts_at: d.startsAt,
    ends_at: d.endsAt,
    discount_gid: discountGid,
    linked_product_ids: allProductIds,
    minimum_amount: extractMinimumAmount(d.minimumRequirement),
    savings_label: formatSavingsLabel(d.customerGets?.value),
  });

  // If the merchant changed collections (some products removed from scope),
  // clean the offer off any product that's no longer in the new product list.
  const removedProductIds = previouslyLinked.filter((id) => !allProductIds.includes(id));
  if (removedProductIds.length > 0) {
    for (let i = 0; i < removedProductIds.length; i += BATCH_SIZE) {
      const batch = removedProductIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((id) => removeOfferFromOneProduct(admin, id, metaobjectId)));
    }
  }

  // Attach to every currently-in-scope product
  await attachOfferToProducts(admin, allProductIds, metaobjectId);

  // Keep the storefront cart's offers list (shop metafield thb.cart_offers)
  // in sync so the cart drawer's Top Offers panel reflects this change.
  await writeCartOffersMetafield(admin);
}

// ---------------------------------------------------------------------------
// 7b. Rebuild the shop-level `thb.cart_offers` metafield the storefront cart
//     drawer reads. Only discount-CODE offers are included (code non-blank)
//     — automatic discounts apply themselves with no "Apply" action needed,
//     so they're surfaced elsewhere (PDP/product offer strips) instead.
//     Expired or not-yet-started offers are excluded.
// ---------------------------------------------------------------------------
async function buildCartOffersPayload(admin) {
  const now = new Date();
  let cursor = null;
  let hasNextPage = true;
  const payload = [];

  while (hasNextPage) {
    const response = await admin.graphql(
      `query listOffersForCart($cursor: String) {
        metaobjects(type: "$app:product_offer", first: 50, after: $cursor) {
          nodes { fields { key value } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } }
    );
    const json = await response.json();
    const conn = json.data.metaobjects;

    for (const node of conn.nodes) {
      const get = (key) => node.fields.find((f) => f.key === key)?.value || "";
      const code = get("code");
      if (!code) continue;

      // Gate: only offers a merchant has explicitly approved in the app
      // dashboard are allowed onto the storefront cart. Everything else
      // (brand-new, still-pending discounts) is skipped here even though
      // it already has its own product_offer metaobject.
      if (get("approved") !== "true") continue;

      const startsAt = get("starts_at");
      const endsAt = get("ends_at");
      if (startsAt && new Date(startsAt) > now) continue;
      if (endsAt && new Date(endsAt) < now) continue;

      const minimumAmountRaw = get("minimum_amount");

      payload.push({
        code,
        description: get("description"),
        minimum_amount: minimumAmountRaw ? Number(minimumAmountRaw) : 0,
        savings_label: get("savings_label"),
      });
    }

    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }

  return payload;
}

async function getShopGid(admin) {
  const response = await admin.graphql(`query { shop { id } }`);
  const json = await response.json();
  return json.data.shop.id;
}

export async function writeCartOffersMetafield(admin) {
  const [payload, shopId] = await Promise.all([
    buildCartOffersPayload(admin),
    getShopGid(admin),
  ]);

  const response = await admin.graphql(
    `mutation setCartOffers($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "thb",
            key: "cart_offers",
            type: "json",
            value: JSON.stringify(payload),
          },
        ],
      },
    }
  );
  const json = await response.json();
  const errors = json.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    throw new Error(`metafieldsSet failed for shop cart_offers: ${JSON.stringify(errors)}`);
  }
}

// ---------------------------------------------------------------------------
// 7c. Approve / un-approve a single offer from the app dashboard. Flips the
//     `approved` field on its metaobject, then immediately rebuilds the
//     shop's cart_offers metafield so the cart drawer / Best Offers panel
//     reflects the decision right away instead of waiting for the next
//     webhook or reconcile pass.
// ---------------------------------------------------------------------------
export async function setOfferApproval(admin, metaobjectId, approved) {
  const response = await admin.graphql(
    `mutation setOfferApproval($id: ID!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
        metaobject { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        id: metaobjectId,
        fields: [{ key: "approved", value: approved ? "true" : "false" }],
      },
    }
  );
  const json = await response.json();
  const errors = json.data?.metaobjectUpdate?.userErrors;
  if (errors?.length) {
    throw new Error(`metaobjectUpdate (approval) failed: ${JSON.stringify(errors)}`);
  }

  await writeCartOffersMetafield(admin);
}

// ---------------------------------------------------------------------------
// 8. Called from the discounts/delete webhook
// ---------------------------------------------------------------------------
export async function removeDiscountFromProducts(admin, discountGid) {
  const existing = await findOfferMetaobjectByDiscountGid(admin, discountGid);
  if (!existing) return;

  const { id: metaobjectId, linkedProductIds } = existing;

  for (let i = 0; i < linkedProductIds.length; i += BATCH_SIZE) {
    const batch = linkedProductIds.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((id) => removeOfferFromOneProduct(admin, id, metaobjectId)));
  }

  await admin.graphql(
    `mutation deleteOffer($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }`,
    { variables: { id: metaobjectId } }
  );

  await writeCartOffersMetafield(admin);
}