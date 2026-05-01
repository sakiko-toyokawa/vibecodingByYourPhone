/**
 * HostOfflineModal - Shows when auto-resume fails because host is unreachable.
 *
 * Displays a user-friendly error when the remote host cannot be reached during
 * session resumption, with options to retry or go to the login page.
 */

import type {
  AutoResumeError,
  AutoResumeErrorReason,
} from "../contexts/RemoteConnectionContext";
import { useI18n } from "../i18n";
import { Modal } from "./ui/Modal";

type Translate = ReturnType<typeof useI18n>["t"];

interface HostOfflineModalProps {
  error: AutoResumeError;
  onRetry: () => void;
  onGoToLogin: () => void;
}

function getErrorTitle(reason: AutoResumeErrorReason, t: Translate): string {
  switch (reason) {
    case "server_offline":
      return t("hostOfflineTitleServerOffline");
    case "unknown_username":
      return t("hostOfflineTitleUnknownUsername");
    case "relay_timeout":
      return t("hostOfflineTitleRelayTimeout");
    case "relay_unreachable":
      return t("hostOfflineTitleRelayUnreachable");
    case "direct_unreachable":
      return t("hostOfflineTitleDirectUnreachable");
    case "resume_incompatible":
      return t("hostOfflineTitleResumeIncompatible");
    default:
      return t("hostOfflineTitleDefault");
  }
}

function getErrorMessage(error: AutoResumeError, t: Translate): string {
  const { reason, mode, relayUsername } = error;

  switch (reason) {
    case "server_offline":
      return relayUsername
        ? t("hostOfflineMessageServerOfflineNamed", { relayUsername })
        : t("hostOfflineMessageServerOffline");

    case "unknown_username":
      return relayUsername
        ? t("hostOfflineMessageUnknownUsernameNamed", { relayUsername })
        : t("hostOfflineMessageUnknownUsername");

    case "relay_timeout":
      return relayUsername
        ? t("hostOfflineMessageRelayTimeoutNamed", { relayUsername })
        : t("hostOfflineMessageRelayTimeout");

    case "relay_unreachable":
      return t("hostOfflineMessageRelayUnreachable");

    case "direct_unreachable":
      return mode === "direct"
        ? t("hostOfflineMessageDirectUnreachableDirect")
        : t("hostOfflineMessageDirectUnreachable");

    case "resume_incompatible":
      return t("hostOfflineMessageResumeIncompatible");

    default:
      return t("hostOfflineMessageDefault");
  }
}

export function HostOfflineModal({
  error,
  onRetry,
  onGoToLogin,
}: HostOfflineModalProps) {
  const { t } = useI18n();
  const title = getErrorTitle(error.reason, t);
  const message = getErrorMessage(error, t);

  return (
    <Modal title={title} onClose={onGoToLogin}>
      <div className="flex flex-col gap-4">
        <p className="text-[var(--text-primary)] [font-size:var(--font-size-base)] leading-relaxed m-0">
          {message}
        </p>

        {error.relayUsername && (
          <p className="bg-[var(--bg-code)] px-3 py-2 rounded-[var(--radius-sm)] [font-size:var(--font-size-sm)] text-[var(--text-secondary)] m-0 break-words">
            <strong className="text-[var(--text-primary)]">
              {t("relayLoginUsername")}:
            </strong>{" "}
            {error.relayUsername}
          </p>
        )}

        <p className="text-[var(--text-muted)] [font-size:var(--font-size-sm)] m-0">
          {error.reason === "resume_incompatible"
            ? t("hostOfflineHintResumeIncompatible")
            : error.mode === "relay"
              ? t("hostOfflineHintRelay")
              : t("hostOfflineHintDirect")}
        </p>

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            className="px-4 py-2 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-[var(--radius-md)] text-sm transition-colors duration-150 hover:bg-[var(--border-color)]"
            onClick={onGoToLogin}
          >
            {t("hostOfflineGoToLogin")}
          </button>
          <button
            type="button"
            className="px-4 py-2 bg-[var(--accent-rust)] text-white rounded-[var(--radius-md)] text-sm font-medium transition-opacity duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onRetry}
          >
            {t("hostOfflineRetry")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
