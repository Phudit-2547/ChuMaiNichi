import { Check, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CodexAuthRequestError,
  disconnectCodexAuth,
  fetchCodexAuthStatus,
  nextCodexAuthPollDelay,
  pollCodexAuth,
  requiresCodexAuthReset,
  setCodexModel,
  startCodexAuth,
  statusRequiresCodexAuthReset,
  type CodexAuthStartResponse,
  type CodexAuthStatus,
} from "../lib/codex-auth";
import { SharedErrorHandler } from "@/global/lib/error-handling";
import { CODEX_AUTH_CHANGED_EVENT } from "@/global/lib/events";

type CodexAction = "start" | "disconnect" | "reset" | "model" | null;

export default function ChatGptConnectionSection({
  active,
}: {
  active: boolean;
}) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusRequest, setStatusRequest] = useState(0);
  const [flow, setFlow] = useState<CodexAuthStartResponse | null>(null);
  const [action, setAction] = useState<CodexAction>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetRequired, setResetRequired] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const startRequestRef = useRef<AbortController | null>(null);
  const disconnectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const keepConnectedRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setConfirmDisconnect(false);
      return;
    }

    const controller = new AbortController();
    let current = true;
    setStatusLoading(true);
    setError(null);

    fetchCodexAuthStatus(controller.signal)
      .then((nextStatus) => {
        if (current) {
          setStatus(nextStatus);
          setResetRequired(statusRequiresCodexAuthReset(nextStatus));
        }
      })
      .catch((requestError: unknown) => {
        if (current && !controller.signal.aborted) {
          const needsReset = requiresCodexAuthReset(requestError);
          setResetRequired(needsReset);
          if (needsReset) setStatus(null);
          setError(codexAuthErrorMessage(requestError, "status"));
        }
      })
      .finally(() => {
        if (current) setStatusLoading(false);
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [active, statusRequest]);

  useEffect(() => {
    if (!active || !flow) return;

    const controller = new AbortController();
    const intervalMs = normalizePollInterval(flow.interval_seconds);
    const expiresAt = Date.parse(flow.expires_at);
    let timer: number | undefined;
    let current = true;

    const scheduleNext = (delayMs = intervalMs) => {
      if (!current) return;
      const remainingMs = Number.isFinite(expiresAt)
        ? Math.max(0, expiresAt - Date.now())
        : delayMs;
      timer = window.setTimeout(runPoll, Math.min(delayMs, remainingMs));
    };

    const runPoll = async () => {
      if (!current) return;
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        setFlow(null);
        setError("The sign-in code expired. Start a new connection.");
        return;
      }

      try {
        const result = await pollCodexAuth(
          flow.login_token,
          controller.signal,
        );
        if (!current) return;

        if (result.status === "connected") {
          setResetRequired(false);
          setStatus((previous) => ({
            connected: true,
            configured: previous?.configured ?? true,
            experimental: true,
            plan_type: result.plan_type ?? previous?.plan_type,
            model: previous?.model,
            updated_at: new Date().toISOString(),
          }));
          setFlow(null);
          setError(null);
          setStatusRequest((request) => request + 1);
          window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
          return;
        }

        if (result.status === "expired") {
          setFlow(null);
          setError("The sign-in code expired. Start a new connection.");
          return;
        }

        setError(null);
        scheduleNext();
      } catch (requestError) {
        if (!current || controller.signal.aborted) return;
        setError(codexAuthErrorMessage(requestError, "poll"));
        const nextDelay = nextCodexAuthPollDelay(requestError, intervalMs);
        if (nextDelay === null) {
          setFlow(null);
          return;
        }
        scheduleNext(nextDelay);
      }
    };

    timer = window.setTimeout(runPoll, intervalMs);

    return () => {
      current = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, flow]);

  useEffect(() => {
    if (!confirmDisconnect) return;
    const frame = window.requestAnimationFrame(() => {
      keepConnectedRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [confirmDisconnect]);

  useEffect(() => {
    if (!active) startRequestRef.current?.abort();
    return () => startRequestRef.current?.abort();
  }, [active]);

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      if (restoreFocusRef.current !== null) {
        window.cancelAnimationFrame(restoreFocusRef.current);
      }
    },
    [],
  );

  const handleStart = async () => {
    startRequestRef.current?.abort();
    const controller = new AbortController();
    startRequestRef.current = controller;
    setAction("start");
    setError(null);
    setCodeCopied(false);

    try {
      const nextFlow = await startCodexAuth(controller.signal);
      if (controller.signal.aborted) return;
      assertSafeVerificationUrl(nextFlow.verification_url);
      setFlow(nextFlow);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(codexAuthErrorMessage(requestError, "start"));
    } finally {
      if (startRequestRef.current === controller) {
        startRequestRef.current = null;
        setAction(null);
      }
    }
  };

  const handleCancelDisconnect = () => {
    setConfirmDisconnect(false);
    scheduleFocus(disconnectTriggerRef);
  };

  const scheduleFocus = (
    target: { current: HTMLElement | null },
  ) => {
    if (restoreFocusRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusRef.current);
    }
    restoreFocusRef.current = window.requestAnimationFrame(() => {
      target.current?.focus();
      restoreFocusRef.current = null;
    });
  };

  const handleCopyCode = async () => {
    if (!flow) return;
    try {
      await navigator.clipboard.writeText(flow.user_code);
      setCodeCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(
        () => setCodeCopied(false),
        2200,
      );
    } catch {
      setError(
        "The code could not be copied. Select the visible code and copy it manually.",
      );
    }
  };

  const handleDisconnect = async () => {
    setAction("disconnect");
    setError(null);

    try {
      const nextStatus = await disconnectCodexAuth();
      setStatus(nextStatus);
      setResetRequired(false);
      setFlow(null);
      setConfirmDisconnect(false);
      setStatusRequest((request) => request + 1);
      window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
      scheduleFocus(statusRef);
    } catch (requestError) {
      setError(codexAuthErrorMessage(requestError, "disconnect"));
    } finally {
      setAction(null);
    }
  };

  const handleResetConnection = async () => {
    setAction("reset");
    setError(null);

    try {
      const nextStatus = await disconnectCodexAuth();
      setStatus(nextStatus);
      setResetRequired(false);
      setFlow(null);
      setConfirmDisconnect(false);
      setStatusRequest((request) => request + 1);
      window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
      scheduleFocus(statusRef);
    } catch (requestError) {
      setError(codexAuthErrorMessage(requestError, "reset"));
    } finally {
      setAction(null);
    }
  };

  const handleModelChange = async (nextModel: string) => {
    if (!status || nextModel === status.model) return;
    setAction("model");
    setPendingModel(nextModel);
    setError(null);

    try {
      const selection = await setCodexModel(nextModel);
      setStatus((previous) => previous
        ? {
            ...previous,
            model: selection.model,
            model_options: selection.model_options,
          }
        : previous);
      window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT));
    } catch (requestError) {
      const activeModel = status.model_options?.find(
        (option) => option.id === status.model,
      )?.label ?? status.model;
      setError(
        `${codexAuthErrorMessage(requestError, "model")} ${activeModel} is still active.`,
      );
    } finally {
      setPendingModel(null);
      setAction(null);
    }
  };

  const connectionState = statusLoading
    ? "checking"
    : resetRequired
      ? "recovery"
      : status?.connected
        ? "connected"
        : status?.configured === false
          ? "unavailable"
          : "disconnected";
  const connectionLabel =
    connectionState === "checking"
      ? "Checking connection…"
      : connectionState === "recovery"
        ? "Connection needs reset"
        : connectionState === "connected"
          ? "Connected"
          : connectionState === "unavailable"
            ? "Not configured"
            : flow
              ? "Waiting for approval"
              : "Not connected";
  const connectionDetail = getConnectionDetail(status, connectionState);
  const selectedModel = pendingModel ?? status?.model;
  const selectedModelOption = status?.model_options?.find(
    (option) => option.id === selectedModel,
  );

  return (
    <section
      className="modal-section codex-auth"
      aria-labelledby="chatgpt-subscription-heading"
    >
      <div className="codex-auth__heading">
        <h3 id="chatgpt-subscription-heading">ChatGPT subscription</h3>
        <span className="codex-auth__experimental">Experimental</span>
      </div>

      <div className="codex-auth__row">
        <div className="codex-auth__summary">
          <div
            ref={statusRef}
            className="codex-auth__status"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            <span
              className="codex-auth__status-dot"
              data-state={
                connectionState === "recovery" ? "unavailable" : connectionState
              }
              aria-hidden="true"
            />
            <span>{connectionLabel}</span>
          </div>
          <div className="row-sub">{connectionDetail}</div>
        </div>

        <div className="codex-auth__actions">
          {!statusLoading &&
          !resetRequired &&
          status?.connected &&
          !confirmDisconnect ? (
            <button
              ref={disconnectTriggerRef}
              type="button"
              className="codex-auth__button codex-auth__button--quiet"
              onClick={() => setConfirmDisconnect(true)}
              disabled={action !== null}
            >
              Disconnect
            </button>
          ) : null}

          {!statusLoading &&
          !resetRequired &&
          status?.configured &&
          !status.connected &&
          !flow ? (
            <button
              type="button"
              className="codex-auth__button codex-auth__button--primary"
              onClick={handleStart}
              disabled={action !== null}
            >
              {action === "start" ? (
                <LoaderCircle
                  className="codex-auth__spinner"
                  aria-hidden="true"
                />
              ) : null}
              {action === "start" ? "Starting…" : "Connect"}
            </button>
          ) : null}

          {!statusLoading && resetRequired ? (
            <button
              type="button"
              className="codex-auth__button codex-auth__button--danger"
              onClick={handleResetConnection}
              disabled={action !== null}
            >
              {action === "reset" ? "Resetting…" : "Reset connection"}
            </button>
          ) : null}

          {!statusLoading && !resetRequired && !status && error ? (
            <button
              type="button"
              className="codex-auth__button codex-auth__button--quiet"
              onClick={() => setStatusRequest((request) => request + 1)}
            >
              Check again
            </button>
          ) : null}
        </div>
      </div>

      {!statusLoading &&
      !resetRequired &&
      status?.configured &&
      status.model_options &&
      status.model_options.length > 0 ? (
        <div className="codex-auth__model">
          <div className="codex-auth__model-heading">
            <label htmlFor="codex-model-select">Assistant model</label>
            <span role="status" aria-live="polite">
              {action === "model" ? "Saving…" : "Saved on server"}
            </span>
          </div>
          <select
            id="codex-model-select"
            value={selectedModel}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={action !== null || confirmDisconnect}
            aria-describedby="codex-model-description codex-model-note"
            aria-busy={action === "model"}
          >
            {status.model_options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}{option.recommended ? " — Recommended" : ""}
              </option>
            ))}
          </select>
          <p id="codex-model-description">
            {selectedModelOption?.description ??
              "Choose the model used for the next Assistant message."}
          </p>
          <p id="codex-model-note" className="codex-auth__model-note">
            Changes apply to the next message. Model access still depends on
            your ChatGPT plan because this connection is experimental.
          </p>
        </div>
      ) : null}

      {flow ? (
        <div className="codex-auth__device" aria-label="ChatGPT sign-in code">
          <div className="codex-auth__device-head">
            <span>Enter this code on the sign-in page</span>
            <time dateTime={flow.expires_at}>
              Expires {formatExpiry(flow.expires_at)}
            </time>
          </div>
          <div className="codex-auth__code-row">
            <code aria-label={`Sign-in code ${flow.user_code}`}>
              {flow.user_code}
            </code>
            <button
              type="button"
              className="codex-auth__copy"
              onClick={handleCopyCode}
              aria-label={codeCopied ? "Sign-in code copied" : "Copy sign-in code"}
            >
              {codeCopied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              <span>{codeCopied ? "Copied" : "Copy"}</span>
            </button>
          </div>
          <div className="codex-auth__device-footer">
            <a
              href={flow.verification_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open sign-in page
              <ExternalLink size={13} aria-hidden="true" />
            </a>
            <span className="codex-auth__waiting" role="status">
              <LoaderCircle className="codex-auth__spinner" aria-hidden="true" />
              Checking automatically
            </span>
          </div>
        </div>
      ) : null}

      {confirmDisconnect ? (
        <div
          className="codex-auth__confirm"
          role="group"
          aria-label="Confirm ChatGPT subscription disconnect"
        >
          <span>Disconnect this ChatGPT subscription?</span>
          <div className="codex-auth__confirm-actions">
            <button
              ref={keepConnectedRef}
              type="button"
              className="codex-auth__button codex-auth__button--quiet"
              onClick={handleCancelDisconnect}
              disabled={action !== null}
            >
              Keep connected
            </button>
            <button
              type="button"
              className="codex-auth__button codex-auth__button--danger"
              onClick={handleDisconnect}
              disabled={action !== null}
            >
              {action === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="codex-auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function normalizePollInterval(intervalSeconds: number): number {
  if (!Number.isFinite(intervalSeconds)) return 5_000;
  return Math.max(1, intervalSeconds) * 1_000;
}

function assertSafeVerificationUrl(value: string): void {
  const url = new URL(value);
  if (url.origin !== "https://auth.openai.com") {
    throw new Error("The sign-in service returned an unsafe verification URL.");
  }
}

function formatExpiry(value: string): string {
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) return "soon";
  return expiresAt.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPlanType(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) =>
      word.toLowerCase() === "chatgpt"
        ? "ChatGPT"
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function getConnectionDetail(
  status: CodexAuthStatus | null,
  connectionState:
    | "checking"
    | "recovery"
    | "connected"
    | "unavailable"
    | "disconnected",
): string {
  if (connectionState === "checking") return "Reading secure server status.";
  if (connectionState === "recovery") {
    return "Remove the saved connection before reconnecting; its refresh state is no longer safe to reuse.";
  }
  if (connectionState === "unavailable") {
    return "Enable subscription sign-in on this deployment first.";
  }
  if (connectionState === "connected") {
    const details = [
      status?.plan_type ? formatPlanType(status.plan_type) : null,
      status?.model ?? null,
    ].filter(Boolean);
    return details.length > 0
      ? details.join(" · ")
      : "Your subscription is available to the Assistant.";
  }
  return "Use your ChatGPT plan for Assistant responses.";
}

function codexAuthErrorMessage(
  error: unknown,
  action: "status" | "start" | "poll" | "disconnect" | "reset" | "model",
): string {
  const requestError =
    error instanceof CodexAuthRequestError ? error : null;
  if (requestError?.serverCode === "codex_auth_invalid_login_token") {
    return "The sign-in session is no longer valid. Start a new connection.";
  }
  if (requestError?.serverCode === "codex_auth_rate_limited") {
    return "Approval checks are temporarily rate limited. Automatic checks will resume.";
  }
  if (
    requestError?.serverCode === "codex_auth_stored_credentials_invalid"
  ) {
    return "The saved connection can no longer be read. Reset it before reconnecting.";
  }
  const code =
    requestError?.generalCode ?? SharedErrorHandler.getErrorCode(error);
  if (code === "INVALID_CREDENTIALS") {
    return "The dashboard session expired. Sign in again, then retry.";
  }
  if (code === "NETWORK_ERROR") {
    return "The connection service could not be reached. Check your connection and retry.";
  }
  if (code === "INTERNAL_ERROR") {
    return "The connection service returned an error. Retry in a moment.";
  }

  if (action === "status") return "Connection status could not be checked. Retry.";
  if (action === "start") return "The ChatGPT sign-in could not be started. Retry.";
  if (action === "poll") {
    return "Approval status could not be checked. Automatic checks will continue.";
  }
  if (action === "reset") {
    return "The saved ChatGPT connection could not be reset. Retry.";
  }
  if (action === "model") {
    return "The Assistant model could not be changed. Retry.";
  }
  return "The ChatGPT subscription could not be disconnected. Retry.";
}
