import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/** Location settings moved with Locations; see `app.products._index`. */
export const loader = ({ request }: LoaderFunctionArgs) => {
  throw redirectWithin(request, "/app/metakocka/locations/settings");
};
