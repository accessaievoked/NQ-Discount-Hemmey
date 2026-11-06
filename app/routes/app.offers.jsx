import { redirect } from "react-router";

// The offers table now lives at the app's home route (/app). This route is
// kept only so the old /app/offers URL doesn't dead-end for anyone with it
// bookmarked or cached in Shopify's nav.
export const loader = async () => {
  return redirect("/app");
};
