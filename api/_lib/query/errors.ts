import {
  ApplicationException,
  ErrorHandler,
  type GeneralErrorCode,
} from "../../../src/global/lib/error-handling";

type QueryErrorCode =
  | "DATABASE_URL_NOT_SET"
  | "METHOD_NOT_ALLOWED"
  | "QUERY_NOT_GIVEN"
  | "PARAMS_NOT_AN_ARRAY"
  | "NOT_SELECT_QUERY"
  | "FORBIDDEN_QUERY";

export class QueryException extends ApplicationException<
  QueryErrorCode | GeneralErrorCode
> {}

export const QueryErrorHandler = new ErrorHandler<QueryErrorCode>([]);
