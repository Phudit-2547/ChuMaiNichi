import {
  ApplicationException,
  ErrorHandler,
  type GeneralErrorCode,
} from "../../global/lib/error-handling";

type ChatErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "MESSAGES_NOT_GIVEN"
  | "TOO_MANY_MESSAGES"
  | "MISSING_MESSAGE_ROLE"
  | "AI_PROVIDER_NOT_CONFIGURED";

export class ChatException extends ApplicationException<
  ChatErrorCode | GeneralErrorCode
> {}

export const ChatErrorHandler = new ErrorHandler<ChatErrorCode>([]);
