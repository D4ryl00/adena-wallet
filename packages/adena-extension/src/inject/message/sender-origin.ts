/**
 * A page's request with the origin the browser saw. The page world stamps
 * `protocol` and `hostname` itself, so it could write any site there.
 * The extension's own pages keep what they wrote.
 */
export function stampSenderOrigin<T extends { protocol?: string; hostname?: string }>(
  message: T,
  sender: chrome.runtime.MessageSender,
): T {
  if (!sender.url) return message;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return message;
  }
  if (url.origin === new URL(chrome.runtime.getURL('')).origin) return message;
  return { ...message, protocol: url.protocol, hostname: url.hostname };
}
