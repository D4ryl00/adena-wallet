import { MemoryProvider } from '@common/provider/memory/memory-provider';
import { clearAutoLockAlarm, resetAutoLockAlarm } from '@common/utils/auto-lock-timer';
import { CommandMessageData } from './command-message';
import {
  clearInMemoryKey,
  decryptPassword,
  encryptPassword,
  getInMemoryKey,
} from './commands/encrypt';
import { clearPopup } from './commands/popup';

export class CommandHandler {
  public static createHandler = async (
    inMemoryProvider: MemoryProvider,
    message: CommandMessageData,
    _: chrome.runtime.MessageSender,
    sendResponse: (response?: CommandMessageData) => void,
  ): Promise<void> => {
    // background.ts holds the message channel open for every command message
    // (`return true`), so an exit that does not answer leaves the caller's
    // promise pending forever — the popup then waits on `isLocked()` and never
    // renders. Route every exit through `respond`, and let the `finally` answer
    // the paths no branch above handled.
    let responded = false;
    const respond = (response: CommandMessageData): void => {
      if (responded) {
        return;
      }

      responded = true;
      sendResponse(response);
    };

    try {
      if (message.code !== 0) {
        respond(makeInternalErrorResponse(message));
        return;
      }

      if (message.command === 'encryptPassword') {
        if (!message.data.password) {
          throw new Error('Password is required');
        }

        const key = await getInMemoryKey(inMemoryProvider);
        if (!key) {
          throw new Error('Failed to get in-memory key');
        }

        const password = message.data.password;
        const responseData = await encryptPassword(key, password);

        respond(makeSuccessResponse(message, responseData));
        return;
      }

      if (message.command === 'decryptPassword') {
        const key = await getInMemoryKey(inMemoryProvider);
        if (!key) {
          throw new Error('Failed to in-memory key');
        }

        const iv = message.data.iv;
        const encryptedPassword = message.data.encryptedPassword;
        const decryptedPassword = await decryptPassword(key, iv, encryptedPassword);

        const responseData = {
          password: decryptedPassword,
        };

        respond(makeSuccessResponse(message, responseData));
        return;
      }

      if (message.command === 'clearEncryptKey') {
        await clearInMemoryKey(inMemoryProvider);
        respond(makeSuccessResponse(message));
        return;
      }

      if (message.command === 'resetAutoLockTimer') {
        await resetAutoLockAlarm();
        respond(makeSuccessResponse(message));
        return;
      }

      if (message.command === 'updateAutoLockTimer') {
        // The new duration is already persisted by the service layer; the
        // helper re-reads from storage so we don't need to trust the payload.
        await resetAutoLockAlarm();
        respond(makeSuccessResponse(message));
        return;
      }

      if (message.command === 'clearPopup') {
        await clearInMemoryKey(inMemoryProvider);
        await clearAutoLockAlarm();
        await clearPopup();
        respond(makeSuccessResponse(message));
        return;
      }
    } catch (error) {
      console.info(error);
      respond(makeInternalErrorResponse(message));
    } finally {
      // No-op once a branch has answered.
      respond(makeInternalErrorResponse(message));
    }
  };
}

function makeSuccessResponse(message: CommandMessageData, data: any = null): CommandMessageData {
  return {
    ...message,
    code: 200,
    data,
  };
}

function makeInternalErrorResponse(message: CommandMessageData): CommandMessageData {
  return {
    ...message,
    code: 500,
  };
}
