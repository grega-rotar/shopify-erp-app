/**
 * The product page reads attribute values through the same path AI autofill
 * does, which lives with the adapters so a job can use it too.
 */
export {
  readAttributeValues,
  type AttributeValues,
} from "~/adapters/products/attribute-values.server";
