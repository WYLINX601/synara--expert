import type { IpcMain, Menu, MenuItem } from "electron";

/** Tracks accepted async native work through its true lifetime, including modal dialogs. */
export class LinxUpdateNativeAdmission {
  private accepted = 0;
  constructor(private readonly held: () => boolean) {}
  get busy(): boolean {
    return this.accepted !== 0;
  }
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.held()) throw new Error("Native mutations are frozen for update handoff");
    this.accepted++;
    try {
      return await operation();
    } finally {
      this.accepted--;
    }
  }
}

/** Application registrations only; never monkey-patches Electron's global IPC singleton. */
export function createLinxUpdateNativeIpc(input: {
  ipc: IpcMain;
  admission: LinxUpdateNativeAdmission;
  held: () => boolean;
  exempt: ReadonlySet<string>;
}): IpcMain {
  return new Proxy(input.ipc, {
    get(target, property) {
      if (property === "handle")
        return (channel: string, listener: Parameters<IpcMain["handle"]>[1]) =>
          target.handle(channel, (event, ...args: unknown[]) =>
            input.exempt.has(channel)
              ? listener(event, ...args)
              : input.admission.run(() => listener(event, ...args)),
          );
      if (property === "on")
        return (channel: string, listener: Parameters<IpcMain["on"]>[1]) =>
          target.on(channel, (event, ...args: unknown[]) => {
            if (!input.held() || input.exempt.has(channel)) listener(event, ...args);
            // sendSync must receive a response even when its mutation is refused.
            else event.returnValue = null;
          });
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Electron role menus invoke native edits without dispatching renderer input. */
export function freezeLinxUpdateNativeMenu(menu: Pick<Menu, "items"> | null): () => void {
  const edits: Record<string, true> = {
    undo: true,
    redo: true,
    cut: true,
    paste: true,
    pasteandmatchstyle: true,
    delete: true,
    reload: true,
    forcereload: true,
    services: true,
    toggledevtools: true,
  };
  const previous = new Map<MenuItem, boolean>();
  const visit = (items: readonly MenuItem[]): void => {
    for (const item of items) {
      if (item.role && edits[item.role.toLowerCase()]) {
        previous.set(item, item.enabled);
        item.enabled = false;
      }
      if (item.submenu) visit(item.submenu.items);
    }
  };
  if (menu) visit(menu.items);
  return () => {
    for (const [item, enabled] of previous) item.enabled = enabled;
    previous.clear();
  };
}
