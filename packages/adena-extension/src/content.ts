import { EVENT_KEYS } from '@common/constants/event-key.constant';
import { EventMessageData } from '@inject/message';
import { CommandMessageData } from '@inject/message/command-message';
import { GnoSessionUpdateMessage } from '@inject/message/methods/gno-session';
import { GnoWebEventWatcherInterceptor } from '@inject/message/methods/interceptors';
import { installNoScriptFallback } from '@inject/gnoconnect/fallback';
import { GNO_STATE_HINT_EVENT, GNO_STATE_HINT_STATUS } from '@inject/gnoconnect/types';

const loadScript = (): void => {
  const container = document.head || document.documentElement;
  const scriptElement = document.createElement('script');

  scriptElement.src = chrome.runtime.getURL('inject.js');
  scriptElement.type = 'text/javascript';
  container.insertBefore(scriptElement, container.children[0]);

  scriptElement.remove();
};

const initListener = (): void => {
  const listener = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) {
      console.warn(`Untrusted origin: ${event.origin}`);
      return;
    }

    try {
      if (event.data?.status === 'request') {
        sendMessage(event);
      } else {
        return event.data;
      }
    } catch (e) {
      console.warn(e);
    }
  };

  window.addEventListener('message', listener, false);
};

const initExtensionListener = (): void => {
  chrome.runtime.onMessage.addListener(
    (message: EventMessageData | CommandMessageData, _sender, sendResponse) => {
      if (message.status === 'event') {
        const changedAccountEvent = new CustomEvent(EVENT_KEYS[message.type], {
          detail: message.data,
        });

        window.dispatchEvent(changedAccountEvent);
        sendResponse({ received: true });
        return;
      }

      // Payload-free: the provider re-reads state itself, so nothing here is trusted.
      if ((message as { status?: string }).status === GNO_STATE_HINT_STATUS) {
        window.dispatchEvent(new Event(GNO_STATE_HINT_EVENT));
      }

      sendResponse({ received: true });
    },
  );
};

const sendMessage = async (event: MessageEvent): Promise<void> => {
  const message = event.data;

  try {
    const isConnected = await new Promise<boolean>((resolve) => {
      chrome.runtime.sendMessage({ type: 'ping' }, () => {
        resolve(!chrome.runtime.lastError);
      });
    }).catch((error) => {
      console.warn('Failed to send message', error);
      return false;
    });

    if (!isConnected) {
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to send message:', chrome.runtime.lastError);
        return;
      }

      Promise.resolve(response)
        .then((result) => {
          if (event.source) {
            event.source.postMessage(result, {
              targetOrigin: event.origin,
            });
          }
        })
        .catch((error) => {
          console.warn('Error processing response:', error);
        });
      return true;
    });
  } catch (e) {
    console.warn('Failed to send message to runtime', e);
  }
};

/**
 * Subscribes to gnoweb's own custom events (`params:changed`, `mode:changed`,
 * `address:changed`) to keep the wallet's gno session in sync with what the user
 * is editing on the page.
 *
 * This observes and cancels nothing. The only interception is the no-script
 * fallback, which stands down once the page dispatches `gno:requestWallet`.
 */
const initGnoWebEventWatcher = (): void => {
  const watcher = new GnoWebEventWatcherInterceptor((message: GnoSessionUpdateMessage) => {
    sendGnoSessionUpdate(message);
  });

  try {
    if (watcher.shouldRegister()) {
      watcher.register();
    }
  } catch (error) {
    console.warn('Failed to register GnoWeb event watcher:', error);
  }
};

/**
 * Sends GnoSessionUpdateMessage to the background script.
 */
const sendGnoSessionUpdate = async (message: GnoSessionUpdateMessage): Promise<void> => {
  try {
    const isConnected = await new Promise<boolean>((resolve) => {
      chrome.runtime.sendMessage({ type: 'ping' }, () => {
        resolve(!chrome.runtime.lastError);
      });
    }).catch(() => false);

    if (!isConnected) {
      return;
    }

    chrome.runtime.sendMessage(message).catch((error) => {
      console.warn('Failed to send GnoSessionUpdate:', error);
    });
  } catch {
    console.warn('Failed to send GnoSessionUpdateMessage to background');
  }
};

// Runs at `document_start`: the fallback must hear the page's first request,
// while the watcher reads `gnoconnect:*` metas that are not parsed yet.
installNoScriptFallback();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGnoWebEventWatcher, { once: true });
} else {
  initGnoWebEventWatcher();
}
loadScript();
initListener();
initExtensionListener();
