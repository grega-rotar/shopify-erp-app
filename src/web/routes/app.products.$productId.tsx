import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/** One product moved with Products; see `app.products._index`. */
export const loader = ({ request, params }: LoaderFunctionArgs) => {
  throw redirectWithin(
    request,
    `/app/metakocka/products/${encodeURIComponent(params.productId ?? "")}`,
  );
};
