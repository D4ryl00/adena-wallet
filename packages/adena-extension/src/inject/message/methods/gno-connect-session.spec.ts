import { createReplayMemory, ReplayEntries, ReplayStore } from './gno-connect-session';

// What outlives the service worker: Chrome may stop it between two messages.
function sharedStore(): ReplayStore & { entries: ReplayEntries } {
  const store = {
    entries: {} as ReplayEntries,
    load: async (): Promise<ReplayEntries> => ({ ...store.entries }),
    save: async (entries: ReplayEntries): Promise<void> => {
      store.entries = { ...entries };
    },
  };
  return store;
}

describe('createReplayMemory', () => {
  const NOW = 1790841600;

  it('refuses a pair seen before the service worker restarted', async () => {
    const store = sharedStore();
    expect(await createReplayMemory(store).check('pk', 's', NOW)).toBe(true);

    const restarted = createReplayMemory(store);
    expect(await restarted.check('pk', 's', NOW + 1)).toBe(false);
  });

  it('lets a check made before a restart be consumed once after it', async () => {
    const store = sharedStore();
    await createReplayMemory(store).check('pk', 's', NOW);

    const restarted = createReplayMemory(store);
    expect(await restarted.consume('pk', 's', NOW + 1)).toBe(true);
    expect(await createReplayMemory(store).consume('pk', 's', NOW + 2)).toBe(false);
  });

  it('accepts one of two checks of the same pair made together', async () => {
    const memory = createReplayMemory(sharedStore());
    const answers = await Promise.all([memory.check('pk', 's', NOW), memory.check('pk', 's', NOW)]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('forgets a pair after the 10-minute window', async () => {
    const store = sharedStore();
    const memory = createReplayMemory(store);
    await memory.check('pk', 's', NOW);
    await memory.check('pk', 'other', NOW + 601);

    expect(Object.keys(store.entries)).toHaveLength(1);
  });

  it('keeps working in memory alone', async () => {
    const memory = createReplayMemory();
    expect(await memory.check('pk', 's', NOW)).toBe(true);
    expect(await memory.check('pk', 's', NOW)).toBe(false);
    expect(await memory.consume('pk', 's', NOW)).toBe(true);
    expect(await memory.consume('pk', 's', NOW)).toBe(false);
  });
});
