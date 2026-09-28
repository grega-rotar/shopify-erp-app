import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/** Product sync moved with Products; see `app.products._index`. */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectWithin(request, "/app/metakocka/products/sync");
};
