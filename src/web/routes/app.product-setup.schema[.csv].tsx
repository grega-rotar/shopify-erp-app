import type { LoaderFunctionArgs } from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { schemaToCsv } from "~/domain/attributes/csv";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The plan as one spreadsheet (docs/attributes.md § Import and export): one
 * row per type, set, attribute, option, attachment and exception, named
 * rather than by id, so it can be edited in a spreadsheet or by an AI
 * assistant and imported again. An empty plan downloads as the header row,
 * which is the template. Fetched from the page by `DownloadButton`.
 */
const BOM = String.fromCharCode(0xfeff);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema } = await getAttributeSchema(principal);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(`${BOM}${schemaToCsv(schema)}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="product-setup-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
