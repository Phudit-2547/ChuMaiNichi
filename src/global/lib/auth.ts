import { queryDB } from "./api";
import { SharedErrorHandler } from "./error-handling";

export async function authenticate() {
  await queryDB("SELECT 1").catch((err) => {
    throw SharedErrorHandler.wrapError(err);
  });
}
