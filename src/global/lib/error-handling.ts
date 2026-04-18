import axios from "axios";

export type GeneralErrorCode =
  | "INVALID_CREDENTIALS"
  | "NETWORK_ERROR"
  | "INTERNAL_ERROR"
  | "UNKNOWN_ERROR";

export class ApplicationException<CodeT extends string> extends Error {
  public code: CodeT;

  constructor(
    code: CodeT,
    message?: string | undefined,
    options?: ErrorOptions | undefined,
  ) {
    super(message ? message : code, options);
    this.code = code;
  }
}

interface ErrorEntry<CodeT extends string> {
  code: CodeT;
  condition: (error: unknown) => boolean;
}

const generalErrorEntries: ErrorEntry<GeneralErrorCode>[] = [
  {
    code: "INVALID_CREDENTIALS",
    condition: (e) => {
      if (axios.isAxiosError(e)) {
        return e.response?.status === 403;
      }

      return false;
    },
  },
  {
    code: "INTERNAL_ERROR",
    condition: (e) => {
      console.log(e);
      if (axios.isAxiosError(e)) {
        return (
          e.response?.status != null &&
          e.response.status >= 500 &&
          e.response.status < 600
        );
      }

      return false;
    },
  },
  {
    code: "NETWORK_ERROR",
    condition: (e) => {
      if (axios.isAxiosError(e)) {
        return e.code === "ERR_NETWORK";
      }

      return false;
    },
  },
  {
    code: "UNKNOWN_ERROR",
    condition: () => true,
  },
];

export class ErrorHandler<CodeT extends string> {
  entries: ErrorEntry<CodeT | GeneralErrorCode>[] = [];

  constructor(entries: ErrorEntry<CodeT>[]) {
    this.entries = [...entries, ...generalErrorEntries];
  }

  public wrapError(
    error: unknown,
  ): ApplicationException<CodeT | GeneralErrorCode> {
    if (error instanceof ApplicationException) {
      return error;
    }
    const errorEntry = this.entries.find((entry) => entry.condition(error));
    const { code } = errorEntry!;
    return new ApplicationException(code);
  }

  public getErrorCode(error: unknown): CodeT | GeneralErrorCode | null {
    if (error instanceof ApplicationException) {
      return error.code;
    }

    return null;
  }
}

export const SharedErrorHandler = new ErrorHandler<never>([]);
