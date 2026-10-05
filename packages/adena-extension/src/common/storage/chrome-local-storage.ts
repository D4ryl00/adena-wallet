import { CommonError } from '@common/errors/common';
import { StorageMigrator, StorageModelLatest } from '@migrates/storage-migrator';
import { Storage } from '.';

// Define the valid types of storage keys
type StorageKeyTypes =
  | 'NETWORKS'
  | 'ATOMONE_NETWORKS'
  | 'NETWORK_MODE'
  | 'CURRENT_CHAIN_ID'
  | 'CURRENT_NETWORK_ID'
  | 'CURRENT_ATOMONE_NETWORK_ID'
  | 'SERIALIZED'
  | 'CURRENT_ACCOUNT_ID'
  | 'ACCOUNT_NAMES'
  | 'ESTABLISH_SITES'
  | 'ESTABLISH_ATOMONE_SITES'
  | 'ADDRESS_BOOK'
  | 'ACCOUNT_TOKEN_METAINFOS'
  | 'QUESTIONNAIRE_EXPIRED_DATE'
  | 'WALLET_CREATION_GUIDE_CONFIRM_DATE'
  | 'ADD_ACCOUNT_GUIDE_CONFIRM_DATE'
  | 'ACCOUNT_GRC721_COLLECTIONS'
  | 'ACCOUNT_GRC721_PINNED_PACKAGES'
  | 'KDF_SALT'
  | 'AUTO_LOCK_TIMEOUT_MINUTES'
  | 'SESSIONS';

// List of all available storage keys
const StorageKeys: StorageKeyTypes[] = [
  'NETWORKS',
  'ATOMONE_NETWORKS',
  'NETWORK_MODE',
  'CURRENT_CHAIN_ID',
  'CURRENT_NETWORK_ID',
  'CURRENT_ATOMONE_NETWORK_ID',
  'SERIALIZED',
  'CURRENT_ACCOUNT_ID',
  'ACCOUNT_NAMES',
  'ESTABLISH_SITES',
  'ESTABLISH_ATOMONE_SITES',
  'ADDRESS_BOOK',
  'ACCOUNT_TOKEN_METAINFOS',
  'QUESTIONNAIRE_EXPIRED_DATE',
  'WALLET_CREATION_GUIDE_CONFIRM_DATE',
  'ADD_ACCOUNT_GUIDE_CONFIRM_DATE',
  'ACCOUNT_GRC721_COLLECTIONS',
  'ACCOUNT_GRC721_PINNED_PACKAGES',
  'KDF_SALT',
  'AUTO_LOCK_TIMEOUT_MINUTES',
  'SESSIONS',
];

// Function to validate if a given key is a valid storage key
function isStorageKey(key: string): key is StorageKeyTypes {
  return StorageKeys.some((storageKey) => storageKey === key);
}

// Class to handle Chrome's local storage with migration support
export class ChromeLocalStorage implements Storage {
  // Define the main storage key for the application
  private static StorageKey = 'ADENA_DATA';

  private storage: chrome.storage.LocalStorageArea;

  private migrator: StorageMigrator;

  // Writes from this context, one after the other. The store is read again for
  // each one: other contexts (background, popup) write to it too.
  private writes: Promise<void> = Promise.resolve();

  constructor() {
    if (!chrome.storage) {
      throw new CommonError('FAILED_INITIALIZE_CHROME_API');
    }
    this.storage = chrome.storage.local;
    this.migrator = new StorageMigrator(StorageMigrator.migrations(), this.storage);
  }

  public get = async (key: string): Promise<any> => {
    if (!isStorageKey(key)) {
      throw new Error('Unsupported key (' + key + ')');
    }
    const data = await this.getStorageData();
    return data?.data?.[key];
  };

  public set = async (key: string, value: any): Promise<void> => {
    await this.setStorageData(key, value);
  };

  public remove = async (key: string): Promise<void> => {
    await this.set(key, '');
    await this.storage.remove(key);
  };

  public clear = async (): Promise<void> => {
    await this.storage.set({ [ChromeLocalStorage.StorageKey]: '{}' });
    await this.storage.clear();
  };

  public updatePassword = async (password: string): Promise<StorageModelLatest | null> => {
    const current = await this.migrator.getCurrent();
    const latest = await this.migrator.migrate(current, password);
    if (latest) {
      await this.storage.set({
        [ChromeLocalStorage.StorageKey]: JSON.stringify(latest),
      });
    }
    return latest;
  };

  private getStorageData = async (): Promise<any | null> => {
    return this.migrator.getCurrent();
  };

  private setStorageData = (key: string, value: any): Promise<void> => {
    const write = this.writes.then(async () => {
      const current = await this.getStorageData();
      if (!current) {
        return;
      }

      const storageData = {
        ...current,
        data: {
          ...current.data,
          [key]: value,
        },
      };

      await this.storage.set({
        [ChromeLocalStorage.StorageKey]: JSON.stringify(storageData),
      });
    });
    this.writes = write.catch(() => undefined);
    return write;
  };
}
