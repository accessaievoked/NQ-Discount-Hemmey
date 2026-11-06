import { authenticate } from "../shopify.server";
import { setOfferApproval } from "../services/discountSync.server";

// ---------------------------------------------------------------------------
// POST /app/offers/:id/approve
// Body: approved=true|false
//
// Flips whether this offer is allowed to show on the storefront cart
// (cart drawer / Best Offers panel). Used by the dashboard's Approve /
// Unapprove buttons — a plain resource route (no loader/UI) so it can be
// called with a fetcher from both the offers table and the offer detail
// page without a full navigation.
// ---------------------------------------------------------------------------
export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = decodeURIComponent(params.id);
  const formData = await request.formData();
  const approved = formData.get("approved") === "true";

  try {
    await setOfferApproval(admin, id, approved);
  } catch (err) {
    console.error(`Failed to set approval for offer ${id}:`, err);
    return { ok: false, error: "Couldn't save — try again." };
  }

  return { ok: true, approved };
};