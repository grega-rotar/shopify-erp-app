import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/** Locations moved under MetaKocka, as Products did; see `app.products._index`. */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectWithin(request, "/app/metakocka/locations");
};
