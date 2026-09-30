import { GNO_STATE_HINT_EVENT, GnoAccount, GnoNetwork, GnoProviderEvents } from './types';

/** A gated read: the value, "this origin is not approved", or no answer. */
export type Peek<T> = { value: T } | 'disconnected' | 'unknown';

type Listener = (detail: unknown) => void;

export interface ProviderEvents {
  on<E extends keyof GnoProviderEvents>(
    event: E,
    listener: (detail: GnoProviderEvents[E]) => void,
  ): () => void;
  /** Records what a page's own call returned, so it is not re-announced. */
  rememberAccount(account: GnoAccount): void;
  rememberNetwork(network: GnoNetwork): void;
}

/**
 * Events are derived, never relayed: a hint only triggers a re-read through the
 * gated request channel, and an event fires only when the answer differs from
 * what the page last knew. An unapproved origin reads `disconnected` and hears
 * nothing; a hint the page forged costs a read and changes nothing.
 */
export function createProviderEvents(
  peekAccount: () => Promise<Peek<GnoAccount>>,
  peekNetwork: () => Promise<Peek<GnoNetwork>>,
  target: EventTarget = window,
): ProviderEvents {
  const listeners = new Map<string, Set<Listener>>();
  // undefined: never read. null: read, and the origin was not approved.
  let account: GnoAccount | null | undefined;
  let network: GnoNetwork | null | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let hinted = false;

  const emit = (event: keyof GnoProviderEvents, detail: unknown): void => {
    listeners.get(event)?.forEach((listener) => {
      try {
        listener(detail);
      } catch (error) {
        console.warn(`GnoConnect: ${event} listener failed`, error);
      }
    });
  };

  const read = async (): Promise<void> => {
    const [nextAccount, nextNetwork] = await Promise.all([peekAccount(), peekNetwork()]);

    if (nextAccount === 'disconnected') {
      const wasConnected = !!account;
      account = null;
      network = null;
      if (wasConnected) {
        emit('disconnect', null);
      }
      return;
    }

    if (nextAccount !== 'unknown') {
      const next = nextAccount.value;
      // Identity only: the address, not the chain it was read against.
      if (account !== undefined && account?.address !== next.address) {
        emit('accountChanged', next);
      }
      account = next;
    }

    if (nextNetwork !== 'unknown' && nextNetwork !== 'disconnected') {
      const next = nextNetwork.value;
      if (network && (network.chainid !== next.chainid || network.rpc !== next.rpc)) {
        emit('networkChanged', next);
      }
      network = next;
    }
  };

  // One read in flight; hints arriving meanwhile collapse into one more.
  const refresh = (): void => {
    // A page that unsubscribed everything costs no reads.
    if (![...listeners.values()].some((set) => set.size > 0)) {
      return;
    }
    if (running) {
      again = true;
      return;
    }
    running = (async (): Promise<void> => {
      do {
        again = false;
        try {
          await read();
        } catch (error) {
          console.warn('GnoConnect: state refresh failed', error);
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
  };

  return {
    on(event, listener): () => void {
      const set = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, set);
      set.add(listener as Listener);

      if (!hinted) {
        hinted = true;
        target.addEventListener(GNO_STATE_HINT_EVENT, refresh);
        refresh(); // baseline, so the first real change has something to differ from
      }
      return () => {
        set.delete(listener as Listener);
      };
    },
    rememberAccount(next): void {
      account = next;
    },
    rememberNetwork(next): void {
      network = next;
    },
  };
}
