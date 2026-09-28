import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/**
 * Products moved under MetaKocka so the MetaKocka entry in the navigation is
 * highlighted while it is open: the admin highlights the entry whose address
 * the current path starts with.
 *
 * Kept as a redirect, with its query string, for the reason every moved page
 * here is: a bookmark that 404s is a support ticket.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectWithin(request, "/app/metakocka/products");
};
