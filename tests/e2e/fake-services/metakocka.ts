import { z } from "zod";

import { shopForCompany, type ShopState } from "./state";

/**
 * Fake MetaKocka, dispatched on the endpoint path (src/adapters/metakocka/
 * endpoints.ts). Responses follow the recorded shapes in
 * tests/fixtures/metakocka and docs/metakocka-verification.md: every value a
 * string, `opr_code` "0" for success.
 *
 * The request names its company; the shop it belongs to is the one whose
 * reset registered that company id. The secret key is never recorded.
 */

type Body = Record<string, unknown>;
type Handler = (state: ShopState, body: Body) => unknown;

const OK = { opr_code: "0", opr_time_ms: "1" };

function markPaidTypes(body: Body): string[] {
  const entries = Array.isArray(body.mark_paid) ? body.mark_paid : [];
  return entries.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null && "payment_type" in entry
      ? [String(entry.payment_type)]
      : [],
  );
}

const handlers: Record<string, Handler> = {
  "json/warehouse_list": ({ metakocka }) => ({
    ...OK,
    doc_type: "warehouse",
    warehouse_list_count: String(metakocka.warehouses.length),
    warehouse_list: metakocka.warehouses.map((warehouse) => ({
      mk_id: warehouse.mkId,
      mark: warehouse.mark,
      name: warehouse.name,
      main_warehouse: String(warehouse.main),
      same_address_as_company: "true",
      include_in_stock_info: "true",
      active: "true",
      warehouse_type: "normal",
    })),
  }),

  "json/product_list": ({ metakocka }, body) => {
    const offset = Number(body.offset ?? 0);
    const limit = Number(body.limit ?? 500);
    return {
      ...OK,
      product_list: metakocka.products
        .slice(offset, offset + limit)
        .map((product) => ({
          mk_id: product.mkId,
          code: product.code,
          name: product.name,
          unit: "kos",
          sales: "true",
          purchasing: "false",
          service: "false",
        })),
    };
  },

  "json/warehouse_stock": ({ metakocka }, body) => {
    const warehouseId = String(body.wh_id_list ?? "");
    const offset = Number(body.offset ?? 0);
    const limit = Number(body.limit ?? 500);
    const rows = metakocka.products.flatMap((product) => {
      const amount = product.stock[warehouseId];
      return amount === undefined
        ? []
        : [
            {
              warehouse_id: warehouseId,
              mk_id: product.mkId,
              code: product.code,
              title: product.name,
              amount: String(amount),
              reserved_amount: "0",
              free_amount: String(amount),
              unit: "kos",
            },
          ];
    });
    return {
      ...OK,
      stock_list_count: String(rows.length),
      stock_list: rows.slice(offset, offset + limit),
    };
  },

  // `probeDocument` pays with a type that cannot exist, and the rejection
  // lists the register (docs/metakocka-verification.md § Payment types).
  put_document: ({ metakocka }, body) => {
    const unknownType = markPaidTypes(body).find(
      (type) => !metakocka.paymentTypes.includes(type),
    );
    if (unknownType !== undefined) {
      return {
        opr_code: "1",
        opr_desc: `Payment type ${unknownType} does not exist. Valid values : ${metakocka.paymentTypes.join(", ")}`,
      };
    }
    return {
      opr_code: "1",
      opr_desc:
        "fake metakocka: put_document only answers the payment register probe so far",
    };
  },
};

const bodySchema = z.record(z.string(), z.unknown());

export function handleMetakocka(path: string, raw: unknown): unknown {
  const { secret_key: _secret, ...body } = bodySchema.parse(raw);
  const companyId = typeof body.company_id === "string" ? body.company_id : "";
  const state = shopForCompany(companyId);

  if (!state) {
    return {
      opr_code: "1",
      opr_desc: `fake metakocka: company ${companyId} belongs to no reset shop`,
    };
  }

  const handler = handlers[path];
  state.calls.push({
    service: "metakocka",
    operation: path,
    variables: body,
    handled: handler !== undefined,
  });

  if (!handler) {
    return {
      opr_code: "1",
      opr_desc: `fake metakocka: no handler for ${path}`,
    };
  }
  return handler(state, body);
}
