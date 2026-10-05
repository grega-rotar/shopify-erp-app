import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/**
 * One product moved to the product workspace at `/app/products/:id`, which
 * shows what this page did — prices, compare-at and the campaign holding
 * each variant — and edits the product besides. Kept as a redirect, with
 * its query string, because a bookmark that 404s is a support ticket.
 */
export const loader = ({ request, params }: LoaderFunctionArgs) => {
  throw redirectWithin(
    request,
    `/app/products/${encodeURIComponent(params.productId ?? "")}`,
    { tab: "variants" },
  );
};
